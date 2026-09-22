/**
 * Renderizador dedicado do template DNA Work - Temos Vagas.
 *
 * Fundo fixo (já contém títulos, ícones, logo, CTA e mascote).
 * Campos dinâmicos: titulo_vaga, regime, salario, beneficio, local, imagem_principal.
 * Formato: 1080x1350.
 */

const sharp = require("sharp");
const { loadAssetBuffer, fitText, escapeXml } = require("./utils");

const WIDTH = 1080;
const HEIGHT = 1350;

// Área da imagem principal (topo direito)
const IMAGE_X = 540;
const IMAGE_Y = 90;
const IMAGE_W = 510;
const IMAGE_H = 650;
const IMAGE_FADE_LEFT = 160;
const IMAGE_FADE_BOTTOM = 180;

// Caixa arredondada do título da vaga
const TITLE_X = 110;
const TITLE_Y = 560;
const TITLE_W = 340;
const TITLE_H = 70;

// 4 blocos de informação (valores abaixo dos rótulos do fundo)
const BLOCK_W = 200;
const BLOCK_H = 70;
const BLOCK_Y = 980;
const BLOCK_XS = [60, 300, 545, 730];

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function resolveValues(values = {}) {
  const titulo = cleanText(values.titulo_vaga);
  const regime = cleanText(values.regime);
  const salarioRaw = cleanText(values.salario);
  const beneficio = cleanText(values.beneficio);
  const local = cleanText(values.local);

  const salario = salarioRaw === "" || salarioRaw === "0" ? "A combinar" : salarioRaw;
  const beneficioResolved = beneficio === "" ? "A combinar" : beneficio;
  const regimeResolved = regime === "" ? "-" : regime;
  const localResolved = local === "" ? "-" : local;
  const tituloResolved = titulo === "" ? "Vaga disponível" : titulo;

  return {
    titulo_vaga: tituloResolved,
    regime: regimeResolved,
    salario,
    beneficio: beneficioResolved,
    local: localResolved,
    imagem_principal: values.imagem_principal,
  };
}

async function resizeAndMaskImage(buffer, width, height) {
  const resized = await sharp(buffer)
    .resize(width, height, { fit: "cover", position: "right top" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const channels = info.channels;
  const w = info.width;
  const h = info.height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * channels;
      const hFactor = Math.min(1, x / Math.max(1, IMAGE_FADE_LEFT));
      const vFactor = Math.min(1, (h - 1 - y) / Math.max(1, IMAGE_FADE_BOTTOM));
      const factor = Math.min(hFactor, vFactor);
      data[idx + 3] = Math.max(0, Math.min(255, Math.round(data[idx + 3] * factor)));
    }
  }

  return sharp(data, {
    raw: { width: w, height: h, channels },
  })
    .png()
    .toBuffer();
}

function findFittingFontSize(text, width, height, maxLines, maxFont, minFont) {
  const lineHeight = 1.15;
  for (let fs = maxFont; fs >= minFont; fs--) {
    const lines = fitText(text, fs, width, height, lineHeight, maxLines, { truncate: false });
    const totalHeight = lines.length * fs * lineHeight;
    if (lines.length <= maxLines && totalHeight <= height) {
      return { fontSize: fs, lines, lineHeight };
    }
  }
  const lines = fitText(text, minFont, width, height, lineHeight, maxLines, { truncate: true });
  return { fontSize: minFont, lines, lineHeight };
}

async function renderTextBox(text, width, height, options = {}) {
  const {
    maxFontSize = 48,
    minFontSize = 18,
    maxLines = 2,
    fontWeight = 700,
    fill = "#ffffff",
    fontFamily = "Montserrat, Arial, sans-serif",
  } = options;

  const { fontSize, lines, lineHeight } = findFittingFontSize(
    text,
    width,
    height,
    maxLines,
    maxFontSize,
    minFontSize
  );

  const totalHeight = lines.length * fontSize * lineHeight;
  const startY = (height - totalHeight) / 2 + fontSize * 0.85;

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : fontSize * lineHeight;
      return `<tspan x="${width / 2}" dy="${dy}" text-anchor="middle" font-family="${escapeXml(fontFamily)}">${escapeXml(line)}</tspan>`;
    })
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <text
    x="${width / 2}"
    y="${startY}"
    text-anchor="middle"
    font-size="${fontSize}"
    font-weight="${fontWeight}"
    fill="${fill}"
    letter-spacing="-0.5"
  >
    ${tspans}
  </text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderDnaWorkVagas(backgroundBuffer, values = {}) {
  const resolved = resolveValues(values);

  const composites = [];

  // Imagem principal com máscara suave
  const imageBuffer = await loadAssetBuffer(resolved.imagem_principal, values?.__runtimeAssets || values?.runtimeAssets || {});
  if (imageBuffer) {
    const masked = await resizeAndMaskImage(imageBuffer, IMAGE_W, IMAGE_H);
    composites.push({ input: masked, left: IMAGE_X, top: IMAGE_Y });
  }

  // Título da vaga
  const titleBuffer = await renderTextBox(resolved.titulo_vaga, TITLE_W, TITLE_H, {
    maxFontSize: 56,
    minFontSize: 28,
    maxLines: 2,
    fontWeight: 800,
  });
  composites.push({ input: titleBuffer, left: TITLE_X, top: TITLE_Y });

  // Valores dos 4 blocos
  const blockValues = [resolved.regime, resolved.salario, resolved.beneficio, resolved.local];
  for (let i = 0; i < blockValues.length; i++) {
    const x = BLOCK_XS[i];
    const textBuffer = await renderTextBox(blockValues[i], BLOCK_W, BLOCK_H, {
      maxFontSize: 32,
      minFontSize: 20,
      maxLines: 2,
      fontWeight: 700,
    });
    composites.push({ input: textBuffer, left: x, top: BLOCK_Y });
  }

  return sharp(backgroundBuffer)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .composite(composites)
    .png()
    .toBuffer();
}

async function renderDnaWorkVagasTemplate(values = {}, runtimeAssets = {}) {
  const backgroundBuffer = loadAssetBuffer("dna-work-vagas-bg.jpg", runtimeAssets);
  if (!backgroundBuffer) {
    throw new Error("Asset de fundo DNA Work não encontrado: dna-work-vagas-bg.jpg");
  }

  // Normaliza acesso a buffers em memória usados pelos testes/estúdio
  const assets = { ...(runtimeAssets || {}) };
  if (values.imagem_principal && runtimeAssets[values.imagem_principal]) {
    assets[values.imagem_principal] = runtimeAssets[values.imagem_principal];
  }

  return renderDnaWorkVagas(backgroundBuffer, { ...values, __runtimeAssets: assets });
}

module.exports = { renderDnaWorkVagasTemplate, resolveValues, resizeAndMaskImage };
