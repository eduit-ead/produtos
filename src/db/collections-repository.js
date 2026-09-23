/**
 * Persistência de coleções e registros no PostgreSQL.
 * Reutiliza o pool de src/db/postgres.js. Não faz fallback para arquivos.
 */

const { query, withTransaction } = require("./postgres");
const { assertConnectedDatabase } = require("./migrate");
const { exposeError } = require("./database-name");
const {
  assertPolicy,
  resolveConflict,
  mergeFields,
  recordIdentity,
  sourceUpdatedAt,
} = require("./record-merge");

const SQL = {
  listCollections: `SELECT id, name, config, default_template_id, archived, created_at, updated_at
     FROM collections`,
  getCollection: `SELECT id, name, config, default_template_id, archived, created_at, updated_at
     FROM collections WHERE id = $1`,
  insertCollection: `INSERT INTO collections (
       id, name, config, default_template_id, archived, created_at, updated_at
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz, $7::timestamptz)`,
  updateCollection: `UPDATE collections
     SET name = $2, config = $3::jsonb, default_template_id = $4, archived = $5, updated_at = $6::timestamptz
     WHERE id = $1`,
  deleteCollection: "DELETE FROM collections WHERE id = $1",
  listRecords: `SELECT item_id, slug, source_key, title, fields, record, created_at, updated_at
     FROM collection_records
     WHERE collection_id = $1
     ORDER BY item_id`,
  listRecordsPage: `SELECT item_id, slug, source_key, title, fields, record, created_at, updated_at
     FROM collection_records
     WHERE collection_id = $1
     ORDER BY item_id
     LIMIT $2 OFFSET $3`,
  countRecords: "SELECT COUNT(*)::int AS count FROM collection_records WHERE collection_id = $1",
  getRecord: `SELECT item_id, slug, source_key, title, fields, record, created_at, updated_at
     FROM collection_records
     WHERE collection_id = $1 AND (item_id = $2 OR slug = $2 OR source_key = $2)
     ORDER BY CASE WHEN item_id = $2 THEN 0 WHEN slug = $2 THEN 1 ELSE 2 END
     LIMIT 1`,
  insertRecord: `INSERT INTO collection_records (
       collection_id, item_id, slug, source_key, title, fields, record, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz, $9::timestamptz)`,
  updateRecord: `UPDATE collection_records
     SET slug = $3, source_key = $4, title = $5, fields = $6::jsonb, record = $7::jsonb, updated_at = $8::timestamptz
     WHERE collection_id = $1 AND item_id = $2`,
};

let databaseReady = null;

function resetDatabaseGuardForTests() {
  databaseReady = null;
}

async function ready() {
  if (!databaseReady) databaseReady = assertConnectedDatabase();
  return databaseReady;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function collectionFromRow(row) {
  if (!row) return null;
  const config = asObject(row.config);
  return {
    ...config,
    id: row.id,
    name: row.name,
    archived: !!row.archived,
    defaultTemplateId: row.default_template_id || config.defaultTemplateId,
    createdAt: config.createdAt || toIso(row.created_at),
    updatedAt: toIso(row.updated_at) || config.updatedAt || null,
  };
}

function summaryFromCollection(collection) {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description || "",
    sourceType: collection.source?.type,
    defaultTemplateId: collection.defaultTemplateId,
    archived: !!collection.archived,
    updatedAt: collection.updatedAt,
  };
}

function apiRecordFromRow(row) {
  const stored = asObject(row.record);
  const fields = asObject(row.fields);
  return {
    ...stored,
    id: row.item_id,
    slug: row.slug,
    sourceKey: row.source_key || null,
    title: row.title || stored.title || "",
    fields: Object.keys(fields).length > 0 ? fields : (stored.fields || {}),
    prompt: stored.prompt || "",
    sourceImage: stored.sourceImage || "",
    sourceStatus: stored.sourceStatus || "",
  };
}

function notFound(id) {
  return exposeError(`Coleção "${id}" não encontrada.`, 404);
}

