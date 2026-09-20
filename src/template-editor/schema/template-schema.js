/**
 * Schema e validação de templates do compositor visual.
 * JSON é a única fonte de verdade; Fabric.js é apenas adaptador visual.
 */

const VALID_TYPES = new Set([
  "background",
  "image",
  "text",
  "shape",
  "overlay",
]);

const VARIABLE_TYPES = new Set(["string", "number", "boolean"]);

const COMMON_LAYER_DEFAULTS = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  zIndex: 0,
  locked: false,
};

function createLayerDefaults(type) {
  const base = {
    ...COMMON_LAYER_DEFAULTS,
    id: cryptoRandomId("layer"),
    type,
    name: `Nova camada ${type}`,
    properties: {},
  };

  switch (type) {
    case "background":
      base.properties = { color: "#ffffff", assetId: null };
      break;
    case "image":
      base.properties = {
        assetId: null,
        fit: "cover",
        position: "center",
      };
      break;
    case "overlay":
      base.properties = {
        assetId: null,
        blendMode: "normal",
      };
      break;
    case "text":
      base.properties = {
        text: "",
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: 32,
        fontWeight: 400,
        fill: "#000000",
        align: "left",
        verticalAlign: "top",
        lineHeight: 1.2,
        letterSpacing: 0,
        autoFit: true,
        minFontSize: 8,
        padding: 0,
        maxLines: 3,
        overflow: "shrink", // shrink | clip
      };
      break;
    case "shape":
      base.properties = {
        shapeType: "rectangle",
        fill: "#000000",
        stroke: null,
        strokeWidth: 0,
        cornerRadius: 0,
      };
      break;
  }

  return base;
}

