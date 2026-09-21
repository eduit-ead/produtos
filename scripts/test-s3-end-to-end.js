/**
 * Teste end-to-end de produção em lote com storage S3 mockado.
 *
 * Não faz chamadas externas. O cliente S3 é injetado no provider.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

function createMockClient(initialState = {}) {
  const objects = new Map(initialState.objects || []);
  let available = initialState.available !== false;
  return {
    send: async (command) => {
      const cmdName = command.constructor.name;
      if (!available && cmdName !== "HeadBucketCommand" && cmdName !== "ListObjectsV2Command") {
        const err = new Error("Network unreachable (mock)");
        err.name = "ServiceUnavailable";
        throw err;
      }
      switch (cmdName) {
        case "PutObjectCommand": {
          objects.set(command.input.Key, { body: command.input.Body, size: command.input.Body.length, contentType: command.input.ContentType });
          return { ETag: `"mock-etag-${Date.now()}"` };
        }
        case "HeadObjectCommand": {
          if (!objects.has(command.input.Key)) {
            const err = new Error("Not Found");
            err.name = "NotFound";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return objects.get(command.input.Key);
        }
        case "GetObjectCommand": {
          if (!objects.has(command.input.Key)) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          const obj = objects.get(command.input.Key);
          const bodyBuffer = obj.body || Buffer.from("fake-content-" + command.input.Key);
          const stream = { async *[Symbol.asyncIterator]() { yield bodyBuffer; } };
          return { Body: stream, ContentType: obj.contentType };
        }
        case "DeleteObjectCommand": {
          objects.delete(command.input.Key);
          return {};
        }
        case "HeadBucketCommand":
          return {};
        case "ListObjectsV2Command": {
          return { Contents: objects.size > 0 ? [{ Key: Array.from(objects.keys())[0] }] : [] };
        }
        default:
          throw new Error(`Comando mock não implementado: ${cmdName}`);
      }
    },
  };
}

function waitForJob(exec, jobId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const job = exec._refreshJob(jobId);
        if (job && ["concluido", "concluido_com_erros"].includes(job.status)) {
          clearInterval(timer);
          resolve(job);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timeout aguardando conclusão do job ${jobId}`));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 100);
  });
}

(async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-e2e-runtime-"));
  process.env.APP_RUNTIME_DIR = runtimeDir;
  process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
  process.env.STORAGE_PROVIDER = "s3";
  process.env.S3_BUCKET = "produtos-bucket";
  process.env.S3_REGION = "auto";
  process.env.S3_ENDPOINT = "https://s3.example.com";
  process.env.S3_FORCE_PATH_STYLE = "true";
  process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com";
  process.env.S3_PREFIX = "catalog";

  const { S3StorageProvider } = require("../src/storage/s3-storage-provider");
  const { BatchExecutor } = require("../src/batch/executor");
  const { writeJob } = require("../src/batch/job");
  const { buildBatchZip } = require("../src/batch/zip-download");
  const { updateJobItemStatus } = require("../src/batch/job-status");
  const { seedRuntimeDefaults } = require("../src/config/seed");
  const { saveCollection } = require("../src/collections/manager");
  const genericProduction = require("../src/production/generic-production-service");

  seedRuntimeDefaults();

  const s3Client = createMockClient();
  const s3Provider = new S3StorageProvider({
    client: s3Client,
    bucket: "produtos-bucket",
    region: "auto",
    endpoint: "https://s3.example.com",
    forcePathStyle: true,
    publicBaseUrl: "https://cdn.example.com",
    prefix: "catalog",
  });

  // Força todo o serviço genérico a usar o provider S3 mockado.
  genericProduction.storageFor = () => s3Provider;

  const collectionId = "s3-e2e-collection";
  const importDir = path.join(runtimeDir, "data", "imports", collectionId);
  fs.mkdirSync(importDir, { recursive: true });
  const csvPath = path.join(importDir, "produtos.csv");
  fs.writeFileSync(csvPath, "SKU,Nome,Categoria\nSKU-001,Produto A,Categoria A", "utf8");

  const collection = {
    id: collectionId,
    name: "S3 E2E",
    source: { type: "csv", path: path.relative(runtimeDir, csvPath) },
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
  saveCollection(collection);

  const catalogDir = genericProduction.catalogDirFor(collectionId);
  const courses = [{ course_id: "SKU-001", slug: "sku-001" }];
  const job = BatchExecutor.createJob(courses, {
    collectionId,
    template_id: "demo",
    background_source: "ia",
    dryRun: true,
  });
  fs.mkdirSync(path.join(catalogDir, "jobs"), { recursive: true });
  writeJob(catalogDir, job);

  const exec = new BatchExecutor({ catalogDir, storageProvider: s3Provider });
  await exec.start(job.id);
  const finished = await waitForJob(exec, job.id);
  assert.ok(["concluido", "concluido_com_erros"].includes(finished.status), `job deveria concluir: ${finished.status}`);
  assert.strictEqual(finished.stats.errors, 0, "não deve haver erros");
  assert.strictEqual(finished.stats.completed, 1, "1 item deve completar");

  const slug = "sku-001";
  assert.strictEqual(await s3Provider.exists(`${slug}/fundo`), true, "fundo deve existir no S3");
  const bgBuffer = await s3Provider.read(`${slug}/fundo`);
  assert.ok(Buffer.isBuffer(bgBuffer), "read deve retornar Buffer");
  assert.strictEqual(await s3Provider.exists(`${slug}/card`), true, "card deve existir no S3");
  assert.strictEqual(await s3Provider.exists(`${slug}/whatsapp`), true, "whatsapp deve existir no S3");

  const approved = await updateJobItemStatus(collectionId, job.id, slug, "aprovado", {}, s3Provider);
  assert.strictEqual(approved.metadata.status, "aprovado", "metadata deve estar aprovado");

  const zipResult = await buildBatchZip({
    catalogDir,
    storageProvider: s3Provider,
    jobId: job.id,
    options: { approvedOnly: true, includeCards: true, includeWhatsApp: true, includeBackgrounds: true, includeMetadata: true },
  });
  const zip = await JSZip.loadAsync(zipResult.buffer);
  assert.ok(zip.files["sku-001-card.png"], "ZIP deve conter card");
  assert.ok(zip.files["sku-001-fundo.png"], "ZIP deve conter fundo");
  assert.ok(zip.files["sku-001-whatsapp.jpg"], "ZIP deve conter whatsapp");
  assert.ok(zip.files["sku-001/metadata.json"], "ZIP deve conter metadata");

  const cardBuffer = await zip.files["sku-001-card.png"].async("nodebuffer");
  assert.ok(Buffer.isBuffer(cardBuffer) && cardBuffer.length > 0, "card no ZIP deve ter conteúdo");

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log("S3 end-to-end OK: fundo, card, WhatsApp, aprovação e ZIP funcionaram com storage mockado.");
})();
