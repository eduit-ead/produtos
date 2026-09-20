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

const VARIABLE_TYPES = new Set(["string", "number", "boolean", "image", "color"]);

// IDs estritos: alfanumérico, hífen e underscore; 1-64 caracteres.
const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// Limites de segurança para dimensões e conteúdo.
const MAX_CANVAS_DIMENSION = 4096;
const MAX_TOTAL_PIXELS = 16 * 1024 * 1024; // 16M
const MAX_LAYERS = 100;
const MAX_STRING_LENGTH = 5000;

const VARIABLE_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function isPositiveInteger(value) {
  return Number.isFinite(value) && value > 0 && Number.isInteger(value);
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function isValidString(value, maxLength = MAX_STRING_LENGTH) {
  return typeof value === "string" && value.length <= maxLength;
}

function validateDimensions(width, height, prefix) {
  const errors = [];
  if (!isPositiveInteger(width)) {
    errors.push(`${prefix}.width deve ser um inteiro positivo.`);
  }
  if (!isPositiveInteger(height)) {
    errors.push(`${prefix}.height deve ser um inteiro positivo.`);
  }
  if (isPositiveInteger(width) && width > MAX_CANVAS_DIMENSION) {
    errors.push(`${prefix}.width excede o máximo de ${MAX_CANVAS_DIMENSION}.`);
  }
  if (isPositiveInteger(height) && height > MAX_CANVAS_DIMENSION) {
    errors.push(`${prefix}.height excede o máximo de ${MAX_CANVAS_DIMENSION}.`);
  }
  if (isPositiveInteger(width) && isPositiveInteger(height)) {
    const pixels = width * height;
    if (pixels > MAX_TOTAL_PIXELS) {
      errors.push(`${prefix} área total (${pixels}) excede o máximo de ${MAX_TOTAL_PIXELS}.`);
    }
  }
  return errors;
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

function validateTemplate(template, { routeId } = {}) {
  const errors = [];

  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return ["Template deve ser um objeto."];
  }

  if (template.schemaVersion !== 1) {
    errors.push("schemaVersion deve ser 1.");
  }

  if (!isValidString(template.id)) {
    errors.push("id é obrigatório e deve ser uma string de até 5000 caracteres.");
  } else if (!ID_REGEX.test(template.id)) {
    errors.push("id contém caracteres inválidos.");
  }

  if (routeId !== undefined && template.id !== routeId) {
    errors.push(`template.id (${template.id}) deve ser igual ao id da rota (${routeId}).`);
  }

  if (!isValidString(template.name)) {
    errors.push("name é obrigatório e deve ser uma string de até 5000 caracteres.");
  }

  if (!template.canvas || typeof template.canvas !== "object" || Array.isArray(template.canvas)) {
    errors.push("canvas deve ser um objeto.");
  } else {
    errors.push(...validateDimensions(template.canvas.width, template.canvas.height, "canvas"));
  }

  if (!Array.isArray(template.layers)) {
    errors.push("layers deve ser um array.");
  } else if (template.layers.length > MAX_LAYERS) {
    errors.push(`layers excede o máximo de ${MAX_LAYERS} camadas.`);
  } else {
    const ids = new Set();
    for (let i = 0; i < template.layers.length; i++) {
      const layer = template.layers[i];
      const prefix = `layers[${i}]`;

      if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
        errors.push(`${prefix} deve ser um objeto.`);
        continue;
      }

      if (!isValidString(layer.id)) {
        errors.push(`${prefix}.id é obrigatório e deve ser uma string.`);
      } else if (!ID_REGEX.test(layer.id)) {
        errors.push(`${prefix}.id contém caracteres inválidos.`);
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
        if (!isFiniteNumber(layer[field])) {
          errors.push(`${prefix}.${field} deve ser um número finito.`);
        }
      }

      if (typeof layer.visible !== "boolean") {
        errors.push(`${prefix}.visible deve ser booleano.`);
      }
      if (typeof layer.locked !== "boolean") {
        errors.push(`${prefix}.locked deve ser booleano.`);
      }

      if (isFiniteNumber(layer.opacity) && (layer.opacity < 0 || layer.opacity > 1)) {
        errors.push(`${prefix}.opacity deve estar entre 0 e 1.`);
      }

      if (isFiniteNumber(layer.width) && isFiniteNumber(layer.height)) {
        errors.push(...validateDimensions(layer.width, layer.height, prefix));
      }

      const propErrors = validateLayerProperties(layer.type, layer.properties);
      for (const e of propErrors) {
        errors.push(`${prefix}.${e}`);
      }
    }
  }

  if (Array.isArray(template.variables)) {
    const variableKeys = new Set();
    for (let i = 0; i < template.variables.length; i++) {
      const v = template.variables[i];
      const prefix = `variables[${i}]`;
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${prefix} deve ser um objeto.`);
        continue;
      }
      if (!isValidString(v.key)) {
        errors.push(`${prefix}.key é obrigatório e deve ser uma string.`);
      } else if (!VARIABLE_KEY_REGEX.test(v.key)) {
        errors.push(`${prefix}.key (${v.key}) não segue o padrão de identificador.`);
      }
      if (v.key && variableKeys.has(v.key)) {
        errors.push(`${prefix}.key (${v.key}) duplicado.`);
      } else if (v.key) {
        variableKeys.add(v.key);
      }
      if (!isValidString(v.label)) {
        errors.push(`${prefix}.label é obrigatório e deve ser uma string.`);
      }
      if (!VARIABLE_TYPES.has(v.type)) {
        errors.push(`${prefix}.type inválido.`);
      }
      if (Object.hasOwn(v, "binding")) {
        const b = v.binding;
        if (!b || typeof b !== "object" || Array.isArray(b)) {
          errors.push(`${prefix}.binding deve ser um objeto.`);
        } else {
          if (!isValidString(b.layerId)) {
            errors.push(`${prefix}.binding.layerId deve ser uma string.`);
          } else if (Array.isArray(template.layers) && !template.layers.some((l) => l.id === b.layerId)) {
            errors.push(`${prefix}.binding.layerId (${b.layerId}) não encontrado em layers.`);
          }
          if (!isValidString(b.property)) {
            errors.push(`${prefix}.binding.property deve ser uma string.`);
          }
          const allowedBindings = {
            image: { assetId: ["background", "image", "overlay"] },
            color: {
              color: ["background"],
              fill: ["shape", "text"],
            },
          };
          if (allowedBindings[v.type] && b.property && b.layerId && Array.isArray(template.layers)) {
            const layer = template.layers.find((l) => l.id === b.layerId);
            if (layer) {
              const validProps = allowedBindings[v.type];
              const allowedTypes = validProps[b.property];
              if (!allowedTypes || !allowedTypes.includes(layer.type)) {
                errors.push(
                  `${prefix}.binding inválido: ${v.type}.${b.property} não pode ser aplicado em ${layer.type}.`
                );
              }
            }
          }
        }
      }
      if (Object.hasOwn(v, "defaultValue") && v.defaultValue === undefined) {
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
      if (!isValidString(p.color)) {
        errors.push("properties.color deve ser uma string.");
      }
      break;
    case "image":
    case "overlay":
      if (!isValidString(p.assetId)) {
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
      if (typeof p.text !== "string" || p.text.length > MAX_STRING_LENGTH) {
        errors.push("properties.text deve ser uma string de até 5000 caracteres.");
      }
      if (!isFiniteNumber(p.fontSize)) {
        errors.push("properties.fontSize deve ser um número finito.");
      }
      if (!isFiniteNumber(p.minFontSize)) {
        errors.push("properties.minFontSize deve ser um número finito.");
      }
      if (!isFiniteNumber(p.padding)) {
        errors.push("properties.padding deve ser um número finito.");
      }
      if (!Number.isInteger(p.maxLines) || p.maxLines < 1) {
        errors.push("properties.maxLines deve ser um inteiro >= 1.");
      }
      if (!["shrink", "clip"].includes(p.overflow)) {
        errors.push("properties.overflow deve ser 'shrink' ou 'clip'.");
      }
      break;
    case "shape":
      if (!["rectangle", "circle", "ellipse"].includes(p.shapeType)) {
        errors.push("properties.shapeType inválido.");
      }
      if (!isValidString(p.fill)) {
        errors.push("properties.fill é obrigatório.");
      }
      if (p.stroke && !isValidString(p.stroke)) {
        errors.push("properties.stroke deve ser uma string.");
      }
      if (Object.hasOwn(p, "strokeWidth") && !isFiniteNumber(p.strokeWidth)) {
        errors.push("properties.strokeWidth deve ser um número finito.");
      }
      if (Object.hasOwn(p, "cornerRadius") && !isFiniteNumber(p.cornerRadius)) {
        errors.push("properties.cornerRadius deve ser um número finito.");
      }
      break;
  }

  return errors;
}

function resolveVariables(template, values = {}) {
  const resolved = {};
  const variableMap = new Map((template.variables || []).map((v) => [v.key, v]));

  for (const [key, variable] of variableMap) {
    if (Object.hasOwn(values, key)) {
      resolved[key] = String(values[key]);
    } else if (Object.hasOwn(variable, "defaultValue") && variable.defaultValue !== undefined) {
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
    return Object.hasOwn(resolved, key) ? resolved[key] : match;
  });
}

function applyVariableBindings(template, values = {}) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return template;
  }
  const copy = structuredClone(template);
  const variableMap = new Map((copy.variables || []).map((v) => [v.key, v]));

  for (const [key, variable] of variableMap) {
    const binding = variable.binding;
    if (!binding || !binding.layerId || !binding.property) continue;

    let value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined || value === null || value === "") {
      value = variable.defaultValue;
    }
    if (value === undefined || value === null || value === "") continue;
    value = String(value);

    const layer = copy.layers.find((l) => l.id === binding.layerId);
    if (!layer) continue;

    if (variable.type === "image" && binding.property === "assetId" && ["background", "image", "overlay"].includes(layer.type)) {
      layer.properties = { ...layer.properties, assetId: value };
    } else if (variable.type === "color") {
      if (binding.property === "color" && layer.type === "background") {
        layer.properties = { ...layer.properties, color: value };
      } else if (binding.property === "fill" && ["shape", "text"].includes(layer.type)) {
        layer.properties = { ...layer.properties, fill: value };
      }
    }
  }

  return copy;
}

module.exports = {
  COMMON_LAYER_DEFAULTS,
  createLayerDefaults,
  createEmptyTemplate,
  validateTemplate,
  resolveVariables,
  replaceVariables,
  applyVariableBindings,
  VALID_TYPES,
};
