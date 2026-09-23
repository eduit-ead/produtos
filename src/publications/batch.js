/**
 * Publicação em lote da coleção. Cada curso chama o publish individual.
 */

const { sanitizeCollectionId } = require("../collections/schema");
const { exposeError } = require("../db/database-name");
const { listRecords } = require("../db/collections-repository");
const { listRaw } = require("../finished-pieces/finished-pieces-service");
const publications = require("./service");

const DEFAULT_CONCURRENCY = 3;

function pathSeemsArbitrary(fileKey) {
  return fileKey.startsWith("/") || fileKey.startsWith("\\") || /^[a-zA-Z]:/.test(fileKey);
}

function isFinishedPiece(piece, collectionId) {
  const key = piece?.fileKey;
  if (typeof key !== "string" || !key.startsWith("finished/") || key.includes("..") || pathSeemsArbitrary(key)) {
    return false;
  }
  return sanitizeCollectionId(piece.collectionId || "") === collectionId && sanitizeCollectionId(piece.itemId || "");
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadEligible(collectionId, listPieces) {
  const records = await listRecords(collectionId);
  const pieces = typeof listPieces === "function" ? await listPieces() : listRaw();
  const byItem = new Map(records.map((record) => [record.id, []]));

  for (const piece of pieces) {
    if (!isFinishedPiece(piece, collectionId)) continue;
    if (!(await publications.finishedFileExists(piece.fileKey))) continue;
    const target = await publications.preview(piece);
    if (!target.ok || target.collectionId !== collectionId) continue;
    if (!byItem.has(target.itemId)) continue;
    byItem.get(target.itemId).push({
      id: piece.id,
      title: piece.title || piece.id,
      createdAt: piece.createdAt || piece.finishedAt || "",
      fileKey: piece.fileKey,
      collectionId: target.collectionId,
      itemId: target.itemId,
    });
  }

  return { records, byItem };
}

function pieceView(piece) {
  return { id: piece.id, title: piece.title, createdAt: piece.createdAt };
}

async function planCollectionPublish(collectionId, { listPieces } = {}) {
  const safeId = sanitizeCollectionId(collectionId || "");
  if (!safeId) throw exposeError("Coleção inválida.", 400);
  const { records, byItem } = await loadEligible(safeId, listPieces);
  const ready = [];
  const published = [];
  const missing = [];
  const choices = [];

  for (const record of records) {
    const eligible = byItem.get(record.id) || [];
    const current = await publications.currentPublication(safeId, record.id);
    const base = { itemId: record.id, title: record.title || record.id };
    if (eligible.length === 0) {
      missing.push(base);
      continue;
    }
    if (current) {
      published.push({
        ...base,
        publicUrl: current.publicUrl,
        finishedPieceId: current.finishedPieceId,
        pieces: eligible.map(pieceView),
      });
      continue;
    }
    if (eligible.length > 1) {
      choices.push({ ...base, pieces: eligible.map(pieceView) });
      continue;
    }
    ready.push({ ...base, pieceId: eligible[0].id, pieceTitle: eligible[0].title });
  }

  return {
    collectionId: safeId,
    total: records.length,
    ready,
    published,
    missing,
    choices,
  };
}

function selectedPiece(eligible, choiceId) {
  if (!choiceId) return eligible.length === 1 ? eligible[0] : null;
  return eligible.find((piece) => piece.id === choiceId) || null;
}

async function publishCollection(collectionId, {
  baseUrl,
  replace = false,
  confirmReplace = false,
  choices = {},
  concurrency = DEFAULT_CONCURRENCY,
  listPieces,
} = {}) {
  if (replace && confirmReplace !== true) {
    throw exposeError("Substituir imagens já publicadas exige confirmação explícita.", 400);
  }
  const plan = await planCollectionPublish(collectionId, { listPieces });
  const { byItem } = await loadEligible(plan.collectionId, listPieces);
  const limit = Math.max(1, Math.min(4, Number(concurrency) || DEFAULT_CONCURRENCY));
  const jobs = [];

  for (const recordId of byItem.keys()) {
    const eligible = byItem.get(recordId) || [];
    const choiceId = choices && typeof choices === "object" ? choices[recordId] : "";
    const piece = selectedPiece(eligible, choiceId);
    const published = plan.published.find((item) => item.itemId === recordId);
    if (published && !replace) {
      jobs.push({ itemId: recordId, skip: "alreadyPublished", publicUrl: published.publicUrl });
      continue;
    }
    if (!published && replace) continue;
    if (!piece) {
      jobs.push({ itemId: recordId, skip: eligible.length > 1 ? "needsChoice" : "missing" });
      continue;
    }
    jobs.push({
      itemId: recordId,
      title: piece.title,
      piece: {
        id: piece.id,
        title: piece.title,
        collectionId: piece.collectionId,
        itemId: piece.itemId,
        fileKey: piece.fileKey,
      },
    });
  }

  const summary = {
    published: 0,
    alreadyPublished: plan.published.length,
    missing: plan.missing.length,
    needsChoice: 0,
    replaced: 0,
    errors: [],
    results: [],
  };
  if (replace) summary.alreadyPublished = 0;

  const outcomes = await mapPool(jobs, limit, async (job) => {
    if (job.skip === "alreadyPublished") {
      return { itemId: job.itemId, status: "alreadyPublished", publicUrl: job.publicUrl };
    }
    if (job.skip === "missing") {
      return { itemId: job.itemId, status: "missing" };
    }
    if (job.skip === "needsChoice") {
      return { itemId: job.itemId, status: "needsChoice" };
    }
    try {
      const result = await publications.publish(job.piece, { baseUrl });
      return {
        itemId: job.itemId,
        status: result.action,
        publicUrl: result.publication.publicUrl,
      };
    } catch (err) {
      return {
        itemId: job.itemId,
        status: "error",
        message: err.expose ? err.message : "Falha ao publicar este curso.",
      };
    }
  });

  for (const outcome of outcomes) {
    summary.results.push(outcome);
    if (outcome.status === "created") summary.published += 1;
    else if (outcome.status === "replaced") summary.replaced += 1;
    else if (outcome.status === "unchanged") summary.alreadyPublished += 1;
    else if (outcome.status === "needsChoice") summary.needsChoice += 1;
    else if (outcome.status === "error") {
      summary.errors.push({ itemId: outcome.itemId, message: outcome.message });
    }
  }

  summary.missing = plan.missing.length;
  summary.needsChoice = outcomes.filter((item) => item.status === "needsChoice").length;
  if (!replace) summary.alreadyPublished = plan.published.length;

  return { collectionId: plan.collectionId, ...summary };
}

module.exports = {
  planCollectionPublish,
  publishCollection,
};
