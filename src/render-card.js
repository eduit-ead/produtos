/**
 * Renderizador de cards 1080x1080 compartilhado.
 *
 * Extraído de src/generate.js para permitir reutilização preservando
 * integralmente o template visual aprovado.
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");

// =======================================================
// TEMPLATE VISUAL FINAL APROVADO - NÃO ALTERAR SEM SOLICITAÇÃO EXPLÍCITA
// =======================================================
const TEMPLATE = {
  width: 1080,
  height: 1080,

  assets: {
    logo: path.join(ROOT, "assets", "logo-cruzeiro-branco.png"),
    gradient: path.join(ROOT, "assets", "gradiente-template.png"),
    frame: path.join(ROOT, "assets", "moldura-template.png"),
  },

  logo: {
    width: 275,
    left: 90,
    top: 561,
    trim: true,
  },

  title: {
    x: 85,
    y: 728,
    fontFamily: "Inter, Arial, Helvetica, sans-serif",
    fontWeight: 800,
    fill: "#ffffff",
    letterSpacing: -1.2,
    lineHeight: 1.0,
    maxBlockWidth: 620,
    maxLines: 2,
    fontSizes: {
      upTo16: 78,
      upTo24: 70,
      upTo34: 62,
      upTo48: 56,
      fallback: 50,
    },
  },

  infoLine: {
    yOffsetFromTitle: 44,
    fontFamily: "Inter, Arial, Helvetica, sans-serif",
    fontSize: 34,
    fontWeight: 700,
    fill: "#6EA0FF",
    letterSpacing: 0.5,
    separator: " | ",
    order: ["modalidade", "formacao", "duracao"],
  },

  photo: {
    fit: "cover",
    position: "attention",
    brightness: 0.98,
    saturation: 0.98,
  },
};

const WIDTH = TEMPLATE.width;
const HEIGHT = TEMPLATE.height;
const LOGO_FILE = TEMPLATE.assets.logo;
const GRADIENT_FILE = TEMPLATE.assets.gradient;
const FRAME_FILE = TEMPLATE.assets.frame;

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeDuration(value = "") {
  return String(value)
    .trim()
    .replace(/Semestres/gi, "semestres")
    .replace(/Semestre/gi, "semestre")
    .replace(/Anos/gi, "anos")
    .replace(/Ano/gi, "ano");
}

function wrapText(text, maxChars = 22) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function wrapTitle(text, fontSize, maxLines = 2) {
  const cleaned = String(text).trim();
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (words.length <= 1) {
    return words;
  }

  const maxBlockWidth = TEMPLATE.title.maxBlockWidth;
  const charWidth = fontSize * 0.56;
  const idealChars = Math.floor(maxBlockWidth / charWidth);

  if (cleaned.length <= idealChars) {
    return [cleaned];
  }

  const totalChars = cleaned.length;
  const targetLines = Math.min(
    maxLines,
    Math.ceil(totalChars / idealChars)
  );
  const targetChars = totalChars / targetLines;

  function splitIntoN(n) {
    const partitions = [];
    function build(start, depth, current) {
      if (depth === n - 1) {
        const last = words.slice(start).join(" ");
        if (last) {
          partitions.push([...current, last]);
        }
        return;
      }
      for (let i = start + 1; i < words.length - (n - depth - 2); i++) {
        const line = words.slice(start, i).join(" ");
        build(i, depth + 1, [...current, line]);
      }
    }
    build(0, 0, []);
    return partitions;
  }

  function score(lines) {
    const lengths = lines.map((l) => l.length);
    const max = Math.max(...lengths);
    const last = lengths[lengths.length - 1];
    const lastWords = lines[lines.length - 1].split(/\s+/).length;

    const lastTooShort = last < Math.max(6, max * 0.38) ? 80 : 0;
    const lastSingleTinyWord =
      lastWords === 1 && last < max * 0.45 ? 120 : 0;

    const overfill = lines.reduce(
      (sum, l) => sum + Math.max(0, l.length - idealChars) * 3,
      0
    );

    const imbalance = lengths.reduce(
      (sum, len) => sum + Math.abs(len - targetChars),
      0
    );

    return imbalance + lastTooShort + lastSingleTinyWord + overfill;
  }

  let candidates = [];
  for (let lines = 2; lines <= maxLines + 1; lines++) {
    const partitions = splitIntoN(lines);
    const valid = partitions.filter(
      (p) => p.length <= maxLines || lines <= maxLines
    );
    candidates = candidates.concat(valid);
  }

  candidates.sort((a, b) => score(a) - score(b));

  const bestWithinLimit = candidates.find((c) => c.length <= maxLines);
  if (bestWithinLimit) {
    return bestWithinLimit;
  }

  if (candidates.length > 0) {
    return candidates[0].slice(0, maxLines + 1);
  }

  return wrapText(cleaned, idealChars).slice(0, maxLines + 1);
}

function getTitleFontSize(title) {
  const len = title.length;
  const sizes = TEMPLATE.title.fontSizes;

  if (len <= 16) return sizes.upTo16;
  if (len <= 24) return sizes.upTo24;
  if (len <= 34) return sizes.upTo34;
  if (len <= 48) return sizes.upTo48;

  return sizes.fallback;
}

function createTextOverlay({ curso, formacao, modalidade, duracao }) {
  const fontSize = getTitleFontSize(curso);
  const titleLines = wrapTitle(curso, fontSize, TEMPLATE.title.maxLines).slice(0, 3);
  const lineHeight = fontSize * TEMPLATE.title.lineHeight;

  const infoValues = {
    modalidade,
    formacao,
    duracao: normalizeDuration(duracao),
  };

  const infoLine = TEMPLATE.infoLine.order
    .map((key) => infoValues[key])
    .filter(Boolean)
    .join(TEMPLATE.infoLine.separator);

  const titleStartY = TEMPLATE.title.y;
  const titleX = TEMPLATE.title.x;

  const titleBlockHeight = titleLines.length * lineHeight;
  const titleBlockBottom = titleStartY + titleBlockHeight;
  const infoY = titleBlockBottom + TEMPLATE.infoLine.yOffsetFromTitle;

  const tspans = titleLines
    .map(
      (line, index) => `
        <tspan
          x="${titleX}"
          dy="${index === 0 ? 0 : lineHeight}"
        >${escapeXml(line)}</tspan>
      `
    )
    .join("");

  return `
  <svg width="${WIDTH}" height="${HEIGHT}"
       viewBox="0 0 ${WIDTH} ${HEIGHT}"
       xmlns="http://www.w3.org/2000/svg">

    <text
      x="${titleX}"
      y="${titleStartY}"
      font-family="${TEMPLATE.title.fontFamily}"
      font-size="${fontSize}"
      font-weight="${TEMPLATE.title.fontWeight}"
      fill="${TEMPLATE.title.fill}"
      letter-spacing="${TEMPLATE.title.letterSpacing}"
    >
      ${tspans}
    </text>

    <text
      x="${titleX}"
      y="${infoY}"
      font-family="${TEMPLATE.infoLine.fontFamily}"
      font-size="${TEMPLATE.infoLine.fontSize}"
      font-weight="${TEMPLATE.infoLine.fontWeight}"
      fill="${TEMPLATE.infoLine.fill}"
      letter-spacing="${TEMPLATE.infoLine.letterSpacing}"
    >
      ${escapeXml(infoLine)}
    </text>

  </svg>
  `;
}

async function loadFrameAssets() {
  const loadPng = async (file, width, height) => {
    if (!fs.existsSync(file)) {
      throw new Error(`Asset não encontrado: ${file}`);
    }

    const pipeline = sharp(file).png();

    if (width && height) {
      pipeline.resize(width, height, {
        fit: "cover",
      });
    }

    return pipeline.toBuffer();
  };

  const [gradientBuffer, frameBuffer, logoBuffer] = await Promise.all([
    loadPng(GRADIENT_FILE, WIDTH, HEIGHT),
    loadPng(FRAME_FILE, WIDTH, HEIGHT),
    (async () => {
      if (!fs.existsSync(LOGO_FILE)) {
        return null;
      }

      const logoPipeline = sharp(LOGO_FILE);

      if (TEMPLATE.logo.trim) {
        logoPipeline.trim();
      }

      return logoPipeline
        .resize({
          width: TEMPLATE.logo.width,
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    })(),
  ]);

  return {
    gradientBuffer,
    frameBuffer,
    logoBuffer,
  };
}

function composeCourseCard(backgroundBuffer, textOverlayBuffer, assets) {
  const { gradientBuffer, frameBuffer, logoBuffer } = assets;

  const composites = [
    { input: gradientBuffer, left: 0, top: 0 },
    { input: frameBuffer, left: 0, top: 0 },
    { input: textOverlayBuffer, left: 0, top: 0 },
  ];

  if (logoBuffer) {
    composites.push({
      input: logoBuffer,
      left: TEMPLATE.logo.left,
      top: TEMPLATE.logo.top,
    });
  }

  return sharp(backgroundBuffer)
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Renderiza um card completo a partir de um buffer de fundo já preparado
 * (1080x1080) e dos dados do curso.
 */
async function renderCourseCard(backgroundBuffer, course) {
  const textOverlay = Buffer.from(createTextOverlay(course));
  const assets = await loadFrameAssets();
  return composeCourseCard(backgroundBuffer, textOverlay, assets);
}

/**
 * Prepara um buffer de fundo a partir de um arquivo/arquivo de imagem original,
 * aplicando o tratamento de foto do template.
 */
async function prepareBackgroundBuffer(inputBuffer) {
  return sharp(inputBuffer)
    .resize(WIDTH, HEIGHT, {
      fit: TEMPLATE.photo.fit,
      position: TEMPLATE.photo.position,
    })
    .modulate({
      brightness: TEMPLATE.photo.brightness,
      saturation: TEMPLATE.photo.saturation,
    })
    .png()
    .toBuffer();
}

module.exports = {
  TEMPLATE,
  WIDTH,
  HEIGHT,
  createTextOverlay,
  loadFrameAssets,
  composeCourseCard,
  renderCourseCard,
  prepareBackgroundBuffer,
  normalizeDuration,
  getTitleFontSize,
  wrapTitle,
};
