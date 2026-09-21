/**
 * DataSource para arquivos CSV.
 */

const fs = require("fs");
const path = require("path");
const { DataSource, normalizeRecord } = require("./base");
const { parseCsvRobust, writeCsv, detectDelimiter } = require("./csv-parser");
const { resolveDataSourcePath } = require("./path-resolver");

class CsvDataSource extends DataSource {
  _resolvedPath() {
    const p = this.collection.source?.path;
    if (!p) throw new Error("Coleção não possui source.path.");
    return resolveDataSourcePath(p);
  }

  _loadRows() {
    const filePath = this._resolvedPath();
    const text = fs.readFileSync(filePath, "utf8");
    return parseCsvRobust(text);
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

  _latestTimestamp(metadata) {
    const candidates = [
      metadata?.timestamps?.whatsapp_at,
      metadata?.timestamps?.rendered_at,
      metadata?.timestamps?.generated_at,
      metadata?.updatedAt,
    ];
    for (const c of candidates) if (c) return c;
    return null;
  }

  _buildNextValues(metadata, outColumns) {
    return {
      [outColumns.backgroundFilename]: metadata?.files?.fundo || null,
      [outColumns.cardFilename]: metadata?.files?.card || null,
      [outColumns.whatsappFilename]: metadata?.files?.whatsapp || null,
      [outColumns.backgroundUrl]: metadata?.urls?.fundo || null,
      [outColumns.cardUrl]: metadata?.urls?.card || null,
      [outColumns.whatsappUrl]: metadata?.urls?.whatsapp || null,
      [outColumns.productionStatus]: metadata?.status || null,
      [outColumns.templateId]: metadata?.template_id || null,
      [outColumns.updatedAt]: this._latestTimestamp(metadata),
    };
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    const { headers, rows, delimiter } = this._loadRows();
    const out = this.collection.outputColumns || {};
    const pk = this.collection.primaryKey;

    const outputHeaders = [...headers];
    for (const colName of Object.values(out)) {
      if (!outputHeaders.includes(colName)) outputHeaders.push(colName);
    }

    const updatedRows = rows.map((row) => ({ ...row }));
    const pkIndex = headers.indexOf(pk);

    const normalizeKey = (s) =>
      String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

    for (const metadata of recordsMetadata) {
      const recordId = metadata.course_id || metadata.id || metadata.slug;
      const recordKey = normalizeKey(recordId);
      const slugKey = normalizeKey(metadata.slug);
      const idx = updatedRows.findIndex((r) => {
        if (pkIndex >= 0) {
          const rowKey = normalizeKey(r[pk]);
          return rowKey === recordKey || rowKey === slugKey;
        }
        const rowKey = normalizeKey(r[Object.keys(r)[0]]);
        return rowKey === recordKey || rowKey === slugKey;
      });
      if (idx < 0) continue;
      const next = this._buildNextValues(metadata, out);
      for (const [col, val] of Object.entries(next)) {
        if (col && outputHeaders.includes(col)) {
          updatedRows[idx][col] = val ?? "";
        }
      }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, writeCsv(updatedRows, outputHeaders, delimiter), "utf8");
    return { wouldChangeCount: recordsMetadata.length, outputPath };
  }

  async syncApprovedRecords(recordsMetadata, options = {}) {
    throw new Error("Sincronização in-place não é suportada para CSV. Use exportUpdatedCopy.");
  }
}

module.exports = { CsvDataSource };
