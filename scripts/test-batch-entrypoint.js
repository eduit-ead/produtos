/**
 * Smoke test para a tela de produção em lote.
 *
 * Confirma que /batch.html inicia na etapa "base" e que a coleção legada
 * graduacao-cruzeiro contém 128 itens.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
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
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "src", "template-editor", "server.js")],
      {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

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
    }, 20000);
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
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-entrypoint-"));
  const server = await startServer(runtimeDir);
  try {
    const batchHtml = await request(server.port, "GET", "/batch.html");
    assert.equal(batchHtml.status, 200, "/batch.html deve ser acessível com auth desativado");
    assert.ok(batchHtml.body.includes('data-step="base"'), "wizard deve ter etapa base");
    assert.ok(batchHtml.body.includes('id="step-base"'), "deve existir painel da etapa base");

    const items = await request(server.port, "GET", "/api/items?collection=graduacao-cruzeiro");
    assert.equal(items.status, 200, "/api/items deve listar cursos");
    const list = JSON.parse(items.body);
    assert.ok(Array.isArray(list), "resposta deve ser array");
    assert.strictEqual(list.length, 128, "graduacao-cruzeiro deve ter 128 itens");
  } finally {
    await stopServer(server.child);
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log("Batch entrypoint OK: step-base ativo, 128 cursos da graduacao-cruzeiro disponíveis.");
})();
