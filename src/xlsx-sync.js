/**
 * Sincronização controlada entre metadata.json dos cursos e a planilha XLSX.
 *
 * Nunca escreve sem backup. Nunca duplica colunas. Relaciona por course_id.
 * Suporta dry-run e gera relatório JSON. Compara valores lógicos com o backup.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const INPUT_FILE = path.join(__dirname, "..", "input", "cursos.xlsx");
const SHEET_NAME = "Graduação";

function lockFilePath(filePath) {
  const base = path.basename(filePath);
  return path.join(path.dirname(filePath), `~$${base}`);
}

function assertNoLockFile(filePath) {
  const lock = lockFilePath(filePath);
  if (fs.existsSync(lock)) {
    throw new Error(`Planilha bloqueada pelo Excel: ${lock}. Feche o arquivo e tente novamente.`);
  }
}

const IMAGE_COLUMNS = [
  "imagem_fundo_arquivo",
  "imagem_card_arquivo",
  "imagem_whatsapp_arquivo",
  "imagem_fundo_url",
  "imagem_card_url",
  "imagem_whatsapp_url",
  "imagem_producao_status",
  "imagem_template_id",
  "imagem_atualizada_em",
];

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

function getColumnValues(row, headerMap) {
  const values = {};
  for (const colName of IMAGE_COLUMNS) {
    const colNumber = headerMap[colName] || headerMap[normalizeHeader(colName)];
    if (!colNumber) {
      values[colName] = undefined;
    } else {
      values[colName] = String(row.getCell(colNumber).value || "").trim() || null;
    }
  }
  return values;
}

function findRowByCourseId(sheet, headerMap, courseId) {
  const courseIdCol = headerMap["course_id"] || headerMap[normalizeHeader("course_id")];
  if (!courseIdCol || !courseId) return null;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const value = String(row.getCell(courseIdCol).value || "").trim();
    if (value === courseId) {
      return rowNumber;
    }
  }
  return null;
}

function latestTimestamp(metadata) {
  const candidates = [
    metadata.timestamps?.whatsapp_at,
    metadata.timestamps?.rendered_at,
    metadata.timestamps?.generated_at,
    metadata.updatedAt,
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return null;
}

function buildNextValues(metadata) {
  return {
    imagem_fundo_arquivo: metadata.files?.fundo || null,
    imagem_card_arquivo: metadata.files?.card || null,
    imagem_whatsapp_arquivo: metadata.files?.whatsapp || null,
    imagem_fundo_url: metadata.urls?.fundo || null,
    imagem_card_url: metadata.urls?.card || null,
    imagem_whatsapp_url: metadata.urls?.whatsapp || null,
    imagem_producao_status: metadata.status || null,
    imagem_template_id: metadata.template_id || null,
    imagem_atualizada_em: latestTimestamp(metadata),
  };
}

function addImageColumnsIfNeeded(workbook) {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada na planilha.`);
  }
  const headerMap = getHeaderMap(sheet);
  let added = false;

  for (const colName of IMAGE_COLUMNS) {
    if (headerMap[colName] || headerMap[normalizeHeader(colName)]) {
      continue;
    }
    const nextCol = Math.max(0, ...Object.values(headerMap)) + 1;
    const cell = sheet.getRow(1).getCell(nextCol);
    cell.value = colName;
    headerMap[colName] = nextCol;
    headerMap[normalizeHeader(colName)] = nextCol;
    added = true;
  }

  return { added, columns: IMAGE_COLUMNS.map((name) => ({ name, colNumber: headerMap[name] })) };
}

function buildSyncPlan(coursesMetadata, workbook, { approvedOnly = false } = {}) {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada na planilha.`);
  }
  const headerMap = getHeaderMap(sheet);
  const plan = {
    columns: IMAGE_COLUMNS,
    approvedOnly,
    items: [],
    notFound: [],
    noChangeCount: 0,
    wouldChangeCount: 0,
    skippedCount: 0,
  };

  for (const metadata of coursesMetadata) {
    if (approvedOnly && metadata.status !== "aprovado") {
      plan.skippedCount++;
      continue;
    }
    const courseId = metadata.course_id;
    const rowNumber = findRowByCourseId(sheet, headerMap, courseId);
    if (!rowNumber) {
      plan.notFound.push({ course_id: courseId, slug: metadata.slug });
      continue;
    }

    const row = sheet.getRow(rowNumber);
    const current = getColumnValues(row, headerMap);
    const next = buildNextValues(metadata);
    const changes = [];

    for (const colName of IMAGE_COLUMNS) {
      const nextValue = next[colName];
      const currentValue = current[colName];
      if (nextValue == null || nextValue === "") {
        continue;
      }
      if (currentValue !== nextValue) {
        changes.push({
          column: colName,
          previous: currentValue,
          next: nextValue,
        });
      }
    }

    if (changes.length === 0) {
      plan.noChangeCount++;
    } else {
      plan.wouldChangeCount++;
    }

    plan.items.push({
      course_id: courseId,
      slug: metadata.slug,
      rowNumber,
      current,
      next,
      changes,
    });
  }

  return plan;
}

function dryRunSyncPlan(plan) {
  const report = {
    mode: "dry-run",
    columns: plan.columns,
    approvedOnly: plan.approvedOnly || false,
    summary: {
      totalCourses: plan.items.length + plan.notFound.length + (plan.skippedCount || 0),
      matched: plan.items.length,
      notFound: plan.notFound.length,
      skipped: plan.skippedCount || 0,
      wouldChange: plan.wouldChangeCount,
      noChange: plan.noChangeCount,
    },
    notFound: plan.notFound,
    changes: plan.items
      .filter((item) => item.changes.length > 0)
      .map((item) => ({
        course_id: item.course_id,
        slug: item.slug,
        rowNumber: item.rowNumber,
        changes: item.changes,
      })),
  };
  return report;
}

function applySyncPlan(workbook, plan) {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  const headerMap = getHeaderMap(sheet);

  for (const item of plan.items) {
    if (item.changes.length === 0) continue;
    const row = sheet.getRow(item.rowNumber);
    for (const change of item.changes) {
      const colNumber = headerMap[change.column] || headerMap[normalizeHeader(change.column)];
      if (!colNumber) {
        throw new Error(`Coluna ${change.column} não encontrada durante aplicação.`);
      }
      row.getCell(colNumber).value = change.next;
    }
  }
}

async function compareWithBackup(workbook, backupPath, plan) {
  const backupWorkbook = new ExcelJS.Workbook();
  await backupWorkbook.xlsx.readFile(backupPath);
  const backupSheet = backupWorkbook.getWorksheet(SHEET_NAME);
  const newSheet = workbook.getWorksheet(SHEET_NAME);
  const backupMap = getHeaderMap(backupSheet);
  const newMap = getHeaderMap(newSheet);

  const mismatches = [];

    for (const item of plan.items) {
      if (item.changes.length === 0) continue;
      const backupRow = backupSheet.getRow(item.rowNumber);
      const newRow = newSheet.getRow(item.rowNumber);

      for (const change of item.changes) {
        const backupCol = backupMap[change.column] || backupMap[normalizeHeader(change.column)];
        const newCol = newMap[change.column] || newMap[normalizeHeader(change.column)];
        const backupValue = backupCol
          ? String(backupRow.getCell(backupCol).value || "").trim() || null
          : null;
        const newValue = newCol
          ? String(newRow.getCell(newCol).value || "").trim() || null
          : null;

        if (backupValue !== change.previous) {
          mismatches.push({
            course_id: item.course_id,
            column: change.column,
            expectedPrevious: change.previous,
            backupValue,
            issue: "backup-different",
          });
        }
        if (newValue !== change.next) {
          mismatches.push({
            course_id: item.course_id,
            column: change.column,
            expectedNext: change.next,
            newValue,
            issue: "write-mismatch",
          });
        }
      }
    }

  if (mismatches.length > 0) {
    throw new Error(
      `Divergência entre backup e planilha sincronizada: ${JSON.stringify(mismatches, null, 2)}`
    );
  }
}

async function syncWorkbook(workbook, plan, backupPath) {
  if (!workbook._sourcePath) {
    throw new Error("syncWorkbook requer workbook._sourcePath para criar backup.");
  }
  if (!backupPath) {
    throw new Error("syncWorkbook requer backupPath.");
  }

  const backupDir = path.dirname(backupPath);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(workbook._sourcePath, backupPath);

  applySyncPlan(workbook, plan);
  await workbook.xlsx.writeFile(workbook._sourcePath);
  await compareWithBackup(workbook, backupPath, plan);

  return dryRunSyncPlan(plan);
}

async function loadWorkbook(filePath) {
  assertNoLockFile(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  workbook._sourcePath = filePath;
  return workbook;
}

async function exportUpdatedSpreadsheet(coursesMetadata, outputPath) {
  const workbook = await loadWorkbook(INPUT_FILE);
  addImageColumnsIfNeeded(workbook);
  const plan = buildSyncPlan(coursesMetadata, workbook);
  applySyncPlan(workbook, plan);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return dryRunSyncPlan(plan);
}

module.exports = {
  IMAGE_COLUMNS,
  addImageColumnsIfNeeded,
  buildSyncPlan,
  dryRunSyncPlan,
  syncWorkbook,
  exportUpdatedSpreadsheet,
  loadWorkbook,
};
