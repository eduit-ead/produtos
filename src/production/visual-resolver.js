/**
 * Resolvedor compartilhado do visual atual de um item.
 *
 * Regras:
 * - current_* = somente imagem oficial: approvedVisual ou imagem original da fonte.
 * - candidate_* = nova versão ainda não aprovada (card+fundo ou fundo isolado).
 * - nunca usa candidato pendente como imagem atual automaticamente.
 */

const fs = require("fs");
const path = require("path");
const { RUNTIME } = require("../config/runtime");
const { createStorageProvider } = require("../storage");
const { readMetadata } = require("../batch/metadata");

const ROOT = path.resolve(__dirname, "..", "..");
const LEGACY_COLLECTION_ID = "graduacao-cruzeiro";

function catalogDirFor(collectionId) {
  const base = process.env.AI_CATALOG_DIR
    ? path.resolve(process.env.AI_CATALOG_DIR)
    : path.join(ROOT, "output", "ai-catalog");
  if (collectionId === LEGACY_COLLECTION_ID) return base;
  const dir = path.join(base, collectionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestFileFor(collectionId) {
  return path.join(catalogDirFor(collectionId), "manifest.json");
}

function ensureManifest(collectionId) {
  const file = manifestFileFor(collectionId);
  if (!fs.existsSync(file)) {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.courses) data.courses = {};
    else if (Array.isArray(data.courses)) {
      const map = {};
      for (const entry of data.courses) {
        if (entry?.slug) map[entry.slug] = entry;
      }
      data.courses = map;
    }
    return data;
  } catch {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
}

function getManifestEntry(manifest, slug) {
  return manifest.courses[slug] || null;
}

async function listStudioMetadata(catalogDir) {
  const dir = path.join(catalogDir, "studio");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "metadata.json");
    if (!fs.existsSync(file)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {}
  }
  return out.sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
}

function findStudioMetadataForItem(studioMetas, collectionId, itemId) {
  const id = itemId || "";
  return studioMetas.find((m) => m.collectionId === collectionId && m.itemId === id) || null;
}

async function keyToPublicUrl(storage, key) {
  return storage.getPublicUrl(key);
}

async function keyExists(storage, key) {
  if (!key) return false;
  try {
    return await storage.exists(key);
  } catch {
    return false;
  }
}

function pickLatest(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || b.approvedAt || b.generatedAt || 0) - new Date(a.updatedAt || a.approvedAt || a.generatedAt || 0))[0] || null;
}

