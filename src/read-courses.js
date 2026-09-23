/**
 * Leitura compartilhada e somente leitura da planilha de cursos.
 */

const ExcelJS = require("exceljs");
const { cleanUrl } = require("./image-cache");
const { COURSES_FILE } = require("./config/runtime");

const INPUT_FILE = COURSES_FILE;
const SHEET_NAME = "Graduação";

function col(headerMap, name) {
  return headerMap[name] || null;
}

async function loadAllCourses() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada na planilha.`);
  }

  const headerMap = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headerMap[cell.value] = colNumber;
  });

  const slugCol = col(headerMap, "slug");
  const courseIdCol = col(headerMap, "course_id");
  const cursoCol = col(headerMap, "Curso");
  const formacaoCol = col(headerMap, "Formação");
  const modalidadeCol = col(headerMap, "Modalidade");
  const duracaoCol = col(headerMap, "Duração");
  const descricaoCol = col(headerMap, "descricao_curta");
  const promptCol = col(headerMap, "prompt_imagem");
  const imageCol = col(headerMap, "Image");
  const statusCol = col(headerMap, "conteudo_status");

  if (!slugCol) {
    throw new Error("Coluna 'slug' não encontrada na planilha.");
  }
  if (!promptCol) {
    throw new Error("Coluna 'prompt_imagem' não encontrada na planilha.");
  }

  const courses = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const slug = String(row.getCell(slugCol).value || "").trim();
    if (!slug) continue;

    courses.push({
      course_id: String(row.getCell(courseIdCol || slugCol).value || slug).trim(),
      slug,
      curso: String(row.getCell(cursoCol).value || "").trim(),
      formacao: String(row.getCell(formacaoCol).value || "").trim(),
      modalidade: String(row.getCell(modalidadeCol).value || "").trim(),
      duracao: String(row.getCell(duracaoCol).value || "").trim(),
      descricao_curta: String(row.getCell(descricaoCol).value || "").trim(),
      prompt_imagem: String(row.getCell(promptCol).value || "").trim(),
      image_url: cleanUrl(imageCol ? row.getCell(imageCol).value || "" : ""),
      conteudo_status: statusCol ? String(row.getCell(statusCol).value || "").trim() : "",
    });
  }

  return courses;
}

async function loadCourseBySlug(targetSlug) {
  const courses = await loadAllCourses();
  return courses.find((c) => c.slug === targetSlug) || null;
}

module.exports = {
  loadAllCourses,
  loadCourseBySlug,
  INPUT_FILE,
  SHEET_NAME,
};
