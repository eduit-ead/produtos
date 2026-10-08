/**
 * Montagem estruturada com castField opcional.
 * Não grava prompt_imagem nem altera a planilha.
 */

const assert = require("node:assert/strict");
const { assemblePrompt } = require("../src/template-editor/ai-background");
const { getImageGenerationRules } = require("../src/content-prompt");
const { validateCollection } = require("../src/collections/schema");
const { loadCollection } = require("../src/collections/manager");
const { getFileDataSource } = require("../src/data-sources");

function normalizeLine(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nonEmptyUnique(lines) {
  const seen = new Set();
  return lines.map(normalizeLine).filter((line) => {
    if (!line) return false;
    const lower = line.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function legacyAssemble(templateImageGeneration, fields = {}) {
  const cfg = templateImageGeneration || {};
  const parts = [];
  if (cfg.basePrompt) parts.push(cfg.basePrompt);
  const description = fields.prompt_imagem || fields.description || "";
  if (description) parts.push(description);
  for (const value of [fields.environment, fields.activity, fields.people, fields.composition, fields.details]) {
    if (value) parts.push(value);
  }
  const negative = [];
  if (cfg.negativePrompt) negative.push(cfg.negativePrompt);
  if (fields.avoid) negative.push(fields.avoid);
  const rules = getImageGenerationRules();
  if (rules) parts.push(rules);
  return {
    prompt: nonEmptyUnique(parts).join("\n\n"),
    negativePrompt: nonEmptyUnique(negative).join("\n\n"),
  };
}

function readBinding(recordFields, fieldName) {
  if (!fieldName) return "";
  const value = recordFields?.[fieldName];
  return value === undefined || value === null ? "" : String(value);
}

function fieldsFromBindings(bindings, recordFields) {
  const source = bindings || {};
  return {
    description: readBinding(recordFields, source.descriptionField),
    environment: readBinding(recordFields, source.environmentField),
    activity: readBinding(recordFields, source.activityField),
    people: readBinding(recordFields, source.peopleField),
    cast: readBinding(recordFields, source.castField),
    composition: readBinding(recordFields, source.compositionField),
    details: readBinding(recordFields, source.detailsField),
    avoid: readBinding(recordFields, source.avoidField),
  };
}

const cfg = { basePrompt: "Base", negativePrompt: "Sem texto" };

function testWithoutCast() {
  const fields = {
    description: "Cena",
    environment: "Sala",
    activity: "Explicando",
    people: "Professora",
    composition: "Plano médio",
    details: "Quadro",
    avoid: "logos",
  };
  const current = assemblePrompt(cfg, fields);
  const previous = legacyAssemble(cfg, fields);
  assert.equal(current.prompt, previous.prompt);
  assert.equal(current.negativePrompt, previous.negativePrompt);
  assert.equal(current.prompt.includes("Elenco / pessoas adicionais"), false);
  assert.equal(current.prompt.includes("Protagonista:"), false);
}

function testWithCast() {
  const fields = {
    description: "Cena",
    people: "Gestora protagonista",
    cast: "Três representantes da comunidade",
    activity: "Planejando oficinas",
    composition: "Plano médio lateral",
  };
  const { prompt } = assemblePrompt(cfg, fields);
  const protagonist = prompt.indexOf("Protagonista: Gestora protagonista");
  const cast = prompt.indexOf("Elenco / pessoas adicionais: Três representantes da comunidade");
  assert.ok(protagonist >= 0);
  assert.ok(cast > protagonist);
  assert.ok(prompt.includes("Planejando oficinas"));
  assert.ok(prompt.includes("Plano médio lateral"));
}

function testEmptyCast() {
  const fields = {
    description: "Cena",
    people: "Professora",
    cast: "   ",
    activity: "Explicando",
  };
  const current = assemblePrompt(cfg, fields);
  const previous = legacyAssemble(cfg, fields);
  assert.equal(current.prompt, previous.prompt);
  assert.equal(current.prompt.includes("Elenco"), false);
}

function testMissingCast() {
  const fields = { description: "Cena", people: "Professora" };
  assert.equal(assemblePrompt(cfg, fields).prompt, legacyAssemble(cfg, fields).prompt);
  const errors = validateCollection({
    id: "demo",
    name: "Demo",
    source: { type: "json", path: "data/imports/test-posts/posts.json" },
    primaryKey: "id",
    displayField: "nome",
    searchFields: ["nome"],
    fieldMappings: { title: "nome", slug: "id" },
    filters: [],
    templateIds: ["demo"],
    defaultTemplateId: "demo",
    filenamePattern: "{{slug}}",
    outputColumns: {
      backgroundFilename: "a",
      cardFilename: "b",
      whatsappFilename: "c",
      backgroundUrl: "d",
      cardUrl: "e",
      whatsappUrl: "f",
      productionStatus: "g",
      templateId: "h",
      updatedAt: "i",
    },
    imageGenerationBindings: { peopleField: "visual_personagem" },
  });
  assert.equal(errors.length, 0);
}

async function testRealCollections() {
  const pos = loadCollection("pos-graduacao-cruzeiro");
  const grad = loadCollection("graduacao-cruzeiro");
  assert.equal(pos.imageGenerationBindings.castField, "visual_elenco");
  assert.equal(pos.imageGenerationBindings.peopleField, "visual_personagem");
  assert.equal(grad.imageGenerationBindings.castField, undefined);

  const posRecords = await getFileDataSource(pos).listRecords();
  const sample = posRecords.find((record) => record.slug === "administracao-e-gestao-de-projetos-sociais");
  assert.ok(sample);
  const savedPrompt = sample.fields.prompt_imagem;
  const posFields = fieldsFromBindings(pos.imageGenerationBindings, sample.fields);
  const posPrompt = assemblePrompt({}, posFields).prompt;
  assert.ok(posPrompt.includes(sample.fields.visual_personagem));
  assert.ok(posPrompt.includes(sample.fields.visual_elenco));
  assert.ok(posPrompt.includes(sample.fields.visual_atividade));
  assert.ok(posPrompt.includes(sample.fields.visual_composicao));
  assert.ok(posPrompt.includes("Protagonista:"));
  assert.ok(posPrompt.includes("Elenco / pessoas adicionais:"));
  assert.equal(sample.fields.prompt_imagem, savedPrompt);

  const gradRecords = await getFileDataSource(grad).listRecords();
  assert.equal(gradRecords.length, 128);
  assert.equal(posRecords.length, 291);
  const course = gradRecords[0];
  const gradFields = fieldsFromBindings(grad.imageGenerationBindings, course.fields);
  const current = assemblePrompt({}, gradFields);
  const previous = legacyAssemble({}, gradFields);
  assert.equal(current.prompt, previous.prompt);
  assert.equal(current.prompt.includes("Elenco / pessoas adicionais"), false);
  assert.equal(course.fields.prompt_imagem, gradFields.description);
}

(async () => {
  testWithoutCast();
  testWithCast();
  testEmptyCast();
  testMissingCast();
  await testRealCollections();
  console.log("castField prompt OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
