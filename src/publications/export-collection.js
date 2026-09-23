/**
 * Exportação da coleção inteira. A planilha de origem só é lida e nunca é regravada.
 */

const ExcelJS = require("exceljs");
const { sanitizeCollectionId } = require("../collections/schema");
const { exposeError } = require("../db/database-name");
const { listRecords, patchRecordFields } = require("../db/collections-repository");
const { loadCollection } = require("../collections/store");
const { getFileDataSource } = require("../data-sources");

const IMAGE_FIELDS = ["imagem_url", "imagem_status", "imagem_publicada_em"];
const LABELS = {
  descricao_curta: "Descrição curta",
  imagem_url: "URL da imagem",
  imagem_status: "Status da imagem",
  imagem_publicada_em: "Publicada em",
};

function text(value) {
  return String(value == null ? "" : value).trim();
}

function shortColumn(headers, collection) {
  const mapped = collection.fieldMappings && collection.fieldMappings.subtitle;
  if (mapped && headers.includes(mapped)) return mapped;
  if (headers.includes("descricao_curta")) return "descricao_curta";
  return null;
}

function matchesValue(record, collection, value) {
  const needle = text(value);
  if (!needle) return false;
  const slugField = collection.fieldMappings && collection.fieldMappings.slug;
  return record.id === needle
    || record.slug === needle
    || record.sourceKey === needle
    || text(record.fields && record.fields[collection.primaryKey]) === needle
    || (slugField && text(record.fields && record.fields[slugField]) === needle);
}

function findByIdentifier(records, collection, value) {
  return records.filter((record) => matchesValue(record, collection, value));
}

function matchRecord(records, sourceRow, collection) {
  const courseId = text(sourceRow.fields && sourceRow.fields[collection.primaryKey]);
  const slugField = collection.fieldMappings && collection.fieldMappings.slug;
  const slug = slugField ? text(sourceRow.fields && sourceRow.fields[slugField]) : "";
  const byCourse = courseId ? findByIdentifier(records, collection, courseId) : [];
  const bySlug = slug ? findByIdentifier(records, collection, slug) : [];

  if (courseId && slug) {
    const courseIds = new Set(byCourse.map((record) => record.id));
    const both = bySlug.filter((record) => courseIds.has(record.id));
    if (byCourse.length === 1 && bySlug.length === 1 && both.length === 1) {
      return { status: "matched", record: both[0] };
    }
    return { status: "conflict" };
  }
  if (byCourse.length === 1) return { status: "matched", record: byCourse[0] };
  if (bySlug.length === 1) return { status: "matched", record: bySlug[0] };
  if (byCourse.length > 1 || bySlug.length > 1) return { status: "conflict" };
  return { status: "unmatched" };
}

async function readSource(collection) {
  if (!collection.source || collection.source.type !== "xlsx") {
    return { column: null, rows: [], reason: "fonte-nao-xlsx" };
  }
  try {
    const source = getFileDataSource(collection);
    const headers = await source.getFields();
    const column = shortColumn(headers, collection);
    if (!column) return { column: null, rows: [], reason: "coluna-ausente" };
    return { column, rows: await source.listRecords(), reason: null };
  } catch {
    return { column: null, rows: [], reason: "leitura-indisponivel" };
  }
}

async function incorporateShortDescriptions(collectionId) {
  const safeId = sanitizeCollectionId(collectionId || "");
  if (!safeId) throw exposeError("Coleção inválida.", 400);
  const collection = await loadCollection(safeId);
  const records = await listRecords(safeId);
  const source = await readSource(collection);
  const report = {
    column: source.column,
    reason: source.reason,
    filled: 0,
    preserved: 0,
    conflicts: 0,
    unmatched: 0,
  };
  if (!source.column) return { collection, records, report };

  for (const row of source.rows) {
    const value = text(row.fields && row.fields[source.column]);
    if (!value) continue;
    const match = matchRecord(records, row, collection);
    if (match.status !== "matched") {
      report[match.status] += 1;
      continue;
    }
    const fields = match.record.fields || {};
    const current = text(fields[source.column]);
    const subtitle = text(fields.subtitle);
    if (current || subtitle) {
      report.preserved += 1;
      continue;
    }
    const patch = { [source.column]: value };
    if (source.column !== "subtitle") patch.subtitle = value;
    const updated = await patchRecordFields(safeId, match.record.id, patch);
    if (updated) {
      match.record.fields = updated.fields;
      report.filled += 1;
    }
  }
  return { collection, records, report };
}

