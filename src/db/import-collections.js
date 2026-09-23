/**
 * Lê as coleções em arquivo e importa para o PostgreSQL.
 * Não altera os arquivos de origem.
 */

const fileStore = require("../collections/manager");
const { validateCollection } = require("../collections/schema");
const { getFileDataSource } = require("../data-sources");
const repo = require("./collections-repository");
const { assertPolicy, recordIdentity } = require("./record-merge");
const { assertConnectedDatabase } = require("./migrate");

async function readCollectionRecords(collection) {
  const source = getFileDataSource(collection);
  return source.listRecords();
}

function countIdentities(collection, records) {
  const seen = new Set();
  let duplicates = 0;
  let valid = 0;
  for (const record of records) {
    const identity = recordIdentity(collection, record);
    if (!identity.itemId) continue;
    if (seen.has(identity.itemId)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity.itemId);
    valid += 1;
  }
  return { valid, duplicates };
}

async function scanFileCollections() {
  const summaries = fileStore.listCollections({ includeArchived: true });
  const items = [];
  for (const summary of summaries) {
    const item = { id: summary.id, name: summary.name, records: 0, duplicates: 0, error: null };
    try {
      const collection = fileStore.loadCollection(summary.id);
      const errors = validateCollection(collection);
      if (errors.length > 0) {
        item.error = errors.join("; ");
        items.push(item);
        continue;
      }
      const records = await readCollectionRecords(collection);
      const counts = countIdentities(collection, records);
      item.records = counts.valid;
      item.duplicates = counts.duplicates;
      item.collection = collection;
      item.loadedRecords = records;
    } catch (err) {
      item.error = err.message || "Falha ao ler a coleção.";
    }
    items.push(item);
  }
  return {
    collections: items.length,
    records: items.reduce((sum, item) => sum + item.records, 0),
    items: items.map(({ id, name, records, duplicates, error }) => ({ id, name, records, duplicates, error })),
    _private: items,
  };
}

function publicReport(scan) {
  return {
    collections: scan.collections,
    records: scan.records,
    items: scan.items,
  };
}

async function applyFileImport(scan, { onConflict = "skip" } = {}) {
  assertPolicy(onConflict);
  await assertConnectedDatabase();
  const results = [];
  for (const item of scan._private) {
    if (item.error || !item.collection) {
      results.push({ id: item.id, name: item.name, status: "erro", error: item.error });
      continue;
    }
    try {
      const saved = await repo.saveCollection(item.collection, { onConflict });
      const imported = await repo.importRecords(item.collection, item.loadedRecords, { onConflict });
      results.push({ id: item.id, name: item.name, status: "ok", collection: saved.action, ...imported });
    } catch (err) {
      results.push({ id: item.id, name: item.name, status: "erro", error: err.message || "Falha ao importar." });
    }
  }
  return results;
}

module.exports = {
  scanFileCollections,
  publicReport,
  applyFileImport,
};
