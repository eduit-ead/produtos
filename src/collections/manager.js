/**
 * Gerenciamento de coleções.
 * CRUD, listagem e importação de configurações.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateCollection, sanitizeCollectionId, isSafeRelative, ROOT } = require("./schema");

const COLLECTIONS_DIR = path.join(ROOT, "data", "collections");

function ensureCollectionsDir() {
  fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
}

function collectionPath(id) {
  return path.join(COLLECTIONS_DIR, `${sanitizeCollectionId(id)}.json`);
}

function listCollections({ includeArchived = false } = {}) {
  ensureCollectionsDir();
  const files = fs.readdirSync(COLLECTIONS_DIR).filter((f) => f.endsWith(".json"));
  const collections = [];
  for (const file of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, file), "utf8"));
      if (!includeArchived && c.archived) continue;
      collections.push({
        id: c.id,
        name: c.name,
        description: c.description || "",
        sourceType: c.source?.type,
        defaultTemplateId: c.defaultTemplateId,
        archived: !!c.archived,
        updatedAt: c.updatedAt,
      });
    } catch {
      // ignora arquivos corrompidos
    }
  }
  return collections.sort((a, b) => a.name.localeCompare(b.name));
}

function loadCollection(id) {
  const safeId = sanitizeCollectionId(id);
  if (!safeId) throw new Error("ID de coleção inválido.");
  const filePath = collectionPath(safeId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Coleção "${id}" não encontrada.`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const errors = validateCollection(data);
  if (errors.length > 0) {
    throw new Error(`Coleção inválida: ${errors.join("; ")}`);
  }
  return data;
}

function saveCollection(collection) {
  const errors = validateCollection(collection);
  if (errors.length > 0) {
    throw new Error(`Coleção inválida: ${errors.join("; ")}`);
  }
  ensureCollectionsDir();
  const filePath = collectionPath(collection.id);
  const tmp = path.join(COLLECTIONS_DIR, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  collection.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(collection, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  return collection;
}

function deleteCollection(id) {
  const safeId = sanitizeCollectionId(id);
  if (!safeId) throw new Error("ID de coleção inválido.");
  const filePath = collectionPath(safeId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function archiveCollection(id, archived = true) {
  const collection = loadCollection(id);
  collection.archived = archived;
  return saveCollection(collection);
}

function getDefaultCollectionId() {
  if (fs.existsSync(collectionPath("graduacao-cruzeiro"))) {
    return "graduacao-cruzeiro";
  }
  const all = listCollections();
  return all.length > 0 ? all[0].id : null;
}

module.exports = {
  listCollections,
  loadCollection,
  saveCollection,
  deleteCollection,
  archiveCollection,
  getDefaultCollectionId,
  collectionPath,
  COLLECTIONS_DIR,
};