function cryptoRandomId(prefix = "id") {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function createEmptyTemplate(width = 1080, height = 1080) {
  return {
    schemaVersion: 1,
    id: cryptoRandomId("tpl"),
    name: "Novo template",
    canvas: {
      width,
      height,
      background: "#ffffff",
    },
    variables: [],
    assets: [],
    layers: [
      {
        ...createLayerDefaults("background"),
        name: "Fundo",
        width,
        height,
        properties: { color: "#0b1120", assetId: null },
      },
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function validateTemplate(template) {
  const errors = [];

  if (!template || typeof template !== "object") {
    return ["Template deve ser um objeto."];
  }

  if (template.schemaVersion !== 1) {
    errors.push("schemaVersion deve ser 1.");
  }

  if (!template.id || typeof template.id !== "string") {
    errors.push("id é obrigatório e deve ser uma string.");
  }

  if (!template.name || typeof template.name !== "string") {
    errors.push("name é obrigatório e deve ser uma string.");
  }

  if (
    !template.canvas ||
    typeof template.canvas.width !== "number" ||
    typeof template.canvas.height !== "number"
  ) {
    errors.push("canvas.width e canvas.height devem ser números.");
  }

  if (!Array.isArray(template.layers)) {
    errors.push("layers deve ser um array.");
  } else {
    const ids = new Set();
    for (let i = 0; i < template.layers.length; i++) {
      const layer = template.layers[i];
      const prefix = `layers[${i}]`;

      if (!layer.id || typeof layer.id !== "string") {
        errors.push(`${prefix}.id é obrigatório.`);
      } else if (ids.has(layer.id)) {
        errors.push(`${prefix}.id duplicado: ${layer.id}.`);
      } else {
        ids.add(layer.id);
      }

      if (!VALID_TYPES.has(layer.type)) {
        errors.push(
          `${prefix}.type inválido: ${layer.type}. Valores: ${[...VALID_TYPES].join(", ")}.`
        );
      }

      for (const field of ["x", "y", "width", "height", "rotation", "opacity", "zIndex"]) {
        if (typeof layer[field] !== "number") {
          errors.push(`${prefix}.${field} deve ser um número.`);
        }
      }

      if (typeof layer.visible !== "boolean") {
        errors.push(`${prefix}.visible deve ser booleano.`);
      }
      if (typeof layer.locked !== "boolean") {
        errors.push(`${prefix}.locked deve ser booleano.`);
      }

      if (layer.opacity < 0 || layer.opacity > 1) {
        errors.push(`${prefix}.opacity deve estar entre 0 e 1.`);
      }

      const propErrors = validateLayerProperties(layer.type, layer.properties);
      for (const e of propErrors) {
        errors.push(`${prefix}.${e}`);
      }
    }
  }

  if (Array.isArray(template.variables)) {
    for (let i = 0; i < template.variables.length; i++) {
      const v = template.variables[i];
      const prefix = `variables[${i}]`;
      if (!v.key || typeof v.key !== "string") {
        errors.push(`${prefix}.key é obrigatório.`);
      }
      if (!v.label || typeof v.label !== "string") {
        errors.push(`${prefix}.label é obrigatório.`);
      }
      if (!VARIABLE_TYPES.has(v.type)) {
        errors.push(`${prefix}.type inválido.`);
      }
      if ("defaultValue" in v && v.defaultValue === undefined) {
        errors.push(`${prefix}.defaultValue não pode ser undefined.`);
      }
      if (typeof v.required !== "boolean") {
        errors.push(`${prefix}.required deve ser booleano.`);
      }
    }
  }

  if (!Array.isArray(template.assets)) {
    errors.push("assets deve ser um array.");
  }

  return errors;
}

function validateLayerProperties(type, properties) {
  const errors = [];
  const p = properties || {};

  switch (type) {
    case "background":
      if (!p.color || typeof p.color !== "string") {
        errors.push("properties.color deve ser uma string.");
      }
      break;
    case "image":
    case "overlay":
      if (!p.assetId || typeof p.assetId !== "string") {
        errors.push("properties.assetId é obrigatório.");
      }
      if (type === "image" && p.fit && !["cover", "contain", "fill"].includes(p.fit)) {
        errors.push("properties.fit inválido.");
      }
      if (type === "overlay" && p.blendMode && typeof p.blendMode !== "string") {
        errors.push("properties.blendMode deve ser uma string.");
      }
      break;
    case "text":
      if (typeof p.text !== "string") {
        errors.push("properties.text deve ser uma string.");
      }
      if (typeof p.fontSize !== "number") {
        errors.push("properties.fontSize deve ser um número.");
      }
      if (typeof p.minFontSize !== "number") {
        errors.push("properties.minFontSize deve ser um número.");
      }
      if (typeof p.padding !== "number") {
        errors.push("properties.padding deve ser um número.");
      }
      if (typeof p.maxLines !== "number" || p.maxLines < 1) {
        errors.push("properties.maxLines deve ser >= 1.");
      }
      if (!["shrink", "clip"].includes(p.overflow)) {
        errors.push("properties.overflow deve ser 'shrink' ou 'clip'.");
      }
      break;
    case "shape":
      if (!["rectangle", "circle", "ellipse"].includes(p.shapeType)) {
        errors.push("properties.shapeType inválido.");
      }
      if (!p.fill || typeof p.fill !== "string") {
        errors.push("properties.fill é obrigatório.");
      }
      break;
  }

  return errors;
}

function resolveVariables(template, values = {}) {
  const resolved = {};
  const variableMap = new Map((template.variables || []).map((v) => [v.key, v]));

  for (const [key, variable] of variableMap) {
    if (key in values) {
      resolved[key] = String(values[key]);
    } else if ("defaultValue" in variable && variable.defaultValue !== undefined) {
      resolved[key] = String(variable.defaultValue);
    } else if (variable.required) {
      throw new Error(`Variável obrigatória ausente: ${key} (${variable.label})`);
    } else {
      resolved[key] = "";
    }
  }

  return resolved;
}

function replaceVariables(text, resolved) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in resolved ? resolved[key] : match;
  });
}

module.exports = {
  COMMON_LAYER_DEFAULTS,
  createLayerDefaults,
  createEmptyTemplate,
  validateTemplate,
  resolveVariables,
  replaceVariables,
  VALID_TYPES,
};
