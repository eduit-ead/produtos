/**
 * Leitura e escrita atômica do metadata.json de cada curso.
 *
 * Schema: course_id, slug, curso, template_id, prompt, model, quality, size,
 * cost_usd, background_origin, files, storage.keys, urls, hashes, status,
 * timestamps, error, attempts.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { courseFiles } = require("./naming");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CATALOG_DIR = path.join(ROOT, "output", "ai-catalog");

function getCatalogDir() {
  return process.env.AI_CATALOG_DIR
    ? path.resolve(process.env.AI_CATALOG_DIR)
    : DEFAULT_CATALOG_DIR;
}

function courseDir(catalogDir, slug) {
  const dir = path.join(catalogDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metadataPath(catalogDir, slug) {
  return path.join(courseDir(catalogDir, slug), "metadata.json");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createMetadata(course, options = {}) {
  const files = courseFiles(course.slug);
  const provider = options.provider || "local";
  return {
    course_id: course.course_id,
    slug: course.slug,
    curso: course.curso,
    template_id: options.template_id || "cruzeiro-graduacao-v1",
    prompt: options.prompt || course.prompt_imagem || null,
    model: options.model || "gpt-image-2.5-flare",
    quality: options.quality || "medium",
    size: options.size || "1024x1024",
    cost_usd: 0,
    background_origin: options.background_origin || "ia",
    files,
    storage: {
      provider,
      keys: {
        fundo: `${course.slug}/fundo`,
        card: `${course.slug}/card`,
        whatsapp: `${course.slug}/whatsapp`,
      },
    },
    urls: {
      fundo: null,
      card: null,
      whatsapp: null,
    },
    hashes: {
      fundo: null,
      card: null,
      whatsapp: null,
    },
    status: "pendente",
    timestamps: {},
    error: null,
    attempts: 0,
  };
}

function readMetadata(catalogDir, slug) {
  const file = metadataPath(catalogDir, slug);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeMetadataAtomic(catalogDir, slug, metadata) {
  const file = metadataPath(catalogDir, slug);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

async function updateMetadataUrls(metadata, provider) {
  if (!provider || !provider.getPublicUrl) return;
  metadata.urls.fundo = await provider.getPublicUrl(metadata.storage.keys.fundo);
  metadata.urls.card = await provider.getPublicUrl(metadata.storage.keys.card);
  metadata.urls.whatsapp = await provider.getPublicUrl(
    metadata.storage.keys.whatsapp
  );
}

function listMetadata(catalogDir) {
  const dir = catalogDir || getCatalogDir();
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(dir, entry.name, "metadata.json");
    if (!fs.existsSync(metaFile)) continue;
    try {
      result.push(JSON.parse(fs.readFileSync(metaFile, "utf8")));
    } catch {
      // ignora metadata corrompido
    }
  }
  return result;
}

module.exports = {
  getCatalogDir,
  metadataPath,
  sha256,
  createMetadata,
  readMetadata,
  writeMetadata: writeMetadataAtomic,
  updateMetadataUrls,
  listMetadata,
};
