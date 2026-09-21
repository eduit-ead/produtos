/**
 * Schema e validação de coleções.
 */

const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const FIELD_REGEX = /^[a-zA-Z0-9_\-()\/\s]+$/i;

function isSafeRelative(p) {
  if (!p || typeof p !== "string") return false;
  const resolvedRoot = path.resolve(ROOT, p);
  if (resolvedRoot.startsWith(ROOT + path.sep) || resolvedRoot === ROOT) return true;
  const runtimeDir = process.env.APP_RUNTIME_DIR ? path.resolve(process.env.APP_RUNTIME_DIR) : null;
  if (runtimeDir) {
    const resolvedRuntime = path.resolve(runtimeDir, p);
    if (resolvedRuntime.startsWith(runtimeDir + path.sep) || resolvedRuntime === runtimeDir) return true;
  }
  return false;
}

function validateCollection(collection) {
  const errors = [];

  if (!collection || typeof collection !== "object") {
    return ["Coleção deve ser um objeto."];
  }

  if (!ID_REGEX.test(collection.id || "")) {
    errors.push("id deve conter apenas letras, números, hífen e underscore.");
  }

  if (!collection.name || typeof collection.name !== "string" || collection.name.trim().length === 0) {
    errors.push("name é obrigatório.");
  }

  const source = collection.source;
  if (!source || typeof source !== "object") {
    errors.push("source é obrigatório.");
  } else {
    const allowedTypes = new Set(["xlsx", "csv", "json"]);
    if (!allowedTypes.has(source.type)) {
      errors.push("source.type deve ser xlsx, csv ou json.");
    }
    if (!source.path || typeof source.path !== "string") {
      errors.push("source.path é obrigatório.");
    } else if (!isSafeRelative(source.path)) {
      errors.push("source.path deve estar dentro do projeto.");
    }
    if (source.type === "xlsx" && (!source.sheet || typeof source.sheet !== "string")) {
      errors.push("source.sheet é obrigatório para XLSX.");
    }
  }

  if (!collection.primaryKey || typeof collection.primaryKey !== "string") {
    errors.push("primaryKey é obrigatório.");
  }

  if (!collection.displayField || typeof collection.displayField !== "string") {
    errors.push("displayField é obrigatório.");
  }

  if (!Array.isArray(collection.searchFields) || collection.searchFields.length === 0) {
    errors.push("searchFields deve ser um array não vazio.");
  }

  const mappings = collection.fieldMappings;
  if (!mappings || typeof mappings !== "object") {
    errors.push("fieldMappings é obrigatório.");
  } else {
    if (!mappings.title) errors.push("fieldMappings.title é obrigatório.");
    if (!mappings.slug) errors.push("fieldMappings.slug é obrigatório.");
  }

  if (!Array.isArray(collection.filters)) {
    errors.push("filters deve ser um array.");
  } else {
    for (const f of collection.filters) {
      if (!f || typeof f !== "object" || !f.field || !f.label) {
        errors.push("Cada filtro deve ter field e label.");
        break;
      }
    }
  }

  if (!Array.isArray(collection.templateIds) || collection.templateIds.length === 0) {
    errors.push("templateIds deve ser um array não vazio.");
  }

  if (!collection.defaultTemplateId || typeof collection.defaultTemplateId !== "string") {
    errors.push("defaultTemplateId é obrigatório.");
  } else if (!collection.templateIds?.includes(collection.defaultTemplateId)) {
    errors.push("defaultTemplateId deve estar em templateIds.");
  }

  if (!collection.filenamePattern || typeof collection.filenamePattern !== "string") {
    errors.push("filenamePattern é obrigatório.");
  }

  const binding = collection.productionBackgroundBinding;
  if (binding && typeof binding === "object") {
    if (!binding.variable && !binding.layerId) {
      errors.push("productionBackgroundBinding deve ter variable ou layerId.");
    }
  }

  const out = collection.outputColumns;
  if (!out || typeof out !== "object") {
    errors.push("outputColumns é obrigatório.");
  } else {
    const required = [
      "backgroundFilename",
      "cardFilename",
      "whatsappFilename",
      "backgroundUrl",
      "cardUrl",
      "whatsappUrl",
      "productionStatus",
      "templateId",
      "updatedAt",
    ];
    for (const key of required) {
      if (!out[key]) errors.push(`outputColumns.${key} é obrigatório.`);
    }
  }

  return errors;
}

function sanitizeCollectionId(id) {
  if (!id || typeof id !== "string") return null;
  const cleaned = id.trim();
  return ID_REGEX.test(cleaned) ? cleaned : null;
}

function isValidFieldName(name) {
  return typeof name === "string" && FIELD_REGEX.test(name.trim());
}

module.exports = {
  validateCollection,
  sanitizeCollectionId,
  isValidFieldName,
  isSafeRelative,
  ROOT,
};
