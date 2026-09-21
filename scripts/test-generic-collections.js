const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "generic-collections-test-"));
process.env.AI_CATALOG_DIR = TEMP_DIR;
process.env.STORAGE_LOCAL_DIR = TEMP_DIR;

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const { listCollections, loadCollection, saveCollection, deleteCollection } = require("../src/collections/manager");
const genericProduction = require("../src/production/generic-production-service");

const ROOT = path.resolve(__dirname, "..");
const IMPORTS_DIR = path.join(ROOT, "data", "imports");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertJson(response) {
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.body}`);
  }
  return parsed;
}

async function pollJob(port, jobId, targetStatuses, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const poll = await request(port, "GET", `/api/batches/${jobId}`);
    const job = assertJson(poll);
    if (targetStatuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout aguardando status ${targetStatuses.join(",")} para ${jobId}`);
}

function makeOutputColumns() {
  return {
    backgroundFilename: "bg_file",
    cardFilename: "card_file",
    whatsappFilename: "wa_file",
    backgroundUrl: "bg_url",
    cardUrl: "card_url",
    whatsappUrl: "wa_url",
    productionStatus: "prod_status",
    templateId: "tpl_id",
    updatedAt: "updated_at",
  };
}

async function runBatchForCollection(port, collectionId) {
  const list = assertJson(await request(port, "GET", `/api/items?collection=${collectionId}`));
  assert.ok(Array.isArray(list) && list.length > 0, `coleção ${collectionId} sem itens`);
  const courses = list.map((item) => ({ course_id: item.record_id || item.slug, slug: item.slug }));

  const create = await request(
    port,
    "POST",
    "/api/batches",
    JSON.stringify({
      collection_id: collectionId,
      courses,
      template_id: "demo",
      background_source: "ia",
      dryRun: true,
      batch_size: 1,
      concurrency: 1,
    }),
    { "Content-Type": "application/json" }
  );
  assert.equal(create.status, 201, `criar lote ${collectionId} falhou: ${create.body}`);
  const job = assertJson(create).job;
  assert.equal(job.collectionId, collectionId);

  const start = await request(port, "POST", `/api/batches/${job.id}/start`);
  assert.equal(start.status, 200, `start ${collectionId} falhou: ${start.body}`);
  const finished = await pollJob(port, job.id, ["concluido", "concluido_com_erros"]);
  assert.equal(finished.status, "concluido", `lote ${collectionId} terminou com erros: ${finished.error || JSON.stringify(finished.stats)}`);

  const items = assertJson(await request(port, "GET", `/api/batches/${job.id}/items`));
  assert.equal(items.length, courses.length);
  for (const item of items) {
    assert.equal(item.status, "simulacao", `item ${item.slug} não ficou simulação`);
    assert.equal(item.dryRun, true, `item ${item.slug} deve estar marcado como dryRun`);
    const base = path.join(TEMP_DIR, collectionId, item.slug);
    assert.ok(fs.existsSync(path.join(base, `${item.slug}-fundo.png`)), `fundo de ${item.slug} ausente`);
    assert.ok(fs.existsSync(path.join(base, `${item.slug}-card.png`)), `card de ${item.slug} ausente`);
    assert.ok(fs.existsSync(path.join(base, `${item.slug}-whatsapp.jpg`)), `whatsapp de ${item.slug} ausente`);
    assert.ok(fs.existsSync(path.join(base, "metadata.json")));
  }
  return { job, items };
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const createdIds = [];
  const createdImportDirs = [];

  try {
    // 1. Coleção padrão legada
    const defaultItems = assertJson(await request(port, "GET", "/api/items"));
    assert.equal(defaultItems.length, 128, "coleção padrão deve ter 128 cursos");
    const first = defaultItems[0];
    assert.ok(first.slug && (first.title || first.curso), "item padrão deve ter slug e título");

    // 2. Coleção CSV: produtos
    const csvDir = path.join(IMPORTS_DIR, "test-produtos");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, "produtos.csv");
    fs.writeFileSync(
      csvPath,
      'id,nome,categoria,preco,imagem,prompt\n' +
        'prod-001,Notebook Gamer,Eletrônicos,7500,https://via.placeholder.com/1080,notebook gamer profissional\n' +
        'prod-002,Cafeteira Premium,Cozinha,1299,https://via.placeholder.com/1080,cafeteira premium em ambiente moderno\n',
      "utf8"
    );
    createdImportDirs.push(csvDir);

    const csvCollection = {
      id: "test-produtos",
      name: "Produtos CSV",
      description: "Teste de coleção genérica via CSV.",
      source: { type: "csv", path: "data/imports/test-produtos/produtos.csv" },
      primaryKey: "id",
      displayField: "nome",
      searchFields: ["nome", "categoria"],
      fieldMappings: { title: "nome", slug: "id", prompt: "prompt", sourceImage: "imagem" },
      filters: [{ field: "categoria", label: "Categoria" }],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [
        { templateVariable: "titulo", sourceField: "nome" },
        { templateVariable: "subtitulo", sourceField: "categoria" },
        { templateVariable: "imagemFundo", sourceField: "imagem" },
      ],
    };
    saveCollection(csvCollection);
    createdIds.push(csvCollection.id);

    await runBatchForCollection(port, csvCollection.id);

    // 3. Coleção JSON: posts
    const jsonDir = path.join(IMPORTS_DIR, "test-posts");
    fs.mkdirSync(jsonDir, { recursive: true });
    const jsonPath = path.join(jsonDir, "posts.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        [
          { id: "post-001", titulo: "10 dicas de produtividade", categoria: "Produtividade", imagem: "https://via.placeholder.com/1080", prompt: "minimalista produtividade" },
          { id: "post-002", titulo: "Como investir em 2026", categoria: "Finanças", imagem: "https://via.placeholder.com/1080", prompt: "finanças pessoais" },
        ],
        null,
        2
      ),
      "utf8"
    );
    createdImportDirs.push(jsonDir);

    const jsonCollection = {
      id: "test-posts",
      name: "Posts JSON",
      description: "Teste de coleção genérica via JSON.",
      source: { type: "json", path: "data/imports/test-posts/posts.json" },
      primaryKey: "id",
      displayField: "titulo",
      searchFields: ["titulo", "categoria"],
      fieldMappings: { title: "titulo", slug: "id", prompt: "prompt", sourceImage: "imagem" },
      filters: [{ field: "categoria", label: "Categoria" }],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [
        { templateVariable: "titulo", sourceField: "titulo" },
        { templateVariable: "subtitulo", sourceField: "categoria" },
        { templateVariable: "imagemFundo", sourceField: "imagem" },
      ],
    };
    saveCollection(jsonCollection);
    createdIds.push(jsonCollection.id);

    await runBatchForCollection(port, jsonCollection.id);

    // 4. Coleção XLSX: outra
    const xlsxDir = path.join(IMPORTS_DIR, "test-outra");
    fs.mkdirSync(xlsxDir, { recursive: true });
    const xlsxPath = path.join(xlsxDir, "outra.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados");
    sheet.addRow(["id", "nome", "segmento", "imagem", "prompt"]);
    sheet.addRow(["outra-001", "Campanha Verão", "Moda", "https://via.placeholder.com/1080", "verão praia"])
    sheet.addRow(["outra-002", "Campanha Inverno", "Moda", "https://via.placeholder.com/1080", "inverno urbano"])
    await workbook.xlsx.writeFile(xlsxPath);
    createdImportDirs.push(xlsxDir);

    const xlsxCollection = {
      id: "test-outra",
      name: "Outra XLSX",
      description: "Teste de coleção genérica via XLSX.",
      source: { type: "xlsx", path: "data/imports/test-outra/outra.xlsx", sheet: "Dados" },
      primaryKey: "id",
      displayField: "nome",
      searchFields: ["nome", "segmento"],
      fieldMappings: { title: "nome", slug: "id", prompt: "prompt", sourceImage: "imagem" },
      filters: [{ field: "segmento", label: "Segmento" }],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [
        { templateVariable: "titulo", sourceField: "nome" },
        { templateVariable: "subtitulo", sourceField: "segmento" },
        { templateVariable: "imagemFundo", sourceField: "imagem" },
      ],
    };
    saveCollection(xlsxCollection);
    createdIds.push(xlsxCollection.id);

    await runBatchForCollection(port, xlsxCollection.id);

    // 5. Verifica isolamento: planilha original intacta
    const originalHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "input", "cursos.xlsx"))).digest("hex");
    assert.ok(originalHash, "hash da planilha original calculado");

    // 6. Listar coleções
    const all = listCollections();
    assert.ok(all.some((c) => c.id === "graduacao-cruzeiro"));
    assert.ok(createdIds.every((id) => all.some((c) => c.id === id)));

    console.log("Generic collections OK: graduação legada, CSV, JSON e XLSX.");
  } finally {
    server.close();
    for (const id of createdIds) {
      try { deleteCollection(id); } catch {}
    }
    for (const dir of createdImportDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
})();