async function resolveItemVisual(collectionId, slug, record) {
  const catalogDir = catalogDirFor(collectionId);
  const storage = createStorageProvider({ baseDir: catalogDir });
  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  const batchMeta = readMetadata(catalogDir, slug) || null;

  const studioMetas = await listStudioMetadata(catalogDir);
  const studioMeta = findStudioMetadataForItem(studioMetas, collectionId, record?.id || slug);

  // 1. Aprovado oficial
  const approvedVisual = entry.approvedVisual || null;
  if (approvedVisual && await keyExists(storage, approvedVisual.backgroundKey) && await keyExists(storage, approvedVisual.cardKey)) {
    return {
      visualStatus: "aprovado",
      currentBackgroundUrl: await keyToPublicUrl(storage, approvedVisual.backgroundKey),
      currentCardUrl: await keyToPublicUrl(storage, approvedVisual.cardKey),
      currentWhatsAppUrl: approvedVisual.whatsappKey && (await keyExists(storage, approvedVisual.whatsappKey))
        ? await keyToPublicUrl(storage, approvedVisual.whatsappKey)
        : null,
      candidateBackgroundUrl: null,
      candidateCardUrl: null,
      visualUpdatedAt: approvedVisual.updatedAt || approvedVisual.approvedAt || null,
      visualSource: approvedVisual.source || "batch",
      approvedVisual,
      backgroundKey: approvedVisual.backgroundKey,
      cardKey: approvedVisual.cardKey,
      whatsappKey: approvedVisual.whatsappKey || null,
    };
  }

  // Coleta candidatos (nunca aprovados)
  const candidates = [];

  if (batchMeta?.storage?.keys) {
    candidates.push({
      source: "batch",
      hasCard: true,
      backgroundKey: batchMeta.storage.keys.fundo,
      cardKey: batchMeta.storage.keys.card,
      whatsappKey: batchMeta.storage.keys.whatsapp,
      updatedAt: batchMeta.updatedAt,
      generatedAt: batchMeta.timestamps?.generated_at,
      dryRun: batchMeta.dryRun,
    });
  }

  if (entry.backgroundPath) {
    candidates.push({
      source: entry.selectedBackground === "upload" ? "upload" : "batch",
      hasCard: !!entry.cardPath,
      backgroundKey: entry.backgroundPath,
      cardKey: entry.cardPath || null,
      whatsappKey: entry.whatsappPath || null,
      updatedAt: entry.updatedAt,
      generatedAt: entry.generatedAt || entry.renderedAt,
      dryRun: entry.dryRun,
    });
  }

  if (studioMeta?.storage?.key) {
    candidates.push({
      source: "studio",
      hasCard: false,
      backgroundKey: studioMeta.storage.key,
      cardKey: null,
      whatsappKey: null,
      updatedAt: studioMeta.generatedAt,
      generatedAt: studioMeta.generatedAt,
      dryRun: studioMeta.dryRun === true,
      runId: studioMeta.runId,
    });
  }

  // Candidatos com fundo realmente existente
  const existingCandidates = [];
  for (const c of candidates) {
    if (!c.backgroundKey) continue;
    if (await keyExists(storage, c.backgroundKey)) {
      existingCandidates.push(c);
    }
  }

  const latestCandidate = pickLatest(existingCandidates);

  // 2. Imagem original da fonte de dados (current oficial quando não há aprovado)
  const originalUrl = record?.sourceImage || record?.image_url || null;

  if (latestCandidate) {
    const isSimulation = latestCandidate.dryRun === true;
    return {
      visualStatus: isSimulation ? "simulacao" : "aguardando_revisao",
      currentBackgroundUrl: originalUrl || null,
      currentCardUrl: null,
      currentWhatsAppUrl: null,
      candidateBackgroundUrl: await keyToPublicUrl(storage, latestCandidate.backgroundKey),
      candidateCardUrl: latestCandidate.cardKey && (await keyExists(storage, latestCandidate.cardKey))
        ? await keyToPublicUrl(storage, latestCandidate.cardKey)
        : null,
      visualUpdatedAt: latestCandidate.updatedAt || latestCandidate.generatedAt || null,
      visualSource: latestCandidate.source,
      approvedVisual: null,
      backgroundKey: latestCandidate.backgroundKey,
      cardKey: latestCandidate.cardKey || null,
      whatsappKey: latestCandidate.whatsappKey || null,
    };
  }

  // 3. Apenas imagem original
  if (originalUrl) {
    return {
      visualStatus: "original",
      currentBackgroundUrl: originalUrl,
      currentCardUrl: null,
      currentWhatsAppUrl: null,
      candidateBackgroundUrl: null,
      candidateCardUrl: null,
      visualUpdatedAt: null,
      visualSource: "spreadsheet",
      approvedVisual: null,
      backgroundKey: null,
      cardKey: null,
      whatsappKey: null,
    };
  }

  // 4. Sem imagem
  return {
    visualStatus: "sem_imagem",
    currentBackgroundUrl: null,
    currentCardUrl: null,
    currentWhatsAppUrl: null,
    candidateBackgroundUrl: null,
    candidateCardUrl: null,
    visualUpdatedAt: null,
    visualSource: null,
    approvedVisual: null,
    backgroundKey: null,
    cardKey: null,
    whatsappKey: null,
  };
}

async function resolveBackgroundBufferForItem(collectionId, slug, record) {
  const visual = await resolveItemVisual(collectionId, slug, record);
  if (visual.visualStatus === "aprovado" && visual.backgroundKey) {
    const catalogDir = catalogDirFor(collectionId);
    const storage = createStorageProvider({ baseDir: catalogDir });
    return storage.read(visual.backgroundKey);
  }
  if (visual.visualStatus === "original" && (record?.sourceImage || record?.image_url)) {
    const { getImageBuffer } = require("../image-cache");
    return getImageBuffer(record.sourceImage || record.image_url);
  }
  throw new Error("Nenhum fundo oficial disponível para renderizar.");
}

module.exports = {
  resolveItemVisual,
  resolveBackgroundBufferForItem,
  ensureManifest,
  getManifestEntry,
  listStudioMetadata,
  findStudioMetadataForItem,
};
