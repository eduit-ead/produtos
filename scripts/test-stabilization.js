const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const sharp = require("sharp");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stabilization-test-"));
process.env.APP_RUNTIME_DIR = TEMP_DIR;
process.env.AI_CATALOG_DIR = TEMP_DIR;
process.env.STORAGE_LOCAL_DIR = TEMP_DIR;

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();
const { saveCollection, deleteCollection, listCollections } = require("../src/collections/manager");
const genericProduction = require("../src/production/generic-production-service");
const { renderTemplate } = require("../src/template-editor/renderer");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "data", "assets");
const IMPORTS_DIR = path.join(TEMP_DIR, "data", "imports");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

function buildMultipart(fields, file) {
  const boundary = `----FormBoundary${crypto.randomBytes(8).toString("hex")}`;
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
  return { body: Buffer.concat(chunks.map((c) => Buffer.from(c))), boundary };
}

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
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

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const createdCollections = [];
  const createdImportDirs = [];

  try {
    const originalAssets = new Set(fs.readdirSync(ASSETS_DIR));

    // 1. Upload multipart XLSX, CSV e JSON
    const testCsv = Buffer.from("SKU,nome,categoria\nSKU-001,Produto A,Categoria A", "utf8");
    const multipartCsv = buildMultipart({}, { filename: "test.csv", contentType: "text/csv", buffer: testCsv });
    const csvUpload = await request(port, "POST", "/api/collections/test-upload/import", multipartCsv.body, {
      "Content-Type": `multipart/form-data; boundary=${multipartCsv.boundary}`,
      "Content-Length": multipartCsv.body.length,
    });
    assert.equal(csvUpload.status, 200, `upload CSV falhou: ${csvUpload.body}`);
    const csvUploadJson = assertJson(csvUpload);
    assert.ok(csvUploadJson.path.endsWith("test-upload.csv"), "caminho do CSV retornado");

    const testJson = Buffer.from(JSON.stringify([{ id: 1, nome: "A" }]), "utf8");
    const multipartJson = buildMultipart({}, { filename: "test.json", contentType: "application/json", buffer: testJson });
    const jsonUpload = await request(port, "POST", "/api/collections/test-upload-json/import", multipartJson.body, {
      "Content-Type": `multipart/form-data; boundary=${multipartJson.boundary}`,
      "Content-Length": multipartJson.body.length,
    });
    assert.equal(jsonUpload.status, 200, `upload JSON falhou: ${jsonUpload.body}`);

    const xlsxDir = path.join(IMPORTS_DIR, "test-upload-xlsx");
    fs.mkdirSync(xlsxDir, { recursive: true });
    const xlsxPath = path.join(xlsxDir, "test.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados");
    sheet.addRow(["id", "nome"]);
    sheet.addRow(["1", "A"]);
    await workbook.xlsx.writeFile(xlsxPath);
    const xlsxBuffer = fs.readFileSync(xlsxPath);
    const multipartXlsx = buildMultipart({}, { filename: "test.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsxBuffer });
    const xlsxUpload = await request(port, "POST", "/api/collections/test-upload-xlsx/import", multipartXlsx.body, {
      "Content-Type": `multipart/form-data; boundary=${multipartXlsx.boundary}`,
      "Content-Length": multipartXlsx.body.length,
    });
    assert.equal(xlsxUpload.status, 200, `upload XLSX falhou: ${xlsxUpload.body}`);
    createdImportDirs.push(xlsxDir);
    createdImportDirs.push(path.join(IMPORTS_DIR, "test-upload"));
    createdImportDirs.push(path.join(IMPORTS_DIR, "test-upload-json"));

    // 2. Prévia sem coluna id e escolha posterior da primaryKey
    const csvSemicolonDir = path.join(IMPORTS_DIR, "test-semicolon");
    fs.mkdirSync(csvSemicolonDir, { recursive: true });
    const csvSemicolonPath = path.join(csvSemicolonDir, "produtos.csv");
    const bgA = path.join(csvSemicolonDir, "bg-a.png");
    const bgB = path.join(csvSemicolonDir, "bg-b.png");
    fs.writeFileSync(bgA, await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#4488cc" } }).png().toBuffer());
    fs.writeFileSync(bgB, await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#cc8844" } }).png().toBuffer());
    const bom = "\ufeff";
    fs.writeFileSync(
      csvSemicolonPath,
      `${bom}SKU;Nome;Categoria;Descrição;image_url\n` +
        `ABC-123;"Produto ""Premium""";Eletrônicos;"Produto de alta\nqualidade";${bgA}\n` +
        `DEF-456;Cafeteira;Cozinha;"Cafeteira  premium";${bgB}\n`,
      "utf8"
    );
    createdImportDirs.push(csvSemicolonDir);

    const preview = assertJson(
      await request(
        port,
        "POST",
        "/api/collections/test-semicolon/preview",
        JSON.stringify({ source: { type: "csv", path: "data/imports/test-semicolon/produtos.csv" } }),
        { "Content-Type": "application/json" }
      )
    );
    assert.deepEqual(preview.headers, ["SKU", "Nome", "Categoria", "Descrição", "image_url"]);
    assert.equal(preview.total, 2, "total de registros CSV");
    assert.equal(preview.rows[0]["Nome"], 'Produto "Premium"', "preserva aspas");

    const keyValidation = assertJson(
      await request(
        port,
        "POST",
        "/api/collections/test-semicolon/validate-key",
        JSON.stringify({
          source: { type: "csv", path: "data/imports/test-semicolon/produtos.csv" },
          primaryKey: "SKU",
        }),
        { "Content-Type": "application/json" }
      )
    );
    assert.equal(keyValidation.total, 2);
    assert.equal(keyValidation.emptyIds, 0);
    assert.equal(keyValidation.duplicateIds.length, 0);

    // 3. Fundo de produção aplicado ao template
    const template = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "templates", "demo.json"), "utf8"));
    const blueBg = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#0000ff" } }).png().toBuffer();
    const redBg = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const card1 = await renderTemplate(template, { titulo: "A", subtitulo: "B", imagemFundo: "__bg__" }, { runtimeAssets: { __bg__: blueBg } });
    const card2 = await renderTemplate(template, { titulo: "A", subtitulo: "B", imagemFundo: "__bg__" }, { runtimeAssets: { __bg__: redBg } });
    assert.notEqual(crypto.createHash("sha256").update(card1).digest("hex"), crypto.createHash("sha256").update(card2).digest("hex"), "cards devem diferir quando o fundo muda");

    // 4. Criar coleção CSV, produzir, aprovar/rejeitar e persistir
    const csvCollection = {
      id: "test-stabilizacao",
      name: "Teste Estabilização",
      description: "Base para validação de aprovação e exportação.",
      source: { type: "csv", path: "data/imports/test-semicolon/produtos.csv" },
      primaryKey: "SKU",
      displayField: "Nome",
      searchFields: ["Nome", "Categoria"],
      fieldMappings: { title: "Nome", slug: "SKU", prompt: "Descrição", sourceImage: "image_url" },
      filters: [{ field: "Categoria", label: "Categoria" }],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [
        { templateVariable: "titulo", sourceField: "Nome" },
        { templateVariable: "subtitulo", sourceField: "Categoria" },
      ],
    };
    saveCollection(csvCollection);
    createdCollections.push(csvCollection.id);

    const items = assertJson(await request(port, "GET", `/api/items?collection=${csvCollection.id}`));
    assert.equal(items.length, 2);
    const courses = items.map((i) => ({ course_id: i.record_id || i.slug, slug: i.slug }));

    const create = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({ collection_id: csvCollection.id, courses, template_id: "demo", background_source: "original", dryRun: false, batch_size: 1 }),
      { "Content-Type": "application/json" }
    );
    assert.equal(create.status, 201, `criar lote falhou: ${create.body}`);
    const job = assertJson(create).job;

    await request(port, "POST", `/api/batches/${job.id}/start`);
    const finished = await pollJob(port, job.id, ["concluido"]);
    assert.equal(finished.stats.ready, 2, "ambos itens aguardando revisão");
    assert.equal(finished.stats.completed, 2, "ambos itens concluídos");

    const first = finished.courses[0];
    const second = finished.courses[1];

    const approve = await request(port, "POST", `/api/batches/${job.id}/items/${first.slug}/approve`);
    assert.equal(approve.status, 200, `aprovação falhou: ${approve.body}`);
    const afterApprove = assertJson(approve);
    assert.equal(afterApprove.job.stats.approved, 1, "job reflete aprovação");
    assert.equal(afterApprove.manifest.status, "aprovado", "manifesto reflete aprovação");

    const reject = await request(port, "POST", `/api/batches/${job.id}/items/${second.slug}/reject`);
    assert.equal(reject.status, 200, `rejeição falhou: ${reject.body}`);
    const afterReject = assertJson(reject);
    assert.equal(afterReject.job.stats.rejected, 1, "job reflete rejeição");

    // Simula recarregamento lendo arquivos diretamente
    const catalogDir = path.join(TEMP_DIR, csvCollection.id);
    const reloadedJob = JSON.parse(fs.readFileSync(path.join(catalogDir, "jobs", `${job.id}.json`), "utf8"));
    assert.equal(reloadedJob.courses.find((c) => c.slug === first.slug).status, "aprovado", "persistência da aprovação");
    assert.equal(reloadedJob.courses.find((c) => c.slug === second.slug).status, "rejeitado", "persistência da rejeição");

    const manifest = JSON.parse(fs.readFileSync(path.join(catalogDir, "manifest.json"), "utf8"));
    assert.equal(manifest.courses[first.slug].status, "aprovado", "manifesto persistiu aprovado");

    // metadata.json deve refletir aprovação e rejeição
    const metaApproved = JSON.parse(fs.readFileSync(path.join(catalogDir, first.slug, "metadata.json"), "utf8"));
    assert.equal(metaApproved.status, "aprovado", "metadata aprovado");
    assert.ok(metaApproved.timestamps.approved_at, "timestamp approved_at preenchido");
    assert.equal(metaApproved.timestamps.rejected_at, null, "rejected_at limpo");

    const metaRejected = JSON.parse(fs.readFileSync(path.join(catalogDir, second.slug, "metadata.json"), "utf8"));
    assert.equal(metaRejected.status, "rejeitado", "metadata rejeitado");
    assert.ok(metaRejected.timestamps.rejected_at, "timestamp rejected_at preenchido");
    assert.equal(metaRejected.timestamps.approved_at, null, "approved_at limpo");

    // Fórmula de conclusão: completed inclui aprovado e rejeitado, sem contar duas vezes
    assert.equal(afterReject.job.stats.completed, 2, "completed = aprovado + rejeitado");
    assert.equal(afterReject.job.stats.approved, 1, "approved separado");
    assert.equal(afterReject.job.stats.rejected, 1, "rejected separado");
    assert.equal(afterReject.job.stats.total, 2, "total");
    assert.equal(afterReject.job.stats.completed + afterReject.job.stats.errors, 2, "terminalCount === total");

    // Arquivos inexistentes reportados como indisponíveis
    const jobBeforeStart = assertJson(
      await request(port, "GET", `/api/batches/${job.id}`)
    );
    // itens já processados possuem arquivos; testamos a API retornando flags
    const processedItem = jobBeforeStart.courses.find((c) => c.slug === first.slug);
    assert.equal(processedItem.hasCard, true, "flag hasCard true quando card existe");
    assert.equal(processedItem.hasBackground, true, "flag hasBackground true quando fundo existe");
    assert.equal(processedItem.hasWhatsApp, true, "flag hasWhatsApp true quando whatsapp existe");

    // Aprovação sem card deve falhar
    const noCardCollection = {
      id: "test-no-card",
      name: "Sem card",
      description: ".",
      source: { type: "csv", path: "data/imports/test-semicolon/produtos.csv" },
      primaryKey: "SKU",
      displayField: "Nome",
      searchFields: ["Nome"],
      fieldMappings: { title: "Nome", slug: "SKU" },
      filters: [],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [{ templateVariable: "titulo", sourceField: "Nome" }],
    };
    saveCollection(noCardCollection);
    createdCollections.push(noCardCollection.id);
    const createNoCard = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({
        collection_id: noCardCollection.id,
        courses: [{ course_id: first.course_id, slug: first.slug }],
        template_id: "demo",
        background_source: "ia",
        dryRun: true,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(createNoCard.status, 201, `criar lote no-card falhou: ${createNoCard.body}`);
    const noCardJob = assertJson(createNoCard).job;
    const approveNoCard = await request(port, "POST", `/api/batches/${noCardJob.id}/items/${first.slug}/approve`);
    assert.equal(approveNoCard.status, 409, "aprovação de simulação/sem card deve retornar 409");

    // Reprocessamento de item rejeitado
    const regenerate = await request(port, "POST", `/api/batches/${job.id}/items/${second.slug}/regenerate`);
    assert.equal(regenerate.status, 200, `reprocessamento falhou: ${regenerate.body}`);
    const regeneratedJob = await pollJob(port, job.id, ["concluido"]);
    const regeneratedItem = regeneratedJob.courses.find((c) => c.slug === second.slug);
    assert.equal(regeneratedItem.status, "pronto_revisao", "reprocessado volta ao estado de revisão");
    assert.equal(regeneratedJob.stats.rejected, 0, "reprocessamento remove rejeitado das estatísticas");
    assert.equal(regeneratedJob.stats.completed, 2, "reprocessamento mantém completed");

    // Exportação CSV contém prod_status=aprovado para o item aprovado
    const exportResult = assertJson(
      await request(
        port,
        "POST",
        `/api/collections/${csvCollection.id}/export`,
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      )
    );
    assert.ok(fs.existsSync(exportResult.outputPath), "arquivo de exportação gerado");
    const exportedContent = fs.readFileSync(exportResult.outputPath, "utf8");
    assert.ok(exportedContent.includes("prod_status"), "exportação inclui coluna prod_status");
    assert.ok(exportedContent.includes("aprovado"), "exportação contém status aprovado");

    // sync-preview XLSX reconhece item aprovado
    const stabXlsxDir = path.join(IMPORTS_DIR, "test-stab-xlsx");
    fs.mkdirSync(stabXlsxDir, { recursive: true });
    const stabXlsxPath = path.join(stabXlsxDir, "stab.xlsx");
    const stabBg = path.join(stabXlsxDir, "bg-x.png");
    fs.writeFileSync(stabBg, await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#66aa88" } }).png().toBuffer());
    const stabWorkbook = new ExcelJS.Workbook();
    const stabSheet = stabWorkbook.addWorksheet("Dados");
    stabSheet.addRow(["id", "nome", "image_url"]);
    stabSheet.addRow(["x-001", "Item X", stabBg]);
    await stabWorkbook.xlsx.writeFile(stabXlsxPath);
    createdImportDirs.push(stabXlsxDir);

    const xlsxCollection = {
      id: "test-stab-xlsx",
      name: "Stab XLSX",
      description: ".",
      source: { type: "xlsx", path: "data/imports/test-stab-xlsx/stab.xlsx", sheet: "Dados" },
      primaryKey: "id",
      displayField: "nome",
      searchFields: ["nome"],
      fieldMappings: { title: "nome", slug: "id", sourceImage: "image_url" },
      filters: [],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: makeOutputColumns(),
      templateBindings: [{ templateVariable: "titulo", sourceField: "nome" }],
    };
    saveCollection(xlsxCollection);
    createdCollections.push(xlsxCollection.id);

    const xItems = assertJson(await request(port, "GET", `/api/items?collection=${xlsxCollection.id}`));

    const xCreate = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({
        collection_id: xlsxCollection.id,
        courses: xItems.map((i) => ({ course_id: i.record_id || i.slug, slug: i.slug })),
        template_id: "demo",
        background_source: "original",
        dryRun: false,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(xCreate.status, 201, `criar lote xlsx falhou: ${xCreate.body}`);
    const xJobId = assertJson(xCreate).job.id;
    await request(port, "POST", `/api/batches/${xJobId}/start`);
    const xFinished = await pollJob(port, xJobId, ["concluido"]);
    const xFirst = xFinished.courses[0];
    const xApprove = await request(port, "POST", `/api/batches/${xJobId}/items/${xFirst.slug}/approve`);
    assert.equal(xApprove.status, 200, `aprovação xlsx falhou: ${xApprove.body}`);

    const syncPreview = assertJson(
      await request(
        port,
        "POST",
        `/api/collections/${xlsxCollection.id}/sync-preview`,
        JSON.stringify({}),
        { "Content-Type": "application/json" }
      )
    );
    const syncPlan = syncPreview.plan && syncPreview.plan.plan ? syncPreview.plan.plan : syncPreview.plan;
    assert.ok(syncPlan && syncPlan.items && syncPlan.items.length > 0, "sync-preview retorna plano");
    assert.equal(syncPlan.items[0].slug, xFirst.slug, "sync-preview inclui item aprovado");
    assert.equal(syncPlan.items[0].next.prod_status, "aprovado", "sync-preview reconhece status aprovado");

    // 6. Arquivar e reativar
    const archive = await request(
      port,
      "POST",
      `/api/collections/${csvCollection.id}/archive`,
      JSON.stringify({ archived: true }),
      { "Content-Type": "application/json" }
    );
    assert.equal(archive.status, 200, `arquivamento falhou: ${archive.body}`);
    const normalList = assertJson(await request(port, "GET", "/api/collections"));
    assert.ok(!normalList.some((c) => c.id === csvCollection.id), "arquivada não aparece na listagem normal");
    const allList = assertJson(await request(port, "GET", "/api/collections?archived=all"));
    assert.ok(allList.some((c) => c.id === csvCollection.id && c.archived), "arquivada aparece com archived=all");

    // 7. Confirmação de ausência de resíduos em data/assets
    const finalAssets = new Set(fs.readdirSync(ASSETS_DIR));
    const addedAssets = [...finalAssets].filter((a) => !originalAssets.has(a));
    assert.deepEqual(addedAssets, [], `não deve haver novos assets em data/assets: ${addedAssets.join(", ")}`);

    console.log("Stabilization OK: upload, preview, csv semicolon, production background, approve/reject persistence, export, archive, no residue.");
  } finally {
    server.close();
    for (const id of createdCollections) {
      try { deleteCollection(id); } catch {}
    }
    for (const dir of createdImportDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
})();
