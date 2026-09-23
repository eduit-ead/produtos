/**
 * Finaliza artes já existentes, com o fundo oficial e o template da coleção.
 * Não aprova candidatas, não altera o manifesto e não chama geração de imagem.
 */

const crypto = require("crypto");
const genericProduction = require("./generic-production-service");
const { resolveItemVisual } = require("./visual-resolver");
const finishedPieces = require("../finished-pieces");

function itemIdOf(record, slug) {
  return record.id || record.slug || slug;
}

function titleOf(record, slug) {
  return record.curso || record.title || slug;
}

function officialBackground(record, visual) {
  if (visual?.currentBackgroundKey) return { kind: "approved-file" };
  const url = String(record?.sourceImage || record?.image_url || record?.current_background_url || "").trim();
  if (url) return { kind: "source-image" };
  return null;
}

function pendingCandidate(visual) {
  return !!(visual?.candidateBackgroundKey);
}

function reviewStatus(visual) {
  return visual?.visualStatus === "aguardando_revisao"
    || visual?.visualStatus === "simulacao"
    || visual?.visualStatus === "pronto_revisao";
}

function linkedPieces(pieces, collectionId, itemId) {
  return pieces.filter((piece) => piece.collectionId === collectionId && piece.itemId === itemId);
}

async function describeCourse(collectionId, slug, deps) {
  const record = await deps.getRecord(collectionId, slug);
  if (!record) {
    return { slug, title: slug, blocked: "Curso não encontrado.", official: false, alreadyFinished: false };
  }
  const visual = await deps.resolveVisual(collectionId, slug, record);
  const itemId = itemIdOf(record, slug);
  const pieces = linkedPieces(await deps.listPieces(), collectionId, itemId);
  const official = officialBackground(record, visual);
  const candidate = pendingCandidate(visual);
  const base = {
    slug,
    itemId,
    title: titleOf(record, slug),
    templateId: await deps.templateId(collectionId),
    visualStatus: visual?.visualStatus || "sem_imagem",
    official: !!official,
    officialKind: official?.kind || null,
    candidate,
    pieceId: pieces[0]?.id || null,
  };

  if (pieces.length > 0) {
    return { ...base, alreadyFinished: true, blocked: null, note: null };
  }
  if (!official && candidate) {
    return {
      ...base,
      alreadyFinished: false,
      blocked: "Não há fundo oficial. A imagem em aguardando revisão é só uma fotografia candidata e não será usada sem aprovação.",
      note: null,
    };
  }
  if (!official) {
    return {
      ...base,
      alreadyFinished: false,
      blocked: "Não há fundo oficial associado a este curso.",
      note: null,
    };
  }
  const note = candidate || reviewStatus(visual)
    ? "Aguardando revisão refere-se somente à fotografia candidata. A finalização usa o fundo oficial atual e não altera a candidata nem o status de aprovação."
    : null;
  return { ...base, alreadyFinished: false, blocked: null, note };
}

function summarize(items) {
  return {
    selected: items.length,
    ready: items.filter((item) => item.official && !item.alreadyFinished && !item.blocked),
    blocked: items.filter((item) => item.blocked),
    alreadyFinished: items.filter((item) => item.alreadyFinished),
  };
}

async function planFinalizeExisting(collectionId, slugs, deps = {}) {
  const resolved = withDefaults(deps);
  const unique = [...new Set((slugs || []).map((slug) => String(slug || "").trim()).filter(Boolean))];
  const items = [];
  for (const slug of unique) items.push(await describeCourse(collectionId, slug, resolved));
  return { collectionId, ...summarize(items) };
}

async function finalizeExisting(collectionId, slugs, deps = {}) {
  const resolved = withDefaults(deps);
  const plan = await planFinalizeExisting(collectionId, slugs, resolved);
  const results = [];
  for (const item of plan.ready) {
    try {
      const record = await resolved.getRecord(collectionId, item.slug);
      const background = await resolved.readOfficialBackground(collectionId, item.slug, record);
      const card = await resolved.renderCard(collectionId, item.slug, record);
      const fingerprint = crypto.createHash("sha256")
        .update(collectionId)
        .update("\0")
        .update(item.itemId)
        .update("\0")
        .update(item.templateId || "")
        .update("\0")
        .update(background)
        .update("\0")
        .update(card)
        .digest("hex");
      const saved = await resolved.savePiece({
        collectionId,
        itemId: item.itemId,
        templateId: item.templateId,
        buffer: card,
        fingerprint,
        title: item.title,
        values: {
          curso: record.curso || record.title || "",
          modalidade: record.modalidade || "",
          formacao: record.formacao || "",
          duracao: record.duracao || "",
        },
      });
      results.push({ slug: item.slug, itemId: item.itemId, status: saved.created ? "created" : "unchanged", pieceId: saved.piece.id });
    } catch (err) {
      results.push({
        slug: item.slug,
        itemId: item.itemId,
        title: item.title,
        status: "error",
        message: err.message || "Falha ao finalizar.",
      });
    }
  }
  return {
    collectionId,
    selected: plan.selected,
    finalized: results.filter((item) => item.status === "created").length,
    alreadyFinished: plan.alreadyFinished.length + results.filter((item) => item.status === "unchanged").length,
    blocked: plan.blocked.length,
    errors: results.filter((item) => item.status === "error"),
    results,
  };
}

function withDefaults(deps) {
  return {
    getRecord: deps.getRecord || ((collectionId, slug) => genericProduction.getRecord(collectionId, slug)),
    resolveVisual: deps.resolveVisual || resolveItemVisual,
    listPieces: deps.listPieces || (() => finishedPieces.listRaw()),
    readOfficialBackground: deps.readOfficialBackground || readBackground,
    renderCard: deps.renderCard || ((collectionId, slug, record) => genericProduction.renderOfficialCardBuffer(collectionId, slug, record)),
    savePiece: deps.savePiece || ((input) => finishedPieces.createFromExistingArt(input)),
    templateId: deps.templateId || defaultTemplateId,
  };
}

async function defaultTemplateId(collectionId) {
  if (collectionId === genericProduction.LEGACY_COLLECTION_ID) return genericProduction.LEGACY_TEMPLATE_ID;
  const { loadCollection } = require("../collections/store");
  const collection = await loadCollection(collectionId);
  return collection.defaultTemplateId;
}

async function readBackground(collectionId, slug, record) {
  const { resolveBackgroundBufferForItem } = require("./visual-resolver");
  return resolveBackgroundBufferForItem(collectionId, slug, {
    id: record.id || record.slug || slug,
    sourceImage: record.sourceImage || record.image_url || record.current_background_url || "",
    image_url: record.image_url || record.sourceImage || record.current_background_url || "",
  });
}

module.exports = {
  planFinalizeExisting,
  finalizeExisting,
};
