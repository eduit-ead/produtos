/**
 * Testes de geração de fundo com IA na tela "Criar imagem".
 *
 * - montagem do prompt protege basePrompt e remove campos vazios
 * - dry-run funciona sem OPENAI_API_KEY
 * - fundo salvo via StorageProvider e usado no preview oficial
 * - nenhuma credencial aparece em respostas, logs ou metadata
 * - versões anteriores não são sobrescritas
 * - coleção genérica continua funcionando
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

delete process.env.OPENAI_API_KEY;

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ai-runtime-"));
process.env.APP_RUNTIME_DIR = runtimeDir;
process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
process.env.AUTH_DISABLED = "true";
process.env.STORAGE_PROVIDER = "local";

const { seedRuntimeDefaults } = require("../src/config/seed");
const { assemblePrompt, generateStudioBackground, estimateImageCost } = require("../src/template-editor/ai-background");
const { createStorageProvider } = require("../src/storage");

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

function containsSecrets(text) {
  const checks = [
    process.env.OPENAI_API_KEY,
    process.env.S3_SECRET_ACCESS_KEY,
    process.env.APP_SESSION_SECRET,
    "Authorization",
    "sk-",
  ].filter(Boolean);
  return checks.some((secret) => text && text.includes(secret));
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
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestBuffer(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      APP_RUNTIME_DIR: runtimeDir,
      AI_CATALOG_DIR: path.join(runtimeDir, "output", "ai-catalog"),
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_DISABLED: "true",
      OPENAI_API_KEY: "",
    };

    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "src", "template-editor", "server.js")], {
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

(async () => {
  seedRuntimeDefaults();
  process.env.OPENAI_API_KEY = "";

  const inputSrc = path.resolve(__dirname, "..", "input", "cursos.xlsx");
  const inputDest = path.join(runtimeDir, "input", "cursos.xlsx");
  if (fs.existsSync(inputSrc)) {
    fs.mkdirSync(path.dirname(inputDest), { recursive: true });
    fs.copyFileSync(inputSrc, inputDest);
  }

  const beforeRootTemplates = snapshotDir(path.resolve(__dirname, "..", "data", "templates"));
  const beforeRootCollections = snapshotDir(path.resolve(__dirname, "..", "data", "collections"));
  const beforeRootOutput = snapshotDir(path.resolve(__dirname, "..", "output"));

  // 1. assemblePrompt protege basePrompt, remove vazio e deduplica
  {
    const cfg = {
      basePrompt: "Base protegida",
      negativePrompt: "Evitar texto",
    };
    const fields = {
      description: "Cena principal",
      environment: "",
      activity: "Ação X",
      people: "pessoa",
      composition: "pessoa",
      details: "",
      avoid: "logotipos",
    };
    const { prompt, negativePrompt } = assemblePrompt(cfg, fields);
    assert.ok(prompt.includes("Base protegida"), "prompt deve incluir basePrompt");
    assert.ok(prompt.includes("Cena principal"), "prompt deve incluir descrição");
    assert.ok(prompt.includes("Ação X"), "prompt deve incluir campos preenchidos");
    assert.ok(!prompt.includes("\n\n\n"), "prompt não deve ter blocos vazios");
    assert.ok(!prompt.includes("pessoa\n\npessoa"), "prompt deve deduplicar");
    assert.ok(negativePrompt.includes("Evitar texto"), "negativePrompt deve incluir do template");
    assert.ok(negativePrompt.includes("logotipos"), "negativePrompt deve incluir campos adicionais");
  }

  // 2. dry-run sem OPENAI_API_KEY gera fundo utilizável via StorageProvider
  {
    const values = {
      titulo: "Administração",
      modalidade: "EAD",
      formacao: "Bacharelado",
      duracao: "8 semestres",
    };
    const visual = {
      description: "Estudante analisando relatórios em escritório moderno",
      environment: "escritório contemporâneo",
      activity: "analisando gráficos",
    };
    const meta = await generateStudioBackground({
      templateId: "cruzeiro-graduacao-v1",
      values,
      visual,
      dryRun: true,
    });

    assert.ok(meta.runId, "runId deve existir");
    assert.ok(meta.prompt.includes("Fotografia publicitária realista"), "prompt deve conter basePrompt protegido");
    assert.ok(meta.storage && meta.storage.key, "metadata deve conter storage key");
    assert.strictEqual(meta.storage.provider, "local", "provider deve ser local");
    assert.ok(meta.urls && meta.urls.fundo, "metadata deve conter URL do fundo");
    assert.ok(meta.cost && meta.cost.dryRun, "custo dry-run deve estar marcado");
    assert.ok(!containsSecrets(JSON.stringify(meta)), "metadata não deve conter segredos");

    const storage = createStorageProvider({ baseDir: path.join(runtimeDir, "output", "ai-catalog") });
    const buffer = await storage.read(meta.storage.key);
    assert.ok(buffer.length > 0, "fundo salvo deve ter conteúdo");

    const metadataPath = path.join(runtimeDir, "output", "ai-catalog", "studio", meta.runId, "metadata.json");
    assert.ok(fs.existsSync(metadataPath), "metadata.json deve existir");
  }

  // 3. servidor: health, template descriptor e geração dry-run end-to-end
  const server = await startServer();
  try {
    const health = await requestJson(server.port, "GET", "/api/health");
    assert.equal(health.status, 200, "health retorna 200");
    assert.strictEqual(health.body.openaiConfigured, false, "OpenAI não configurada");
    assert.strictEqual(health.body.storageProvider, "local", "storage local");
    assert.ok(!containsSecrets(health.raw), "health não expõe segredos");

    const template = await requestJson(server.port, "GET", "/api/templates/cruzeiro-graduacao-v1");
    assert.equal(template.status, 200, "template oficial retorna 200");
    assert.strictEqual(template.body.imageGeneration?.enabled, true, "imageGeneration habilitado");
    assert.ok(template.body.imageGeneration?.basePrompt, "template possui basePrompt");
    assert.strictEqual(template.body.variables.find((v) => v.key === "titulo")?.defaultValue, "Administração", "título padrão atualizado");
    assert.strictEqual(template.body.variables.find((v) => v.key === "modalidade")?.defaultValue, "EAD", "modalidade padrão atualizada");
    assert.strictEqual(template.body.variables.find((v) => v.key === "formacao")?.defaultValue, "Bacharelado", "formação padrão atualizada");
    assert.strictEqual(template.body.variables.find((v) => v.key === "duracao")?.defaultValue, "8 semestres", "duração padrão atualizada");

    const collection = await requestJson(server.port, "GET", "/api/collections/graduacao-cruzeiro");
    assert.equal(collection.status, 200);
    assert.ok(collection.body.imageGenerationBindings?.descriptionField, "coleção possui bindings de geração");

    const records = await requestJson(server.port, "GET", "/api/collections/graduacao-cruzeiro/records");
    assert.equal(records.status, 200);
    assert.ok(Array.isArray(records.body) && records.body.length > 0, "há registros");
    const sample = records.body[0];
    assert.ok(sample.fields?.curso, "registro possui curso");

    const visualFields = {
      description: String(sample.prompt || sample.fields?.prompt_imagem || ""),
      environment: String(sample.fields?.visual_ambiente || ""),
      activity: String(sample.fields?.visual_atividade || ""),
      people: String(sample.fields?.visual_personagem || ""),
      composition: String(sample.fields?.visual_composicao || ""),
      avoid: String(sample.fields?.visual_evitar || ""),
      details: "",
    };
    const values = {
      titulo: String(sample.fields.curso),
      modalidade: String(sample.fields.modalidade || "EAD"),
      formacao: String(sample.fields.formacao || "Bacharelado"),
      duracao: String(sample.fields.duracao || "8 semestres"),
      imagemFundo: "generated",
    };

    const generateRes = await requestJson(
      server.port,
      "POST",
      "/api/studio/generate-background",
      JSON.stringify({
        templateId: "cruzeiro-graduacao-v1",
        values,
        visual: visualFields,
        collectionId: "graduacao-cruzeiro",
        itemId: String(sample.course_id || sample.slug),
        dryRun: true,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(generateRes.status, 200, `geração dry-run falhou: ${generateRes.raw}`);
    assert.ok(!containsSecrets(generateRes.raw), "resposta de geração não expõe segredos");
    const meta1 = generateRes.body.metadata;
    assert.ok(meta1 && meta1.runId, "metadata retornada");
    assert.ok(meta1.cost && meta1.cost.dryRun, "custo marcado dry-run");

    // carregar fundo gerado e renderizar card oficial
    const bgRes = await requestBuffer(server.port, "GET", meta1.urls.fundo);
    assert.equal(bgRes.status, 200, "fundo gerado acessível");
    const bgBase64 = arrayBufferToBase64(bgRes.buffer);
    values.imagemFundo = meta1.storage.key;

    const renderRes = await requestBuffer(
      server.port,
      "POST",
      "/api/render/cruzeiro-graduacao-v1",
      JSON.stringify({
        values,
        runtimeAssets: { [meta1.storage.key]: bgBase64 },
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(renderRes.status, 200, "renderização do card falhou");
    assert.ok(renderRes.buffer.length > 1000, "PNG gerado tem tamanho razoável");

    const waRes = await requestBuffer(
      server.port,
      "POST",
      "/api/render-whatsapp/cruzeiro-graduacao-v1",
      JSON.stringify({
        values,
        runtimeAssets: { [meta1.storage.key]: bgBase64 },
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(waRes.status, 200, "renderização WhatsApp falhou");
    assert.ok(waRes.buffer.length > 1000, "JPG WhatsApp gerado tem tamanho razoável");

    // 4. versões anteriores não são sobrescritas
    const generateRes2 = await requestJson(
      server.port,
      "POST",
      "/api/studio/generate-background",
      JSON.stringify({
        templateId: "cruzeiro-graduacao-v1",
        values,
        visual: visualFields,
        dryRun: true,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(generateRes2.status, 200);
    const meta2 = generateRes2.body.metadata;
    assert.notStrictEqual(meta1.runId, meta2.runId, "nova geração deve ter runId diferente");

    const studioDir = path.join(runtimeDir, "output", "ai-catalog", "studio");
    const dirs = fs.readdirSync(studioDir).filter((d) => fs.statSync(path.join(studioDir, d)).isDirectory());
    assert.ok(dirs.includes(meta1.runId), "diretório da primeira versão preservado");
    assert.ok(dirs.includes(meta2.runId), "diretório da segunda versão criado");

    // 5. coleção genérica funciona: cria template editável com imageGeneration e gera dry-run
    const genericTemplate = await requestJson(
      server.port,
      "POST",
      "/api/templates",
      JSON.stringify({ width: 200, height: 200 }),
      { "Content-Type": "application/json" }
    );
    assert.equal(genericTemplate.status, 200);
    const genericId = genericTemplate.body.template.id;

    const genericBody = {
      ...genericTemplate.body.template,
      name: "Genérico IA",
      imageGeneration: {
        enabled: true,
        basePrompt: "Base genérica",
        negativePrompt: "evitar texto",
        defaultModel: "gpt-image-2.5-flare",
        defaultQuality: "medium",
        defaultSize: "1024x1024",
      },
      variables: [
        { key: "titulo", label: "Título", type: "string", defaultValue: "Item", required: true },
        { key: "prompt_imagem", label: "Prompt", type: "string", defaultValue: "Cena", required: false },
      ],
      layers: [
        { id: "bg", type: "background", name: "Fundo", x: 0, y: 0, width: 200, height: 200, rotation: 0, opacity: 1, visible: true, zIndex: 0, locked: false, properties: { color: "#ffffff" } },
        { id: "txt", type: "text", name: "Texto", x: 10, y: 10, width: 180, height: 40, rotation: 0, opacity: 1, visible: true, zIndex: 1, locked: false, properties: { text: "{{titulo}}", fontFamily: "Arial", fontSize: 16, fontWeight: 400, fill: "#000000", align: "left", verticalAlign: "top", lineHeight: 1.2, letterSpacing: 0, autoFit: true, minFontSize: 8, padding: 0, maxLines: 2, overflow: "shrink" } },
      ],
    };
    const saveGeneric = await requestJson(
      server.port,
      "POST",
      `/api/templates/${genericId}`,
      JSON.stringify(genericBody),
      { "Content-Type": "application/json" }
    );
    assert.equal(saveGeneric.status, 200, `salvar template genérico falhou: ${saveGeneric.raw}`);

    const genericGenerate = await requestJson(
      server.port,
      "POST",
      "/api/studio/generate-background",
      JSON.stringify({
        templateId: genericId,
        values: { titulo: "Genérico", prompt_imagem: "Cena genérica colorida" },
        visual: { description: "Cena genérica colorida" },
        dryRun: true,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(genericGenerate.status, 200, `geração genérica falhou: ${genericGenerate.raw}`);
    assert.ok(genericGenerate.body.metadata.prompt.includes("Base genérica"), "template genérico usa basePrompt");
  } finally {
    await stopServer(server.child);
  }

  // 6. nenhum arquivo real alterado
  assert.deepStrictEqual(
    snapshotDir(path.resolve(__dirname, "..", "data", "templates")),
    beforeRootTemplates,
    "templates originais não alterados"
  );
  assert.deepStrictEqual(
    snapshotDir(path.resolve(__dirname, "..", "data", "collections")),
    beforeRootCollections,
    "coleções originais não alteradas"
  );
  assert.deepStrictEqual(
    snapshotDir(path.resolve(__dirname, "..", "output")),
    beforeRootOutput,
    "output original não alterado"
  );

  console.log("Studio AI background OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
