/**
 * Renderizador final de templates.
 * Composição de camadas via Sharp.
 * x/y = canto superior esquerdo; rotação pelo centro da camada.
 */

const sharp = require("sharp");
const {
  loadAssetBuffer,
  applyOpacity,
  rotateLayer,
  computeCompositePosition,
  mapFit,
  mapPosition,
  mapPositionFactors,
  mapBlend,
} = require("./utils");
const { renderTextLayer } = require("./text-layer");
const { renderShapeLayer } = require("./shape-layer");

async function renderBackgroundLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }

  const props = layer.properties || {};

  if (props.assetId) {
    const buffer = loadAssetBuffer(props.assetId);
    if (!buffer) {
      throw new Error(`Asset de fundo não encontrado: ${props.assetId}`);
    }
    return sharp(buffer)
      .resize(layer.width, layer.height, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
  }

  return sharp({
    create: {
      width: Math.max(1, layer.width),
      height: Math.max(1, layer.height),
      channels: 4,
      background: props.color || "#ffffff",
    },
  })
    .png()
    .toBuffer();
}

async function renderImageLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }

  const props = layer.properties || {};
  const buffer = loadAssetBuffer(props.assetId);
  if (!buffer) {
    throw new Error(`Asset de imagem não encontrado: ${props.assetId}`);
  }

  const fit = props.fit || "cover";

  if (fit === "contain") {
    const resized = await sharp(buffer)
      .resize(layer.width, layer.height, { fit: "inside" })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const factors = mapPositionFactors(props.position);
    const left = Math.round((layer.width - meta.width) * factors.x);
    const top = Math.round((layer.height - meta.height) * factors.y);

    return sharp({
      create: {
        width: layer.width,
        height: layer.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: resized, left, top }])
      .png()
      .toBuffer();
  }

  return sharp(buffer)
    .resize(layer.width, layer.height, {
      fit: mapFit(fit),
      position: mapPosition(props.position),
    })
    .png()
    .toBuffer();
}

async function renderOverlayLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }

  const props = layer.properties || {};
  const buffer = loadAssetBuffer(props.assetId);
  if (!buffer) {
    throw new Error(`Asset de overlay não encontrado: ${props.assetId}`);
  }

  return sharp(buffer)
    .resize(layer.width, layer.height, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

async function renderLayer(layer, resolvedVariables) {
  switch (layer.type) {
    case "background":
      return renderBackgroundLayer(layer);
    case "image":
      return renderImageLayer(layer);
    case "overlay":
      return renderOverlayLayer(layer);
    case "text":
      return renderTextLayer(layer, resolvedVariables);
    case "shape":
      return renderShapeLayer(layer);
    default:
      throw new Error(`Tipo de camada desconhecido: ${layer.type}`);
  }
}

async function renderTemplate(template, values = {}) {
  const { validateTemplate, resolveVariables } = require("../schema/template-schema");

  const errors = validateTemplate(template);
  if (errors.length > 0) {
    throw new Error(`Template inválido:\n${errors.join("\n")}`);
  }

  const resolved = resolveVariables(template, values);

  const canvas = template.canvas || { width: 1080, height: 1080 };
  let base = sharp({
    create: {
      width: Math.max(1, canvas.width),
      height: Math.max(1, canvas.height),
      channels: 4,
      background: canvas.background || "#ffffff",
    },
  });

  const layers = [...template.layers].sort((a, b) => a.zIndex - b.zIndex);
  const composites = [];

  for (const layer of layers) {
    if (!layer.visible) continue;

    let layerBuffer = await renderLayer(layer, resolved);
    layerBuffer = await applyOpacity(layerBuffer, layer.opacity);
    const rotated = await rotateLayer(layerBuffer, layer.rotation || 0);
    const { left, top } = computeCompositePosition(layer, rotated.width, rotated.height);

    composites.push({
      input: rotated.buffer,
      left,
      top,
      blend: layer.type === "overlay" ? mapBlend(layer.properties?.blendMode) : "over",
    });
  }

  if (composites.length > 0) {
    base = base.composite(composites);
  }

  return base.png().toBuffer();
}

module.exports = { renderTemplate, renderLayer };
