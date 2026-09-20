const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-sync-test-"));
const TEMP_XLSX = path.join(TEMP_DIR, "cursos-temp.xlsx");
const EXPORT_XLSX = path.join(TEMP_DIR, "cursos-export.xlsx");

process.env.AI_CATALOG_DIR = TEMP_DIR;

const {
  loadWorkbook,
  addImageColumnsIfNeeded,
  buildSyncPlan,
  dryRunSyncPlan,
  syncWorkbook,
  exportUpdatedSpreadsheet,
  IMAGE_COLUMNS,
} = require("../src/xlsx-sync");
const { loadAllCourses } = require("../src/read-courses");
const { createMetadata, writeMetadata, updateMetadataUrls } = require("../src/batch/metadata");
const { LocalStorageProvider } = require("../src/storage/local-storage-provider");

async function headerMap(workbook) {
  const sheet = workbook.getWorksheet("Graduação");
  const map = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    map[String(cell.value || "").trim()] = colNumber;
  });
  return map;
}

(async () => {
  // Garante que input original não será alterado.
  const inputHashBefore = crypto.createHash("sha256").update(fs.readFileSync(INPUT_FILE)).digest("hex");

  // Prepara planilha temporária e catálogo com um curso de exemplo.
  fs.copyFileSync(INPUT_FILE, TEMP_XLSX);
  const allCourses = await loadAllCourses();
  const course = allCourses.find((c) => c.slug === "analise-e-desenvolvimento-de-sistemas");
  assert.ok(course, "curso de exemplo deve existir na planilha");

  const storage = new LocalStorageProvider(TEMP_DIR);
  const metadata = createMetadata(course, {
    template_id: "cruzeiro-graduacao-v1",
    model: "gpt-image-2.5-flare",
    quality: "medium",
    size: "1024x1024",
  });
  metadata.status = "pronto_revisao";
  metadata.timestamps.whatsapp_at = new Date().toISOString();
  metadata.urls.fundo = await storage.getPublicUrl(metadata.storage.keys.fundo);
  metadata.urls.card = await storage.getPublicUrl(metadata.storage.keys.card);
  metadata.urls.whatsapp = await storage.getPublicUrl(metadata.storage.keys.whatsapp);
  writeMetadata(TEMP_DIR, course.slug, metadata);

  // 1. Dry-run
  const workbook = await loadWorkbook(TEMP_XLSX);
  const beforeAdd = await headerMap(workbook);
  const addResult = addImageColumnsIfNeeded(workbook);
  assert.ok(addResult.added, "deveria ter adicionado colunas");
  const afterAdd = await headerMap(workbook);
  for (const col of IMAGE_COLUMNS) {
    assert.ok(afterAdd[col], `coluna ${col} não foi adicionada`);
  }

  const plan = buildSyncPlan([metadata], workbook);
  const report = dryRunSyncPlan(plan);
  assert.equal(report.mode, "dry-run");
  assert.ok(report.summary.wouldChange > 0, "dry-run deve indicar mudanças");
  assert.equal(report.summary.matched, 1);
  assert.ok(report.changes[0].changes.some((c) => c.column === "imagem_whatsapp_url"));

  // 2. Preservar colunas: chamar addImageColumnsIfNeeded novamente não deve duplicar
  const addAgain = addImageColumnsIfNeeded(workbook);
  assert.equal(addAgain.added, false, "não deve duplicar colunas");

  // 3. syncWorkbook com backup
  const backupPath = path.join(TEMP_DIR, "cursos-backup.xlsx");
  const syncReport = await syncWorkbook(workbook, plan, backupPath);
  assert.equal(syncReport.mode, "dry-run");
  assert.ok(fs.existsSync(backupPath), "backup deve existir");

  // Verifica que o arquivo temporário foi alterado e backup contém os valores antigos.
  const updatedWorkbook = await loadWorkbook(TEMP_XLSX);
  const updatedMap = await headerMap(updatedWorkbook);
  const updatedRow = updatedWorkbook.getWorksheet("Graduação").getRow(plan.items[0].rowNumber);
  const statusValue = String(updatedRow.getCell(updatedMap.imagem_producao_status).value || "").trim();
  assert.equal(statusValue, "pronto_revisao", "planilha sincronizada deve conter status atualizado");

  const backupWorkbook = await loadWorkbook(backupPath);
  const backupMap = await headerMap(backupWorkbook);
  const backupRow = backupWorkbook.getWorksheet("Graduação").getRow(plan.items[0].rowNumber);
  const backupStatus = backupMap.imagem_producao_status
    ? String(backupRow.getCell(backupMap.imagem_producao_status).value || "").trim()
    : "";
  assert.notEqual(backupStatus, "pronto_revisao", "backup deve conter valor antigo");

  // 4. exportUpdatedSpreadsheet
  const exportReport = await exportUpdatedSpreadsheet([metadata], EXPORT_XLSX);
  assert.equal(exportReport.mode, "dry-run");
  assert.ok(fs.existsSync(EXPORT_XLSX), "arquivo exportado deve existir");
  const exportWorkbook = await loadWorkbook(EXPORT_XLSX);
  const exportMap = await headerMap(exportWorkbook);
  assert.ok(exportMap.imagem_producao_status, "export deve conter coluna imagem_producao_status");

  // Confirma que input/cursos.xlsx não foi alterado.
  const inputHashAfter = crypto.createHash("sha256").update(fs.readFileSync(INPUT_FILE)).digest("hex");
  assert.equal(inputHashAfter, inputHashBefore, "input/cursos.xlsx foi modificado pelo teste");

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log("XLSX sync OK: dry-run, export, preserve columns, backup comparison.");
})();
