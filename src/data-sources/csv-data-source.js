/**
 * DataSource para arquivos CSV.
 * Parser simples com suporte a campos entre aspas e separador vírgula.
 */

const fs = require("fs");
const path = require("path");
const { DataSource, normalizeRecord } = require("./base");
const { isSafeRelative, ROOT } = require("../collections/schema");

function parseCsv(text) {
  const rows = [];
  let current = [];
  let value = "";
  let insideQuotes = false;
  let i = 0;

  function pushValue() {
    current.push(value.trim());
    value = "";
  }

  function pushRow() {
    if (current.length > 0 || value !== "") {
      pushValue();
      rows.push(current);
      current = [];
    }
  }

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (insideQuotes) {
      if (char === '"') {
        if (next === '"') {
          value += '"';
          i += 2;
          continue;
        }
        insideQuotes = false;
      } else {
        value += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ",") {
        pushValue();
      } else if (char === "\r" || char === "\n") {
        pushRow();
      } else {
        value += char;
      }
    }
    i++;
  }
  pushRow();
  return rows;
}

class CsvDataSource extends DataSource {
  _resolvedPath() {
    const p = this.collection.source?.path;
    if (!p) throw new Error("Coleção não possui source.path.");
    if (!isSafeRelative(p)) throw new Error("Caminho da fonte fora do projeto.");
    return path.resolve(ROOT, p);
  }

  _loadRows() {
    const filePath = this._resolvedPath();
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = parseCsv(text);
    if (parsed.length === 0) return { headers: [], rows: [] };
    const headers = parsed[0];
    const rows = [];
    for (let i = 1; i < parsed.length; i++) {
      const cells = parsed[i];
      if (cells.length === 0 || cells.every((c) => c === "")) continue;
      const row = {};
      for (let h = 0; h < headers.length; h++) {
        row[headers[h]] = cells[h] !== undefined ? cells[h] : "";
      }
      rows.push(row);
    }
    return { headers, rows };
  }

  async listRecords() {
    const { rows } = this._loadRows();
    const records = [];
    for (const row of rows) {
      const pk = row[this.collection.primaryKey];
      const titleField = this.collection.displayField;
      if (!pk && !row[titleField]) continue;
      records.push(normalizeRecord(row, this.collection));
    }
    return records;
  }

  async getFields() {
    const { headers } = this._loadRows();
    return headers;
  }

  async getFilterOptions(field) {
    const { rows } = this._loadRows();
    const values = new Set();
    for (const row of rows) {
      const v = row[field];
      if (v) values.add(String(v).trim());
    }
    return [...values].sort();
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    throw new Error("Exportação de cópia para CSV ainda não implementada.");
  }

  async syncApprovedRecords(recordsMetadata, options = {}) {
    throw new Error("Sincronização in-place não é suportada para CSV. Use exportUpdatedCopy.");
  }
}

module.exports = { CsvDataSource };
