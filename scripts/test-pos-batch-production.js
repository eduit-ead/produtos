/**
 * Produção da Pós: prompt estruturado, fundo no card e renderer dedicado.
 * Não chama a API de imagem e não grava catálogo.
 */

require("../src/template-editor/renderer/pos-fontconfig").ensurePosFontconfig();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { POS_COMPOSITION_DIRECTION } = require("../src/template-editor/ai-background");
const { renderCourseCard, prepareBackgroundBuffer } = require("../src/render-card");
const { loadAllCourses } = require("../src/read-courses");
const { convertCardToWhatsAppJpeg } = require("../src/whatsapp-image");
const {
  PRODUCTION_BACKGROUND_KEY,
  applyProductionBackground,
  loadCollectionAndRecords,
  renderProductionCard,
  resolveProductionImagePrompt,
  resolveTemplateBindingsValues,
  usesDedicatedSavedRenderer,
} = require("../src/production/generic-production-service");

const POS_ID = "pos-graduacao-cruzeiro";
const CASTS = [
  { count: 1, prefix: "1 pessoa" },
  { count: 2, prefix: "2 pessoas" },
  { count: 3, prefix: "3 pessoas" },
  { count: 4, prefix: "4 pessoas" },
];
const COLORS = {
  1: { r: 220, g: 30, b: 30 },
  2: { r: 30, g: 180, b: 40 },
  3: { r: 30, g: 40, b: 210 },
  4: { r: 230, g: 180, b: 20 },
};

function sha(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function solidPng(color, width = 640, height = 640) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
}

async function pixel(buffer, x, y) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], width: info.width, height: info.height };
}

function looksLikePosBadge(point) {
  return point.r > 200 && point.g > 160 && point.b < 180 && point.r > point.b && point.g > point.b;
}

function near(pixelValue, color, tolerance) {
  return Math.abs(pixelValue.r - color.r) <= tolerance
    && Math.abs(pixelValue.g - color.g) <= tolerance
    && Math.abs(pixelValue.b - color.b) <= tolerance;
}

