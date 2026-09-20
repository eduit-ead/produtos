/**
 * DataSource para arquivos JSON.
 */

const fs = require("fs");
const path = require("path");
const { DataSource, normalizeRecord } = require("./base");
const { isSafeRelative, ROOT } = require("../collections/schema");

class JsonDataSource extends DataSource {
  _resolvedPath() {
    const p = this.collection.source?.path;
    if (!p) throw new Error("Coleção não possui source.path.");
    if (!isSafeRelative(p)) throw new Error("Caminho da fonte fora do projeto.");
    return path.resolve(ROOT, p);
  }

  _loadData() {
    const filePath = this._resolvedPath();
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(raw)) throw new Error("JSON deve conter um array de registros.");
    return raw;
  }

  async listRecords() {
    const data = this._loadData();
    const records = [];
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const pk = row[this.collection.primaryKey];
      const titleField = this.collection.displayField;
      if (!pk && !row[titleField]) continue;
      records.push(normalizeRecord(row, this.collection));
    }
    return records;
  }

  async getFields() {
    const data = this._loadData();
    const fields = new Set();
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      for (const key of Object.keys(row)) fields.add(key);
    }
    return [...fields].sort();
  }

  async getFilterOptions(field) {
    const data = this._loadData();
    const values = new Set();
    for (const row of data) {
      const v = row[field];
      if (v) values.add(String(v).trim());
    }
    return [...values].sort();
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    const data = this._loadData();
    const out = data.map((row) => ({ ...row }));
    const pk = this.collection.primaryKey;
    const outColumns = this.collection.outputColumns || {};
    for (const metadata of recordsMetadata) {
      const recordId = metadata.id || metadata.slug;
      const idx = out.findIndex((r) => String(r[pk]) === recordId || String(r[pk]) === metadata.slug);
      if (idx < 0) continue;
      if (outColumns.backgroundFilename) out[idx][outColumns.backgroundFilename] = metadata.files?.fundo || null;
      if (outColumns.cardFilename) out[idx][outColumns.cardFilename] = metadata.files?.card || null;
      if (outColumns.whatsappFilename) out[idx][outColumns.whatsappFilename] = metadata.files?.whatsapp || null;
      if (outColumns.backgroundUrl) out[idx][outColumns.backgroundUrl] = metadata.urls?.fundo || null;
      if (outColumns.cardUrl) out[idx][outColumns.cardUrl] = metadata.urls?.card || null;
      if (outColumns.whatsappUrl) out[idx][outColumns.whatsappUrl] = metadata.urls?.whatsapp || null;
      if (outColumns.productionStatus) out[idx][outColumns.productionStatus] = metadata.status || null;
      if (outColumns.templateId) out[idx][outColumns.templateId] = metadata.template_id || null;
      if (outColumns.updatedAt) out[idx][outColumns.updatedAt] = metadata.updatedAt || null;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2), "utf8");
    return { wouldChangeCount: recordsMetadata.length };
  }

  async syncApprovedRecords(recordsMetadata, options = {}) {
    throw new Error("Sincronização in-place não é suportada para JSON. Use exportUpdatedCopy.");
  }
}

module.exports = { JsonDataSource };
