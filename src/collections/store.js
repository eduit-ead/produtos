/**
 * Acesso às coleções e registros.
 * DATA_SOURCE=files usa os arquivos atuais.
 * DATA_SOURCE=postgres usa o repositório e não cai para arquivo se o banco falhar.
 */

const fileStore = require("./manager");
const { usesPostgres, assertPostgresConfigured } = require("../db/data-source-mode");
const repo = require("../db/collections-repository");
const { getFileDataSource } = require("../data-sources");
const { exposeError } = require("../db/database-name");

function assertMode() {
  if (usesPostgres()) assertPostgresConfigured();
}

async function listCollections(options) {
  assertMode();
  if (!usesPostgres()) return fileStore.listCollections(options);
  return repo.listCollections(options);
}

async function loadCollection(id) {
  assertMode();
  if (!usesPostgres()) return fileStore.loadCollection(id);
  return repo.requireCollection(id);
}

async function saveCollection(collection, options) {
  assertMode();
  if (!usesPostgres()) return fileStore.saveCollection(collection);
  const saved = await repo.saveCollection(collection, options || { onConflict: "replace" });
  return saved.collection;
}

async function deleteCollection(id) {
  assertMode();
  if (!usesPostgres()) return fileStore.deleteCollection(id);
  await repo.deleteCollection(id);
}

async function archiveCollection(id, archived = true) {
  assertMode();
  if (!usesPostgres()) return fileStore.archiveCollection(id, archived);
  const collection = await repo.requireCollection(id);
  collection.archived = archived;
  const saved = await repo.saveCollection(collection, { onConflict: "replace" });
  return saved.collection;
}

async function duplicateCollection(id) {
  assertMode();
  const original = await loadCollection(id);
  const newId = `${original.id}-copia-${Date.now()}`;
  const copy = {
    ...original,
    id: newId,
    name: `${original.name} (cópia)`,
    archived: false,
    createdAt: new Date().toISOString(),
  };
  const saved = await saveCollection(copy, { onConflict: "replace" });
  if (usesPostgres()) await repo.duplicateRecords(original.id, newId);
  return saved;
}

async function listRecords(id, page = null) {
  const collection = await loadCollection(id);
  if (usesPostgres()) return repo.listRecords(collection.id, page || {});
  const records = await getFileDataSource(collection).listRecords();
  if (!page) return records;
  return {
    records: records.slice(page.offset, page.offset + page.limit),
    total: records.length,
    limit: page.limit,
    offset: page.offset,
  };
}

async function importRecordsFromFile(collection, { onConflict = "merge" } = {}) {
  assertMode();
  if (!usesPostgres()) {
    throw exposeError("Importação para o PostgreSQL exige DATA_SOURCE=postgres.", 400);
  }
  const records = await getFileDataSource(collection).listRecords();
  await saveCollection(collection, { onConflict: "replace" });
  return repo.importRecords(collection, records, { onConflict });
}

module.exports = {
  usesPostgres,
  listCollections,
  loadCollection,
  saveCollection,
  deleteCollection,
  archiveCollection,
  duplicateCollection,
  listRecords,
  importRecordsFromFile,
};
