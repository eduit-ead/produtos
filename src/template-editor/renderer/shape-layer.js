/**
 * Renderização de camadas de forma via SVG processado pelo Sharp.
 */

const sharp = require("sharp");
const { escapeXml } = require("./utils");

function buildShapeSvg(layer) {
  if (!layer || typeof layer !== "object") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1">
  <rect width="1" height="1" fill="none"/>
</svg>`;
  }

  const props = layer.properties || {};
  const w = layer.width;
  const h = layer.height;
  const fill = escapeXml(props.fill || "#000000");
  const stroke = props.stroke ? escapeXml(props.stroke) : null;
  const strokeWidth = Number(props.strokeWidth) || 0;

  let shapeSvg = "";
  const inset = strokeWidth / 2;

  switch (props.shapeType) {
    case "circle": {
      const r = Math.max(0, Math.min(w, h) / 2 - inset);
      shapeSvg = `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
      }/>`;
      break;
    }
    case "ellipse": {
      const rx = Math.max(0, w / 2 - inset);
      const ry = Math.max(0, h / 2 - inset);
      shapeSvg = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${rx}" ry="${ry}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
      }/>`;
      break;
    }
    case "rectangle":
    default: {
      const maxRadius = Math.min(w / 2, h / 2) - inset;
      const radius = Math.max(0, Math.min(Number(props.cornerRadius) || 0, maxRadius));
      shapeSvg = `<rect x="${inset}" y="${inset}" width="${Math.max(0, w - strokeWidth)}" height="${Math.max(
        0,
        h - strokeWidth
      )}" rx="${radius}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
      }/>`;
      break;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${shapeSvg}
</svg>`;
}

async function renderShapeLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }

  const svg = buildShapeSvg(layer);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderShapeLayer };
