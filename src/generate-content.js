const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const {
  CONTENT_COLUMNS,
  OUTPUT_FIELDS,
  SOURCE_FIELDS,
  validateBatch,
  createEmptyRecord,
} = require("./content-schema");

const { generateBatchInstructions } = require("./content-prompt");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const BACKUP_DIR = path.join(ROOT, "input", "backups");
const CONTENT_DIR = path.join(ROOT, "output", "content");
const SHEET_NAME = "Graduação";
const CONTENT_STATUS_COLUMN = "conteudo_status";

// =======================================================
// Utilidades
// =======================================================

function normalizeCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.richText) {
      return value.richText.map((part) => part.text).join("");
    }
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    return JSON.stringify(value);
  }
  return String(value);
}

function readWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.xlsx.readFile(INPUT_FILE);
  return workbook;
}

async function loadSheet() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada na planilha.`);
  }

  return { workbook, sheet };
}

function getHeaderMap(sheet) {
  const headerRow = sheet.getRow(1);
  const map = {};

  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const value = normalizeCellValue(cell.value).trim();
    if (value) {
      map[value] = colNumber;
    }
  });

  return map;
}

function rowToCourse(row, headerMap) {
  const get = (name) => {
    const col = headerMap[name];
    if (!col) return "";
    return normalizeCellValue(row.getCell(col).value).trim();
  };

  return {
    course_id: get("course_id") || get("slug"),
    Curso: get("Curso"),
    Formação: get("Formação"),
    Modalidade: get("Modalidade"),
    Duração: get("Duração"),
    Classificação: get("Classificação"),
    "Descrição": get("Descrição"),
    "Mercado de Trabalho": get("Mercado de Trabalho"),
    "area de atuação": get("area de atuação"),
    conteudo_status: get(CONTENT_STATUS_COLUMN),
  };
}

function ensureContentColumns(sheet) {
  const headerMap = getHeaderMap(sheet);
  const headerRow = sheet.getRow(1);
  const existingCols = Object.keys(headerMap);
  const missingCols = CONTENT_COLUMNS.filter((c) => !existingCols.includes(c));

  if (missingCols.length === 0) {
    return { added: [], headerMap };
  }

  const gradeStatusCol = headerMap["grade_status"];
  let insertAfter = gradeStatusCol || Math.max(...Object.values(headerMap));

  const added = [];

  for (const colName of missingCols) {
    insertAfter++;
    const newCell = headerRow.getCell(insertAfter);
    newCell.value = colName;

    // Copia estilo da célula vizinha anterior, se existir
    const neighborCell = headerRow.getCell(insertAfter - 1);
    if (neighborCell && neighborCell.style) {
      newCell.style = JSON.parse(JSON.stringify(neighborCell.style));
    }

    added.push({ column: insertAfter, name: colName });
  }

  return { added, headerMap: getHeaderMap(sheet) };
}

function findNextBatchNumber() {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });

  const files = fs.readdirSync(CONTENT_DIR);
  const numbers = files
    .filter((f) => f.match(/^batch-(\d+)-input\.json$/))
    .map((f) => parseInt(f.match(/^batch-(\d+)-input\.json$/)[1], 10));

  if (numbers.length === 0) return 1;
  return Math.max(...numbers) + 1;
}

function buildInputRecords(courses) {
  return courses.map((course) => {
    const record = {};
    for (const field of SOURCE_FIELDS) {
      record[field] = course[field] || "";
    }
    return record;
  });
}

function buildOutputTemplate(courseIds) {
  return courseIds.map((id) => createEmptyRecord(id));
}

// =======================================================
// Exportação de lote
// =======================================================

async function exportBatch(limit) {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });

  const { sheet } = await loadSheet();
  const headerMap = getHeaderMap(sheet);

  // Adiciona colunas ausentes (sem salvar a planilha nesta etapa)
  const { added } = ensureContentColumns(sheet);

  const courses = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const course = rowToCourse(row, headerMap);
    if (!course.Curso) return;

    // Seleciona cursos ainda sem conteudo_status preenchido
    if (!course.conteudo_status) {
      courses.push(course);
    }
  });

  if (courses.length === 0) {
    console.log("Nenhum curso pendente de conteúdo.");
    return;
  }

  const selected = courses.slice(0, limit);
  const batchNumber = findNextBatchNumber();
  const batchId = String(batchNumber).padStart(3, "0");

  const inputFile = path.join(
    CONTENT_DIR,
    `batch-${batchId}-input.json`
  );
  const promptFile = path.join(
    CONTENT_DIR,
    `batch-${batchId}-prompt.md`
  );
  const outputTemplateFile = path.join(
    CONTENT_DIR,
    `batch-${batchId}-output.json`
  );

  const inputRecords = buildInputRecords(selected);

  fs.writeFileSync(
    inputFile,
    JSON.stringify(inputRecords, null, 2),
    "utf8"
  );

  const promptMarkdown = generateBatchInstructions(
    batchNumber,
    selected
  ).replace(
    `output/content/batch-${batchId}-output.json`,
    outputTemplateFile
  );

  fs.writeFileSync(promptFile, promptMarkdown, "utf8");

  // Cria template vazio de output para referência
  const outputTemplate = buildOutputTemplate(
    selected.map((c) => c.course_id)
  );
  fs.writeFileSync(
    outputTemplateFile,
    JSON.stringify(outputTemplate, null, 2),
    "utf8"
  );

  console.log("");
  console.log("================================");
  console.log(`LOTE ${batchId} EXPORTADO`);
  console.log("================================");
  console.log(`Cursos pendentes: ${courses.length}`);
  console.log(`Selecionados: ${selected.length}`);
  if (added.length > 0) {
    console.log(`Colunas adicionadas: ${added.map((a) => a.name).join(", ")}`);
  } else {
    console.log("Nenhuma coluna nova necessária.");
  }
  console.log("");
  console.log("Arquivos criados:");
  console.log(`  ${inputFile}`);
  console.log(`  ${promptFile}`);
  console.log(`  ${outputTemplateFile}`);
  console.log("");
  console.log("Cursos incluídos:");
  for (const c of selected) {
    console.log(`  - ${c.course_id}: ${c.Curso}`);
  }
}

// =======================================================
// Validação de lote
// =======================================================

async function validateBatchFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    process.exit(1);
  }

  const { sheet } = await loadSheet();
  const headerMap = getHeaderMap(sheet);

  const courseIds = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const course = rowToCourse(row, headerMap);
    if (course.course_id) courseIds.push(course.course_id);
  });

  let records;
  try {
    records = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`JSON inválido: ${error.message}`);
    process.exit(1);
  }

  const errors = validateBatch(records, courseIds, {
    requireRascunho: true,
  });

  if (errors.length === 0) {
    console.log("");
    console.log("================================");
    console.log("VALIDAÇÃO APROVADA");
    console.log("================================");
    console.log(`Registros validados: ${records.length}`);
    console.log("Nenhum erro encontrado.");
  } else {
    console.log("");
    console.log("================================");
    console.log("VALIDAÇÃO COM ERROS");
    console.log("================================");
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  }
}

// =======================================================
// Importação de lote
// =======================================================

async function importBatchFile(filePath, force = false) {
  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    process.exit(1);
  }

  const { workbook, sheet } = await loadSheet();
  const headerMap = getHeaderMap(sheet);

  // Adiciona colunas ausentes se necessário
  const { added } = ensureContentColumns(sheet);
  if (added.length > 0) {
    console.log(`Colunas adicionadas antes da importação: ${added.map((a) => a.name).join(", ")}`);
  }

  // Reconstroi headerMap após adicionar colunas
  const updatedHeaderMap = getHeaderMap(sheet);

  let records;
  try {
    records = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`JSON inválido: ${error.message}`);
    process.exit(1);
  }

  const courseIds = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const course = rowToCourse(row, updatedHeaderMap);
    if (course.course_id) courseIds.push(course.course_id);
  });

  const validationErrors = validateBatch(records, courseIds, {
    requireRascunho: true,
  });

  if (validationErrors.length > 0) {
    console.log("");
    console.log("================================");
    console.log("IMPORTAÇÃO BLOQUEADA");
    console.log("================================");
    validationErrors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Cria backup
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(
    BACKUP_DIR,
    `cursos-backup-${timestamp}.xlsx`
  );
  await workbook.xlsx.writeFile(backupFile);

  // Escreve em arquivo temporário
  const tempFile = path.join(
    ROOT,
    "input",
    `cursos-temp-${timestamp}.xlsx`
  );

  // Mapeia course_id -> row number
  const rowMap = {};
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const course = rowToCourse(row, updatedHeaderMap);
    if (course.course_id) {
      rowMap[course.course_id] = rowNumber;
    }
  });

  const report = [];

  for (const record of records) {
    const rowNumber = rowMap[record.course_id];
    const result = {
      course_id: record.course_id,
      status: "ok",
      erro: "",
    };

    if (!rowNumber) {
      result.status = "erro";
      result.erro = "Curso não encontrado na planilha";
      report.push(result);
      continue;
    }

    const row = sheet.getRow(rowNumber);

    // Verifica se já existe conteúdo e não está com --force
    const existingStatus = normalizeCellValue(
      row.getCell(updatedHeaderMap[CONTENT_STATUS_COLUMN]).value
    );

    if (!force && existingStatus && existingStatus !== "rascunho") {
      result.status = "ignorado";
      result.erro = `Conteúdo existente (${existingStatus}) não sobrescrito sem --force`;
      report.push(result);
      continue;
    }

    for (const field of CONTENT_COLUMNS) {
      const col = updatedHeaderMap[field];
      if (!col) {
        result.status = "erro";
        result.erro = `Coluna ${field} não encontrada`;
        break;
      }
      row.getCell(col).value = record[field];
    }

    report.push(result);
  }

  await workbook.xlsx.writeFile(tempFile);

  // Validação pós-escrita: recarrega e confere dados
  const tempWorkbook = new ExcelJS.Workbook();
  await tempWorkbook.xlsx.readFile(tempFile);
  const tempSheet = tempWorkbook.getWorksheet(SHEET_NAME);
  const tempHeaderMap = getHeaderMap(tempSheet);

  for (const record of records) {
    const rowNumber = rowMap[record.course_id];
    if (!rowNumber) continue;

    const row = tempSheet.getRow(rowNumber);
    for (const field of CONTENT_COLUMNS) {
      const col = tempHeaderMap[field];
      const value = normalizeCellValue(row.getCell(col).value);
      if (value !== record[field]) {
        console.error(
          `Falha de conferência: ${record.course_id}.${field} esperado "${record[field]}" obtido "${value}"`
        );
        process.exit(1);
      }
    }
  }

  // Substituição atômica
  fs.renameSync(tempFile, INPUT_FILE);

  // Relatório
  const reportFile = path.join(
    CONTENT_DIR,
    `batch-import-${timestamp}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

  const okCount = report.filter((r) => r.status === "ok").length;
  const ignoredCount = report.filter((r) => r.status === "ignorado").length;
  const errorCount = report.filter((r) => r.status === "erro").length;

  console.log("");
  console.log("================================");
  console.log("IMPORTAÇÃO FINALIZADA");
  console.log("================================");
  console.log(`Importados: ${okCount}`);
  console.log(`Ignorados: ${ignoredCount}`);
  console.log(`Erros: ${errorCount}`);
  console.log(`Backup: ${backupFile}`);
  console.log(`Relatório: ${reportFile}`);
}

// =======================================================
// Status
// =======================================================

async function showStatus() {
  const { sheet } = await loadSheet();
  const headerMap = getHeaderMap(sheet);

  let total = 0;
  let pending = 0;
  let rascunho = 0;
  let aprovado = 0;
  let rejeitado = 0;
  let other = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const course = rowToCourse(row, headerMap);
    if (!course.Curso) return;

    total++;

    const status = course.conteudo_status || "";

    if (!status) {
      pending++;
    } else if (status === "rascunho") {
      rascunho++;
    } else if (status === "aprovado") {
      aprovado++;
    } else if (status === "rejeitado") {
      rejeitado++;
    } else {
      other++;
    }
  });

  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const files = fs.readdirSync(CONTENT_DIR);
  const exportedBatches = files.filter((f) =>
    f.match(/^batch-(\d+)-input\.json$/)
  ).length;
  const importedReports = files.filter((f) =>
    f.match(/^batch-import-.*\.json$/)
  ).length;

  console.log("");
  console.log("================================");
  console.log("STATUS DE CONTEÚDO");
  console.log("================================");
  console.log(`Total de cursos: ${total}`);
  console.log(`Pendentes: ${pending}`);
  console.log(`Rascunho: ${rascunho}`);
  console.log(`Aprovados: ${aprovado}`);
  console.log(`Rejeitados: ${rejeitado}`);
  if (other > 0) console.log(`Outros status: ${other}`);
  console.log(`Lotes exportados: ${exportedBatches}`);
  console.log(`Lotes importados: ${importedReports}`);
  console.log(`Erros: ${other > 0 ? "verifique 'Outros status'" : "0"}`);
}

// =======================================================
// Entrypoint
// =======================================================

async function main() {
  const args = process.argv.slice(2);

  const exportArg = args.find((a) => a.startsWith("--export"));
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const validateArg = args.find((a) => a.startsWith("--validate="));
  const importArg = args.find((a) => a.startsWith("--import="));
  const statusArg = args.includes("--status");
  const forceArg = args.includes("--force");

  if (exportArg) {
    const limit = limitArg
      ? parseInt(limitArg.replace("--limit=", ""), 10)
      : 5;
    await exportBatch(limit);
    return;
  }

  if (validateArg) {
    const filePath = validateArg.replace("--validate=", "");
    await validateBatchFile(filePath);
    return;
  }

  if (importArg) {
    const filePath = importArg.replace("--import=", "");
    await importBatchFile(filePath, forceArg);
    return;
  }

  if (statusArg) {
    await showStatus();
    return;
  }

  console.log("");
  console.log("Uso:");
  console.log("  node src/generate-content.js --export --limit=5");
  console.log("  node src/generate-content.js --validate=output/content/batch-001-output.json");
  console.log("  node src/generate-content.js --import=output/content/batch-001-output.json [--force]");
  console.log("  node src/generate-content.js --status");
}

main().catch((error) => {
  console.error("ERRO FATAL:", error);
  process.exit(1);
});
