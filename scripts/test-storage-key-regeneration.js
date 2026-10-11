/**
 * Regeneração reaproveita o metadata e normaliza storage.keys.
 * Não grava no catálogo real e não apaga o arquivo antigo.
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { BatchExecutor } = require("../src/batch/executor");
const { writeJob } = require("../src/batch/job");
const {
  writeMetadata,
  readMetadata,
  sha256,
  storageKeysForCourse,
} = require("../src/batch/metadata");
const { LocalStorageProvider } = require("../src/storage/local-storage-provider");

const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "regen-catalog-"));
const storageBase = fs.mkdtempSync(path.join(os.tmpdir(), "regen-storage-"));
const storage = new LocalStorageProvider(storageBase);

const posSlug = "administracao-e-gestao-de-projetos-sociais";
const posCollection = "pos-graduacao-cruzeiro";
const gradSlug = "jornalismo";
const gradCollection = "graduacao-cruzeiro";

function preservedFields(metadata) {
  return {
    prompt: metadata.prompt,
    model: metadata.model,
    quality: metadata.quality,
    size: metadata.size,
    cost_usd: metadata.cost_usd,
    attempts: metadata.attempts,
  };
}

function oldMetadata(slug, curso) {
  return {
    course_id: `${slug}-id`,
    slug,
    curso,
    template_id: "template",
    prompt: `prompt-original-${slug}`,
    model: "gpt-image-2.5-flare",
    quality: "medium",
    size: "1024x1024",
    cost_usd: 1.25,
    background_origin: "ia",
    files: {},
    storage: {
      provider: "local",
      keys: {
        fundo: `${slug}/fundo`,
        card: `${slug}/card`,
        whatsapp: `${slug}/whatsapp`,
      },
    },
    urls: {
      fundo: `/api/files/old-${slug}-fundo`,
      card: `/api/files/old-${slug}-card`,
      whatsapp: `/api/files/old-${slug}-whatsapp`,
    },
    hashes: {
      fundo: "hash-fundo-antigo",
      card: "hash-card-antigo",
      whatsapp: "hash-whatsapp-antigo",
    },
    status: "pronto_revisao",
    timestamps: {
      generated_at: "2020-01-01T00:00:00.000Z",
      rendered_at: "2020-01-02T00:00:00.000Z",
      whatsapp_at: "2020-01-03T00:00:00.000Z",
    },
    error: null,
    attempts: 4,
  };
}

async function regenerate(collectionId, slug, curso) {
  const job = {
    id: `job-${slug}`,
    collectionId,
    status: "executando",
    template_id: "template",
    background_source: "ia",
    dryRun: true,
    model: "gpt-image-2.5-flare",
    quality: "medium",
    size: "1024x1024",
    courses: [{
      course_id: `${slug}-id`,
      slug,
      status: "pendente",
      error: null,
      attempts: 0,
      cost_usd: 0,
    }],
    stats: {},
  };
  writeJob(catalogDir, job);
  const before = oldMetadata(slug, curso);
  const kept = preservedFields(before);
  writeMetadata(catalogDir, slug, before);
  const oldBuffer = Buffer.from(`arquivo-antigo-${slug}`);
  await storage.save(`${slug}/fundo`, oldBuffer);
  const oldPath = storage.resolveLocalPath(`${slug}/fundo`);

  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
  const provider = {
    async generateBackground() { return png; },
    async renderCard() { return png; },
  };
  const executor = new BatchExecutor({ catalogDir, storageProvider: storage });
  const courseMap = {
    [slug]: { course_id: `${slug}-id`, slug, curso, prompt_imagem: kept.prompt },
  };

  for (let step = 0; step < 3; step++) {
    const result = await executor._processOneStep(job.id, courseMap, provider);
    assert.equal(result.done, false);
  }

  const after = readMetadata(catalogDir, slug);
  return { before, after, kept, oldPath, png };
}

async function main() {
  const pos = await regenerate(posCollection, posSlug, "Administração");
  const expected = storageKeysForCourse(posSlug, posCollection);
  assert.deepEqual(pos.after.storage.keys, expected);
  assert.equal(pos.after.storage.keys.fundo, `${posCollection}/${posSlug}/fundo`);
  assert.equal(pos.after.storage.keys.card, `${posCollection}/${posSlug}/card`);
  assert.equal(pos.after.storage.keys.whatsapp, `${posCollection}/${posSlug}/whatsapp`);
  assert.equal(pos.after.urls.fundo, await storage.getPublicUrl(expected.fundo));
  assert.equal(pos.after.urls.card, await storage.getPublicUrl(expected.card));
  assert.equal(pos.after.urls.whatsapp, await storage.getPublicUrl(expected.whatsapp));
  assert.equal(fs.existsSync(pos.oldPath), true);
  assert.equal(fs.existsSync(storage.resolveLocalPath(expected.fundo)), true);
  assert.deepEqual(preservedFields(pos.after), pos.kept);
  assert.notEqual(pos.after.hashes.fundo, pos.before.hashes.fundo);
  assert.equal(pos.after.hashes.fundo, sha256(pos.png));
  assert.notEqual(pos.after.timestamps.generated_at, pos.before.timestamps.generated_at);
  assert.notEqual(pos.after.timestamps.rendered_at, pos.before.timestamps.rendered_at);
  assert.notEqual(pos.after.timestamps.whatsapp_at, pos.before.timestamps.whatsapp_at);

  const grad = await regenerate(gradCollection, gradSlug, "Jornalismo");
  assert.deepEqual(grad.after.storage.keys, {
    fundo: `${gradSlug}/fundo`,
    card: `${gradSlug}/card`,
    whatsapp: `${gradSlug}/whatsapp`,
  });
  assert.equal(grad.after.urls.fundo, await storage.getPublicUrl(`${gradSlug}/fundo`));
  assert.equal(grad.after.urls.card, await storage.getPublicUrl(`${gradSlug}/card`));
  assert.equal(grad.after.urls.whatsapp, await storage.getPublicUrl(`${gradSlug}/whatsapp`));
  assert.deepEqual(preservedFields(grad.after), grad.kept);
  assert.equal(grad.after.hashes.fundo, sha256(grad.png));
  assert.notEqual(grad.after.timestamps.generated_at, grad.before.timestamps.generated_at);

  console.log("storage key regeneration ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
