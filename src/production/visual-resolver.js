/**
 * Resolvedor compartilhado do visual atual de um item.
 *
 * Prioridade:
 * 1. card/fundo explicitamente aprovado mais recentemente;
 * 2. card/fundo produzido mais recentemente e pronto para revisão;
 * 3. imagem configurada na coleção/manifesto;
 * 4. imagem original da fonte de dados;
 * 5. sem imagem.
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
  return studioMetas.find((m) => m.collectionId === collectionId && (m.itemId === id || m.itemId === null)) || null;
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

  // 1. Aprovado
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

  // 2. Candidatos produzidos
  const candidates = [];

  if (batchMeta?.storage?.keys) {
    candidates.push({
      source: "batch",
      backgroundKey: batchMeta.storage.keys.fundo,
      cardKey: batchMeta.storage.keys.card,
      whatsappKey: batchMeta.storage.keys.whatsapp,
      updatedAt: batchMeta.updatedAt,
      generatedAt: batchMeta.timestamps?.generated_at,
      status: batchMeta.status,
      dryRun: batchMeta.dryRun,
    });
  }

  if (entry.backgroundPath && entry.cardPath) {
    candidates.push({
      source: entry.selectedBackground === "upload" ? "upload" : "batch",
      backgroundKey: entry.backgroundPath,
      cardKey: entry.cardPath,
      whatsappKey: entry.whatsappPath || `${path.dirname(entry.cardPath)}/${slug}-whatsapp.jpg`,
      updatedAt: entry.updatedAt,
      generatedAt: entry.generatedAt || entry.renderedAt,
      status: entry.status,
      dryRun: entry.dryRun,
    });
  }

  if (studioMeta?.storage?.key) {
    const studioBackgroundKey = studioMeta.storage.key;
    // Card do estúdio ainda não existe por padrão; aqui só registramos o fundo como candidato.
    candidates.push({
      source: "studio",
      backgroundKey: studioBackgroundKey,
      cardKey: null,
      whatsappKey: null,
      updatedAt: studioMeta.generatedAt,
      generatedAt: studioMeta.generatedAt,
      status: "gerado",
      dryRun: false,
      runId: studioMeta.runId,
    });
  }

  // Filtra candidatos com background válido
  const validCandidates = [];
  const pendingBackgrounds = [];
  for (const c of candidates) {
    if (!c.backgroundKey) continue;
    const hasBg = await keyExists(storage, c.backgroundKey);
    const hasCard = c.cardKey ? await keyExists(storage, c.cardKey) : false;
    if (hasBg && hasCard) {
      validCandidates.push({ ...c, hasBg, hasCard });
    } else if (hasBg) {
      pendingBackgrounds.push({ ...c, hasBg, hasCard });
    }
  }

  const latest = pickLatest(validCandidates);

  if (latest) {
    return {
      visualStatus: latest.status === "pronto_revisao" || latest.status === "gerado" || latest.dryRun
        ? "aguardando_revisao"
        : (latest.status || "aguardando_revisao"),
      currentBackgroundUrl: await keyToPublicUrl(storage, latest.backgroundKey),
      currentCardUrl: await keyToPublicUrl(storage, latest.cardKey),
      currentWhatsAppUrl: latest.whatsappKey && (await keyExists(storage, latest.whatsappKey))
        ? await keyToPublicUrl(storage, latest.whatsappKey)
        : null,
      candidateBackgroundUrl: await keyToPublicUrl(storage, latest.backgroundKey),
      candidateCardUrl: await keyToPublicUrl(storage, latest.cardKey),
      visualUpdatedAt: latest.updatedAt || latest.generatedAt || null,
      visualSource: latest.source,
      approvedVisual: null,
      backgroundKey: latest.backgroundKey,
      cardKey: latest.cardKey,
      whatsappKey: latest.whatsappKey || null,
    };
  }

  // Fundo gerado isolado (sem card) ainda é mostrado como candidato, mas não muda o status atual.
  const latestBg = pickLatest(pendingBackgrounds);
  if (latestBg) {
    return {
      visualStatus: "original",
      currentBackgroundUrl: null,
      currentCardUrl: null,
      currentWhatsAppUrl: null,
      candidateBackgroundUrl: await keyToPublicUrl(storage, latestBg.backgroundKey),
      candidateCardUrl: null,
      visualUpdatedAt: latestBg.updatedAt || latestBg.generatedAt || null,
      visualSource: latestBg.source,
      approvedVisual: null,
      backgroundKey: latestBg.backgroundKey,
      cardKey: null,
      whatsappKey: null,
    };
  }

  // 3. Imagem original da fonte de dados
  const originalUrl = record?.sourceImage || record?.image_url || null;
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
  if (!visual.backgroundKey) {
    if (record?.sourceImage || record?.image_url) {
      const { getImageBuffer } = require("../image-cache");
      return getImageBuffer(record.sourceImage || record.image_url);
    }
    throw new Error("Nenhum fundo disponível para renderizar.");
  }
  const catalogDir = catalogDirFor(collectionId);
  const storage = createStorageProvider({ baseDir: catalogDir });
  return storage.read(visual.backgroundKey);
}

module.exports = {
  resolveItemVisual,
  resolveBackgroundBufferForItem,
  ensureManifest,
  getManifestEntry,
  listStudioMetadata,
  findStudioMetadataForItem,
};
