/**
 * Utilitários para renderização de templates.
 * x/y representam canto superior esquerdo.
 * A rotação acontece pelo centro da camada.
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ASSETS_DIR = path.join(__dirname, "..", "..", "..", "data", "assets");
const CHAR_WIDTH_RATIO = 0.55;

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function loadAssetBuffer(assetId, runtimeAssets = {}) {
  if (!assetId) return null;
  if (runtimeAssets[assetId]) return runtimeAssets[assetId];
  const safeId = path.basename(assetId);
  const assetPath = path.join(ASSETS_DIR, safeId);
  if (!fs.existsSync(assetPath)) return null;
  return fs.readFileSync(assetPath);
}

function assetPath(assetId) {
  if (!assetId) return null;
  const safeId = path.basename(assetId);
  return path.join(ASSETS_DIR, safeId);
}

function applyOpacity(buffer, opacity) {
  if (opacity >= 1) return buffer;
  if (opacity <= 0) {
    return sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  }
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      for (let i = 3; i < data.length; i += info.channels) {
        data[i] = Math.max(0, Math.min(255, Math.round(data[i] * opacity)));
      }
      return sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
      })
        .png()
        .toBuffer();
    });
}

async function rotateLayer(buffer, angle) {
  if (!angle) {
    const meta = await sharp(buffer).metadata();
    return { buffer, width: meta.width, height: meta.height };
  }
  const rotated = await sharp(buffer)
    .rotate(angle, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const meta = await sharp(rotated).metadata();
  return { buffer: rotated, width: meta.width, height: meta.height };
}

function computeCompositePosition(layer, rotatedWidth, rotatedHeight) {
  return {
    left: Math.round(layer.x + layer.width / 2 - rotatedWidth / 2),
    top: Math.round(layer.y + layer.height / 2 - rotatedHeight / 2),
  };
}

function wrapText(text, maxChars) {
  const paragraphs = String(text).split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = "";
      }

      if (word.length <= maxChars) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += maxChars) {
          const chunk = word.slice(i, i + maxChars);
          if (i + maxChars < word.length) {
            lines.push(chunk);
          } else {
            current = chunk;
          }
        }
      }
    }

    if (current) lines.push(current);
  }

  return lines;
}

function fitText(text, fontSize, maxWidth, maxHeight, lineHeight, maxLines, options = {}) {
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * CHAR_WIDTH_RATIO)));
  const lines = wrapText(text, maxChars);

  if (options.truncate && maxLines > 0 && lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  return lines;
}

function mapFit(fit) {
  switch (fit) {
    case "contain":
      return "inside";
    case "fill":
      return "fill";
    case "cover":
    default:
      return "cover";
  }
}

function mapPosition(position) {
  const map = {
    center: "centre",
    left: "west",
    right: "east",
    top: "north",
    bottom: "south",
    "top-left": "northwest",
    "top-right": "northeast",
    "bottom-left": "southwest",
    "bottom-right": "southeast",
  };
  return map[position] || "centre";
}

function mapPositionFactors(position) {
  const map = {
    center: { x: 0.5, y: 0.5 },
    left: { x: 0, y: 0.5 },
    right: { x: 1, y: 0.5 },
    top: { x: 0.5, y: 0 },
    bottom: { x: 0.5, y: 1 },
    "top-left": { x: 0, y: 0 },
    "top-right": { x: 1, y: 0 },
    "bottom-left": { x: 0, y: 1 },
    "bottom-right": { x: 1, y: 1 },
  };
  return map[position] || { x: 0.5, y: 0.5 };
}

function mapBlend(blendMode) {
  const normalized = String(blendMode || "normal").toLowerCase();
  const map = {
    normal: "over",
    over: "over",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    difference: "difference",
    exclusion: "exclusion",
    "color-dodge": "colour-dodge",
    "color-burn": "colour-burn",
    "hard-light": "hard-light",
    "soft-light": "soft-light",
  };
  return map[normalized] || "over";
}

module.exports = {
  escapeXml,
  loadAssetBuffer,
  assetPath,
  applyOpacity,
  rotateLayer,
  computeCompositePosition,
  wrapText,
  fitText,
  mapFit,
  mapPosition,
  mapPositionFactors,
  mapBlend,
  ASSETS_DIR,
};