function columnKeys(records, descriptionColumn) {
  const seen = new Set();
  const keys = [];
  const push = (key) => {
    if (!key || seen.has(key) || IMAGE_FIELDS.includes(key)) return;
    seen.add(key);
    keys.push(key);
  };
  if (descriptionColumn) push(descriptionColumn);
  for (const record of records) {
    for (const key of Object.keys(record.fields || {})) push(key);
  }
  return keys.concat(IMAGE_FIELDS);
}

function cellValue(record, key, sourceValue) {
  if (IMAGE_FIELDS.includes(key)) return record.fields && record.fields[key] != null ? String(record.fields[key]) : "";
  const stored = record.fields && record.fields[key];
  if (text(stored)) return String(stored);
  if (sourceValue != null && text(sourceValue)) return String(sourceValue);
  return stored == null ? "" : String(stored);
}

function sourceValueFor(record, column, rows, collection) {
  if (!column) return "";
  for (const row of rows) {
    const match = matchRecord([record], row, collection);
    if (match.status === "matched") return text(row.fields && row.fields[column]);
  }
  return "";
}

function headerLabel(key) {
  return LABELS[key] || key;
}

async function buildRows(collectionId) {
  const incorporated = await incorporateShortDescriptions(collectionId);
  const { collection, records, report } = incorporated;
  const source = report.column ? await readSource(collection) : { column: null, rows: [] };
  const keys = columnKeys(records, report.column);
  const rows = records.map((record) => {
    const fromFile = sourceValueFor(record, report.column, source.rows, collection);
    const values = {};
    for (const key of keys) {
      values[key] = cellValue(record, key, key === report.column ? fromFile : "");
    }
    return values;
  });
  return { keys, rows, report, collectionId: collection.id };
}

function csvEscape(value) {
  const textValue = value == null ? "" : String(value);
  if (/[;"\r\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

function toCsv(keys, rows) {
  const lines = [keys.map((key) => csvEscape(headerLabel(key))).join(";")];
  for (const row of rows) {
    lines.push(keys.map((key) => csvEscape(row[key])).join(";"));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

function worksheetValue(value) {
  // Célula vazia não pode ir como string "". O ExcelJS grava isso como
  // shared string e o Excel mostra o índice (por exemplo 72) no lugar do vazio.
  if (value == null || value === "") return null;
  return value;
}

async function toXlsx(keys, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Coleção");
  sheet.addRow(keys.map((key) => headerLabel(key)));
  for (const row of rows) sheet.addRow(keys.map((key) => worksheetValue(row[key])));
  return workbook.xlsx.writeBuffer();
}

async function exportCollection(collectionId, format) {
  const kind = format === "csv" ? "csv" : format === "xlsx" ? "xlsx" : "";
  if (!kind) throw exposeError("Formato de exportação inválido.", 400);
  const built = await buildRows(collectionId);
  if (kind === "csv") {
    return {
      filename: `${built.collectionId}-colecao.csv`,
      contentType: "text/csv; charset=utf-8",
      body: Buffer.from(toCsv(built.keys, built.rows), "utf8"),
      report: built.report,
      total: built.rows.length,
    };
  }
  return {
    filename: `${built.collectionId}-colecao.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: Buffer.from(await toXlsx(built.keys, built.rows)),
    report: built.report,
    total: built.rows.length,
  };
}

module.exports = {
  incorporateShortDescriptions,
  exportCollection,
  matchRecord,
};
