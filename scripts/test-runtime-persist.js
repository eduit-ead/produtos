/**
 * Teste de persistência do APP_RUNTIME_DIR entre reinicializações do servidor.
 *
 * Inicia o servidor em diretório de runtime temporário, cria template, faz upload
 * de asset, importa CSV para uma coleção, mata o processo e reinicia.
 * Confirma que todos os dados permanecem e que os arquivos originais de ROOT/data
 * não foram alterados.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()
  );
}

function diffSnapshots(before, after) {
  const added = [...after].filter((f) => !before.has(f));
  const removed = [...before].filter((f) => !after.has(f));
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function buildMultipartBody(fields, file) {
  const boundary = `----FormBoundary${require("crypto").randomBytes(8).toString("hex")}`;
  const chunks = [];
  for (const [key, value] of Object.entries(fields || {})) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  if (file) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    );
    chunks.push(file.buffer);
    chunks.push(`\r\n--${boundary}--\r\n`);
  } else {
    chunks.push(`--${boundary}--\r\n`);
  }
  return {
    body: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")))),
    boundary,
  };
}

function requestJson(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(runtimeDir) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      APP_RUNTIME_DIR: runtimeDir,
      AI_CATALOG_DIR: path.join(runtimeDir, "output", "ai-catalog"),
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_DISABLED: "true",
    };
    const child = spawn(process.execPath, ["src/template-editor/server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    function onData(data) {
      output += data.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && child) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve({ child, port: parseInt(match[1], 10) });
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Servidor saiu com código ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout iniciando servidor. Output: ${output}`));
    }, 15000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.kill();
    child.on("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

(async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-persist-"));

  const beforeTemplates = snapshotDir(path.resolve(__dirname, "..", "data", "templates"));
  const beforeAssets = snapshotDir(path.resolve(__dirname, "..", "data", "assets"));
  const beforeCollections = snapshotDir(path.resolve(__dirname, "..", "data", "collections"));

  const collectionId = "persist-collection";
  const sourceRelPath = path.posix.join("data", "imports", collectionId, `${collectionId}.csv`);
  let createdTemplateId = null;
  let uploadedAssetId = null;

  // 1ª execução
  const server1 = await startServer(runtimeDir);

  try {
    const initialTemplates = await requestJson(server1.port, "GET", "/api/templates");
    assert.ok(Array.isArray(initialTemplates.body), "templates devem ser uma lista");
    assert.ok(initialTemplates.body.some((t) => t.id === "demo"), "demo deve vir do seed");

    const createdTemplate = await requestJson(
      server1.port,
      "POST",
      "/api/templates",
      JSON.stringify({ width: 1080, height: 1080 }),
      { "Content-Type": "application/json" }
    );
    assert.equal(createdTemplate.status, 200, `criar template falhou: ${JSON.stringify(createdTemplate.body)}`);
    const templateId = createdTemplate.body.template?.id;
    createdTemplateId = templateId;
    assert.ok(templateId, "template criado deve ter id");

    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>`,
      "utf8"
    );
    const { body: uploadBody, boundary } = buildMultipartBody({}, { filename: "asset.svg", contentType: "image/svg+xml", buffer: svg });
    const uploadRes = await requestJson(server1.port, "POST", "/api/upload", uploadBody, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(uploadRes.status, 200, `upload falhou: ${JSON.stringify(uploadRes.body)}`);
    const assetId = uploadRes.body.assetId;
    uploadedAssetId = assetId;
    assert.ok(assetId, "assetId deve existir");

    const collection = {
      id: collectionId,
      name: "Persist Collection",
      source: { type: "csv", path: sourceRelPath },
      primaryKey: "SKU",
      displayField: "Nome",
      searchFields: ["Nome", "Categoria"],
      fieldMappings: { title: "Nome", slug: "SKU" },
      filters: [{ field: "Categoria", label: "Categoria" }],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: {
        backgroundFilename: "bg_file",
        cardFilename: "card_file",
        whatsappFilename: "wa_file",
        backgroundUrl: "bg_url",
        cardUrl: "card_url",
        whatsappUrl: "wa_url",
        productionStatus: "prod_status",
        templateId: "tpl_id",
        updatedAt: "updated_at",
      },
      templateBindings: [
        { templateVariable: "titulo", sourceField: "Nome" },
        { templateVariable: "subtitulo", sourceField: "Categoria" },
      ],
    };
    const collRes = await requestJson(server1.port, "POST", "/api/collections", JSON.stringify(collection), {
      "Content-Type": "application/json",
    });
    assert.equal(collRes.status, 201, `criar coleção falhou: ${JSON.stringify(collRes.body)}`);

    const csv = Buffer.from("SKU,Nome,Categoria\nSKU-001,Produto A,Categoria A", "utf8");
    const { body: importBody, boundary: importBoundary } = buildMultipartBody({}, {
      filename: `${collectionId}.csv`,
      contentType: "text/csv",
      buffer: csv,
    });
    const importRes = await requestJson(server1.port, "POST", `/api/collections/${collectionId}/import`, importBody, {
      "Content-Type": `multipart/form-data; boundary=${importBoundary}`,
    });
    assert.equal(importRes.status, 200, `import falhou: ${JSON.stringify(importRes.body)}`);

    const itemsRes = await requestJson(server1.port, "GET", `/api/collections/${collectionId}/records`);
    assert.equal(itemsRes.status, 200, `listar itens falhou: ${JSON.stringify(itemsRes.body)}`);
    assert.ok(Array.isArray(itemsRes.body) && itemsRes.body.length === 1, "deve haver 1 item");
  } finally {
    await stopServer(server1.child);
  }

  // 2ª execução com o mesmo runtime
  const server2 = await startServer(runtimeDir);
  try {
    const templatesAfter = await requestJson(server2.port, "GET", "/api/templates");
    assert.ok(
      templatesAfter.body.some((t) => t.id === createdTemplateId),
      "template criado deve persistir"
    );

    const assetsAfter = await requestJson(server2.port, "GET", "/api/assets");
    assert.ok(
      Array.isArray(assetsAfter.body) && assetsAfter.body.some((a) => a.assetId === uploadedAssetId),
      "asset deve persistir"
    );

    const collectionsAfter = await requestJson(server2.port, "GET", "/api/collections");
    assert.ok(
      collectionsAfter.body.some((c) => c.id === collectionId),
      "coleção deve persistir"
    );

    const itemsAfter = await requestJson(server2.port, "GET", `/api/collections/${collectionId}/records`);
    assert.ok(Array.isArray(itemsAfter.body) && itemsAfter.body.length === 1, "item da coleção deve persistir");
  } finally {
    await stopServer(server2.child);
  }

  const afterTemplates = snapshotDir(path.resolve(__dirname, "..", "data", "templates"));
  const afterAssets = snapshotDir(path.resolve(__dirname, "..", "data", "assets"));
  const afterCollections = snapshotDir(path.resolve(__dirname, "..", "data", "collections"));

  const templatesDiff = diffSnapshots(beforeTemplates, afterTemplates);
  const assetsDiff = diffSnapshots(beforeAssets, afterAssets);
  const collectionsDiff = diffSnapshots(beforeCollections, afterCollections);

  assert.ok(!templatesDiff.changed, `data/templates não deve mudar: ${JSON.stringify(templatesDiff)}`);
  assert.ok(!assetsDiff.changed, `data/assets não deve mudar: ${JSON.stringify(assetsDiff)}`);
  assert.ok(!collectionsDiff.changed, `data/collections não deve mudar: ${JSON.stringify(collectionsDiff)}`);

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log("Runtime persistence OK: dados sobrevivem a restart e ROOT/data permanece intacto.");
})();
