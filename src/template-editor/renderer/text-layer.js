/**
 * Renderização de camadas de texto via SVG processado pelo Sharp.
 * Texto rasterizado como PNG transparente e depois composto.
 */

const sharp = require("sharp");
const { escapeXml, fitText } = require("./utils");

function resolveTextAlign(align) {
  switch (align) {
    case "center":
      return "middle";
    case "right":
      return "end";
    case "left":
    default:
      return "start";
  }
}

function resolveVerticalOffset(verticalAlign, totalHeight, layerHeight, padding) {
  switch (verticalAlign) {
    case "middle":
      return (layerHeight - totalHeight) / 2;
    case "bottom":
      return layerHeight - totalHeight - padding;
    case "top":
    default:
      return padding;
  }
}

function resolveXAnchor(align, layerWidth, padding) {
  switch (align) {
    case "center":
      return layerWidth / 2;
    case "right":
      return layerWidth - padding;
    case "left":
    default:
      return padding;
  }
}

function findFittingFontSize(text, props, maxWidth, maxHeight) {
  const fontSize = Math.max(1, Number(props.fontSize) || 16);
  const minFontSize = Math.max(1, Number(props.minFontSize) || 8);
  const lineHeight = Number(props.lineHeight) || 1.2;
  const maxLines = Math.max(1, Number(props.maxLines) || 1);

  if (!props.autoFit) {
    return { fontSize, lines: fitText(text, fontSize, maxWidth, maxHeight, lineHeight, maxLines) };
  }

  for (let fs = fontSize; fs >= minFontSize; fs--) {
    const lines = fitText(text, fs, maxWidth, maxHeight, lineHeight, maxLines);
    const totalHeight = lines.length * fs * lineHeight;
    if (totalHeight <= maxHeight) {
      return { fontSize: fs, lines };
    }
  }

  return {
    fontSize: minFontSize,
    lines: fitText(text, minFontSize, maxWidth, maxHeight, lineHeight, maxLines),
  };
}

async function renderTextLayer(layer, resolvedVariables) {
  const props = layer.properties || {};
  const text = String(props.text || "").replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in resolvedVariables ? resolvedVariables[key] : match;
  });

  const padding = Number(props.padding) || 0;
  const maxWidth = Math.max(1, layer.width - padding * 2);
  const maxHeight = Math.max(1, layer.height - padding * 2);

  const { fontSize, lines } = findFittingFontSize(text, props, maxWidth, maxHeight);
  const lineHeight = Number(props.lineHeight) || 1.2;
  const totalHeight = lines.length * fontSize * lineHeight;

  const xAnchor = resolveXAnchor(props.align, layer.width, padding);
  const startY =
    resolveVerticalOffset(props.verticalAlign, totalHeight, layer.height, padding) + fontSize * 0.85;

  const textAnchor = resolveTextAlign(props.align);
  const fontFamily = escapeXml(props.fontFamily || "Arial");
  const fill = escapeXml(props.fill || "#000000");
  const fontWeight = props.fontWeight || 400;
  const letterSpacing = props.letterSpacing || 0;

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : fontSize * lineHeight;
      return `<tspan x="${xAnchor}" dy="${dy}" font-family="${fontFamily}">${escapeXml(line)}</tspan>`;
    })
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layer.width}" height="${layer.height}" viewBox="0 0 ${layer.width} ${layer.height}" overflow="hidden">
  <text
    x="${xAnchor}"
    y="${startY}"
    text-anchor="${textAnchor}"
    font-size="${fontSize}"
    font-weight="${fontWeight}"
    fill="${fill}"
    letter-spacing="${letterSpacing}"
  >
    ${tspans}
  </text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderTextLayer };
