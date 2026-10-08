/**
 * Conferências do release da Pós e dos uploads. Não gera lote.
 */

delete process.env.FONTCONFIG_FILE;

const assert = require("assert");
const ExcelJS = require("exceljs");
const sharp = require("sharp");
const { renderCruzeiroPosV1 } = require("../src/template-editor/renderer/cruzeiro-pos-v1");
const { applyPosImageDirection, POS_COLLECTION_ID, POS_COMPOSITION_DIRECTION } = require("../src/template-editor/ai-background");
const { XlsxDataSource } = require("../src/data-sources/xlsx-data-source");
const fs = require("fs");
const path = require("path");

async function sheetRows(file, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Aba ausente: ${sheetName}`);
  let rows = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values = row.values.slice(1);
    if (values.some((value) => value != null && String(value).trim() !== "")) rows += 1;
  });
  return rows;
}

async function main() {
  const xlsx = path.resolve("input/pos-graduacao-cruzeiro.xlsx");
  const cursos = await sheetRows(xlsx, "Cursos");
  const variantes = await sheetRows(xlsx, "Variantes");
  const validar = await sheetRows(xlsx, "Validar");
  assert.strictEqual(cursos, 291, `Cursos ${cursos}`);
  assert.strictEqual(variantes, 572, `Variantes ${variantes}`);
  assert.strictEqual(validar, 20, `Validar ${validar}`);

  const collection = JSON.parse(fs.readFileSync("data/collections/pos-graduacao-cruzeiro.json", "utf8"));
  const graduacao = JSON.parse(fs.readFileSync("data/collections/graduacao-cruzeiro.json", "utf8"));
  assert.strictEqual(collection.defaultTemplateId, "cruzeiro-pos-v1");
  assert.strictEqual(collection.imageGenerationBindings.castField, "visual_elenco");
  assert.deepStrictEqual(graduacao.templateIds, ["cruzeiro-graduacao-v1"]);

  const posRecords = await new XlsxDataSource(collection).listRecords();
  const gradRecords = await new XlsxDataSource(graduacao).listRecords();
  assert.strictEqual(posRecords.length, 291);
  assert.strictEqual(gradRecords.length, 128);
  const social = posRecords.find((record) => record.slug === "administracao-e-gestao-de-projetos-sociais");
  assert.ok(social);
  assert.strictEqual(social.fields.curso, "Administração e Gestão de Projetos Sociais");
  assert.ok(social.id);
  assert.ok(String(social.fields.visual_elenco).startsWith("4 pessoas"));
  assert.ok(social.fields.prompt_imagem);

  const directed = applyPosImageDirection({
    description: social.fields.prompt_imagem,
    composition: social.fields.visual_composicao,
    avoid: social.fields.visual_evitar,
    people: social.fields.visual_personagem,
    cast: social.fields.visual_elenco,
  }, POS_COLLECTION_ID);
  assert.ok(directed.composition.includes(POS_COMPOSITION_DIRECTION));
  assert.ok(directed.imageRules.includes("28 e 45 anos"));
  assert.ok(!directed.imageRules.includes("128 cursos"));
  assert.ok(!directed.imageRules.includes("70% das cenas"));
  const gradDirected = applyPosImageDirection({ description: "curso superior" }, "graduacao-cruzeiro");
  assert.strictEqual(gradDirected.imageRules, undefined);
  assert.strictEqual(gradDirected.description, "curso superior");

  const bg = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#335577" } }).png().toBuffer();
  const rendered = await renderCruzeiroPosV1({
    titulo: "Administração e Gestão de Projetos Sociais",
    modalidade: "EAD",
    duracao: "6 ou 9 meses",
    backgroundBuffer: bg,
  });
  assert.ok(rendered.font.stemPxAt140 >= 22, `stem ${rendered.font.stemPxAt140}`);
  assert.strictEqual(rendered.badge.text, "PÓS - GRADUAÇÃO");
  assert.strictEqual(rendered.badge.fontFamily, "Inter ExtraBold");
  assert.strictEqual(rendered.badge.fontWeight, 800);
  assert.strictEqual(rendered.badge.fontSize, 23);
  assert.strictEqual(rendered.badge.letterSpacing, 1.6);
  assert.ok(!fs.readFileSync("assets/fonts/fonts.conf", "utf8").includes("C:/Users"));
  console.log(JSON.stringify({
    cursos,
    variantes,
    validar,
    pos: posRecords.length,
    graduacao: gradRecords.length,
    stem: rendered.font.stemPxAt140,
    badge: rendered.badge.text,
    courseId: social.id,
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
