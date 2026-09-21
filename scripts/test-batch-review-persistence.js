#!/usr/bin/env node
"use strict";

/**
 * Teste de persistência e isolamento da aprovação/rejeição em lote.
 *
 * Garante que:
 * - aprovar/rejeitar pelo endpoint do lote atualiza apenas aquele job;
 * - metadata.json e manifest são atualizados atomicamente;
 * - estatísticas são recalculadas;
 * - reload mantém o estado;
 * - o mesmo slug em outro lote não é alterado.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const assert = require("node:assert/strict");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "batch-review-persistence-"));
process.env.AI_CATALOG_DIR = path.join(TEMP_DIR, "output", "ai-catalog");
process.env.STORAGE_LOCAL_DIR = path.join(TEMP_DIR, "output", "ai-catalog");
process.env.AUTH_DISABLED = "true";

const { BatchExecutor } = require("../src/batch/executor");
const { writeJob } = require("../src/batch/job");
const { createMetadata, writeMetadata } = require("../src/batch/metadata");
const { courseFiles } = require("../src/batch/naming");
const genericProduction = require("../src/production/generic-production-service");

const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

const COLLECTION_ID = "graduacao-cruzeiro";
const SLUG = "ciberseguranca";

function request(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
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

function createMockMetadata(course) {
  const files = courseFiles(SLUG);
  const metadata = createMetadata(course, {
    template_id: "cruzeiro-graduacao-v1",
    model: "gpt-image-2.5-flare",
    quality: "medium",
    size: "1024x1024",
    background_origin: "pilot",
  });
  metadata.status = "pronto_revisao";
  metadata.files = files;
  metadata.storage.keys = {
    fundo: `${SLUG}/fundo`,
    card: `${SLUG}/card`,
    whatsapp: `${SLUG}/whatsapp`,
  };
  metadata.urls = {
    fundo: `/api/files/${Buffer.from(`${SLUG}/fundo`, "utf8").toString("base64url")}`,
    card: `/api/files/${Buffer.from(`${SLUG}/card`, "utf8").toString("base64url")}`,
    whatsapp: `/api/files/${Buffer.from(`${SLUG}/whatsapp`, "utf8").toString("base64url")}`,
  };
  metadata.hashes = {
    fundo: crypto.createHash("sha256").update("fundo").digest("hex"),
    card: crypto.createHash("sha256").update("card").digest("hex"),
    whatsapp: crypto.createHash("sha256").update("whatsapp").digest("hex"),
  };
  return metadata;
}

function createJobForCollection(jobId, collectionId, slug, extraSlug = null) {
  const courses = [{ course_id: `${slug}-id`, slug }];
  if (extraSlug) courses.push({ course_id: `${extraSlug}-id`, slug: extraSlug });
  const job = BatchExecutor.createJob(courses, {
    collectionId,
    template_id: "cruzeiro-graduacao-v1",
    background_source: "pilot",
    dryRun: false,
  });
  job.id = jobId;
  job.status = "concluido";
  job.courses.forEach((c) => {
    c.status = "pronto_revisao";
    c.updatedAt = new Date().toISOString();
  });
  // Recalcular stats para refletir o estado inicial manual.
  const stats = {
    total: job.courses.length,
    completed: job.courses.length,
    errors: 0,
    approved: 0,
    rejected: 0,
    calls: 0,
    cost_usd: 0,
  };
  job.stats = stats;
  return job;
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const catalogDir = process.env.AI_CATALOG_DIR;

    // Carrega curso real da coleção legada.
    const course = await genericProduction.getRecord(COLLECTION_ID, SLUG);
    assert.ok(course, `curso ${SLUG} deve existir na coleção legada`);

    // Cria metadata para o curso no catálogo temporário.
    const metadata = createMockMetadata(course);
    writeMetadata(catalogDir, SLUG, metadata);

    // Cria um arquivo de card dummy para permitir aprovação (cardExists exige arquivo).
    const dummyCardSource = path.join(__dirname, "..", "assets", "logo-cruzeiro-branco.png");
    assert.ok(fs.existsSync(dummyCardSource), "logo dummy deve existir");
    const courseDir = path.join(catalogDir, SLUG);
    fs.mkdirSync(courseDir, { recursive: true });
    fs.copyFileSync(dummyCardSource, path.join(courseDir, `${SLUG}-card.png`));

    // Cria manifesto mínimo para o curso.
    const manifest = genericProduction.ensureManifest(COLLECTION_ID);
    genericProduction.setManifestEntry(manifest, SLUG, {
      course_id: course.id,
      curso: course.title,
      status: "pronto_revisao",
      backgroundPath: `${SLUG}/${SLUG}-fundo.png`,
      cardPath: `${SLUG}/${SLUG}-card.png`,
      selectedBackground: "pilot",
      model: metadata.model,
      quality: metadata.quality,
      size: metadata.size,
      costUsd: 0,
    });
    genericProduction.saveManifest(COLLECTION_ID, manifest);

    // Cria dois lotes independentes com o mesmo slug.
    const job1 = createJobForCollection("job-persist-1", COLLECTION_ID, SLUG, "gestao-publica");
    const job2 = createJobForCollection("job-persist-2", COLLECTION_ID, SLUG);
    writeJob(catalogDir, job1);
    writeJob(catalogDir, job2);

    // 1. Estado inicial: job1 tem ciberseguranca aguardando revisão.
    const items1Before = assertJson(await request(port, "GET", `/api/batches/${job1.id}/items`));
    const item1Before = items1Before.find((i) => i.slug === SLUG);
    assert.ok(item1Before, "item deve existir no job1");
    assert.equal(item1Before.status, "pronto_revisao", "item deve começar aguardando revisão");

    const items2Before = assertJson(await request(port, "GET", `/api/batches/${job2.id}/items`));
    const item2Before = items2Before.find((i) => i.slug === SLUG);
    assert.equal(item2Before.status, "pronto_revisao", "item no job2 também começa aguardando revisão");

    // 2. Aprovação via endpoint do lote.
    const approveRes = await request(port, "POST", `/api/batches/${job1.id}/items/${SLUG}/approve`);
    assert.equal(approveRes.status, 200, `aprovação deve retornar 200: ${approveRes.body}`);
    const approveBody = assertJson(approveRes);
    assert.equal(approveBody.job.courses.find((c) => c.slug === SLUG).status, "aprovado", "job1: item deve estar aprovado");
    assert.equal(approveBody.job.stats.approved, 1, "job1: stats.approved deve ser 1");
    assert.equal(approveBody.job.stats.total, 2, "job1: stats.total deve ser 2");

    // 3. Metadata aprovada.
    const metadataAfterApprove = JSON.parse(fs.readFileSync(path.join(catalogDir, SLUG, "metadata.json"), "utf8"));
    assert.equal(metadataAfterApprove.status, "aprovado", "metadata deve estar aprovada");
    assert.ok(metadataAfterApprove.timestamps.approved_at, "metadata deve ter approved_at");

    // 4. Manifest aprovado.
    const manifestAfterApprove = JSON.parse(fs.readFileSync(path.join(catalogDir, "manifest.json"), "utf8"));
    assert.equal(manifestAfterApprove.courses[SLUG].status, "aprovado", "manifest deve estar aprovado");

    // 5. Reload mantém aprovação.
    const job1Reload = assertJson(await request(port, "GET", `/api/batches/${job1.id}`));
    assert.equal(job1Reload.courses.find((c) => c.slug === SLUG).status, "aprovado", "reload do job1 deve manter aprovado");
    assert.equal(job1Reload.stats.approved, 1, "reload: stats.approved deve ser 1");

    // 6. Isolamento: job2 não deve ser alterado.
    const job2After = assertJson(await request(port, "GET", `/api/batches/${job2.id}`));
    assert.equal(job2After.courses.find((c) => c.slug === SLUG).status, "pronto_revisao", "job2: item deve continuar aguardando revisão");

    // 7. Rejeição persiste.
    const rejectRes = await request(port, "POST", `/api/batches/${job1.id}/items/${SLUG}/reject`);
    assert.equal(rejectRes.status, 200, `rejeição deve retornar 200: ${rejectRes.body}`);
    const job1AfterReject = assertJson(await request(port, "GET", `/api/batches/${job1.id}`));
    assert.equal(job1AfterReject.courses.find((c) => c.slug === SLUG).status, "rejeitado", "job1: item deve estar rejeitado");
    assert.equal(job1AfterReject.stats.approved, 0, "job1: approved deve voltar a 0");
    assert.equal(job1AfterReject.stats.rejected, 1, "job1: rejected deve ser 1");

    const metadataAfterReject = JSON.parse(fs.readFileSync(path.join(catalogDir, SLUG, "metadata.json"), "utf8"));
    assert.equal(metadataAfterReject.status, "rejeitado", "metadata deve estar rejeitada");

    // 8. Filtro "Aguardando revisão" retorna somente os corretos.
    // O endpoint lista todos; simulamos o filtro que a UI aplica.
    const items1Final = assertJson(await request(port, "GET", `/api/batches/${job1.id}/items`));
    const pending = items1Final.filter((i) => i.status === "pronto_revisao");
    assert.equal(pending.length, 1, "apenas gestao-publica deve estar aguardando revisão no job1");
    assert.equal(pending[0].slug, "gestao-publica", "item pendente deve ser gestao-publica");

    // 9. Cache-Control no-store nos endpoints de estado do lote.
    const batchesRes = await request(port, "GET", "/api/batches");
    assert.equal(batchesRes.headers["cache-control"], "no-store", "/api/batches deve ter Cache-Control: no-store");
    const jobRes = await request(port, "GET", `/api/batches/${job1.id}`);
    assert.equal(jobRes.headers["cache-control"], "no-store", "/api/batches/:id deve ter Cache-Control: no-store");
    const itemsRes = await request(port, "GET", `/api/batches/${job1.id}/items`);
    assert.equal(itemsRes.headers["cache-control"], "no-store", "/api/batches/:id/items deve ter Cache-Control: no-store");

    console.log("Batch review persistence OK: aprovação/rejeição isolada por lote, metadata/manifest sincronizados, estatísticas recalculadas e cache desabilitado.");
  } finally {
    server.close();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
})();
