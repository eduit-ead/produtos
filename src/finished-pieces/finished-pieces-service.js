/**
 * Serviço de histórico de peças finalizadas.
 *
 * Persiste uma cópia imutável do arquivo final (PNG) e um índice com
 * metadados da produção. Reutiliza StorageProvider e o diretório de
 * catálogo existente (output/ai-catalog/finished).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const { createStorageProvider } = require("../storage");
const { getCatalogDir } = require("../batch/metadata");
const { renderSavedTemplate } = require("../template-editor/renderer/render-saved-template");
const { loadCollection } = require("../collections/manager");
const { getDataSource } = require("../data-sources");
const { RUNTIME } = require("../config/runtime");

const FINISHED_DIR = "finished";
const INDEX_FILE = "index.json";

function decodeRuntimeAssets(runtimeAssets = {}) {
  const decoded = {};
  for (const [key, value] of Object.entries(runtimeAssets)) {
    if (typeof value === "string") {
      decoded[key] = Buffer.from(value, "base64");
    } else if (Buffer.isBuffer(value)) {
      decoded[key] = value;
    }
  }
  return decoded;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function storageForFinished() {
  return createStorageProvider({ baseDir: getCatalogDir() });
}

function storageForCollection(collectionId) {
  const baseDir = collectionId === "graduacao-cruzeiro"
    ? getCatalogDir()
    : path.join(getCatalogDir(), collectionId);
  return createStorageProvider({ baseDir });
}

function finishedDir() {
  return path.join(getCatalogDir(), FINISHED_DIR);
}

function indexPath() {
  return path.join(finishedDir(), INDEX_FILE);
}

function ensureFinishedDir() {
  fs.mkdirSync(finishedDir(), { recursive: true });
}

function readIndex() {
  ensureFinishedDir();
  const file = indexPath();
  if (!fs.existsSync(file)) {
    return { pieces: [], version: 1 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { pieces: [], version: 1, ...data };
  } catch {
    return { pieces: [], version: 1 };
  }
}

function writeIndexAtomic(index) {
  ensureFinishedDir();
  const file = indexPath();
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function generateId() {
  return `fp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function fileKeyForId(id) {
  return `${FINISHED_DIR}/${id}.png`;
}

function loadTemplate(templateId) {
  const filePath = path.join(RUNTIME.templatesDir, `${path.basename(templateId)}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function validateRequiredValues(template, values) {
  const missing = [];
  for (const v of template.variables || []) {
    if (!v.required) continue;
    const val = values?.[v.key];
    if (val === undefined || val === null || String(val).trim() === "") {
      missing.push(v.label || v.key);
    }
  }
  return missing;
}

function resolveTitle(values, template) {
  const candidates = [
    values?.titulo_vaga,
    values?.titulo,
    values?.curso,
    values?.nome,
    values?.name,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return template?.name || "Peça finalizada";
}

function resolveRefs(values) {
  return {
    photoRef: values?.imagem_principal || values?.foto || null,
    backgroundRef: values?.imagemFundo || values?.fundo || values?.background || null,
  };
}

function buildRecord({ id, templateId, templateName, values, source, collectionId, itemId, fileKey, dimensions, collectionTitle, approvedVisual }) {
  const now = new Date().toISOString();
  const refs = resolveRefs(values);
  const record = {
    id,
    title: resolveTitle(values, { name: templateName }),
    templateId,
    templateName: templateName || templateId,
    createdAt: now,
    finishedAt: now,
    source,
    collectionId: collectionId || null,
    itemId: itemId || null,
    collectionTitle: collectionTitle || null,
    values: values || {},
    photoRef: refs.photoRef,
    backgroundRef: refs.backgroundRef,
    fileKey,
    format: "png",
    dimensions: {
      width: dimensions?.width || 0,
      height: dimensions?.height || 0,
    },
  };

  if (approvedVisual) {
    record.approvedVisual = {
      collectionId: approvedVisual.collectionId,
      slug: approvedVisual.slug,
      backgroundKey: approvedVisual.backgroundKey || null,
      cardKey: approvedVisual.cardKey,
      whatsappKey: approvedVisual.whatsappKey || null,
      approvedAt: approvedVisual.approvedAt || now,
    };
  }

  return record;
}

async function saveCardCopy(sourceStorage, sourceKey, destStorage, destKey) {
  const buffer = await sourceStorage.read(sourceKey);
  return destStorage.save(destKey, buffer, { contentType: "image/png" });
}

async function createFromRender({ templateId, values, runtimeAssets, source = "criar", collectionId, itemId } = {}) {
  if (!templateId) throw new Error("Template é obrigatório.");
  const template = loadTemplate(templateId);
  if (!template) throw new Error("Template não encontrado.");

  const missing = validateRequiredValues(template, values);
  if (missing.length > 0) {
    throw new Error(`Campos obrigatórios ausentes: ${missing.join(", ")}`);
  }

  const decodedAssets = decodeRuntimeAssets(runtimeAssets);
  const buffer = await renderSavedTemplate(templateId, values || {}, decodedAssets);
  const metadata = await sharp(buffer).metadata();

  const id = generateId();
  const fileKey = fileKeyForId(id);
  const storage = storageForFinished();
  await storage.save(fileKey, buffer, { contentType: "image/png" });

  const record = buildRecord({
    id,
    templateId,
    templateName: template.name,
    values: values || {},
    source,
    collectionId,
    itemId,
    fileKey,
    dimensions: { width: metadata.width, height: metadata.height },
  });

  const index = readIndex();
  index.pieces.unshift(record);
  writeIndexAtomic(index);

  return record;
}

async function getCollectionItemData(collectionId, itemId) {
  try {
    const collection = loadCollection(collectionId);
    if (!collection) return null;
    const ds = getDataSource(collection);
    const records = await ds.listRecords();
    return records.find((r) => r.id === itemId || r.slug === itemId) || null;
  } catch {
    return null;
  }
}

async function createFromBatchApprovedVisual({ collectionId, slug, approvedVisual, manifest, source = "batch" } = {}) {
  if (!approvedVisual?.cardKey) throw new Error("approvedVisual.cardKey é obrigatório.");
  const collectionStorage = storageForCollection(collectionId);
  if (!(await collectionStorage.exists(approvedVisual.cardKey))) {
    throw new Error(`Card finalizado não encontrado: ${approvedVisual.cardKey}`);
  }

  // Idempotência: já existe peça com a mesma chave final?
  const index = readIndex();
  const existing = index.pieces.find((p) => p.approvedVisual?.cardKey === approvedVisual.cardKey);
  if (existing) return existing;

  const deterministicId = `fp-${sha256Hex(`${collectionId}:${slug}:${approvedVisual.cardKey}`).slice(0, 16)}`;
  if (index.pieces.find((p) => p.id === deterministicId)) return index.pieces.find((p) => p.id === deterministicId);

  const recordData = await getCollectionItemData(collectionId, slug);
  const itemValues = recordData?.fields || {};

  const cardBuffer = await collectionStorage.read(approvedVisual.cardKey);
  const dimensions = await sharp(cardBuffer).metadata();

  const id = deterministicId;
  const fileKey = fileKeyForId(id);
  const finishedStorage = storageForFinished();
  await finishedStorage.save(fileKey, cardBuffer, { contentType: "image/png" });

  const record = buildRecord({
    id,
    templateId: approvedVisual.templateId,
    templateName: approvedVisual.templateId,
    values: itemValues,
    source,
    collectionId,
    itemId: recordData?.id || slug,
    fileKey,
    dimensions: { width: dimensions.width, height: dimensions.height },
    collectionTitle: manifest?.name || collectionId,
    approvedVisual,
  });

  index.pieces.unshift(record);
  writeIndexAtomic(index);

  return record;
}

async function list({ page = 1, limit = 20, query = "", templateId = "", source = "", from = "", to = "" } = {}) {
  const index = readIndex();
  let items = [...index.pieces];

  if (query) {
    const q = String(query).toLowerCase();
    items = items.filter((p) => (p.title || "").toLowerCase().includes(q));
  }
  if (templateId) {
    items = items.filter((p) => p.templateId === templateId);
  }
  if (source) {
    items = items.filter((p) => p.source === source);
  }
  if (from) {
    items = items.filter((p) => (p.createdAt || "") >= from);
  }
  if (to) {
    items = items.filter((p) => (p.createdAt || "") <= to);
  }

  items.sort((a, b) => {
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    return tb.localeCompare(ta);
  });

  const total = items.length;
  const start = Math.max(0, (page - 1) * limit);
  const pageItems = items.slice(start, start + limit);

  const storage = storageForFinished();
  const withUrls = await Promise.all(pageItems.map(async (p) => ({
    ...p,
    url: await storage.getPublicUrl(p.fileKey),
  })));

  return { items: withUrls, total, page, limit };
}

async function get(id) {
  const index = readIndex();
  const piece = index.pieces.find((p) => p.id === id);
  if (!piece) return null;
  const storage = storageForFinished();
  return { ...piece, url: await storage.getPublicUrl(piece.fileKey) };
}

async function remove(id) {
  const index = readIndex();
  const idx = index.pieces.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("Peça não encontrada.");
  const [piece] = index.pieces.splice(idx, 1);

  const storage = storageForFinished();
  try {
    await storage.delete(piece.fileKey);
  } catch (err) {
    console.warn("Falha ao remover arquivo da peça:", piece.fileKey, err.message);
  }

  writeIndexAtomic(index);
  return piece;
}

async function duplicateData(id) {
  const piece = await get(id);
  if (!piece) return null;
  return {
    templateId: piece.templateId,
    values: piece.values,
    photoRef: piece.photoRef,
    backgroundRef: piece.backgroundRef,
  };
}

async function migrate() {
  const catalogRoot = getCatalogDir();
  if (!fs.existsSync(catalogRoot)) return { created: 0 };

  const manifests = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.name === "manifest.json") {
        manifests.push(full);
      }
    }
  }
  scan(catalogRoot);

  let created = 0;
  for (const manifestPath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const courses = manifest.courses || {};
    const collectionId = path.relative(catalogRoot, path.dirname(manifestPath)) || "graduacao-cruzeiro";
    for (const [slug, entry] of Object.entries(courses)) {
      const av = entry?.approvedVisual;
      if (!av?.cardKey) continue;
      try {
        const existing = readIndex().pieces.find((p) => p.approvedVisual?.cardKey === av.cardKey);
        if (existing) continue;
        await createFromBatchApprovedVisual({ collectionId, slug, approvedVisual: av, manifest, source: "migration" });
        created++;
      } catch (err) {
        console.warn("Migração ignorada:", collectionId, slug, err.message);
      }
    }
  }

  return { created };
}

module.exports = {
  createFromRender,
  createFromBatchApprovedVisual,
  list,
  get,
  remove,
  duplicateData,
  migrate,
};
