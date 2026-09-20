/**
 * Interface base para DataSources.
 */

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function normalizeRecord(row, collection) {
  const mappings = collection.fieldMappings || {};
  const fields = {};

  function getValue(possibleNames) {
    const names = Array.isArray(possibleNames) ? possibleNames : [possibleNames];
    for (const name of names) {
      if (!name) continue;
      const normalizedName = String(name)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();

      for (const key of Object.keys(row)) {
        const normalizedKey = String(key)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase();
        if (normalizedKey === normalizedName && row[key] !== undefined && row[key] !== null) {
          return row[key];
        }
      }
    }
    return "";
  }

  for (const [key, mapping] of Object.entries(mappings)) {
    fields[key] = String(getValue(mapping) || "").trim();
  }

  // Inclui todos os campos originais para bindings dinâmicos e filtros.
  for (const [key, value] of Object.entries(row)) {
    if (fields[key] === undefined && value !== undefined && value !== null) {
      fields[key] = String(value).trim();
    }
  }

  const title = fields[mappings.title] || fields.title || fields.name || "";
  const id = fields[mappings.slug || collection.primaryKey] || fields[collection.primaryKey] || "";
  const slug = id ? slugify(id) : slugify(title) || "item";
  const prompt = fields[mappings.prompt] || fields.prompt || "";
  const sourceImage = fields[mappings.sourceImage] || fields.sourceImage || fields.image || fields.image_url || "";
  const sourceStatus = fields[mappings.status] || fields.status || "";

  return {
    id: id || slug,
    title,
    slug,
    fields,
    prompt,
    sourceImage,
    sourceStatus,
  };
}

class DataSource {
  constructor(collection) {
    this.collection = collection;
  }

  async listRecords() {
    throw new Error("listRecords deve ser implementado.");
  }

  async getRecord(recordId) {
    const records = await this.listRecords();
    return records.find((r) => r.id === recordId || r.slug === recordId) || null;
  }

  async getFilterOptions(field) {
    const records = await this.listRecords();
    const values = new Set();
    for (const r of records) {
      const value = r.fields[field];
      if (value) values.add(value);
    }
    return [...values].sort();
  }

  async getFields() {
    throw new Error("getFields deve ser implementado.");
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    throw new Error("exportUpdatedCopy não suportado para este tipo de fonte.");
  }

  async syncApprovedRecords(recordsMetadata, { backupDir, confirm = false, approvedOnly = true } = {}) {
    throw new Error("syncApprovedRecords não suportado para este tipo de fonte.");
  }
}

module.exports = {
  DataSource,
  normalizeRecord,
  slugify,
};
