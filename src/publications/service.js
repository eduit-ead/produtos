/**
 * Publicação manual da imagem principal de um registro.
 * A URL depende só de collectionId e itemId. O PNG do histórico não é sobrescrito.
 */

const crypto = require("crypto");
const { sanitizeCollectionId } = require("../collections/schema");
const { usesPostgres } = require("../db/data-source-mode");
const { exposeError } = require("../db/database-name");
const { withTransaction } = require("../db/postgres");
const { getRecord, patchRecordFields } = require("../db/collections-repository");
const { createStorageProvider } = require("../storage");
const { getCatalogDir } = require("../batch/metadata");

const SQL = {
  lockRecord: `SELECT item_id, slug, source_key, title, fields, record
     FROM collection_records
     WHERE collection_id = $1 AND item_id = $2
     FOR UPDATE`,
  lockPublication: `SELECT collection_id, item_id, public_id, public_url, finished_piece_id, file_key, version, created_at, updated_at
     FROM published_images
     WHERE collection_id = $1 AND item_id = $2
     FOR UPDATE`,
  insertPublication: `INSERT INTO published_images (
       collection_id, item_id, public_id, public_url, finished_piece_id, file_key, version, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
  updatePublication: `UPDATE published_images
     SET finished_piece_id = $3, file_key = $4, version = $5, updated_at = $6::timestamptz
     WHERE collection_id = $1 AND item_id = $2 AND version = $7`,
  insertVersion: `INSERT INTO published_image_versions (
       collection_id, item_id, version, finished_piece_id, file_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
  selectCurrent: `SELECT collection_id, item_id, public_id, public_url, finished_piece_id, file_key, version, created_at, updated_at
     FROM published_images
     WHERE collection_id = $1 AND item_id = $2`,
};

let storageOverride = null;

function setStorageForTests(storage) {
  storageOverride = storage || null;
}

function storage() {
  if (storageOverride) return storageOverride;
  return createStorageProvider({ baseDir: getCatalogDir() });
}

function requirePostgres() {
  if (!usesPostgres()) {
    throw exposeError("Publicação de imagens exige DATA_SOURCE=postgres.", 400);
  }
}

function permanentPath(collectionId, itemId) {
  return `/api/public/images/${encodeURIComponent(collectionId)}/${encodeURIComponent(itemId)}`;
}

function publicIdFor(collectionId, itemId) {
  return `pub:${collectionId}:${itemId}`;
}

function versionFileKey(collectionId, itemId, version, pieceId) {
  const hash = crypto.createHash("sha256")
    .update(`${collectionId}\0${itemId}\0${version}\0${pieceId}`)
    .digest("hex")
    .slice(0, 20);
  return `published-images/v${version}-${hash}.png`;
}

function contentTypeFor(buffer, fileKey) {
  if (buffer && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  const lower = String(fileKey || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

function view(row) {
  if (!row) return null;
  return {
    collectionId: row.collection_id,
    itemId: row.item_id,
    publicId: row.public_id,
    publicUrl: row.public_url,
    finishedPieceId: row.finished_piece_id,
    fileKey: row.file_key,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function missingLink() {
  return {
    ok: false,
    code: "missing-link",
    message: "Esta peça não está vinculada a um registro. Identifique o registro de destino antes de publicar.",
  };
}

async function resolveTarget(piece) {
  const collectionId = sanitizeCollectionId(piece?.collectionId || "");
  const itemId = sanitizeCollectionId(piece?.itemId || "");
  if (!collectionId || !itemId) return { error: missingLink() };
  requirePostgres();
  const record = await getRecord(collectionId, itemId);
  if (!record) {
    return {
      error: {
        ok: false,
        code: "missing-record",
        message: "Registro de destino não encontrado. Identifique o registro antes de publicar.",
      },
    };
  }
  return { collectionId, itemId: record.id, record };
}

async function getPublication(collectionId, itemId) {
  const { query } = require("../db/postgres");
  const result = await query(SQL.selectCurrent, [collectionId, itemId]);
  return result.rows[0] || null;
}

async function preview(piece, { findPiece } = {}) {
  const target = await resolveTarget(piece);
  if (target.error) return target.error;
  const current = await getPublication(target.collectionId, target.itemId);
  let pieceTitle = null;
  if (current && findPiece) {
    const published = await findPiece(current.finished_piece_id);
    pieceTitle = published?.title || current.finished_piece_id;
  }
  return {
    ok: true,
    collectionId: target.collectionId,
    itemId: target.itemId,
    recordTitle: target.record.title || target.itemId,
    pieceTitle: piece.title || piece.id,
    publication: current ? {
      publicUrl: current.public_url,
      finishedPieceId: current.finished_piece_id,
      version: Number(current.version),
      pieceTitle,
    } : null,
  };
}

async function attach(pieces) {
  if (!usesPostgres()) return pieces;
  const attached = [];
  for (const piece of pieces) {
    const collectionId = sanitizeCollectionId(piece.collectionId || "");
    const itemId = sanitizeCollectionId(piece.itemId || "");
    let publication = null;
    if (collectionId && itemId) {
      const record = await getRecord(collectionId, itemId);
      if (record) {
        const current = await getPublication(collectionId, record.id);
        if (current) {
          publication = {
            publicUrl: current.public_url,
            finishedPieceId: current.finished_piece_id,
            version: Number(current.version),
          };
        }
      }
    }
    attached.push({ ...piece, publication });
  }
  return attached;
}

async function publish(piece, { baseUrl }) {
  if (!piece?.id || !piece.fileKey) {
    throw exposeError("Peça finalizada inválida.", 400);
  }
  if (typeof piece.fileKey !== "string" || piece.fileKey.includes("..") || pathSeemsArbitrary(piece.fileKey)) {
    throw exposeError("Arquivo da peça inválido.", 400);
  }
  const target = await resolveTarget(piece);
  if (target.error) {
    const err = exposeError(target.error.message, 400);
    err.code = target.error.code;
    throw err;
  }
  const origin = String(baseUrl || "").replace(/\/$/, "");
  if (!origin) throw exposeError("URL pública de base ausente.", 400);

  const bytes = await storage().read(piece.fileKey);
  const now = new Date().toISOString();
  let writtenKey = null;

  try {
    return await withTransaction(async (client) => {
      const lockedRecord = await client.query(SQL.lockRecord, [target.collectionId, target.itemId]);
      if (!lockedRecord.rows[0]) {
        throw exposeError("Registro de destino não encontrado. Identifique o registro antes de publicar.", 400);
      }
      const currentResult = await client.query(SQL.lockPublication, [target.collectionId, target.itemId]);
      const current = currentResult.rows[0] || null;
      if (current && current.finished_piece_id === piece.id) {
        return { action: "unchanged", publication: view(current), recordTitle: target.record.title || target.itemId };
      }

      const version = current ? Number(current.version) + 1 : 1;
      const fileKey = versionFileKey(target.collectionId, target.itemId, version, piece.id);
      writtenKey = fileKey;
      await storage().save(fileKey, bytes, { contentType: contentTypeFor(bytes, fileKey) });

      const publicUrl = current ? current.public_url : `${origin}${permanentPath(target.collectionId, target.itemId)}`;
      try {
        if (!current) {
          await client.query(SQL.insertPublication, [
            target.collectionId,
            target.itemId,
            publicIdFor(target.collectionId, target.itemId),
            publicUrl,
            piece.id,
            fileKey,
            version,
            now,
            now,
          ]);
        } else {
          const updated = await client.query(SQL.updatePublication, [
            target.collectionId,
            target.itemId,
            piece.id,
            fileKey,
            version,
            now,
            current.version,
          ]);
          if (updated.rowCount === 0) {
            throw exposeError("A publicação foi alterada ao mesmo tempo. Tente novamente.", 409);
          }
        }
        await client.query(SQL.insertVersion, [
          target.collectionId,
          target.itemId,
          version,
          piece.id,
          fileKey,
          now,
        ]);
        await patchRecordFields(target.collectionId, target.itemId, {
          imagem_url: publicUrl,
          imagem_status: "publicada",
          imagem_publicada_em: now,
        }, client);
      } catch (err) {
        await storage().delete(fileKey).catch(() => {});
        writtenKey = null;
        throw err;
      }

      const saved = await client.query(SQL.selectCurrent, [target.collectionId, target.itemId]);
      return {
        action: current ? "replaced" : "created",
        publication: view(saved.rows[0]),
        recordTitle: target.record.title || target.itemId,
      };
    });
  } catch (err) {
    if (writtenKey) await storage().delete(writtenKey).catch(() => {});
    throw err;
  }
}

function pathSeemsArbitrary(fileKey) {
  if (fileKey.startsWith("/") || fileKey.startsWith("\\") || /^[a-zA-Z]:/.test(fileKey)) return true;
  return false;
}

async function loadPublishedImage(collectionId, itemId) {
  const safeCollection = sanitizeCollectionId(collectionId || "");
  const safeItem = sanitizeCollectionId(itemId || "");
  if (!safeCollection || !safeItem || !usesPostgres()) return null;
  const current = await getPublication(safeCollection, safeItem);
  if (!current?.file_key || current.file_key.includes("..") || pathSeemsArbitrary(current.file_key)) return null;
  if (!String(current.file_key).startsWith("published-images/")) return null;
  let buffer;
  try {
    buffer = await storage().read(current.file_key);
  } catch {
    return null;
  }
  const updated = current.updated_at instanceof Date ? current.updated_at.toISOString() : String(current.updated_at || "");
  return {
    buffer,
    contentType: contentTypeFor(buffer, current.file_key),
    etag: `"pub-${current.version}-${updated}"`,
    version: Number(current.version),
  };
}

async function sendPublishedImage(req, res) {
  try {
    const image = await loadPublishedImage(req.params.collectionId, req.params.itemId);
    if (!image) return res.status(404).json({ error: "Imagem publicada não encontrada." });
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("ETag", image.etag);
    res.setHeader("Content-Type", image.contentType);
    if (req.headers["if-none-match"] === image.etag) return res.status(304).end();
    res.end(image.buffer);
  } catch (err) {
    const status = err.status || 503;
    res.status(status).json({ error: err.expose ? err.message : "Imagem publicada não encontrada." });
  }
}

function requestBaseUrl(req) {
  const configured = typeof process.env.PUBLIC_BASE_URL === "string" ? process.env.PUBLIC_BASE_URL.trim() : "";
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

module.exports = {
  SQL,
  setStorageForTests,
  permanentPath,
  preview,
  attach,
  publish,
  loadPublishedImage,
  sendPublishedImage,
  requestBaseUrl,
};
