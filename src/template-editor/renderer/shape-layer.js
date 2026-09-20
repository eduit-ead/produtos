/**
 * Renderização de camadas de forma via SVG processado pelo Sharp.
 */

const sharp = require("sharp");
const { escapeXml } = require("./utils");

function buildShapeSvg(layer) {
  const props = layer.properties || {};
  const w = layer.width;
  const h = layer.height;
  const fill = escapeXml(props.fill || "#000000");
  const stroke = props.stroke ? escapeXml(props.stroke) : null;
  const strokeWidth = Number(props.strokeWidth) || 0;

  let shapeSvg = "";

  switch (props.shapeType) {
    case "circle": {
      const r = Math.min(w, h) / 2;
      shapeSvg = `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
      }/>`;
      break;
    }
    case "ellipse": {
      shapeSvg = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
      }/>`;
      break;
    }
    case "rectangle":
    default: {
      const radius = Math.max(0, Math.min(Number(props.cornerRadius) || 0, w / 2, h / 2));
      shapeSvg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="${fill}"${
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
  const svg = buildShapeSvg(layer);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderShapeLayer };
