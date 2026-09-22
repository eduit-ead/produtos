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

function parseSize(size = DEFAULT_SIZE) {
  const parts = String(size).toLowerCase().split("x").map(Number);
  const width = Number.isFinite(parts[0]) ? parts[0] : 1024;
  const height = Number.isFinite(parts[1]) ? parts[1] : 1792;
  return { width, height };
}

async function createMockPhoto(size = "1024x1792") {
  const { width, height } = parseSize(size);
  const bg = "#0a1a35";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${bg}"/>
  <ellipse cx="${width / 2}" cy="${height * 0.32}" rx="${width * 0.18}" ry="${width * 0.18}" fill="#d4a373"/>
  <path d="M${width * 0.38},${height * 0.45} L${width * 0.28},${height * 0.72} L${width * 0.72},${height * 0.72} Z" fill="#f37021"/>
  <rect x="${width * 0.34}" y="${height * 0.72}" width="${width * 0.32}" height="${height * 0.20}" rx="${width * 0.03}" fill="#ffffff" opacity="0.9"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function buildDnaWorkImagePrompt(tituloVaga = "") {
  const title = normalizeLine(tituloVaga || "profissional");
  return `Gere uma fotografia publicitária hiper-realista de EXATAMENTE UMA pessoa adulta exercendo ou representando a profissão de ${title}.

COMPOSIÇÃO OBRIGATÓRIA:
- Formato vertical 3:4.
- Exatamente uma pessoa na fotografia.
- Pessoa em pé, com enquadramento da metade das coxas até acima da cabeça.
- A pessoa deve ocupar aproximadamente 75% da altura total da imagem.
- Posicionar a pessoa no centro horizontal da fotografia, sem cortar cabeça, braços, mãos ou tronco.
- O rosto deve estar na região superior da fotografia, com espaço livre acima da cabeça.
- Corpo voltado levemente para a esquerda da câmera, com o rosto olhando para a câmera ou discretamente para a esquerda.
- Postura profissional, natural e confiante.
- Rosto nítido, proporções anatômicas realistas e expressão amigável.
- Vestimenta profissional compatível com a função de ${title}.
- Mostrar a pessoa inteira dentro do enquadramento definido, sem cortes artificiais de ombros ou braços.

CENÁRIO E ILUMINAÇÃO:
- Ambiente de trabalho realista e diretamente relacionado à profissão de ${title}.
- Cenário discreto, com poucos objetos e profundidade de campo suave.
- Fundo levemente desfocado, sem pessoas adicionais.
- Iluminação fotográfica profissional, suave e equilibrada.
- Fotografia comercial de alta qualidade, com cores naturais e aparência autêntica.
- Evitar objetos importantes junto às bordas esquerda e inferior.

INTEGRAÇÃO COM O TEMPLATE:
Esta fotografia será inserida exclusivamente no canto superior direito de um card publicitário vertical da DNA Work.

A fotografia NÃO deve conter o card publicitário, textos ou elementos gráficos.

O sistema aplicará posteriormente uma máscara de transparência nas bordas esquerda e inferior para integrar a imagem ao fundo azul-marinho do template.

Manter a pessoa bem destacada e com boa separação visual do cenário, permitindo esse recorte sem prejudicar sua aparência.

RESTRIÇÕES ABSOLUTAS:
- Não gerar mais de uma pessoa.
- Não gerar pessoas ao fundo, reflexos de pessoas ou pessoas parcialmente visíveis.
- Não gerar montagem, colagem, mosaico ou múltiplos enquadramentos.
- Não gerar textos, letras, números, legendas ou placas.
- Não gerar logotipos, marcas comerciais ou marcas-d'água.
- Não gerar flyer, banner, anúncio ou layout gráfico.
- Não gerar ilustrações, desenhos, caricaturas ou personagens 3D.
- Não cortar a cabeça nem os braços da pessoa.
- Não gerar mãos extras, dedos adicionais ou deformações anatômicas.
- Não adicionar molduras, bordas ou gradientes artificiais.

RESULTADO FINAL:
Uma única fotografia profissional realista de uma pessoa adulta representando a profissão de ${title}, centralizada, em enquadramento vertical da metade das coxas para cima, com cenário profissional discreto, pronta para ser posicionada na parte superior direita do template DNA Work.`;
}

const DNA_WORK_NEGATIVE_PROMPT = "Textos, letras, números, legendas, placas, logotipos, marcas comerciais, marcas-d'água, flyers, banners, anúncios, layouts gráficos, ilustrações, desenhos, caricaturas, personagens 3D, montagens, colagens, mosaicos, múltiplos enquadramentos, mais de uma pessoa, pessoas ao fundo, pessoas parcialmente visíveis, cortes na cabeça ou braços, mãos extras, dedos adicionais, deformações anatômicas, molduras, bordas artificiais, gradientes artificiais.";

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

async function generateStudioPhoto({
  templateId,
  values = {},
  visual = {},
  collectionId,
  itemId,
  dryRun = false,
  model,
  quality,
  size,
  prompt,
  negativePrompt,
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt é obrigatório para gerar a fotografia.");
  }

  const finalModel = model || DEFAULT_MODEL;
  const finalQuality = quality || DEFAULT_QUALITY;
  const finalSize = size || "1024x1792";
  const finalFormat = DEFAULT_FORMAT;

  const runId = uniqueRunId();
  const catalogDir = RUNTIME.catalogDir;
  const storageProvider = createStorageProvider({ baseDir: catalogDir });
  const storageKey = `studio/${runId}/foto`;

  let buffer;
  let record = null;
  let usage = null;
  let cost = null;

  const apiKey = process.env.OPENAI_API_KEY;
  const shouldDryRun = dryRun || !apiKey;

  if (shouldDryRun) {
    buffer = await createMockPhoto(finalSize);
    cost = { ...estimateImageCost(finalModel, finalQuality, finalSize), dryRun: true };
  } else {
    const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "studio-photo-"));
    try {
      const courseLike = {
        course_id: itemId || runId,
        slug: runId,
        curso: values.titulo_vaga || templateId || runId,
        prompt,
      };
      record = await generateImage(courseLike, {
        outputDir: tempDir,
        dryRun: false,
        model: finalModel,
        quality: finalQuality,
        size: finalSize,
        format: finalFormat,
        fileSuffix: "foto",
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
    kind: "photo",
    runId,
    templateId,
    collectionId: collectionId || null,
    itemId: itemId || null,
    values: { ...values },
    visual: { ...visual },
    prompt,
    negativePrompt: negativePrompt || "",
    model: finalModel,
    quality: finalQuality,
    size: finalSize,
    format: finalFormat,
    usage,
    cost,
    dryRun: shouldDryRun,
    hashes: { foto: sha256(buffer) },
    storage: {
      provider: process.env.STORAGE_PROVIDER || "local",
      key: storageKey,
    },
    urls: {
      foto: await storageProvider.getPublicUrl(storageKey),
    },
    generatedAt: new Date().toISOString(),
  };

  const metaDir = path.join(catalogDir, "studio", runId);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  return metadata;
}

async function approveStudioPhoto(runId, { catalogDir, assetsDir } = {}) {
  const resolvedCatalogDir = catalogDir || RUNTIME.catalogDir;
  const resolvedAssetsDir = assetsDir || RUNTIME.assetsDir;
  const storageProvider = createStorageProvider({ baseDir: resolvedCatalogDir });
  const metaPath = path.join(resolvedCatalogDir, "studio", runId, "metadata.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error("Metadados da fotografia não encontrados.");
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (meta.kind !== "photo") {
    throw new Error("O runId informado não corresponde a uma fotografia de estúdio.");
  }
  if (meta.dryRun === true) {
    throw new Error("Fotografias de simulação/dry-run não podem ser aprovadas.");
  }
  const storageKey = meta.storage?.key;
  if (!storageKey || !(await storageProvider.exists(storageKey))) {
    throw new Error("Fotografia não disponível no storage.");
  }
  const buffer = await storageProvider.read(storageKey);
  const assetId = `dna-work-photo-${runId}.png`;
  const assetPath = path.join(resolvedAssetsDir, assetId);
  fs.mkdirSync(resolvedAssetsDir, { recursive: true });
  fs.writeFileSync(assetPath, buffer);
  return { assetId, url: `/api/assets/${assetId}`, runId, metadata: meta };
}

module.exports = {
  assemblePrompt,
  generateStudioBackground,
  generateStudioPhoto,
  approveStudioPhoto,
  estimateImageCost,
  buildDnaWorkImagePrompt,
  DNA_WORK_NEGATIVE_PROMPT,
};
