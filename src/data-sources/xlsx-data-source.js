/**
 * DataSource para planilhas XLSX.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { DataSource, normalizeRecord } = require("./base");
const { resolveDataSourcePath } = require("./path-resolver");

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getHeaderMap(sheet) {
  const map = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = String(cell.value || "").trim();
    if (header) {
      map[header] = colNumber;
      map[normalizeHeader(header)] = colNumber;
    }
  });
  return map;
}

function rowToObject(row, headerMap) {
  const obj = {};
  for (const [header, colNumber] of Object.entries(headerMap)) {
    if (colNumber === undefined || colNumber === null) continue;
    if (normalizeHeader(header) !== header) continue; // evita duplicados normalizados
    const cell = row.getCell(colNumber);
    let value = cell.value;
    if (value && typeof value === "object" && value.text !== undefined) {
      value = value.text;
    }
    obj[header] = value === null || value === undefined ? "" : value;
  }
  return obj;
}

function latestTimestamp(metadata) {
  const candidates = [
    metadata.timestamps?.whatsapp_at,
    metadata.timestamps?.rendered_at,
    metadata.timestamps?.generated_at,
    metadata.updatedAt,
  ];
  for (const c of candidates) if (c) return c;
  return null;
}

class XlsxDataSource extends DataSource {
  _resolvedPath() {
    const p = this.collection.source?.path;
    if (!p) throw new Error("Coleção não possui source.path.");
    return resolveDataSourcePath(p);
  }

  async _loadWorkbook() {
    const filePath = this._resolvedPath();
    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo não encontrado: ${filePath}`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    workbook._sourcePath = filePath;
    return workbook;
  }

  _getSheet(workbook) {
    const sheetName = this.collection.source?.sheet;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      throw new Error(`Aba "${sheetName}" não encontrada na planilha.`);
    }
    return sheet;
  }

  async listRecords() {
    const workbook = await this._loadWorkbook();
    const sheet = this._getSheet(workbook);
    const headerMap = getHeaderMap(sheet);
    const primaryKey = this.collection.primaryKey;
    const slugField = this.collection.fieldMappings?.slug || primaryKey;

    const records = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const raw = rowToObject(row, headerMap);
      if (!raw || Object.keys(raw).length === 0) continue;
      const keyValue = raw[primaryKey] || raw[slugField];
      if (!keyValue || String(keyValue).trim() === "") continue;
      records.push(normalizeRecord(raw, this.collection));
    }
    return records;
  }

  async getFields() {
    const workbook = await this._loadWorkbook();
    const sheet = this._getSheet(workbook);
    const map = getHeaderMap(sheet);
    return Object.keys(map).filter((h) => normalizeHeader(h) === h);
  }

  async getFilterOptions(field) {
    const workbook = await this._loadWorkbook();
    const sheet = this._getSheet(workbook);
    const headerMap = getHeaderMap(sheet);
    const col = headerMap[field] || headerMap[normalizeHeader(field)];
    if (!col) return [];
    const values = new Set();
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const value = row.getCell(col).value;
      if (value) values.add(String(value).trim());
    }
    return [...values].sort();
  }

  _buildNextValues(metadata) {
    const out = this.collection.outputColumns;
    return {
      [out.backgroundFilename]: metadata.files?.fundo || null,
      [out.cardFilename]: metadata.files?.card || null,
      [out.whatsappFilename]: metadata.files?.whatsapp || null,
      [out.backgroundUrl]: metadata.urls?.fundo || null,
      [out.cardUrl]: metadata.urls?.card || null,
      [out.whatsappUrl]: metadata.urls?.whatsapp || null,
      [out.productionStatus]: metadata.status || null,
      [out.templateId]: metadata.template_id || null,
      [out.updatedAt]: latestTimestamp(metadata),
    };
  }

  _findRowByPrimaryKey(sheet, headerMap, recordId) {
    const pk = this.collection.primaryKey;
    const slugField = this.collection.fieldMappings?.slug || pk;
    const pkCol = headerMap[pk] || headerMap[normalizeHeader(pk)];
    const slugCol = headerMap[slugField] || headerMap[normalizeHeader(slugField)];
    if (!pkCol && !slugCol) return null;

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const pkValue = pkCol ? String(row.getCell(pkCol).value || "").trim() : "";
      const slugValue = slugCol ? String(row.getCell(slugCol).value || "").trim() : "";
      if (pkValue === recordId || slugValue === recordId) {
        return rowNumber;
      }
    }
    return null;
  }

  async _buildSyncPlan(recordsMetadata, { approvedOnly = true } = {}) {
    const workbook = await this._loadWorkbook();
    const sheet = this._getSheet(workbook);
    const headerMap = getHeaderMap(sheet);
    const out = this.collection.outputColumns;

    // Garante colunas de saída.
    let nextCol = Math.max(0, ...Object.values(headerMap)) + 1;
    for (const colName of Object.values(out)) {
      if (headerMap[colName] || headerMap[normalizeHeader(colName)]) continue;
      sheet.getRow(1).getCell(nextCol).value = colName;
      headerMap[colName] = nextCol;
      headerMap[normalizeHeader(colName)] = nextCol;
      nextCol++;
    }

    const plan = {
      columns: Object.values(out),
      approvedOnly,
      items: [],
      notFound: [],
      noChangeCount: 0,
      wouldChangeCount: 0,
      skippedCount: 0,
    };

    for (const metadata of recordsMetadata) {
      if (approvedOnly && metadata.status !== "aprovado") {
        plan.skippedCount++;
        continue;
      }
      const recordId = metadata.id || metadata.slug;
      const rowNumber = this._findRowByPrimaryKey(sheet, headerMap, recordId);
      if (!rowNumber) {
        plan.notFound.push({ recordId, slug: metadata.slug });
        continue;
      }

      const row = sheet.getRow(rowNumber);
      const current = {};
      const next = this._buildNextValues(metadata);
      const changes = [];
      for (const colName of Object.values(out)) {
        const col = headerMap[colName] || headerMap[normalizeHeader(colName)];
        const currentValue = col ? String(row.getCell(col).value || "").trim() || null : null;
        current[colName] = currentValue;
        const nextValue = next[colName];
        if (nextValue == null || nextValue === "") continue;
        if (currentValue !== nextValue) {
          changes.push({ column: colName, previous: currentValue, next: nextValue });
        }
      }
      if (changes.length === 0) plan.noChangeCount++;
      else plan.wouldChangeCount++;
      plan.items.push({ recordId, slug: metadata.slug, rowNumber, current, next, changes });
    }

    return { workbook, plan };
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    const { workbook, plan } = await this._buildSyncPlan(recordsMetadata, { approvedOnly: false });
    for (const item of plan.items) {
      if (item.changes.length === 0) continue;
      const row = workbook.getWorksheet(this.collection.source.sheet).getRow(item.rowNumber);
      for (const change of item.changes) {
        const headerMap = getHeaderMap(workbook.getWorksheet(this.collection.source.sheet));
        const col = headerMap[change.column];
        if (col) row.getCell(col).value = change.next;
      }
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);
    return plan;
  }

  async syncApprovedRecords(recordsMetadata, { backupPath, confirm = false } = {}) {
    if (!confirm) {
      const { plan } = await this._buildSyncPlan(recordsMetadata, { approvedOnly: true });
      return { mode: "dry-run", plan };
    }
    const sourcePath = this._resolvedPath();
    const { workbook, plan } = await this._buildSyncPlan(recordsMetadata, { approvedOnly: true });

    if (plan.wouldChangeCount === 0) {
      return { mode: "sync", plan, backup: null };
    }

    if (!backupPath) throw new Error("backupPath é obrigatório para sincronização.");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(sourcePath, backupPath);

    const sheet = workbook.getWorksheet(this.collection.source.sheet);
    for (const item of plan.items) {
      if (item.changes.length === 0) continue;
      const row = sheet.getRow(item.rowNumber);
      for (const change of item.changes) {
        const headerMap = getHeaderMap(sheet);
        const col = headerMap[change.column];
        if (col) row.getCell(col).value = change.next;
      }
    }

    await workbook.xlsx.writeFile(sourcePath);
    return { mode: "sync", plan, backup: backupPath };
  }
}

module.exports = { XlsxDataSource };
