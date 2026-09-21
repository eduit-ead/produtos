/**
 * Teste de download organizado por lote (FASE 4).
 *
 * Cria uma coleção CSV, executa um lote dry-run, aprova/rejeita itens e
 * valida os ZIPs gerados pelo endpoint /api/batches/:id/download.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "batch-zip-test-"));
process.env.AI_CATALOG_DIR = TEMP_DIR;
process.env.STORAGE_LOCAL_DIR = TEMP_DIR;

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const downloadRoutes = require("../src/batch/download-routes");
const { saveCollection, deleteCollection } = require("../src/collections/manager");
const genericProduction = require("../src/production/generic-production-service");

const ROOT = path.resolve(__dirname, "..");
const IMPORTS_DIR = path.join(ROOT, "data", "imports");
const COLLECTION_ID = "test-batch-zip";

const app = express();
const apiRouter = createRouter();
apiRouter.use("/batches", downloadRoutes);
app.use("/api", apiRouter);
const server = http.createServer(app);

function buildMultipart(fields, file) {
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
  return { body: Buffer.concat(chunks.map((c) => Buffer.from(c))), boundary };
}

function requestRaw(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestJson(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    requestRaw(port, method, urlPath, body, headers)
      .then((res) => {
        let parsed;
        try {
          parsed = JSON.parse(res.body.toString("utf8"));
        } catch {
          assert.fail(`Resposta não é JSON válido: ${res.body.toString("utf8")}`);
        }
        resolve({ status: res.status, headers: res.headers, body: parsed });
      })
      .catch(reject);
  });
}

function assertOk(res, message) {
  assert.equal(res.status, 200, `${message}: ${JSON.stringify(res.body)}`);
}

async function pollJob(port, jobId, targetStatuses, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const poll = await requestJson(port, "GET", `/api/batches/${jobId}`);
    if (targetStatuses.includes(poll.body.status)) return poll.body;
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
  console.log("Starting test server...");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log("Server listening on port", port);

  try {
    // 1. Criar coleção CSV com 2 itens
    const importDir = path.join(IMPORTS_DIR, COLLECTION_ID);
    fs.mkdirSync(importDir, { recursive: true });
    const csvPath = path.join(importDir, "produtos.csv");
    const imageUrl1 = "https://i.ibb.co/Z6b3dBtT/Jornalismo.png";
    const imageUrl2 = "https://i.ibb.co/svKGPvYR/Digital-Influence.png";
    fs.writeFileSync(
      csvPath,
      `SKU,Nome,Categoria,image_url\nSKU-001,Produto A,Categoria A,${imageUrl1}\nSKU-002,Produto B,Categoria B,${imageUrl2}`,
      "utf8"
    );

    const collection = {
      id: COLLECTION_ID,
      name: "Teste ZIP Lote",
      description: "Base para validação de download organizado por lote.",
      source: { type: "csv", path: "data/imports/test-batch-zip/produtos.csv" },
      primaryKey: "SKU",
      displayField: "Nome",
      searchFields: ["Nome", "Categoria"],
      fieldMappings: { title: "Nome", slug: "SKU" },
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
    saveCollection(collection);

    // 2. Listar itens e criar lote de produção real com imagens existentes
    console.log("Listing items...");
    const itemsRes = await requestJson(port, "GET", `/api/items?collection=${COLLECTION_ID}`);
    assert.ok(Array.isArray(itemsRes.body) && itemsRes.body.length === 2, "deve haver 2 itens");
    const [first, second] = itemsRes.body;
    assert.ok(first.current_background_url, "item deve ter imagem de origem");
    const courses = itemsRes.body.map((i) => ({ course_id: i.record_id || i.slug, slug: i.slug }));
    console.log("Creating batch...");

    const createRes = await requestJson(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({
        collection_id: COLLECTION_ID,
        courses,
        template_id: "demo",
        background_source: "original",
        dryRun: false,
      }),
      { "Content-Type": "application/json" }
    );
    assert.equal(createRes.status, 201, `criar lote falhou: ${JSON.stringify(createRes.body)}`);
    const job = createRes.body.job;

    // 3. Executar lote até conclusão
    console.log("Starting batch", job.id);
    const startRes = await requestJson(port, "POST", `/api/batches/${job.id}/start`);
    assertOk(startRes, "iniciar lote");
    console.log("Polling batch...");
    const finished = await pollJob(port, job.id, ["concluido"]);
    assert.equal(finished.stats.ready, 2, "ambos os itens devem estar aguardando revisão");
    assert.equal(finished.stats.completed, 2, "ambos os itens devem concluir");
    console.log("Batch finished");

    // 4. Aprovar primeiro e rejeitar segundo
    console.log("Approving/rejecting items...");
    const approveRes = await requestJson(port, "POST", `/api/batches/${job.id}/items/${first.slug}/approve`);
    assertOk(approveRes, "aprovar item");
    const rejectRes = await requestJson(port, "POST", `/api/batches/${job.id}/items/${second.slug}/reject`);
    assertOk(rejectRes, "rejeitar item");

    // 5. Teste: apenas aprovados e nomes corretos (cards)
    console.log("Downloading cards ZIP...");
    const cardsZipRaw = await requestRaw(
      port,
      "POST",
      `/api/batches/${job.id}/download`,
      JSON.stringify({ approvedOnly: true, includeCards: true }),
      { "Content-Type": "application/json" }
    );
    assert.equal(cardsZipRaw.status, 200, "download de cards deve retornar 200");
    assert.equal(cardsZipRaw.headers["content-type"], "application/zip", "content-type deve ser zip");

    const cardsZip = await JSZip.loadAsync(cardsZipRaw.body);
    const cardEntry = `${first.slug}-card.png`;
    assert.ok(cardsZip.files[cardEntry], `deve conter ${cardEntry}`);
    assert.ok(!cardsZip.files[`${second.slug}-card.png`], "não deve conter card rejeitado");
    assert.ok(cardsZip.files["report.json"], "deve conter report.json");

    const cardsReport = JSON.parse(await cardsZip.files["report.json"].async("string"));
    assert.equal(cardsReport.included.length, 1, "report deve listar 1 card incluído");
    assert.equal(cardsReport.included[0].slug, first.slug, "card incluído deve ser do item aprovado");
    assert.equal(cardsReport.missing.length, 0, "não deve haver ausentes");

    // 6. Teste: ausência de arquivo gera relatório (WhatsApp)
    const approvedBase = path.join(TEMP_DIR, COLLECTION_ID, first.slug);
    const whatsappPath = path.join(approvedBase, `${first.slug}-whatsapp.jpg`);
    assert.ok(fs.existsSync(whatsappPath), "whatsapp deve existir antes da remoção");
    fs.unlinkSync(whatsappPath);

    const waZipRaw = await requestRaw(
      port,
      "POST",
      `/api/batches/${job.id}/download`,
      JSON.stringify({ approvedOnly: true, includeWhatsApp: true }),
      { "Content-Type": "application/json" }
    );
    assert.equal(waZipRaw.status, 200, "download de whatsapp deve retornar 200");

    const waZip = await JSZip.loadAsync(waZipRaw.body);
    assert.ok(!waZip.files[`${first.slug}-whatsapp.jpg`], "não deve conter whatsapp removido");
    assert.ok(waZip.files["missing.txt"], "deve conter missing.txt");
    assert.ok(waZip.files["report.json"], "deve conter report.json");

    const missingText = await waZip.files["missing.txt"].async("string");
    assert.ok(missingText.includes(first.slug), "missing.txt deve mencionar slug aprovado");
    assert.ok(missingText.includes("whatsapp"), "missing.txt deve mencionar tipo whatsapp");

    // 7. Teste: pacote completo com nomes determinísticos
    const packageZipRaw = await requestRaw(
      port,
      "POST",
      `/api/batches/${job.id}/download`,
      JSON.stringify({ approvedOnly: true, includeCards: true, includeWhatsApp: true, includeBackgrounds: true, includeMetadata: true }),
      { "Content-Type": "application/json" }
    );
    assert.equal(packageZipRaw.status, 200, "download do pacote deve retornar 200");

    const packageZip = await JSZip.loadAsync(packageZipRaw.body);
    assert.ok(packageZip.files[`${first.slug}-card.png`], "pacote deve conter card");
    assert.ok(packageZip.files[`${first.slug}-fundo.png`], "pacote deve conter fundo");
    assert.ok(packageZip.files[`${first.slug}/metadata.json`], "pacote deve conter metadata.json em pasta do slug");
    assert.ok(packageZip.files["missing.txt"], "pacote deve conter missing.txt (whatsapp ausente)");

    const packageReport = JSON.parse(await packageZip.files["report.json"].async("string"));
    const includedNames = packageReport.included.map((i) => i.entryName).sort();
    assert.deepEqual(includedNames, [`${first.slug}-card.png`, `${first.slug}-fundo.png`, `${first.slug}/metadata.json`].sort(), "nomes determinísticos corretos");
    assert.equal(packageReport.missing.length, 1, "pacote deve reportar whatsapp ausente");
    assert.equal(packageReport.missing[0].type, "whatsapp", "ausente deve ser whatsapp");

    // 8. Validação do header X-Download-Report
    const reportHeader = waZipRaw.headers["x-download-report"];
    assert.ok(reportHeader, "deve retornar header X-Download-Report");
    const headerReport = JSON.parse(decodeURIComponent(reportHeader));
    assert.equal(headerReport.missing.length, 1, "header deve refletir missing");

    console.log("Batch ZIP OK: aprovados filtrados, nomes determinísticos, relatório de ausentes e pacote completo.");
  } finally {
    server.close();
    try { deleteCollection(COLLECTION_ID); } catch {}
    try { fs.rmSync(path.join(IMPORTS_DIR, COLLECTION_ID), { recursive: true, force: true }); } catch {}
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
})();
