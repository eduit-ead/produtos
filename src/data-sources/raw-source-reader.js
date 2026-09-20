/**
 * Leitura bruta de fontes de dados para preview/importação.
 * Não depende de primaryKey configurado; retorna cabeçalhos e linhas originais.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { parseCsvRobust, detectDelimiter } = require("./csv-parser");
const { isSafeRelative, ROOT } = require("../collections/schema");

function resolvePath(relPath) {
  if (!relPath || !isSafeRelative(relPath)) {
    throw new Error("Caminho da fonte inválido ou fora do projeto.");
  }
  const resolved = path.resolve(ROOT, relPath);
  if (!resolved.startsWith(ROOT + path.sep)) {
    throw new Error("Caminho da fonte fora do projeto.");
  }
  return resolved;
}

async function readXlsxSheets(relPath) {
  const filePath = resolvePath(relPath);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo não encontrado.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((s) => s.name);
}

async function readXlsxPreview(relPath, sheetName, sampleSize = 5) {
  const filePath = resolvePath(relPath);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo não encontrado.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error(`Aba "${sheetName}" não encontrada.`);

  const rows = [];
  let headers = [];
  let total = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values.slice(1).map((v) => (v && typeof v === "object" && v.text !== undefined ? v.text : v));
    const stringValues = values.map((v) => (v === null || v === undefined ? "" : String(v)));
    if (rowNumber === 1) {
      headers = stringValues;
    } else {
      total++;
      if (rows.length < sampleSize) {
        const obj = {};
        headers.forEach((h, idx) => {
          obj[h] = stringValues[idx] !== undefined ? stringValues[idx] : "";
        });
        rows.push(obj);
      }
    }
  });
  return { type: "xlsx", headers, rows, total, sheets: workbook.worksheets.map((s) => s.name) };
}

async function readCsvPreview(relPath, sampleSize = 5) {
  const filePath = resolvePath(relPath);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo não encontrado.");
  const raw = fs.readFileSync(filePath, "utf8");
  const { headers, rows } = parseCsvRobust(raw);
  return {
    type: "csv",
    headers,
    rows: rows.slice(0, sampleSize),
    total: rows.length,
    delimiter: detectDelimiter(raw),
  };
}

async function readJsonPreview(relPath, sampleSize = 5) {
  const filePath = resolvePath(relPath);
  if (!fs.existsSync(filePath)) throw new Error("Arquivo não encontrado.");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("JSON deve conter um array de registros.");
  const rows = data.filter((r) => r && typeof r === "object");
  const headers = new Set();
  for (const row of rows.slice(0, sampleSize + 1)) {
    for (const key of Object.keys(row)) headers.add(key);
  }
  return {
    type: "json",
    headers: [...headers].sort(),
    rows: rows.slice(0, sampleSize).map((r) => {
      const obj = {};
      for (const h of headers) obj[h] = r[h] !== undefined && r[h] !== null ? String(r[h]) : "";
      return obj;
    }),
    total: rows.length,
  };
}

async function readPreview(source, sampleSize = 5) {
  const { type, path: relPath, sheet } = source;
  switch (type) {
    case "xlsx":
      return readXlsxPreview(relPath, sheet, sampleSize);
    case "csv":
      return readCsvPreview(relPath, sampleSize);
    case "json":
      return readJsonPreview(relPath, sampleSize);
    default:
      throw new Error(`Tipo de fonte não suportado: ${type}`);
  }
}

async function readXlsxAllRows(relPath, sheetName) {
  const filePath = resolvePath(relPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) throw new Error(`Aba "${sheetName}" não encontrada.`);

  let headers = [];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values.slice(1).map((v) => (v && typeof v === "object" && v.text !== undefined ? v.text : v));
    const stringValues = values.map((v) => (v === null || v === undefined ? "" : String(v)));
    if (rowNumber === 1) {
      headers = stringValues;
    } else {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = stringValues[idx] !== undefined ? stringValues[idx] : "";
      });
      rows.push(obj);
    }
  });
  return { headers, rows, total: rows.length };
}

async function validatePrimaryKey(source, primaryKey) {
  let preview;
  if (source.type === "xlsx") {
    preview = await readXlsxAllRows(source.path, source.sheet);
  } else {
    preview = await readPreview(source, Number.MAX_SAFE_INTEGER);
  }
  const headers = preview.headers.map((h) => String(h).trim().toLowerCase());
  const normalizedKey = String(primaryKey || "").trim().toLowerCase();
  const keyIndex = headers.findIndex((h) => h === normalizedKey);

  if (!primaryKey || keyIndex < 0) {
    return { total: preview.total, emptyIds: 0, duplicateIds: [], missingColumn: true };
  }

  const seen = new Set();
  const duplicateIds = [];
  let emptyIds = 0;

  for (const row of preview.rows) {
    const rawValue = row[primaryKey];
    const value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();
    if (value === "") {
      emptyIds++;
      continue;
    }
    if (seen.has(value)) {
      duplicateIds.push(value);
    } else {
      seen.add(value);
    }
  }

  return { total: preview.total, emptyIds, duplicateIds: [...new Set(duplicateIds)], missingColumn: false };
}

module.exports = {
  readPreview,
  readXlsxSheets,
  validatePrimaryKey,
};
