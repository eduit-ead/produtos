/**
 * Serviço genérico de produção de itens visuais por coleção.
 * Delega ao legado course-production-service para a coleção padrão.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const { RUNTIME } = require("../config/runtime");
const { loadCollection } = require("../collections/store");
const { getDataSource } = require("../data-sources");
const { createStorageProvider } = require("../storage");
const { courseFiles } = require("../batch/naming");
const {
  createMetadata,
  readMetadata,
  writeMetadata,
  updateMetadataUrls,
  getCatalogDir,
} = require("../batch/metadata");
const { renderTemplate } = require("../template-editor/renderer");
const { resolveVariables, applyVariableBindings } = require("../template-editor/schema/template-schema");
const { generateImage } = require("../generate-ai-background");
const { renderCourseCard, prepareBackgroundBuffer } = require("../render-card");
const { getImageBuffer } = require("../image-cache");
const { convertCardToWhatsAppJpeg } = require("../whatsapp-image");
const courseService = require("../course-production-service");
const { resolveItemVisual, resolveBackgroundBufferForItem } = require("./visual-resolver");
const finishedPiecesService = require("../finished-pieces");

const LEGACY_COLLECTION_ID = "graduacao-cruzeiro";
const LEGACY_TEMPLATE_ID = "cruzeiro-graduacao-v1";
const SLUG_REGEX = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_BG_EXT = new Set([".png", ".jpg", ".jpeg", ".svg"]);

function validateSlug(slug) {
  if (!slug || !SLUG_REGEX.test(slug)) throw new Error("Slug inválido.");
  return slug;
}

function isLegacyCollection(collectionId) {
  return collectionId === LEGACY_COLLECTION_ID;
}

function catalogDirFor(collectionId) {
  const base = getCatalogDir();
  if (isLegacyCollection(collectionId)) {
    return base;
  }
  const dir = path.join(base, collectionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestFileFor(collectionId) {
  const dir = catalogDirFor(collectionId);
  return path.join(dir, "manifest.json");
}

function ensureManifest(collectionId) {
  const file = manifestFileFor(collectionId);
  if (!fs.existsSync(file)) {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.courses) data.courses = {};
    else if (Array.isArray(data.courses)) {
      const map = {};
      for (const entry of data.courses) {
        if (entry?.slug) map[entry.slug] = entry;
      }
      data.courses = map;
    }
    return data;
  } catch {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
}

function saveManifest(collectionId, manifest) {
  const file = manifestFileFor(collectionId);
  manifest.updatedAt = new Date().toISOString();
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function storageFor(collectionId) {
  return createStorageProvider({ baseDir: catalogDirFor(collectionId) });
}

function recordToMetadataRecord(record) {
  return {
    course_id: record.id,
    slug: record.slug,
    curso: record.title,
    modalidade: record.fields.modalidade || "",
    formacao: record.fields.formacao || "",
    duracao: record.fields.duracao || "",
    prompt_imagem: record.prompt || record.title,
    image_url: record.sourceImage || "",
    conteudo_status: record.sourceStatus || "",
  };
}

async function loadCollectionAndRecords(collectionId) {
  const collection = await loadCollection(collectionId);
  const source = getDataSource(collection);
  const records = await source.listRecords();
  return { collection, records, source };
}

async function getRecord(collectionId, slug) {
  if (isLegacyCollection(collectionId)) {
    return courseService.getCourseDetail(slug);
  }
  const { records } = await loadCollectionAndRecords(collectionId);
  return records.find((r) => r.slug === slug) || null;
}

function getManifestEntry(manifest, slug) {
  return manifest.courses[slug] || null;
}

function setManifestEntry(manifest, slug, partial) {
  const existing = manifest.courses[slug] || {};
  manifest.courses[slug] = {
    course_id: partial.course_id ?? existing.course_id,
    slug,
    curso: partial.curso ?? existing.curso,
    status: partial.status ?? existing.status ?? "pendente",
    prompt: partial.prompt ?? existing.prompt,
    backgroundPath: partial.backgroundPath ?? existing.backgroundPath,
    cardPath: partial.cardPath ?? existing.cardPath,
    whatsappPath: partial.whatsappPath ?? existing.whatsappPath,
    selectedBackground: partial.selectedBackground ?? existing.selectedBackground,
    model: partial.model ?? existing.model,
    quality: partial.quality ?? existing.quality,
    size: partial.size ?? existing.size,
    costUsd: partial.costUsd ?? existing.costUsd ?? 0,
    usage: partial.usage ?? existing.usage,
    dryRun: partial.dryRun ?? existing.dryRun,
    attempts: partial.attempts ?? existing.attempts ?? 0,
    error: partial.error ?? existing.error,
    generatedAt: partial.generatedAt ?? existing.generatedAt,
    uploadedAt: partial.uploadedAt ?? existing.uploadedAt,
    renderedAt: partial.renderedAt ?? existing.renderedAt,
    approvedAt: partial.approvedAt ?? existing.approvedAt,
    rejectedAt: partial.rejectedAt ?? existing.rejectedAt,
    approvedVisual: partial.approvedVisual ?? existing.approvedVisual,
    updatedAt: new Date().toISOString(),
  };
}

async function resolveGenericStatus(manifestEntry, storage, slug) {
  if (manifestEntry?.status === "aprovado") return "aprovado";
  if (manifestEntry?.status === "rejeitado") return "rejeitado";
  if (manifestEntry?.status === "erro") return "erro";
  if (manifestEntry?.status === "gerando") return "gerando";
  const [hasBg, hasCard] = await Promise.all([
    storage.exists(`${slug}/fundo`).catch(() => false),
    storage.exists(`${slug}/card`).catch(() => false),
  ]);
  if (hasCard || hasBg) return "gerado";
  return "pendente";
}

function catalogFileUrl(collectionId, slug, filename) {
  if (isLegacyCollection(collectionId)) {
    return `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
  }
  return `/api/catalog/${encodeURIComponent(collectionId)}/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
}

function recordSourceImageUrl(record) {
  if (!record.sourceImage) return null;
  // Imagem original não pode ser servida diretamente se for URL externa;
  // aqui apenas indicamos a string para o painel.
  return record.sourceImage;
}

// ============================================================
// Operações legadas
// ============================================================

function buildVisualFields(visual, overrides = {}) {
  return {
    visual_status: visual.visualStatus,
    visual_source: visual.visualSource,
    visual_updated_at: visual.visualUpdatedAt,
    current_background_key: visual.currentBackgroundKey,
    current_card_key: visual.currentCardKey,
    current_whatsapp_key: visual.currentWhatsAppKey,
    current_background_url: visual.currentBackgroundUrl,
    current_card_url: visual.currentCardUrl,
    current_whatsapp_url: visual.currentWhatsAppUrl,
    candidate_background_key: visual.candidateBackgroundKey,
    candidate_card_key: visual.candidateCardKey,
    candidate_whatsapp_key: visual.candidateWhatsAppKey,
    candidate_background_url: visual.candidateBackgroundUrl,
    candidate_card_url: visual.candidateCardUrl,
    candidate_whatsapp_url: visual.candidateWhatsAppUrl,
    candidate_source: visual.candidateSource,
    ...overrides,
  };
}

async function listLegacyItems() {
  const courses = await courseService.listCourses();
  return Promise.all(courses.map(async (course) => {
    const record = { sourceImage: course.image_url || course.current_background_url || "" };
    const visual = await resolveItemVisual(LEGACY_COLLECTION_ID, course.slug, record);
    return {
      ...course,
      ...buildVisualFields(visual, {
        current_background_url: visual.currentBackgroundUrl || course.current_background_url || null,
        current_card_url: visual.currentCardUrl || course.current_card_url || null,
        current_whatsapp_url: visual.currentWhatsAppUrl || course.current_whatsapp_url || null,
      }),
      ai_background_url: visual.candidateBackgroundUrl || course.current_background_url || null,
      ai_card_url: visual.candidateCardUrl || course.current_card_url || null,
      status: visual.visualStatus,
    };
  }));
}

async function getLegacyItem(slug) {
  const course = await courseService.getCourseDetail(slug);
  if (!course) return null;
  const record = { sourceImage: course.image_url || course.current_background_url || "" };
  const visual = await resolveItemVisual(LEGACY_COLLECTION_ID, slug, record);
  return {
    ...course,
    ...buildVisualFields(visual, {
      current_background_url: visual.currentBackgroundUrl || course.current_background_url || null,
      current_card_url: visual.currentCardUrl || course.current_card_url || null,
      current_whatsapp_url: visual.currentWhatsAppUrl || course.current_whatsapp_url || null,
    }),
    ai_background_url: visual.candidateBackgroundUrl || course.current_background_url || null,
    ai_card_url: visual.candidateCardUrl || course.current_card_url || null,
    status: visual.visualStatus,
  };
}

// ============================================================
// Operações genéricas
// ============================================================

async function listItems(collectionId) {
  if (isLegacyCollection(collectionId)) {
    return listLegacyItems();
  }

  const { records, collection } = await loadCollectionAndRecords(collectionId);

  return Promise.all(records.map(async (record) => {
    const visual = await resolveItemVisual(collectionId, record.slug, record);
    return {
      collection_id: collectionId,
      record_id: record.id,
      slug: record.slug,
      title: record.title,
      fields: record.fields,
      ...buildVisualFields(visual),
      ai_background_url: visual.candidateBackgroundUrl || catalogFileUrl(collectionId, record.slug, `${record.slug}-fundo.png`),
      ai_card_url: visual.candidateCardUrl || catalogFileUrl(collectionId, record.slug, `${record.slug}-card.png`),
      status: visual.visualStatus,
      source_status: record.sourceStatus,
      collection_name: collection.name,
    };
  }));
}

async function getItem(collectionId, slug) {
  if (isLegacyCollection(collectionId)) {
    return getLegacyItem(slug);
  }

  const record = await getRecord(collectionId, slug);
  if (!record) return null;
  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug);
  const visual = await resolveItemVisual(collectionId, slug, record);

  return {
    collection_id: collectionId,
    record_id: record.id,
    slug: record.slug,
    title: record.title,
    fields: record.fields,
    prompt: record.prompt || record.title,
    ...buildVisualFields(visual),
    ai_background_url: visual.candidateBackgroundUrl || catalogFileUrl(collectionId, slug, `${slug}-fundo.png`),
    ai_card_url: visual.candidateCardUrl || catalogFileUrl(collectionId, slug, `${slug}-card.png`),
    status: visual.visualStatus,
    source_status: record.sourceStatus,
    manifest: entry,
  };
}

async function createMockBackground() {
  return sharp({
    create: { width: 1080, height: 1080, channels: 3, background: { r: 11, g: 17, b: 32 } },
  })
    .png()
    .toBuffer();
}

async function generateAIBackground(collectionId, slug, { dryRun = false, prompt = null } = {}) {
  if (isLegacyCollection(collectionId)) {
    return courseService.generateAIBackground(slug, { dryRun, prompt });
  }

  const record = await getRecord(collectionId, validateSlug(slug));
  if (!record) throw new Error("Item não encontrado.");
  if (!dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada. Configure a chave para gerar imagens reais.");
  }

  const manifest = ensureManifest(collectionId);
  const usedPrompt = typeof prompt === "string" && prompt.trim() ? prompt.trim() : record.prompt || record.title;
  const catalogDir = catalogDirFor(collectionId);
  const storage = storageFor(collectionId);

  setManifestEntry(manifest, slug, {
    course_id: record.id,
    curso: record.title,
    status: "gerando",
    prompt: usedPrompt,
    error: null,
  });
  saveManifest(collectionId, manifest);

  const files = courseFiles(slug);

  try {
    let buffer;
    let model = "mock";
    let quality = "mock";
    let size = "1080x1080";
    let costUsd = 0;
    let usage = null;

    if (dryRun) {
      buffer = await createMockBackground();
    } else {
      const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "gen-bg-"));
      try {
        const recordForImage = {
          course_id: record.id,
          slug: record.slug,
          curso: record.title,
          prompt: usedPrompt,
        };
        const recordImage = await generateImage(recordForImage, { outputDir: tempDir });
        const generatedPath = recordImage.caminho_arquivo;
        buffer = fs.readFileSync(generatedPath);
        model = recordImage.modelo || model;
        quality = recordImage.qualidade || quality;
        size = recordImage.tamanho || size;
        costUsd = recordImage.custo_estimado_usd?.totalCostUsd || 0;
        usage = recordImage.uso_api || null;
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    await storage.save(`${slug}/fundo`, buffer, { contentType: "image/png" });

    setManifestEntry(manifest, slug, {
      course_id: record.id,
      curso: record.title,
      status: "gerado",
      prompt: usedPrompt,
      backgroundPath: `${slug}/fundo`,
      selectedBackground: "ai",
      model,
      quality,
      size,
      costUsd,
      usage,
      dryRun,
      generatedAt: new Date().toISOString(),
      error: null,
    });
    saveManifest(collectionId, manifest);
    return getManifestEntry(manifest, slug);
  } catch (err) {
    const entry = getManifestEntry(manifest, slug) || {};
    setManifestEntry(manifest, slug, {
      ...entry,
      status: "erro",
      error: err.message,
      attempts: (entry.attempts || 0) + 1,
    });
    saveManifest(collectionId, manifest);
    throw err;
  }
}

async function uploadBackground(collectionId, slug, buffer, ext) {
  if (isLegacyCollection(collectionId)) {
    return courseService.uploadBackground(slug, buffer, ext);
  }

  const record = await getRecord(collectionId, validateSlug(slug));
  if (!record) throw new Error("Item não encontrado.");
  const lowerExt = String(ext || "").toLowerCase();
  if (!ALLOWED_BG_EXT.has(lowerExt)) throw new Error("Formato de imagem não permitido.");

  const normalized = await sharp(buffer, lowerExt === ".svg" ? { density: 144 } : undefined)
    .png()
    .toBuffer();

  const catalogDir = catalogDirFor(collectionId);
  const storage = storageFor(collectionId);
  const files = courseFiles(slug);

  await storage.save(`${slug}/fundo`, normalized, { contentType: "image/png" });

  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  const status = await resolveGenericStatus(entry, storage, slug);
  setManifestEntry(manifest, slug, {
    ...entry,
    course_id: record.id,
    curso: record.title,
    status,
    backgroundPath: `${slug}/fundo`,
    selectedBackground: "upload",
    uploadedAt: new Date().toISOString(),
    error: null,
  });
  saveManifest(collectionId, manifest);

  return { size: normalized.length };
}

function resolveTemplateBindingsValues(collection, record) {
  const values = {};
  for (const binding of collection.templateBindings || []) {
    if (!binding.templateVariable || !binding.sourceField) continue;
    let value = record.fields[binding.sourceField];
    if (value === undefined || value === null || value === "") {
      value = binding.defaultValue || "";
    }
    values[binding.templateVariable] = value;
  }
  return values;
}

function requiredVariablesMissing(template, values) {
  if (!Array.isArray(template.variables)) return [];
  const missing = [];
  for (const v of template.variables) {
    if (!v.required) continue;
    const hasValue = Object.hasOwn(values, v.key) && values[v.key] !== "" && values[v.key] !== null && values[v.key] !== undefined;
    const hasBinding = Array.isArray(v.binding) || (v.binding && v.binding.layerId && v.binding.property);
    if (!hasValue && !hasBinding) {
      missing.push(v.key);
    }
  }
  return missing;
}

async function loadTemplate(templateId) {
  const file = path.join(RUNTIME.templatesDir, `${templateId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Template "${templateId}" não encontrado.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function resolveBackgroundBufferGeneric(collectionId, slug, manifestEntry, record) {
  return resolveBackgroundBufferForItem(collectionId, slug, record);
}

const PRODUCTION_BACKGROUND_KEY = "__production_background__";

async function validateCollectionProduction(collection) {
  const errors = [];
  const templateId = collection.defaultTemplateId;
  let template;
  try {
    template = await loadTemplate(templateId);
  } catch (err) {
    errors.push(`Template "${templateId}" não encontrado.`);
    return errors;
  }

  const dummyFields = {};
  for (const binding of collection.templateBindings || []) {
    if (binding.sourceField) dummyFields[binding.sourceField] = "Valor de exemplo";
  }
  for (const [_, source] of Object.entries(collection.fieldMappings || {})) {
    if (source) dummyFields[source] = dummyFields[source] || "Valor de exemplo";
  }
  const dummyRecord = { fields: dummyFields, prompt: "Prompt de exemplo", sourceImage: "", sourceStatus: "" };
  const values = resolveTemplateBindingsValues(collection, dummyRecord);
  const missing = requiredVariablesMissing(template, values);
  if (missing.length > 0) {
    errors.push(`Variáveis obrigatórias sem binding: ${missing.join(", ")}.`);
  }

  const binding = collection.productionBackgroundBinding;
  if (binding?.variable) {
    const variable = (template.variables || []).find((v) => v.key === binding.variable);
    if (!variable) errors.push(`Variável de fundo "${binding.variable}" não existe no template.`);
    else if (variable.type !== "image") errors.push(`A variável "${binding.variable}" deve ser do tipo imagem.`);
  } else if (binding?.layerId) {
    const layer = template.layers.find((l) => l.id === binding.layerId);
    if (!layer) errors.push(`Camada de fundo "${binding.layerId}" não existe no template.`);
    else if (!["background", "image", "overlay"].includes(layer.type)) {
      errors.push(`A camada "${binding.layerId}" não aceita asset de imagem.`);
    }
  } else {
    const hasImageVar = (template.variables || []).some(
      (v) => v.type === "image" && v.binding && v.binding.property === "assetId"
    );
    const hasBgLayer = template.layers.some((l) => l.type === "background");
    if (!hasImageVar && !hasBgLayer) {
      errors.push("Template não possui variável de imagem com binding assetId nem camada background para receber o fundo de produção.");
    }
  }

  return errors;
}

function applyProductionBackground(template, values, collection) {
  const binding = collection.productionBackgroundBinding;
  if (binding?.variable) {
    return { ...values, [binding.variable]: PRODUCTION_BACKGROUND_KEY };
  }
  if (binding?.layerId) {
    const templateCopy = JSON.parse(JSON.stringify(template));
    const layer = templateCopy.layers.find((l) => l.id === binding.layerId);
    if (layer) {
      layer.properties = { ...layer.properties, assetId: PRODUCTION_BACKGROUND_KEY };
    }
    return { template: templateCopy, values };
  }

  // Fallback: primeira variável de imagem com binding assetId ou camada background.
  const imageVar = (template.variables || []).find(
    (v) => v.type === "image" && v.binding && v.binding.property === "assetId"
  );
  if (imageVar) {
    return { ...values, [imageVar.key]: PRODUCTION_BACKGROUND_KEY };
  }

  const bgLayer = template.layers.find((l) => l.type === "background");
  if (bgLayer) {
    const templateCopy = JSON.parse(JSON.stringify(template));
    const layer = templateCopy.layers.find((l) => l.id === bgLayer.id);
    if (layer) {
      layer.properties = { ...layer.properties, assetId: PRODUCTION_BACKGROUND_KEY };
    }
    return { template: templateCopy, values };
  }

  return { template, values };
}

async function renderItem(collectionId, slug, { templateId = null } = {}) {
  if (isLegacyCollection(collectionId)) {
    return courseService.renderCourse(slug);
  }

  const record = await getRecord(collectionId, validateSlug(slug));
  if (!record) throw new Error("Item não encontrado.");

  const collection = await loadCollection(collectionId);
  const useTemplateId = templateId || collection.defaultTemplateId;

  if (useTemplateId === LEGACY_TEMPLATE_ID) {
    throw new Error("Template Cruzeiro não pode ser usado fora da coleção padrão.");
  }

  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  const catalogDir = catalogDirFor(collectionId);
  const storage = storageFor(collectionId);
  const files = courseFiles(slug);

  const backgroundBuffer = await resolveBackgroundBufferGeneric(collectionId, slug, entry, record);

  let cardBuffer;
  if (useTemplateId === LEGACY_TEMPLATE_ID) {
    const courseLike = recordToMetadataRecord(record);
    cardBuffer = await renderCourseCard(await prepareBackgroundBuffer(backgroundBuffer), courseLike);
  } else {
    const template = await loadTemplate(useTemplateId);
    const values = resolveTemplateBindingsValues(collection, record);
    const missing = requiredVariablesMissing(template, values);
    if (missing.length > 0) {
      throw new Error(`Variáveis obrigatórias sem binding: ${missing.join(", ")}`);
    }
    const applied = applyProductionBackground(template, values, collection);
    cardBuffer = await renderTemplate(applied.template || template, applied.values, {
      runtimeAssets: { [PRODUCTION_BACKGROUND_KEY]: backgroundBuffer },
    });
  }

  await storage.save(`${slug}/card`, cardBuffer, { contentType: "image/png" });

  const resolvedStatus = await resolveGenericStatus(entry, storage, slug);
  const nextStatus = resolvedStatus === "aprovado" ? "aprovado" : "gerado";
  setManifestEntry(manifest, slug, {
    course_id: record.id,
    curso: record.title,
    status: nextStatus,
    cardPath: `${slug}/card`,
    template_id: useTemplateId,
    renderedAt: new Date().toISOString(),
    error: null,
  });
  saveManifest(collectionId, manifest);

  return { cardPath: path.join(catalogDir, slug, files.card), size: cardBuffer.length };
}

async function approveItem(collectionId, slug, { source = "batch", runId = null, jobId = null, templateId = null } = {}) {
  if (isLegacyCollection(collectionId)) {
    return courseService.approveCourse(slug);
  }

  const record = await getRecord(collectionId, validateSlug(slug));
  if (!record) throw new Error("Item não encontrado.");

  const catalogDir = catalogDirFor(collectionId);
  const storage = storageFor(collectionId);
  const files = courseFiles(slug);

  // Resolve as chaves do visual atual (aprovado ou candidato).
  const visual = await resolveItemVisual(collectionId, slug, record);
  if (!visual.backgroundKey || !visual.cardKey || !(await storage.exists(visual.cardKey))) {
    throw new Error("Não é possível aprovar sem card renderizado.");
  }

  // Gera WhatsApp se ainda não existir.
  const whatsappKey = visual.whatsappKey || `${slug}/${files.whatsapp}`;
  if (!(await storage.exists(whatsappKey))) {
    const cardBuffer = await storage.read(visual.cardKey);
    const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
    await storage.save(whatsappKey, whatsappBuffer, { contentType: "image/jpeg" });
  }

  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  const approvedAt = new Date().toISOString();
  setManifestEntry(manifest, slug, {
    ...entry,
    course_id: record.id,
    curso: record.title,
    status: "aprovado",
    approvedAt,
    error: null,
    approvedVisual: {
      collectionId,
      slug,
      source,
      runId,
      jobId,
      templateId: templateId || entry.template_id || null,
      backgroundKey: visual.backgroundKey,
      cardKey: visual.cardKey,
      whatsappKey,
      approvedAt,
      updatedAt: approvedAt,
    },
  });
  saveManifest(collectionId, manifest);

  try {
    await finishedPiecesService.createFromBatchApprovedVisual({
      collectionId,
      slug,
      approvedVisual: getManifestEntry(manifest, slug).approvedVisual,
      manifest,
      source: "batch",
    });
  } catch (err) {
    console.warn("Falha ao registrar peça finalizada no histórico:", err.message);
  }

  return getManifestEntry(manifest, slug);
}

async function rejectItem(collectionId, slug) {
  if (isLegacyCollection(collectionId)) {
    return courseService.rejectCourse(slug);
  }

  const record = await getRecord(collectionId, validateSlug(slug));
  if (!record) throw new Error("Item não encontrado.");

  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  setManifestEntry(manifest, slug, {
    ...entry,
    course_id: record.id,
    curso: record.title,
    status: "rejeitado",
    rejectedAt: new Date().toISOString(),
    error: null,
  });
  saveManifest(collectionId, manifest);
  return getManifestEntry(manifest, slug);
}

async function generateWhatsApp(collectionId, slug) {
  const record = await getRecord(collectionId, slug);
  const visual = record ? await resolveItemVisual(collectionId, slug, record) : null;
  const cardKey = visual?.cardKey || `${slug}/${files.card}`;
  const whatsappKey = visual?.whatsappKey || `${slug}/${files.whatsapp}`;
  const storage = storageFor(collectionId);
  if (!(await storage.exists(cardKey))) {
    throw new Error("Card ainda não foi renderizado.");
  }

  const cardBuffer = await storage.read(cardKey);
  const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
  await storage.save(whatsappKey, whatsappBuffer, { contentType: "image/jpeg" });

  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  setManifestEntry(manifest, slug, {
    ...entry,
    status: entry.status === "aprovado" ? "aprovado" : "pronto_revisao",
    whatsappPath: `${slug}/whatsapp`,
    error: null,
  });
  saveManifest(collectionId, manifest);
  return { size: whatsappBuffer.length, file: courseFiles(slug).whatsapp };
}

async function listMetadataForCollection(collectionId) {
  const catalogDir = catalogDirFor(collectionId);
  const result = [];
  if (!fs.existsSync(catalogDir)) return result;
  for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(catalogDir, entry.name, "metadata.json");
    if (!fs.existsSync(file)) continue;
    try {
      result.push(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // ignora
    }
  }
  return result;
}

module.exports = {
  LEGACY_COLLECTION_ID,
  LEGACY_TEMPLATE_ID,
  catalogDirFor,
  manifestFileFor,
  ensureManifest,
  saveManifest,
  storageFor,
  listItems,
  getItem,
  generateAIBackground,
  uploadBackground,
  renderItem,
  approveItem,
  rejectItem,
  generateWhatsApp,
  loadCollectionAndRecords,
  getRecord,
  listMetadataForCollection,
  resolveTemplateBindingsValues,
  requiredVariablesMissing,
  isLegacyCollection,
  applyProductionBackground,
  resolveBackgroundBufferGeneric,
  validateCollectionProduction,
  getManifestEntry,
  setManifestEntry,
  PRODUCTION_BACKGROUND_KEY,
};
