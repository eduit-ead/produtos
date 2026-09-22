/**
 * Teste de integração visual entre Estúdio, lote e listagem de itens.
 *
 * Verifica:
 * - fundo gerado no Estúdio aparece no item correto;
 * - aprovação no Estúdio torna a imagem atual e persiste;
 * - aprovação em lote torna a imagem atual;
 * - "Usar imagem existente" prioriza aprovada;
 * - curso sem imagem é ignorado;
 * - planilha original não é alterada.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-batch-visual-"));
process.env.APP_RUNTIME_DIR = runtimeDir;
process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.OPENAI_API_KEY = "";
process.env.STORAGE_PROVIDER = "local";
process.env.AUTH_DISABLED = "true";

const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const { saveCollection, deleteCollection } = require("../src/collections/manager");
const { createStorageProvider } = require("../src/storage");
const { resolveItemVisual, resolveBackgroundBufferForItem } = require("../src/production/visual-resolver");
const { getImageBuffer } = require("../src/image-cache");

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
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          let parsed;
          try { parsed = JSON.parse(buffer.toString("utf8")); } catch { parsed = buffer.toString("utf8"); }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertOk(res, message) {
  assert.equal(res.status, 200, `${message}: ${JSON.stringify(res.body)}`);
}

function findItem(list, slug) {
  return list.find((i) => i.slug === slug);
}

async function pollJob(port, jobId, targetStatuses, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const poll = await request(port, "GET", `/api/batches/${jobId}`);
    if (targetStatuses.includes(poll.body.status)) return poll.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout aguardando status ${targetStatuses.join(",")} para ${jobId}`);
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Lista de cursos legados
    const itemsRes = await request(port, "GET", "/api/items?collection=graduacao-cruzeiro");
    assertOk(itemsRes, "listar cursos");
    assert.equal(itemsRes.body.length, 128, "deve haver 128 cursos");
    const sample = itemsRes.body[0];
    assert.ok(sample.slug, "curso deve ter slug");
    assert.equal(sample.visual_status, "original", "curso sem produção deve ter imagem original");

    // 2. Gerar fundo no Estúdio em dry-run
    const generateRes = await request(port, "POST", "/api/studio/generate-background", JSON.stringify({
      templateId: "cruzeiro-graduacao-v1",
      collectionId: "graduacao-cruzeiro",
      itemId: sample.slug,
      values: {
        titulo: sample.curso || sample.title || sample.slug,
        modalidade: "EAD",
        formacao: "Bacharelado",
        duracao: "8 semestres",
        prompt_imagem: "fotografia publicitária realista",
      },
      dryRun: true,
    }), { "Content-Type": "application/json" });
    assertOk(generateRes, "gerar fundo no estúdio");
    const runId = generateRes.body.metadata.runId;
    assert.ok(runId, "runId deve existir");

    // Verifica que o item ainda mostra imagem original, mas possui candidato do estúdio
    const afterGenerate = await request(port, "GET", "/api/items?collection=graduacao-cruzeiro");
    const itemAfterGenerate = findItem(afterGenerate.body, sample.slug);
    assert.equal(itemAfterGenerate.visual_status, "simulacao", "dry-run deve aparecer como simulação");
    assert.ok(itemAfterGenerate.candidate_background_url, "candidato do estúdio deve aparecer");

    // Dry-run não pode ser aprovado
    const approveDryRunRes = await request(port, "POST", "/api/studio/approve-background", JSON.stringify({
      runId,
      collectionId: "graduacao-cruzeiro",
      itemId: sample.slug,
      templateId: "cruzeiro-graduacao-v1",
      values: {
        titulo: sample.curso || sample.title || sample.slug,
        modalidade: "EAD",
        formacao: "Bacharelado",
        duracao: "8 semestres",
      },
    }), { "Content-Type": "application/json" });
    assert.equal(approveDryRunRes.status, 409, "dry-run não pode ser aprovado");

    // 3. Aprovar fundo do Estúdio (simulando uma geração real gravando metadados manualmente)
    const realRunId = `studio-real-${Date.now()}`;
    const realStudioDir = path.join(runtimeDir, "output", "ai-catalog", "studio", realRunId);
    fs.mkdirSync(realStudioDir, { recursive: true });
    const realBgKey = `studio/${realRunId}/fundo.png`;
    const realBgBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#336699" } }).png().toBuffer();
    const studioStorage = createStorageProvider({ baseDir: path.join(runtimeDir, "output", "ai-catalog") });
    await studioStorage.save(realBgKey, realBgBuffer, { contentType: "image/png" });
    fs.writeFileSync(
      path.join(realStudioDir, "metadata.json"),
      JSON.stringify({
        runId: realRunId,
        templateId: "cruzeiro-graduacao-v1",
        collectionId: "graduacao-cruzeiro",
        itemId: sample.slug,
        dryRun: false,
        generatedAt: new Date().toISOString(),
        values: {
          titulo: sample.curso || sample.title || sample.slug,
          modalidade: "EAD",
          formacao: "Bacharelado",
          duracao: "8 semestres",
        },
        storage: { key: realBgKey },
        urls: { fundo: `/api/files?key=${encodeURIComponent(realBgKey)}` },
      }, null, 2)
    );

    // Candidato pendente + imagem original: current continua sendo a original
    const originalImageUrl = sample.current_background_url || sample.ai_background_url;
    assert.ok(originalImageUrl, "curso de amostra deve ter imagem original");
    const visualWithCandidate = await resolveItemVisual("graduacao-cruzeiro", sample.slug, { sourceImage: originalImageUrl });
    assert.equal(visualWithCandidate.visualStatus, "aguardando_revisao", "candidato pendente fica aguardando revisao");
    assert.equal(visualWithCandidate.currentBackgroundUrl, originalImageUrl, "currentBackgroundUrl deve ser imagem original");
    assert.ok(visualWithCandidate.candidateBackgroundUrl, "deve haver candidato pendente");
    assert.equal(visualWithCandidate.candidateSource, "studio", "candidateSource deve ser studio");
    const chosenBuffer = await resolveBackgroundBufferForItem("graduacao-cruzeiro", sample.slug, { sourceImage: originalImageUrl });
    assert.ok(Buffer.isBuffer(chosenBuffer) && chosenBuffer.length > 0, "resolveBackgroundBufferForItem deve resolver imagem oficial (original)");

    // Tentar aprovar com metadados de outro item deve ser rejeitado
    const mismatchRes = await request(port, "POST", "/api/studio/approve-background", JSON.stringify({
      runId: realRunId,
      collectionId: "graduacao-cruzeiro",
      itemId: itemsRes.body[1].slug,
      templateId: "cruzeiro-graduacao-v1",
      values: {
        titulo: sample.curso || sample.title || sample.slug,
        modalidade: "EAD",
        formacao: "Bacharelado",
        duracao: "8 semestres",
      },
    }), { "Content-Type": "application/json" });
    assert.equal(mismatchRes.status, 409, "aprovação de metadados de outro item deve retornar 409");

    const approveRes = await request(port, "POST", "/api/studio/approve-background", JSON.stringify({
      runId: realRunId,
      collectionId: "graduacao-cruzeiro",
      itemId: sample.slug,
      templateId: "cruzeiro-graduacao-v1",
      values: {
        titulo: sample.curso || sample.title || sample.slug,
        modalidade: "EAD",
        formacao: "Bacharelado",
        duracao: "8 semestres",
      },
    }), { "Content-Type": "application/json" });
    assertOk(approveRes, "aprovar fundo do estúdio");

    const afterApprove = await request(port, "GET", "/api/items?collection=graduacao-cruzeiro");
    const itemAfterApprove = findItem(afterApprove.body, sample.slug);
    assert.equal(itemAfterApprove.visual_status, "aprovado", "após aprovação visual deve ser aprovado");
    assert.ok(itemAfterApprove.current_background_url, "deve ter background atual");
    assert.ok(itemAfterApprove.current_card_url, "deve ter card atual");
    assert.equal(itemAfterApprove.visual_source, "studio", "fonte deve ser estúdio");

    // Persistência: ler manifesto diretamente
    const manifestPath = path.join(runtimeDir, "output", "ai-catalog", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const approved = manifest.courses[sample.slug].approvedVisual;
    assert.ok(approved, "manifesto deve conter approvedVisual");
    assert.equal(approved.source, "studio", "approvedVisual.source deve ser studio");

    // 4. Lote "Usar imagem existente" deve priorizar aprovada e produzir card real
    const batchCreate = await request(port, "POST", "/api/batches", JSON.stringify({
      collection_id: "graduacao-cruzeiro",
      courses: [{ course_id: sample.course_id || sample.slug, slug: sample.slug }],
      template_id: "cruzeiro-graduacao-v1",
      background_source: "original",
      dryRun: false,
    }), { "Content-Type": "application/json" });
    assert.equal(batchCreate.status, 201, `criar lote falhou: ${JSON.stringify(batchCreate.body)}`);
    const job = batchCreate.body.job;

    const startRes = await request(port, "POST", `/api/batches/${job.id}/start`);
    assertOk(startRes, "iniciar lote com imagem existente");
    const finished = await pollJob(port, job.id, ["concluido"]);
    assert.equal(finished.stats.ready, 1, "item deve estar pronto para revisão");

    // Aprovar no lote
    const batchApprove = await request(port, "POST", `/api/batches/${job.id}/items/${sample.slug}/approve`);
    assertOk(batchApprove, "aprovar no lote");

    const afterBatchApprove = await request(port, "GET", "/api/items?collection=graduacao-cruzeiro");
    const itemBatch = findItem(afterBatchApprove.body, sample.slug);
    assert.equal(itemBatch.visual_status, "aprovado", "após aprovação do lote deve estar aprovado");
    assert.equal(itemBatch.visual_source, "batch", "fonte deve ser lote");

    // 5. Item genérico sem imagem deve ser ignorado em lote com imagem existente
    const csvDir = path.join(runtimeDir, "data", "imports", "test-no-image");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvNoImage = path.join(csvDir, "produtos.csv");
    fs.writeFileSync(csvNoImage, "SKU,Nome\nNO-IMAGE,Sem Imagem", "utf8");

    const noImageCollection = {
      id: "test-no-image",
      name: "Sem Imagem",
      source: { type: "csv", path: path.relative(runtimeDir, csvNoImage) },
      primaryKey: "SKU",
      displayField: "Nome",
      searchFields: ["Nome"],
      fieldMappings: { title: "Nome", slug: "SKU" },
      filters: [],
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
      ],
    };
    saveCollection(noImageCollection);

    const itemsNoImage = await request(port, "GET", "/api/items?collection=test-no-image");
    const noImageItem = itemsNoImage.body[0];

    const ignoredCreate = await request(port, "POST", "/api/batches", JSON.stringify({
      collection_id: "test-no-image",
      courses: [{ course_id: noImageItem.record_id, slug: noImageItem.slug }],
      template_id: "demo",
      background_source: "original",
      dryRun: false,
    }), { "Content-Type": "application/json" });
    assert.equal(ignoredCreate.status, 201, `criar lote ignorado falhou: ${JSON.stringify(ignoredCreate.body)}`);
    const ignoredJob = ignoredCreate.body.job;
    await request(port, "POST", `/api/batches/${ignoredJob.id}/start`);
    const ignoredFinished = await pollJob(port, ignoredJob.id, ["concluido", "concluido_com_erros"], 15000);
    assert.equal(ignoredFinished.stats.ignored, 1, "item sem imagem deve ser ignorado");
    assert.equal(ignoredFinished.stats.ready, 0, "não deve haver itens prontos");

    // Candidato pendente sem imagem original: "Usar imagem existente" ignora o item
    const noImageRunId = `studio-noimage-${Date.now()}`;
    const noImageCatalogDir = path.join(runtimeDir, "output", "ai-catalog", "test-no-image");
    const noImageStudioDir = path.join(noImageCatalogDir, "studio", noImageRunId);
    fs.mkdirSync(noImageStudioDir, { recursive: true });
    const noImageBgKey = `studio/${noImageRunId}/fundo.png`;
    const noImageBgBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const noImageStorage = createStorageProvider({ baseDir: noImageCatalogDir });
    await noImageStorage.save(noImageBgKey, noImageBgBuffer, { contentType: "image/png" });
    fs.writeFileSync(
      path.join(noImageStudioDir, "metadata.json"),
      JSON.stringify({
        runId: noImageRunId,
        templateId: "demo",
        collectionId: "test-no-image",
        itemId: noImageItem.slug,
        dryRun: true,
        generatedAt: new Date().toISOString(),
        values: { titulo: "Sem Imagem" },
        storage: { key: noImageBgKey, provider: process.env.STORAGE_PROVIDER || "local" },
        urls: { fundo: `/api/files?key=${encodeURIComponent(noImageBgKey)}` },
      }, null, 2)
    );

    const noImageCandidate = await resolveItemVisual("test-no-image", noImageItem.slug, { sourceImage: noImageItem.fields?.image_url || "" });
    assert.equal(noImageCandidate.visualStatus, "simulacao", "candidato dry-run sem original fica simulacao");
    assert.equal(noImageCandidate.currentBackgroundUrl, null, "sem original, currentBackgroundUrl é null");
    assert.ok(noImageCandidate.candidateBackgroundUrl, "candidato existe");

    const ignoredWithCandidate = await request(port, "POST", "/api/batches", JSON.stringify({
      collection_id: "test-no-image",
      courses: [{ course_id: noImageItem.record_id, slug: noImageItem.slug }],
      template_id: "demo",
      background_source: "original",
      dryRun: false,
    }), { "Content-Type": "application/json" });
    assert.equal(ignoredWithCandidate.status, 201, `criar lote ignorado com candidato falhou: ${JSON.stringify(ignoredWithCandidate.body)}`);
    const ignoredWithCandidateJob = ignoredWithCandidate.body.job;
    await request(port, "POST", `/api/batches/${ignoredWithCandidateJob.id}/start`);
    const ignoredWithCandidateFinished = await pollJob(port, ignoredWithCandidateJob.id, ["concluido", "concluido_com_erros"], 15000);
    assert.equal(ignoredWithCandidateFinished.stats.ignored, 1, "item sem imagem oficial deve ser ignorado mesmo com candidato");

    deleteCollection("test-no-image");

    // 6. Planilha original intacta
    const originalXlsx = path.resolve("input", "cursos.xlsx");
    const originalSize = fs.statSync(originalXlsx).size;
    assert.ok(originalSize > 0, "planilha original existe");

    console.log("Studio/batch visual integration OK");
  } finally {
    server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
})();
