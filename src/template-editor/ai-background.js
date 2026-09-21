/**
 * Geração de fundo com IA guiada por template.
 *
 * Reutiliza generateImage existente e as regras editoriais de content-prompt.js.
 * Não armazena credenciais. Salva via StorageProvider em diretório resolvido por
 * APP_RUNTIME_DIR.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { RUNTIME } = require("../config/runtime");
const { createStorageProvider } = require("../storage");
const {
  generateImage,
  DEFAULT_MODEL,
  DEFAULT_QUALITY,
  DEFAULT_SIZE,
  DEFAULT_FORMAT,
} = require("../generate-ai-background");
const { estimateCost } = require("../ai-pricing");
const { getImageGenerationRules } = require("../content-prompt");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function uniqueRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeLine(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function nonEmptyUnique(lines) {
  const seen = new Set();
  return lines
    .map(normalizeLine)
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
}

function assemblePrompt(templateImageGeneration, fields = {}) {
  const cfg = templateImageGeneration || {};
  const parts = [];

  if (cfg.basePrompt) parts.push(cfg.basePrompt);

  const description = fields.prompt_imagem || fields.description || "";
  if (description) parts.push(description);

  const ordered = [
    fields.environment,
    fields.activity,
    fields.people,
    fields.composition,
    fields.details,
  ];
  for (const value of ordered) {
    if (value) parts.push(value);
  }

  const negative = [];
  if (cfg.negativePrompt) negative.push(cfg.negativePrompt);
  if (fields.avoid) negative.push(fields.avoid);

  const rules = getImageGenerationRules();
  if (rules) parts.push(rules);

  const cleanParts = nonEmptyUnique(parts);
  const cleanNegative = nonEmptyUnique(negative);

  const prompt = cleanParts.join("\n\n");
  const negativePrompt = cleanNegative.join("\n\n");

  return { prompt, negativePrompt };
}

function estimateImageCost(model, quality, size) {
  const pricing = require("../ai-pricing").PRICING[model || DEFAULT_MODEL];
  if (!pricing) return null;
  // Estimativa simplificada baseada em tokens de saída típicos para imagem.
  const outputTokens = size === "1024x1024" ? 1000 : size === "1024x1536" || size === "1536x1024" ? 1500 : 2000;
  const outputCost = (outputTokens * pricing.imageOutputUsdPerMillion) / 1_000_000;
  const inputTokens = 200;
  const inputCost = (inputTokens * pricing.textInputUsdPerMillion) / 1_000_000;
  return {
    model: model || DEFAULT_MODEL,
    totalCostUsd: outputCost + inputCost,
    outputTokens,
    inputTokens,
    estimated: true,
  };
}

async function createMockBackground() {
  return sharp({
    create: { width: 1080, height: 1080, channels: 3, background: { r: 11, g: 17, b: 32 } },
  })
    .png()
    .toBuffer();
}

async function generateStudioBackground({
  templateId,
  values = {},
  visual = {},
  collectionId,
  itemId,
  dryRun = false,
  model,
  quality,
  size,
}) {
  const templatePath = path.join(RUNTIME.templatesDir, `${templateId}.json`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template "${templateId}" não encontrado.`);
  }
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const cfg = template.imageGeneration;
  if (!cfg || !cfg.enabled) {
    throw new Error(`Template "${templateId}" não possui geração de imagem habilitada.`);
  }

  const fields = {
    description: values[cfg.promptField || "prompt_imagem"] || visual.description || "",
    environment: visual.environment || "",
    activity: visual.activity || "",
    people: visual.people || "",
    composition: visual.composition || "",
    details: visual.details || "",
    avoid: visual.avoid || "",
  };

  if (!fields.description.trim()) {
    throw new Error("Descrição da cena é obrigatória para gerar o fundo.");
  }

  const { prompt } = assemblePrompt(cfg, fields);
  if (!prompt.trim()) {
    throw new Error("Prompt final montado ficou vazio.");
  }

  const finalModel = model || cfg.defaultModel || DEFAULT_MODEL;
  const finalQuality = quality || cfg.defaultQuality || DEFAULT_QUALITY;
  const finalSize = size || cfg.defaultSize || DEFAULT_SIZE;

  const runId = uniqueRunId();
  const catalogDir = RUNTIME.catalogDir;
  const storageProvider = createStorageProvider({ baseDir: catalogDir });
  const storageKey = `studio/${runId}/fundo`;

  let buffer;
  let record = null;
  let usage = null;
  let cost = null;

  const apiKey = process.env.OPENAI_API_KEY;
  const shouldDryRun = dryRun || !apiKey;

  if (shouldDryRun) {
    buffer = await createMockBackground();
    cost = { ...estimateImageCost(finalModel, finalQuality, finalSize), dryRun: true };
  } else {
    const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "studio-bg-"));
    try {
      const courseLike = {
        course_id: itemId || runId,
        slug: runId,
        curso: values.titulo || template.name || runId,
        prompt,
      };
      record = await generateImage(courseLike, {
        outputDir: tempDir,
        dryRun: false,
      });
      buffer = fs.readFileSync(record.caminho_arquivo);
      usage = record.uso_api || null;
      cost = record.custo_estimado_usd || estimateImageCost(finalModel, finalQuality, finalSize);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  await storageProvider.save(storageKey, buffer, { contentType: "image/png" });

  const metadata = {
    runId,
    templateId,
    collectionId: collectionId || null,
    itemId: itemId || null,
    values: { ...values },
    visual: { ...visual },
    prompt,
    negativePrompt: cfg.negativePrompt || "",
    model: finalModel,
    quality: finalQuality,
    size: finalSize,
    format: DEFAULT_FORMAT,
    usage,
    cost,
    dryRun: shouldDryRun,
    hashes: { fundo: sha256(buffer) },
    storage: {
      provider: process.env.STORAGE_PROVIDER || "local",
      key: storageKey,
    },
    urls: {
      fundo: await storageProvider.getPublicUrl(storageKey),
    },
    generatedAt: new Date().toISOString(),
  };

  const metaDir = path.join(catalogDir, "studio", runId);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

module.exports = {
  assemblePrompt,
  generateStudioBackground,
  estimateImageCost,
};
