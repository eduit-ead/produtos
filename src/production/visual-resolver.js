/**
 * Resolvedor compartilhado do visual atual de um item.
 *
 * Regras:
 * - current_* / current*Key = somente imagem oficial: approvedVisual ou imagem original da fonte.
 * - candidate_* / candidate*Key = nova versão ainda não aprovada.
 * - nunca usa candidato pendente como imagem atual automaticamente.
 */

const fs = require("fs");
const path = require("path");
const { createStorageProvider } = require("../storage");
const { readMetadata, getCatalogDir } = require("../batch/metadata");

const LEGACY_COLLECTION_ID = "graduacao-cruzeiro";

function catalogDirFor(collectionId) {
  const base = getCatalogDir();
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
  if (!key) return null;
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

  const originalUrl = record?.sourceImage || record?.image_url || null;

  // 1. Aprovado oficial
  const approvedVisual = entry.approvedVisual || null;
  if (approvedVisual && await keyExists(storage, approvedVisual.backgroundKey) && await keyExists(storage, approvedVisual.cardKey)) {
    const approvedWhatsAppUrl = approvedVisual.whatsappKey && (await keyExists(storage, approvedVisual.whatsappKey))
      ? await keyToPublicUrl(storage, approvedVisual.whatsappKey)
      : null;
    return {
      visualStatus: "aprovado",
      visualSource: approvedVisual.source || "batch",
      visualUpdatedAt: approvedVisual.updatedAt || approvedVisual.approvedAt || null,
      approvedVisual,
      currentBackgroundKey: approvedVisual.backgroundKey,
      currentCardKey: approvedVisual.cardKey,
      currentWhatsAppKey: approvedVisual.whatsappKey || null,
      currentBackgroundUrl: await keyToPublicUrl(storage, approvedVisual.backgroundKey),
      currentCardUrl: await keyToPublicUrl(storage, approvedVisual.cardKey),
      currentWhatsAppUrl: approvedWhatsAppUrl,
      candidateBackgroundKey: null,
      candidateCardKey: null,
      candidateWhatsAppKey: null,
      candidateBackgroundUrl: null,
      candidateCardUrl: null,
      candidateWhatsAppUrl: null,
      candidateSource: null,
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
  if (originalUrl) {
    const candidateBackgroundUrl = latestCandidate ? await keyToPublicUrl(storage, latestCandidate.backgroundKey) : null;
    const candidateCardUrl = latestCandidate?.cardKey && (await keyExists(storage, latestCandidate.cardKey))
      ? await keyToPublicUrl(storage, latestCandidate.cardKey)
      : null;
    const candidateWhatsAppUrl = latestCandidate?.whatsappKey && (await keyExists(storage, latestCandidate.whatsappKey))
      ? await keyToPublicUrl(storage, latestCandidate.whatsappKey)
      : null;

    return {
      visualStatus: latestCandidate ? (latestCandidate.dryRun === true ? "simulacao" : "aguardando_revisao") : "original",
      visualSource: "spreadsheet",
      visualUpdatedAt: latestCandidate ? (latestCandidate.updatedAt || latestCandidate.generatedAt || null) : null,
      approvedVisual: null,
      currentBackgroundKey: null,
      currentCardKey: null,
      currentWhatsAppKey: null,
      currentBackgroundUrl: originalUrl,
      currentCardUrl: null,
      currentWhatsAppUrl: null,
      candidateBackgroundKey: latestCandidate?.backgroundKey || null,
      candidateCardKey: latestCandidate?.cardKey || null,
      candidateWhatsAppKey: latestCandidate?.whatsappKey || null,
      candidateBackgroundUrl,
      candidateCardUrl,
      candidateWhatsAppUrl,
      candidateSource: latestCandidate?.source || null,
      backgroundKey: null,
      cardKey: null,
      whatsappKey: null,
    };
  }

  // 3. Apenas candidato, sem imagem original
  if (latestCandidate) {
    return {
      visualStatus: latestCandidate.dryRun === true ? "simulacao" : "aguardando_revisao",
      visualSource: null,
      visualUpdatedAt: latestCandidate.updatedAt || latestCandidate.generatedAt || null,
      approvedVisual: null,
      currentBackgroundKey: null,
      currentCardKey: null,
      currentWhatsAppKey: null,
      currentBackgroundUrl: null,
      currentCardUrl: null,
      currentWhatsAppUrl: null,
      candidateBackgroundKey: latestCandidate.backgroundKey,
      candidateCardKey: latestCandidate.cardKey || null,
      candidateWhatsAppKey: latestCandidate.whatsappKey || null,
      candidateBackgroundUrl: await keyToPublicUrl(storage, latestCandidate.backgroundKey),
      candidateCardUrl: latestCandidate.cardKey && (await keyExists(storage, latestCandidate.cardKey))
        ? await keyToPublicUrl(storage, latestCandidate.cardKey)
        : null,
      candidateWhatsAppUrl: latestCandidate.whatsappKey && (await keyExists(storage, latestCandidate.whatsappKey))
        ? await keyToPublicUrl(storage, latestCandidate.whatsappKey)
        : null,
      candidateSource: latestCandidate.source,
      backgroundKey: null,
      cardKey: null,
      whatsappKey: null,
    };
  }

  // 4. Sem imagem
  return {
    visualStatus: "sem_imagem",
    visualSource: null,
    visualUpdatedAt: null,
    approvedVisual: null,
    currentBackgroundKey: null,
    currentCardKey: null,
    currentWhatsAppKey: null,
    currentBackgroundUrl: null,
    currentCardUrl: null,
    currentWhatsAppUrl: null,
    candidateBackgroundKey: null,
    candidateCardKey: null,
    candidateWhatsAppKey: null,
    candidateBackgroundUrl: null,
    candidateCardUrl: null,
    candidateWhatsAppUrl: null,
    candidateSource: null,
    backgroundKey: null,
    cardKey: null,
    whatsappKey: null,
  };
}

async function resolveBackgroundBufferForItem(collectionId, slug, record) {
  const visual = await resolveItemVisual(collectionId, slug, record);
  if (visual.currentBackgroundKey) {
    const catalogDir = catalogDirFor(collectionId);
    const storage = createStorageProvider({ baseDir: catalogDir });
    return storage.read(visual.currentBackgroundKey);
  }
  const originalUrl = record?.sourceImage || record?.image_url || null;
  if (originalUrl) {
    const { getImageBuffer } = require("../image-cache");
    return getImageBuffer(originalUrl);
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