async function listCollections({ includeArchived = false } = {}) {
  await ready();
  const result = await query(SQL.listCollections);
  return result.rows
    .map(collectionFromRow)
    .filter((collection) => includeArchived || !collection.archived)
    .map(summaryFromCollection)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function getCollection(id) {
  await ready();
  const result = await query(SQL.getCollection, [id]);
  return collectionFromRow(result.rows[0]);
}

async function requireCollection(id) {
  const collection = await getCollection(id);
  if (!collection) throw notFound(id);
  return collection;
}

function collectionParams(collection, now) {
  return [
    collection.id,
    collection.name,
    JSON.stringify(collection),
    collection.defaultTemplateId || null,
    !!collection.archived,
    collection.createdAt || now,
    now,
  ];
}

async function saveCollection(collection, { onConflict = "replace" } = {}) {
  assertPolicy(onConflict);
  await ready();
  const now = new Date().toISOString();
  const existing = await getCollection(collection.id);
  const decision = resolveConflict(
    existing ? { updated_at: existing.updatedAt } : null,
    { updatedAt: collection.updatedAt },
    onConflict === "replace" ? "replace" : onConflict
  );
  if (decision === "skip") return { action: "skip", collection: existing };

  const next = {
    ...collection,
    createdAt: existing?.createdAt || collection.createdAt || now,
    updatedAt: now,
  };
  const params = collectionParams(next, now);
  if (!existing) {
    await query(SQL.insertCollection, params);
    return { action: "insert", collection: next };
  }
  await query(SQL.updateCollection, [
    next.id,
    next.name,
    JSON.stringify(next),
    next.defaultTemplateId || null,
    !!next.archived,
    now,
  ]);
  return { action: "update", collection: next };
}

async function deleteCollection(id) {
  await ready();
  await query(SQL.deleteCollection, [id]);
}

async function listRecords(collectionId, { limit = null, offset = 0 } = {}) {
  await ready();
  if (limit == null) {
    const result = await query(SQL.listRecords, [collectionId]);
    return result.rows.map(apiRecordFromRow);
  }
  const result = await query(SQL.listRecordsPage, [collectionId, limit, offset]);
  const count = await query(SQL.countRecords, [collectionId]);
  return {
    records: result.rows.map(apiRecordFromRow),
    total: count.rows[0] ? Number(count.rows[0].count) : 0,
    limit,
    offset,
  };
}

async function getRecord(collectionId, itemId) {
  await ready();
  const result = await query(SQL.getRecord, [collectionId, String(itemId)]);
  return result.rows[0] ? apiRecordFromRow(result.rows[0]) : null;
}

function storedRecord(record, fields) {
  return {
    id: record.id,
    title: record.title || "",
    slug: record.slug,
    fields,
    prompt: record.prompt || "",
    sourceImage: record.sourceImage || "",
    sourceStatus: record.sourceStatus || "",
  };
}

async function insertOrUpdateRecord(runner, collection, record, policy, now) {
  const identity = recordIdentity(collection, record);
  if (!identity.itemId) return { action: "invalid" };
  const existingResult = await runner.query(SQL.getRecord, [collection.id, identity.itemId]);
  const existing = existingResult.rows[0] || null;
  const decision = resolveConflict(existing, { ...record, updatedAt: sourceUpdatedAt(record) }, policy);
  if (decision === "skip") return { action: "skip", itemId: identity.itemId };

  const fields = decision === "insert"
    ? { ...(record.fields || {}) }
    : mergeFields(asObject(existing.fields), record.fields || {}, policy);
  const payload = storedRecord({ ...record, id: identity.itemId, slug: identity.slug }, fields);
  const sourceKey = identity.sourceKey || existing?.source_key || null;

  if (decision === "insert") {
    await runner.query(SQL.insertRecord, [
      collection.id,
      identity.itemId,
      identity.slug,
      sourceKey,
      payload.title,
      JSON.stringify(fields),
      JSON.stringify(payload),
      now,
      now,
    ]);
    return { action: "insert", itemId: identity.itemId };
  }

  await runner.query(SQL.updateRecord, [
    collection.id,
    existing.item_id,
    identity.slug,
    sourceKey,
    payload.title,
    JSON.stringify(fields),
    JSON.stringify(payload),
    now,
  ]);
  return { action: "update", itemId: existing.item_id };
}

async function importRecords(collection, records, { onConflict = "skip" } = {}) {
  assertPolicy(onConflict);
  await ready();
  const seen = new Set();
  const duplicates = [];
  const unique = [];
  for (const record of records) {
    const identity = recordIdentity(collection, record);
    if (!identity.itemId) continue;
    if (seen.has(identity.itemId)) {
      duplicates.push(identity.itemId);
      continue;
    }
    seen.add(identity.itemId);
    unique.push(record);
  }

  const counts = { inserted: 0, updated: 0, skipped: 0, duplicates: duplicates.length };
  await withTransaction(async (client) => {
    const now = new Date().toISOString();
    for (const record of unique) {
      const result = await insertOrUpdateRecord(client, collection, record, onConflict, now);
      if (result.action === "insert") counts.inserted += 1;
      else if (result.action === "update") counts.updated += 1;
      else counts.skipped += 1;
    }
  });
  return { collectionId: collection.id, ...counts };
}

async function patchRecordFields(collectionId, itemId, patch, runner = null) {
  if (!runner) await ready();
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw exposeError("Campos para atualizar devem ser um objeto.", 400);
  }
  const db = runner || { query };
  const existingResult = await db.query(SQL.getRecord, [collectionId, String(itemId)]);
  const existing = existingResult.rows[0];
  if (!existing) return null;
  const fields = mergeFields(asObject(existing.fields), patch, "merge");
  const record = storedRecord(
    { ...apiRecordFromRow(existing), fields },
    fields
  );
  const now = new Date().toISOString();
  await db.query(SQL.updateRecord, [
    collectionId,
    existing.item_id,
    existing.slug,
    existing.source_key,
    record.title,
    JSON.stringify(fields),
    JSON.stringify(record),
    now,
  ]);
  if (runner) return { ...record, id: existing.item_id, slug: existing.slug, fields };
  return getRecord(collectionId, existing.item_id);
}

async function duplicateRecords(fromId, toId) {
  await ready();
  const records = await listRecords(fromId);
  const target = await requireCollection(toId);
  return importRecords(target, records, { onConflict: "skip" });
}

module.exports = {
  SQL,
  resetDatabaseGuardForTests,
  listCollections,
  getCollection,
  requireCollection,
  saveCollection,
  deleteCollection,
  listRecords,
  getRecord,
  importRecords,
  patchRecordFields,
  duplicateRecords,
  summaryFromCollection,
};