async function main() {
  const { collection, records } = await loadCollectionAndRecords(POS_ID);
  const template = JSON.parse(require("fs").readFileSync(require("path").join("data", "templates", "cruzeiro-pos-v1.json"), "utf8"));
  assert.equal(template.rendererType, "cruzeiro-pos-v1");
  assert.equal(usesDedicatedSavedRenderer(template), true);
  assert.equal(collection.defaultTemplateId, "cruzeiro-pos-v1");

  const chosen = CASTS.map((cast) => {
    const record = records.find((item) => String(item.fields.visual_elenco || "").trim().toLowerCase().startsWith(cast.prefix));
    assert.ok(record, `registro com elenco "${cast.prefix}" não encontrado`);
    return { ...cast, record };
  });

  const cards = [];
  for (const item of chosen) {
    const prompt = resolveProductionImagePrompt(collection, item.record, null);
    const cast = item.record.fields.visual_elenco;
    assert.ok(prompt.includes(cast), `${item.record.slug}: visual_elenco ausente do prompt`);
    assert.ok(prompt.includes("Elenco / pessoas adicionais"), `${item.record.slug}: elenco não entrou na montagem`);
    assert.ok(prompt.includes("Protagonista:"), `${item.record.slug}: protagonista ausente`);
    assert.ok(prompt.includes(item.record.fields.visual_ambiente), `${item.record.slug}: ambiente ausente`);
    assert.ok(prompt.includes(item.record.fields.visual_atividade), `${item.record.slug}: atividade ausente`);
    assert.ok(prompt.includes("Composição visual equilibrada"), `${item.record.slug}: composição ausente`);
    assert.ok(prompt.includes("Evitar"), `${item.record.slug}: evitar ausente`);
    const objects = String(item.record.fields.visual_objetos || "").replace(/\s+/g, " ").trim();
    if (objects) {
      const section = `Objetos / elementos de cena: ${objects}`;
      assert.ok(prompt.includes(section), `${item.record.slug}: seção de objetos ausente`);
      assert.equal(prompt.split(objects).length - 1, 1, `${item.record.slug}: visual_objetos duplicado`);
    } else {
      assert.equal(prompt.includes("Objetos / elementos de cena:"), false);
    }
    assert.ok(prompt.includes(POS_COMPOSITION_DIRECTION), `${item.record.slug}: direção da Pós ausente`);
    assert.ok(prompt.includes("visual_elenco"), `${item.record.slug}: regra de quantidade ausente`);
    if (item.record.fields.visual_personagem) {
      assert.ok(prompt.includes(item.record.fields.visual_personagem), `${item.record.slug}: visual_personagem ausente do prompt`);
    }

    const values = resolveTemplateBindingsValues(collection, item.record);
    assert.equal(values.titulo, item.record.fields.curso);
    assert.equal(values.modalidade, item.record.fields.modalidade);
    assert.equal(values.duracao, item.record.fields.duracao);
    const applied = applyProductionBackground(template, values, collection);
    assert.equal(applied.values.imagemFundo, PRODUCTION_BACKGROUND_KEY);
    assert.equal(applied.template.id, "cruzeiro-pos-v1");

    const background = await solidPng(COLORS[item.count]);
    const card = await renderProductionCard(template.id, template, values, collection, background);
    const meta = await sharp(card).metadata();
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1080);
    assert.equal(meta.format, "png");

    const photo = await pixel(card, 760, 220);
    assert.ok(near(photo, COLORS[item.count], 18), `${item.record.slug}: fundo não apareceu no card (${photo.r},${photo.g},${photo.b})`);
    const logo = await pixel(card, 110, 80);
    assert.equal(near(logo, COLORS[item.count], 18), false, `${item.record.slug}: logo não cobre o canto`);
    const badge = await pixel(card, 220, 650);
    assert.ok(looksLikePosBadge(badge), `${item.record.slug}: selo ausente (${badge.r},${badge.g},${badge.b})`);

    const whatsapp = await convertCardToWhatsAppJpeg(card);
    assert.equal(whatsapp[0], 0xff);
    assert.equal(whatsapp[1], 0xd8);
    const navy = await solidPng({ r: 7, g: 24, b: 51 }, 1080, 1080);
    const other = await convertCardToWhatsAppJpeg(navy);
    assert.notEqual(sha(whatsapp), sha(other));

    cards.push({ slug: item.record.slug, count: item.count, cast, titulo: values.titulo, modalidade: values.modalidade, duracao: values.duracao, card, objects: item.record.fields.visual_objetos });
    console.log(`pos ${item.count}: ${item.record.slug} | ${values.titulo} | ${values.modalidade} | ${values.duracao}`);
  }

  const sampleObjects = String(cards.find((item) => item.objects)?.objects || "").replace(/\s+/g, " ").trim();
  assert.ok(sampleObjects, "nenhum registro com visual_objetos preenchido");
  console.log(`objetos: Objetos / elementos de cena: ${sampleObjects}`);

  const cleared = {
    ...chosen[0].record,
    fields: { ...chosen[0].record.fields, visual_objetos: "   " },
  };
  const clearedPrompt = resolveProductionImagePrompt(collection, cleared, null);
  assert.equal(clearedPrompt.includes("Objetos / elementos de cena:"), false);

  const hashes = new Set(cards.map((item) => sha(item.card)));
  assert.equal(hashes.size, 4, "os quatro cards deveriam ser diferentes");

  const base = chosen[0];
  const baseValues = resolveTemplateBindingsValues(collection, base.record);
  const background = await solidPng(COLORS[1]);
  const retitled = await renderProductionCard(template.id, template, { ...baseValues, titulo: "Curso de controle" }, collection, background);
  const remoded = await renderProductionCard(template.id, template, { ...baseValues, modalidade: "Presencial" }, collection, background);
  const retimed = await renderProductionCard(template.id, template, { ...baseValues, duracao: "18 meses" }, collection, background);
  assert.notEqual(sha(cards[0].card), sha(retitled));
  assert.notEqual(sha(cards[0].card), sha(remoded));
  assert.notEqual(sha(cards[0].card), sha(retimed));

  const demo = JSON.parse(require("fs").readFileSync(require("path").join("data", "templates", "demo.json"), "utf8"));
  const demoCollection = {
    id: "demo-colecao",
    productionBackgroundBinding: { variable: "imagemFundo" },
  };
  assert.equal(usesDedicatedSavedRenderer(demo), false);
  const red = await renderProductionCard("demo", demo, { titulo: "Genérico", subtitulo: "Teste" }, demoCollection, await solidPng({ r: 200, g: 20, b: 20 }));
  const blue = await renderProductionCard("demo", demo, { titulo: "Genérico", subtitulo: "Teste" }, demoCollection, await solidPng({ r: 20, g: 20, b: 200 }));
  const redMeta = await sharp(red).metadata();
  assert.equal(redMeta.width, 1080);
  assert.equal(redMeta.height, 1080);
  assert.notEqual(sha(red), sha(blue), "template genérico ignorou o fundo");

  const graduacaoTemplate = JSON.parse(require("fs").readFileSync(require("path").join("data", "templates", "cruzeiro-graduacao-v1.json"), "utf8"));
  assert.equal(graduacaoTemplate.rendererType, "legacy-course-card");
  assert.equal(usesDedicatedSavedRenderer(graduacaoTemplate), false);
  const courses = await loadAllCourses();
  const course = courses.find((item) => item.curso && item.modalidade && item.duracao);
  assert.ok(course, "curso de graduação não encontrado");
  const prepared = await prepareBackgroundBuffer(await solidPng({ r: 180, g: 40, b: 40 }));
  const legacyCard = await renderCourseCard(prepared, {
    curso: course.curso,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
  });
  const legacyMeta = await sharp(legacyCard).metadata();
  assert.equal(legacyMeta.width, 1080);
  assert.equal(legacyMeta.height, 1080);
  const legacyBadgeSpot = await pixel(legacyCard, 220, 650);
  assert.equal(looksLikePosBadge(legacyBadgeSpot), false, "Graduação passou a desenhar o selo da Pós");
  const grad = await loadCollectionAndRecords("graduacao-cruzeiro");
  const gradPrompt = resolveProductionImagePrompt(grad.collection, grad.records[0], null);
  assert.equal(gradPrompt.includes("Objetos / elementos de cena:"), false);
  assert.equal(grad.collection.imageGenerationBindings.objectsField, undefined);
  console.log(`graduacao: ${course.slug} | ${course.curso} | ${course.modalidade} | ${course.duracao}`);
  console.log("ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
