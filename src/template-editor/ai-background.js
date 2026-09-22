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

function buildDnaWorkImagePrompt(tituloVaga = "", sexo = "Indiferente", ambiente = "", descricaoAdicional = "") {
  const title = normalizeLine(tituloVaga || "profissional");
  const normalizedSexo = normalizeLine(sexo || "Indiferente");
  const sexoKey = normalizedSexo.toLowerCase();
  const sexoText =
    sexoKey === "masculino"
      ? "Aparência feminina ou masculina: apresentar uma pessoa adulta do sexo masculino."
      : sexoKey === "feminino"
      ? "Aparência feminina ou masculina: apresentar uma pessoa adulta do sexo feminino."
      : "Aparência feminina ou masculina: não impor aparência masculina ou feminina; manter gênero neutro e inclusivo.";

  const defaultAmbiente = `ambiente profissional discreto relacionado à função de ${title}`;
  const ambienteText = normalizeLine(ambiente) || defaultAmbiente;
  const extra = normalizeLine(descricaoAdicional);

  const parts = [
    `Gere uma fotografia publicitária fotorrealista de EXATAMENTE UMA pessoa adulta representando a profissão de ${title}.`,
    ``,
    `DADOS DA VAGA (usar como contexto, sem substituir as instruções fixas abaixo):`,
    `- Cargo/profissão: ${title}`,
    `- Sexo selecionado: ${normalizedSexo}`,
    `- ${sexoText}`,
    `- Ambiente profissional: ${ambienteText}`,
  ];
  if (extra) {
    parts.push(`- Descrição adicional: ${extra}`);
  }

  parts.push(
    ``,
    `INSTRUÇÕES FIXAS DE COMPOSIÇÃO (sempre obedecer):`,
    `- Imagem vertical no formato 3:4.`,
    `- Enquadramento da metade das coxas até acima da cabeça.`,
    `- A pessoa deve ocupar aproximadamente 70% da altura total da imagem.`,
    `- Posicionar a pessoa no centro horizontal da fotografia, ligeiramente à direita, sem cortar cabeça, mãos, braços ou tronco.`,
    `- Corpo levemente voltado para a esquerda da câmera, com o rosto olhando para a câmera ou discretamente para a esquerda.`,
    `- Rosto na região superior da imagem, com espaço livre acima da cabeça e à esquerda da pessoa.`,
    `- Postura profissional, natural e confiante.`,
    `- Rosto nítido, proporções anatômicas realistas e expressão amigável.`,
    `- Vestimenta profissional coerente com a função de ${title}.`,
    `- Cenário profissional discreto, com poucos objetos e profundidade de campo suave.`,
    `- Fundo levemente desfocado, sem pessoas adicionais.`,
    `- Iluminação fotográfica profissional, suave e equilibrada.`,
    `- Fotografia comercial de alta qualidade, com cores naturais e aparência autêntica.`,
    ``,
    `INTEGRAÇÃO COM O TEMPLATE DNA WORK:`,
    `A fotografia será inserida no canto superior direito de um card publicitário vertical de 1080x1350 pixels, aplicando uma máscara de transparência progressiva nas bordas esquerda e inferior para revelar o fundo azul-marinho do template.`,
    `A fotografia NÃO deve conter o card publicitário, textos, letras, números, legendas, placas, logotipos, marcas comerciais, marcas-d'água, flyers, banners, anúncios, layouts gráficos, ilustrações, desenhos, caricaturas, personagens 3D, montagens, colagens, mosaicos, múltiplos enquadramentos, molduras, bordas ou gradientes artificiais.`,
    `Não gerar mais de uma pessoa, pessoas ao fundo, pessoas parcialmente visíveis, mãos extras, dedos adicionais ou deformações anatômicas.`,
    ``,
    `RESULTADO FINAL:`,
    `Uma única fotografia profissional fotorrealista de uma pessoa adulta representando a profissão de ${title}, pronta para ser posicionada no canto superior direito do template DNA Work.`
  );

  return parts.join("\n");
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
