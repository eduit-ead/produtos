/**
 * Template visual cruzeiro-pos-v1 (Pós-Graduação), 1080×1080.
 * Independente de cruzeiro-graduacao-v1 / render-card.js.
 */

const fs = require("fs");
const path = require("path");
const { ensurePosFontconfig } = require("./pos-fontconfig");

ensurePosFontconfig();

const sharp = require("sharp");

const WIDTH = 1080;
const HEIGHT = 1080;

const TITLE_X = 55;
const TITLE_Y = 705;
const TITLE_MAX_WIDTH = 970;
const TITLE_MAX_LINES = 3;
const TITLE_MAX_BOTTOM = 888;
const TITLE_FONT_MIN = 53;
const TITLE_FONT_FLOOR = 50;
const TITLE_LINE_FACTOR = 0.98;
const TITLE_MAX_ONE_LINE = 108;
const TITLE_MAX_TWO_LINES = 92;
const TITLE_MAX_THREE_LINES = 82;
const TITLE_TRACKING = "-0.06em";

const NAVY = "#071833";
const YELLOW = "#F5C518";
const TITLE_YELLOW = "#FFE14A";
const BADGE_BLUE = "#0B2A6B";

const LOGO_PATH = path.join(__dirname, "..", "..", "..", "assets", "LOGOcRUZEIRO.png");
const STAR_PATH = path.join(__dirname, "..", "..", "..", "assets", "logo-cruzeiro-branco.png");
const FONT_PATH = path.join(__dirname, "..", "..", "..", "assets", "fonts", "Inter-Black.ttf");
const FONT_FAMILY = "Inter Black";
const FONT_WEIGHT = 900;

// APROVADO — não alterar sem solicitação explícita.
const BADGE = { x: 55, y: 624, width: 340, height: 56, fontSize: 23, letterSpacing: 1.6, radius: 9 };
const BADGE_FAMILY = "Inter ExtraBold";
const BADGE_WEIGHT = 800;
const BADGE_TEXT = "PÓS - GRADUAÇÃO";
const TITLE_ZONE_TOP = 700;
const TITLE_ZONE_BOTTOM = 880;
const CARDS_TOP = 920;

const widthCache = new Map();

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function visualTitle(value) {
  return String(value || "").trim().toLocaleUpperCase("pt-BR");
}

