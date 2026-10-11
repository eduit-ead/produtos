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
const { RUNTIME } = require("../config/runtime");

function getCatalogDir() {
  return process.env.AI_CATALOG_DIR
    ? path.resolve(process.env.AI_CATALOG_DIR)
    : RUNTIME.catalogDir;
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

function storageKeysForCourse(slug, collectionId) {
  const generic = collectionId && collectionId !== "graduacao-cruzeiro";
  const build = (type) => (generic ? `${collectionId}/${slug}/${type}` : `${slug}/${type}`);
  return {
    fundo: build("fundo"),
    card: build("card"),
    whatsapp: build("whatsapp"),
  };
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
      keys: storageKeysForCourse(course.slug, options.collectionId),
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
  const content = JSON.stringify(metadata, null, 2);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      try {
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
        return;
      } catch {}
    }
    fs.writeFileSync(file, content, "utf8");
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function versionedAssetUrl(url, hash) {
  if (!url) return url;
  const version = hash === undefined || hash === null ? "" : String(hash).trim();
  if (!version) return url;
  const base = String(url).split("?")[0];
  return `${base}?v=${encodeURIComponent(version)}`;
}

async function updateMetadataUrls(metadata, provider) {
  if (!provider || !provider.getPublicUrl) return;
  const keys = metadata.storage?.keys || {};
  const hashes = metadata.hashes || {};
  metadata.urls = metadata.urls || {};
  metadata.urls.fundo = versionedAssetUrl(await provider.getPublicUrl(keys.fundo), hashes.fundo);
  metadata.urls.card = versionedAssetUrl(await provider.getPublicUrl(keys.card), hashes.card);
  metadata.urls.whatsapp = versionedAssetUrl(
    await provider.getPublicUrl(keys.whatsapp),
    hashes.whatsapp
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
  storageKeysForCourse,
  readMetadata,
  writeMetadata: writeMetadataAtomic,
  versionedAssetUrl,
  updateMetadataUrls,
  listMetadata,
};