function svgDocument(width, height, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${body}
</svg>`;
}

async function textInkWidth(text, letterSpacing = "0") {
  const key = `${letterSpacing}|${text}`;
  if (widthCache.has(key)) return widthCache.get(key);
  const svg = svgDocument(
    2600,
    220,
    `<text x="20" y="160" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="100" letter-spacing="${letterSpacing}" fill="#ffffff">${escapeXml(text)}</text>`
  );
  const trimmed = await sharp(Buffer.from(svg)).trim().png().toBuffer({ resolveWithObject: true });
  const width = trimmed.info.width || 0;
  widthCache.set(key, width);
  return width;
}

async function measure(text, fontSize) {
  if (!text) return 0;
  const base = await textInkWidth(text);
  return (base * fontSize) / 100;
}

function segmentWidth(prefix, spaceWidth, start, end) {
  if (end <= start) return 0;
  const raw = prefix[end] - prefix[start];
  return start > 0 ? raw - spaceWidth : raw;
}

function scoreWidths(widths) {
  const max = Math.max(...widths);
  const min = Math.min(...widths);
  const avg = widths.reduce((sum, value) => sum + value, 0) / widths.length;
  let variance = 0;
  for (const width of widths) variance += (width - avg) ** 2;
  const last = widths[widths.length - 1];
  const shortLast = Math.max(0, max * 0.62 - last);
  return variance + shortLast * shortLast * 8;
}

function fitsBlock(lineCount, fontSize) {
  const cap = fontSize * 0.76;
  const descent = fontSize * 0.2;
  const step = fontSize * TITLE_LINE_FACTOR;
  const lastBaseline = TITLE_Y + cap + (lineCount - 1) * step;
  return lastBaseline + descent <= TITLE_MAX_BOTTOM;
}

function chooseLayout(words, prefix, spaceWidth, fontSize, maxWidth) {
  const count = words.length;
  if (!count) return null;
  const scale = fontSize / 100;

  function widthOf(start, end) {
    return segmentWidth(prefix, spaceWidth, start, end) * scale;
  }

  function consider(breaks) {
    const widths = [];
    let start = 0;
    for (const end of breaks) {
      const width = widthOf(start, end);
      if (width > maxWidth + 0.5) return null;
      widths.push(width);
      start = end;
    }
    if (!fitsBlock(breaks.length, fontSize)) return null;
    return { breaks, widths, score: scoreWidths(widths) };
  }

  let best = null;
  function keep(candidate) {
    if (!candidate) return;
    if (!best || candidate.breaks.length < best.breaks.length) {
      best = candidate;
      return;
    }
    if (candidate.breaks.length > best.breaks.length) return;
    if (candidate.score < best.score - 0.01) best = candidate;
  }

  keep(consider([count]));

  if (count >= 2) {
    for (let split = 1; split < count; split += 1) {
      keep(consider([split, count]));
    }
  }

  if (count >= 3) {
    for (let first = 1; first < count - 1; first += 1) {
      for (let second = first + 1; second < count; second += 1) {
        keep(consider([first, second, count]));
      }
    }
  }

  if (!best) return null;
  const lines = [];
  let start = 0;
  best.breaks.forEach((end, index) => {
    lines.push({
      text: words.slice(start, end).join(" "),
      width: Math.round(best.widths[index]),
    });
    start = end;
  });
  return { fontSize, lines, overflow: false };
}

function maxFontForLineCount(lineCount) {
  if (lineCount <= 1) return TITLE_MAX_ONE_LINE;
  if (lineCount === 2) return TITLE_MAX_TWO_LINES;
  return TITLE_MAX_THREE_LINES;
}

let fontChecked = false;

async function assertInterBlackLoaded() {
  if (fontChecked) return;
  const svg = svgDocument(
    400,
    220,
    `<text x="10" y="160" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="140" fill="#ffffff">H</text>`
  );
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minY = info.height;
  let maxY = 0;
  let minX = info.width;
  let maxX = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 40) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  const stemY = minY + Math.round((maxY - minY) * 0.18);
  let stem = 0;
  let run = 0;
  for (let x = minX; x <= maxX; x += 1) {
    const alpha = data[(stemY * info.width + x) * 4 + 3];
    if (alpha > 80) {
      run += 1;
      stem = Math.max(stem, run);
    } else run = 0;
  }
  if (!maxX || stem < 22) {
    throw new Error(
      `Inter Black não foi aplicado (haste do H em 140px = ${stem}px; o fallback fica em ~12px).`
    );
  }
  fontChecked = { stemPxAt140: stem, inkWidth: maxX - minX + 1, inkHeight: maxY - minY + 1 };
}

function fontProof() {
  return {
    fontFamily: FONT_FAMILY,
    fontWeight: FONT_WEIGHT,
    letterSpacing: TITLE_TRACKING,
    fontFile: FONT_PATH,
    ...fontChecked,
  };
}

async function layoutPosTitle(title) {
  await assertInterBlackLoaded();
  const text = visualTitle(title);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return { fontSize: TITLE_MAX_ONE_LINE, lines: [], overflow: true, text };
  }

  const spaceWidth = (await textInkWidth("NN NN", TITLE_TRACKING)) - (await textInkWidth("NNNN", TITLE_TRACKING));
  const widths = [];
  for (const word of words) widths.push(await textInkWidth(word, TITLE_TRACKING));
  const prefix = [0];
  for (let i = 0; i < words.length; i += 1) {
    prefix.push(prefix[i] + widths[i] + (i > 0 ? spaceWidth : 0));
  }

  for (let fontSize = TITLE_MAX_ONE_LINE; fontSize >= TITLE_FONT_MIN; fontSize -= 1) {
    const layout = chooseLayout(words, prefix, spaceWidth, fontSize, TITLE_MAX_WIDTH);
    if (!layout) continue;
    if (fontSize > maxFontForLineCount(layout.lines.length)) continue;
    return { ...layout, text };
  }

  const floorLayout = chooseLayout(words, prefix, spaceWidth, TITLE_FONT_FLOOR, TITLE_MAX_WIDTH);
  if (floorLayout) return { ...floorLayout, text };

  const scale = TITLE_FONT_FLOOR / 100;
  const lines = [];
  let current = [];
  let currentWidth = 0;
  for (const word of words) {
    const wordWidth = (await textInkWidth(word, TITLE_TRACKING)) * scale;
    const nextWidth = current.length ? currentWidth + spaceWidth * scale + wordWidth : wordWidth;
    if (current.length && nextWidth > TITLE_MAX_WIDTH) {
      lines.push({ text: current.join(" "), width: Math.round(currentWidth) });
      current = [word];
      currentWidth = wordWidth;
    } else {
      current.push(word);
      currentWidth = nextWidth;
    }
  }
  if (current.length) lines.push({ text: current.join(" "), width: Math.round(currentWidth) });

  const overflow =
    lines.length > TITLE_MAX_LINES || lines.some((line) => line.width > TITLE_MAX_WIDTH + 0.5);
  return {
    fontSize: TITLE_FONT_FLOOR,
    lines,
    overflow,
    text,
  };
}

function lineColor(index, count) {
  if (count <= 1) return "#ffffff";
  return index === count - 1 ? TITLE_YELLOW : "#ffffff";
}

async function fitValueSize(text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    if ((await measure(text, size)) <= maxWidth) return size;
  }
  return minSize;
}

async function renderOverlay(modalidade, duracao) {
  const valueMax = 330;
  const modalidadeSize = await fitValueSize(String(modalidade || ""), valueMax, 36, 22);
  const duracaoSize = await fitValueSize(String(duracao || ""), valueMax, 36, 22);
  const badgeX = BADGE.x;
  const badgeCenter = badgeX + BADGE.width / 2;

  const body = `
    <defs>
      <!-- APROVADO — não alterar sem solicitação explícita. -->
      <linearGradient id="badgeFill" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#F2B90B"/>
        <stop offset="22%" stop-color="#F5C218"/>
        <stop offset="36%" stop-color="#F8D56A"/>
        <stop offset="45%" stop-color="#F8E4A4"/>
        <stop offset="56%" stop-color="#F6D15A"/>
        <stop offset="74%" stop-color="#EBB30E"/>
        <stop offset="100%" stop-color="#E0A807"/>
      </linearGradient>
      <linearGradient id="badgeLift" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
        <stop offset="48%" stop-color="#ffffff" stop-opacity="0.02"/>
        <stop offset="100%" stop-color="#5A3C00" stop-opacity="0.07"/>
      </linearGradient>
      <filter id="badgeShadow" x="-12%" y="-16%" width="124%" height="140%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#071833" flood-opacity="0.13"/>
      </filter>
      <clipPath id="badgeClip">
        <rect x="${badgeX}" y="${BADGE.y}" width="${BADGE.width}" height="${BADGE.height}" rx="${BADGE.radius}"/>
      </clipPath>
    </defs>
    <g filter="url(#badgeShadow)">
      <rect x="${badgeX}" y="${BADGE.y}" width="${BADGE.width}" height="${BADGE.height}" rx="${BADGE.radius}" fill="url(#badgeFill)" stroke="none"/>
    </g>
    <g clip-path="url(#badgeClip)">
      <rect x="${badgeX}" y="${BADGE.y}" width="${BADGE.width}" height="${BADGE.height}" fill="url(#badgeLift)"/>
    </g>
    <text x="${badgeCenter}" y="${BADGE.y + 36}" text-anchor="middle" font-family="${BADGE_FAMILY}" font-weight="${BADGE_WEIGHT}" font-size="${BADGE.fontSize}" letter-spacing="${BADGE.letterSpacing}" fill="${BADGE_BLUE}">${BADGE_TEXT}</text>

    <rect x="65" y="920" width="450" height="105" rx="18" fill="#ffffff"/>
    <circle cx="122" cy="972" r="34" fill="#123A8C"/>
    <circle cx="142" cy="992" r="7" fill="${YELLOW}"/>
    <rect x="107" y="960" width="30" height="22" rx="3" fill="none" stroke="#ffffff" stroke-width="2.6"/>
    <rect x="116" y="955" width="10" height="5" rx="1" fill="#ffffff"/>
    <text x="172" y="960" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="18" fill="#2C3A50">Modalidade:</text>
    <text x="172" y="998" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${modalidadeSize}" fill="#0B2148">${escapeXml(modalidade)}</text>

    <rect x="565" y="920" width="450" height="105" rx="18" fill="#ffffff"/>
    <circle cx="622" cy="972" r="34" fill="#123A8C"/>
    <circle cx="642" cy="992" r="7" fill="${YELLOW}"/>
    <circle cx="622" cy="972" r="15" fill="none" stroke="#ffffff" stroke-width="2.6"/>
    <line x1="622" y1="972" x2="622" y2="961" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
    <line x1="622" y1="972" x2="631" y2="977" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
    <text x="672" y="960" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="18" fill="#2C3A50">Duração:</text>
    <text x="672" y="998" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${duracaoSize}" fill="#0B2148">${escapeXml(duracao)}</text>
  `;

  const buffer = await sharp(Buffer.from(svgDocument(WIDTH, HEIGHT, body))).png().toBuffer();
  return {
    buffer,
    badge: { ...BADGE, text: BADGE_TEXT, fontFamily: BADGE_FAMILY, fontWeight: BADGE_WEIGHT },
    cards: {
      labelSize: 18,
      labelWeight: FONT_WEIGHT,
      modalidadeSize,
      duracaoSize,
      valueWeight: FONT_WEIGHT,
      iconRadius: 34,
    },
  };
}

function titlePlacement(layout) {
  const fontSize = layout.fontSize;
  const lineCount = Math.max(1, layout.lines.length);
  const step = fontSize * TITLE_LINE_FACTOR;
  const cap = fontSize * 0.76;
  const descent = fontSize * 0.2;
  const titleBlockHeight = cap + (lineCount - 1) * step + descent;
  const zoneHeight = TITLE_ZONE_BOTTOM - TITLE_ZONE_TOP;
  const titleY = TITLE_ZONE_TOP + (zoneHeight - titleBlockHeight) / 2;
  const badgeBottom = BADGE.y + BADGE.height;
  const titleBottom = titleY + titleBlockHeight;
  return {
    titleY: Math.round(titleY * 10) / 10,
    titleBlockHeight: Math.round(titleBlockHeight * 10) / 10,
    cap,
    step,
    badgeGap: Math.round((titleY - badgeBottom) * 10) / 10,
    cardsGap: Math.round((CARDS_TOP - titleBottom) * 10) / 10,
  };
}

async function renderTitle(layout) {
  const fontSize = layout.fontSize;
  const place = titlePlacement(layout);
  const baseline = place.titleY + place.cap;
  const step = place.step;
  const lines = layout.lines
    .map((line, index) => {
      const y = Math.round(baseline + index * step);
      const fill = lineColor(index, layout.lines.length);
      return `<text x="${TITLE_X}" y="${y}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${fontSize}" letter-spacing="${TITLE_TRACKING}" fill="${fill}">${escapeXml(line.text)}</text>`;
    })
    .join("");
  const svg = svgDocument(WIDTH, HEIGHT, lines);
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), placement: place };
}

async function loadLogo() {
  return sharp(LOGO_PATH).trim().resize({ width: 400, withoutEnlargement: true }).png().toBuffer();
}

async function loadStar() {
  const resized = await sharp(STAR_PATH)
    .extract({ left: 254, top: 40, width: 515, height: 650 })
    .resize({ width: 330 })
    .ensureAlpha()
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  const visibleWidth = Math.min(meta.width, WIDTH - 820);
  const visibleHeight = Math.min(meta.height, HEIGHT - 690);
  const cropped = await sharp(resized)
    .extract({ left: 0, top: 0, width: visibleWidth, height: visibleHeight })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = cropped;
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * 0.16);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

async function renderCruzeiroPosV1({ titulo, modalidade, duracao, backgroundBuffer }) {
  const layout = await layoutPosTitle(titulo);
  const [photo, gradient, logo, star, overlay, title] = await Promise.all([
    sharp(backgroundBuffer)
      .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
      .extract({ left: 0, top: 160, width: WIDTH, height: 860 })
      .png()
      .toBuffer(),
    sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${NAVY}" stop-opacity="0"/>
            <stop offset="44.44%" stop-color="${NAVY}" stop-opacity="0"/>
            <stop offset="49.07%" stop-color="${NAVY}" stop-opacity="0.05"/>
            <stop offset="53.7%" stop-color="${NAVY}" stop-opacity="0.18"/>
            <stop offset="58.33%" stop-color="${NAVY}" stop-opacity="0.38"/>
            <stop offset="62.96%" stop-color="${NAVY}" stop-opacity="0.65"/>
            <stop offset="67.59%" stop-color="${NAVY}" stop-opacity="0.85"/>
            <stop offset="72.22%" stop-color="${NAVY}" stop-opacity="1"/>
            <stop offset="100%" stop-color="${NAVY}" stop-opacity="1"/>
          </linearGradient>
          <radialGradient id="depth" cx="32%" cy="78%" r="46%">
            <stop offset="0%" stop-color="#14345c" stop-opacity="0.72"/>
            <stop offset="40%" stop-color="${NAVY}" stop-opacity="0.12"/>
            <stop offset="100%" stop-color="#040c18" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#040c18" stop-opacity="0"/>
            <stop offset="74%" stop-color="#040c18" stop-opacity="0"/>
            <stop offset="100%" stop-color="#030914" stop-opacity="0.5"/>
          </linearGradient>
        </defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#depth)"/>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#base)"/>
      </svg>`)
    )
      .png()
      .toBuffer(),
    loadLogo(),
    loadStar(),
    renderOverlay(String(modalidade || ""), String(duracao || "")),
    renderTitle(layout),
  ]);

  const logoMeta = await sharp(logo).metadata();
  const buffer = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: NAVY },
  })
    .composite([
      { input: photo, left: 0, top: 0 },
      { input: gradient, left: 0, top: 0 },
      { input: star, left: 820, top: 690 },
      { input: logo, left: 60, top: 48 },
      { input: overlay.buffer, left: 0, top: 0 },
      { input: title.buffer, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  return {
    buffer,
    layout,
    logo: {
      file: "assets/LOGOcRUZEIRO.png",
      width: logoMeta.width,
      height: logoMeta.height,
    },
    badge: overlay.badge,
    titlePlacement: title.placement,
    cards: overlay.cards,
    font: fontProof(),
  };
}

module.exports = {
  layoutPosTitle,
  renderCruzeiroPosV1,
  visualTitle,
  FONT_FAMILY,
  FONT_WEIGHT,
};
