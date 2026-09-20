/**
 * Adaptador visual do compositor de templates usando Fabric.js.
 * JSON do template é a única fonte de verdade.
 */

const state = {
  template: null,
  templates: [],
  selectedLayerId: null,
  canvas: null,
  isSyncing: false,
  assets: [],
};

const DEFAULT_CANVAS_SIZE = { width: 1080, height: 1080 };

function randomId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptyLayer(type) {
  const defaults = {
    id: randomId("layer"),
    type,
    name: `Camada ${type}`,
    x: 50,
    y: 50,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    zIndex: state.template.layers.length,
    locked: false,
    properties: {},
  };

  switch (type) {
    case "background":
      defaults.name = "Fundo";
      defaults.x = 0;
      defaults.y = 0;
      defaults.width = state.template.canvas.width;
      defaults.height = state.template.canvas.height;
      defaults.properties = { color: "#0b1120", assetId: null };
      break;
    case "image":
      defaults.properties = { assetId: null, fit: "cover", position: "center" };
      break;
    case "overlay":
      defaults.name = "Overlay";
      defaults.width = state.template.canvas.width;
      defaults.height = state.template.canvas.height;
      defaults.properties = { assetId: null, blendMode: "normal" };
      break;
    case "text":
      defaults.properties = {
        text: "Texto",
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: 32,
        fontWeight: 400,
        fill: "#ffffff",
        align: "left",
        verticalAlign: "top",
        lineHeight: 1.2,
        letterSpacing: 0,
        autoFit: true,
        minFontSize: 8,
        padding: 0,
        maxLines: 3,
        overflow: "shrink",
      };
      break;
    case "shape":
      defaults.properties = {
        shapeType: "rectangle",
        fill: "#6ea0ff",
        stroke: null,
        strokeWidth: 0,
        cornerRadius: 0,
      };
      break;
  }

  return defaults;
}

async function init() {
  const canvasEl = document.getElementById("editorCanvas");
  state.canvas = new fabric.Canvas(canvasEl, {
    preserveObjectStacking: true,
  });

  state.canvas.on("object:modified", onObjectModified);
  state.canvas.on("text:changed", onTextChanged);
  state.canvas.on("selection:created", onSelectionChanged);
  state.canvas.on("selection:updated", onSelectionChanged);
  state.canvas.on("selection:cleared", () => {
    state.selectedLayerId = null;
    renderLayerList();
    renderProperties();
  });

  document.getElementById("btnNew").addEventListener("click", createNewTemplate);
  document.getElementById("btnSave").addEventListener("click", saveTemplate);
  document.getElementById("btnRender").addEventListener("click", renderPng);
  document.getElementById("templateSelect").addEventListener("change", (e) => {
    if (e.target.value) loadTemplate(e.target.value);
  });

  document.getElementById("btnAddText").addEventListener("click", () => addLayer("text"));
  document.getElementById("btnAddImage").addEventListener("click", () => addLayer("image"));
  document.getElementById("btnAddShape").addEventListener("click", () => addLayer("shape"));

  document.getElementById("uploadForm").addEventListener("submit", uploadAsset);

  window.addEventListener("resize", () => {
    applyZoom();
  });

  await loadTemplateList();
  await loadAssets();

  const demo = state.templates?.find((t) => t.id === "demo");
  if (demo) {
    await loadTemplate("demo");
  } else {
    createNewTemplate();
  }
}

async function loadTemplateList() {
  const res = await fetch("/api/templates");
  state.templates = await res.json();
  const select = document.getElementById("templateSelect");
  select.innerHTML = `<option value="">Selecione...</option>` +
    state.templates.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");
}

async function loadAssets() {
  const res = await fetch("/api/assets");
  state.assets = await res.json();
  renderAssetList();
  renderProperties();
}

function renderAssetList() {
  const list = document.getElementById("assetList");
  list.innerHTML = state.assets
    .map((a) => `<li>${escapeHtml(a.assetId)} <small>(${(a.size / 1024).toFixed(1)} KB)</small></li>`)
    .join("");
}

function createNewTemplate() {
  state.template = {
    schemaVersion: 1,
    id: randomId("tpl"),
    name: "Novo template",
    canvas: { ...DEFAULT_CANVAS_SIZE, background: "#ffffff" },
    variables: [],
    assets: [],
    layers: [
      {
        id: randomId("layer"),
        type: "background",
        name: "Fundo",
        x: 0,
        y: 0,
        width: DEFAULT_CANVAS_SIZE.width,
        height: DEFAULT_CANVAS_SIZE.height,
        rotation: 0,
        opacity: 1,
        visible: true,
        zIndex: 0,
        locked: false,
        properties: { color: "#0b1120", assetId: null },
      },
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  state.selectedLayerId = null;
  syncCanvasFromTemplate();
  renderLayerList();
  renderProperties();
  renderVariables();
}

async function loadTemplate(id) {
  const res = await fetch(`/api/templates/${id}`);
  if (!res.ok) return alert("Erro ao carregar template.");
  state.template = await res.json();
  state.selectedLayerId = null;
  syncCanvasFromTemplate();
  renderLayerList();
  renderProperties();
  renderVariables();
  document.getElementById("templateSelect").value = id;
}

function syncCanvasFromTemplate() {
  if (!state.template) return;
  state.isSyncing = true;

  state.canvas.discardActiveObject();
  state.canvas.clear();
  state.canvas.setWidth(state.template.canvas.width);
  state.canvas.setHeight(state.template.canvas.height);
  state.canvas.backgroundColor = state.template.canvas.background || "#ffffff";

  const layers = [...state.template.layers].sort((a, b) => a.zIndex - b.zIndex);

  Promise.all(
    layers.map(async (layer) => {
      const obj = await createFabricObject(layer);
      if (obj) {
        obj.set("layerId", layer.id);
        applyLockedState(obj, layer.locked);
      }
      return { layer, obj };
    })
  ).then((results) => {
    results.forEach(({ obj }) => {
      if (obj) state.canvas.add(obj);
    });
    state.canvas.renderAll();
    state.isSyncing = false;
    restoreSelection();
    applyZoom();
  });
}

function restoreSelection() {
  if (!state.selectedLayerId) return;
  const obj = state.canvas.getObjects().find((o) => o.layerId === state.selectedLayerId);
  if (obj) {
    state.canvas.setActiveObject(obj);
    state.canvas.renderAll();
  }
}

function applyLockedState(obj, locked) {
  obj.set({
    selectable: !locked,
    evented: !locked,
    lockMovementX: locked,
    lockMovementY: locked,
    lockRotation: locked,
    lockScalingX: locked,
    lockScalingY: locked,
  });
}

function applyZoom() {
  if (!state.template || !state.canvas) return;
  const wrap = document.getElementById("canvasWrap");
  const width = state.template.canvas.width;
  const height = state.template.canvas.height;

  const padding = 32;
  const availW = Math.max(wrap.clientWidth - padding, 1);
  const availH = Math.max(wrap.clientHeight - padding, 1);
  const scale = Math.max(0.1, Math.min(1, availW / width, availH / height));

  // Keep the logical canvas at 1080x1080 for accurate editing,
  // but set the CSS size to the fitted viewport so it fits the panel.
  // Fabric's viewport zoom maps pointer coordinates correctly.
  const cssW = `${Math.round(width * scale)}px`;
  const cssH = `${Math.round(height * scale)}px`;
  const container = state.canvas.wrapperEl;
  if (container) {
    container.style.width = cssW;
    container.style.height = cssH;
  }
  if (state.canvas.lowerCanvasEl) {
    state.canvas.lowerCanvasEl.style.width = cssW;
    state.canvas.lowerCanvasEl.style.height = cssH;
  }
  if (state.canvas.upperCanvasEl) {
    state.canvas.upperCanvasEl.style.width = cssW;
    state.canvas.upperCanvasEl.style.height = cssH;
  }

  state.canvas.setZoom(scale);
  state.canvas.renderAll();
}

function loadImage(url) {
  return new Promise((resolve) => {
    fabric.Image.fromURL(url, (img) => resolve(img), { crossOrigin: "anonymous" });
  });
}

function applyImageFit(img, layer, fit, position) {
  const targetW = layer.width;
  const targetH = layer.height;
  const imgW = img.width;
  const imgH = img.height;

  let scaleX = 1;
  let scaleY = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (fit === "contain") {
    const scale = Math.min(targetW / imgW, targetH / imgH);
    scaleX = scaleY = scale;
    const scaledW = imgW * scale;
    const scaledH = imgH * scale;
    offsetX = (targetW - scaledW) / 2;
    offsetY = (targetH - scaledH) / 2;
    if (position === "top") offsetY = 0;
    if (position === "bottom") offsetY = targetH - scaledH;
    if (position === "left") offsetX = 0;
    if (position === "right") offsetX = targetW - scaledW;
  } else if (fit === "cover") {
    const scale = Math.max(targetW / imgW, targetH / imgH);
    scaleX = scaleY = scale;
    const scaledW = imgW * scale;
    const scaledH = imgH * scale;
    offsetX = (targetW - scaledW) / 2;
    offsetY = (targetH - scaledH) / 2;
    if (position === "top") offsetY = 0;
    if (position === "bottom") offsetY = targetH - scaledH;
    if (position === "left") offsetX = 0;
    if (position === "right") offsetX = targetW - scaledW;
  } else {
    scaleX = targetW / imgW;
    scaleY = targetH / imgH;
  }

  img._fitOffsetX = offsetX;
  img._fitOffsetY = offsetY;

  img.set({
    scaleX,
    scaleY,
    left: layer.x + offsetX,
    top: layer.y + offsetY,
    clipPath: new fabric.Rect({
      left: 0,
      top: 0,
      width: targetW,
      height: targetH,
      originX: "left",
      originY: "top",
      fill: "transparent",
      stroke: null,
    }),
  });
}

function applyObjectGeometry(obj, layer) {
  obj.set({ scaleX: 1, scaleY: 1 });
  if (layer.type === "text") {
    obj.set({ width: layer.width, height: layer.height });
  } else if (layer.type === "shape") {
    const shapeType = obj.layerShapeType || layer.properties.shapeType;
    if (shapeType === "circle") {
      obj.set({ radius: Math.min(layer.width, layer.height) / 2 });
    } else if (shapeType === "ellipse") {
      obj.set({ rx: layer.width / 2, ry: layer.height / 2 });
    } else {
      obj.set({ width: layer.width, height: layer.height });
    }
  } else {
    obj.set({ width: layer.width, height: layer.height });
  }
  obj.setCoords();
}

const fontPreviewCache = new Map();
async function loadFontForPreview(fontFamily) {
  if (!fontFamily) return "Arial, sans-serif";
  if (fontPreviewCache.has(fontFamily)) return fontPreviewCache.get(fontFamily);
  let result = fontFamily;
  if (document.fonts) {
    try {
      await Promise.race([
        document.fonts.load(`12px ${fontFamily}`),
        new Promise((_, reject) => setTimeout(reject, 300)),
      ]);
    } catch {
      // Offline or font unavailable: fall back to a system font for the preview.
      result = "Arial, sans-serif";
    }
  }
  fontPreviewCache.set(fontFamily, result);
  return result;
}

async function createFabricObject(layer) {
  if (!layer.visible) return null;

  const common = {
    left: layer.x,
    top: layer.y,
    angle: layer.rotation,
    opacity: layer.opacity,
    originX: "left",
    originY: "top",
    centeredRotation: true,
    selectable: true,
    hasControls: true,
  };

  switch (layer.type) {
    case "background": {
      if (layer.properties.assetId) {
        const img = await loadImage(`/api/assets/${layer.properties.assetId}`);
        if (img) {
          applyImageFit(img, layer, "fill", "center");
          img.set({ ...common });
          img.layerAssetId = layer.properties.assetId;
          return img;
        }
      }
      return new fabric.Rect({
        ...common,
        width: layer.width,
        height: layer.height,
        fill: layer.properties.color || "#ffffff",
      });
    }

    case "image":
    case "overlay": {
      if (layer.properties.assetId) {
        const img = await loadImage(`/api/assets/${layer.properties.assetId}`);
        if (img) {
          const isOverlay = layer.type === "overlay";
          applyImageFit(
            img,
            layer,
            isOverlay ? "fill" : layer.properties.fit || "cover",
            layer.properties.position || "center"
          );
          img.set({ ...common });
          img.layerAssetId = layer.properties.assetId;
          if (layer.type === "image") {
            img.layerFit = layer.properties.fit;
            img.layerPosition = layer.properties.position;
          }
          if (isOverlay) {
            img.layerBlendMode = layer.properties.blendMode;
            const blendMap = { normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay" };
            img.set("globalCompositeOperation", blendMap[layer.properties.blendMode] || "source-over");
          }
          return img;
        }
      }
      return new fabric.Rect({
        ...common,
        width: layer.width,
        height: layer.height,
        fill: "#334155",
        stroke: "#6ea0ff",
        strokeDashArray: [5, 5],
      });
    }

    case "text": {
      const renderFont = await loadFontForPreview(layer.properties.fontFamily);
      const tb = new fabric.Textbox(layer.properties.text || "", {
        ...common,
        width: layer.width,
        fontFamily: renderFont,
        fontSize: layer.properties.fontSize || 16,
        fontWeight: layer.properties.fontWeight || 400,
        fill: layer.properties.fill || "#000000",
        textAlign: layer.properties.align || "left",
        lineHeight: layer.properties.lineHeight || 1.2,
        charSpacing: (layer.properties.letterSpacing || 0) * 1000,
      });
      tb.set("height", layer.height);
      tb.layerFontFamily = layer.properties.fontFamily;
      return tb;
    }

    case "shape": {
      const props = layer.properties || {};
      const shapeType = props.shapeType || "rectangle";
      const base = {
        ...common,
        width: layer.width,
        height: layer.height,
        fill: props.fill || "#000000",
        stroke: props.stroke || null,
        strokeWidth: props.strokeWidth || 0,
      };

      if (shapeType === "circle") {
        const radius = Math.min(layer.width, layer.height) / 2;
        const c = new fabric.Circle({ ...base, radius });
        c.layerShapeType = shapeType;
        return c;
      }
      if (shapeType === "ellipse") {
        const e = new fabric.Ellipse({
          ...base,
          rx: layer.width / 2,
          ry: layer.height / 2,
        });
        e.layerShapeType = shapeType;
        return e;
      }
      const r = new fabric.Rect({
        ...base,
        rx: props.cornerRadius || 0,
        ry: props.cornerRadius || 0,
      });
      r.layerShapeType = shapeType;
      return r;
    }
  }

  return null;
}

function onObjectModified(e) {
  if (state.isSyncing) return;
  const obj = e.target;
  if (!obj || !obj.layerId) return;
  updateLayerFromObject(obj);
  renderLayerList();
  renderProperties();
}

function onTextChanged(e) {
  if (state.isSyncing) return;
  const obj = e.target;
  if (!obj || !obj.layerId) return;
  const layer = state.template.layers.find((l) => l.id === obj.layerId);
  if (layer && layer.type === "text") {
    layer.properties.text = obj.text || "";
  }
  renderLayerList();
  renderProperties();
}

function onSelectionChanged(e) {
  const obj = e.selected?.[0];
  if (obj && obj.layerId) {
    state.selectedLayerId = obj.layerId;
  } else {
    state.selectedLayerId = null;
  }
  renderLayerList();
  renderProperties();
}

function updateLayerFromObject(obj) {
  const layer = state.template.layers.find((l) => l.id === obj.layerId);
  if (!layer) return;

  if (layer.type === "image" || layer.type === "overlay") {
    layer.x = Math.round(obj.left - (obj._fitOffsetX || 0));
    layer.y = Math.round(obj.top - (obj._fitOffsetY || 0));
  } else {
    layer.x = Math.round(obj.left);
    layer.y = Math.round(obj.top);
  }
  layer.rotation = Math.round(obj.angle || 0);
  layer.width = Math.round(obj.getScaledWidth());
  layer.height = Math.round(obj.getScaledHeight());
  layer.opacity = obj.opacity ?? 1;
  layer.visible = obj.visible !== false;

  if (layer.type === "image" || layer.type === "overlay") {
    const isOverlay = layer.type === "overlay";
    applyImageFit(
      obj,
      layer,
      isOverlay ? "fill" : layer.properties.fit || "cover",
      isOverlay ? "center" : layer.properties.position || "center"
    );
  } else {
    applyObjectGeometry(obj, layer);
  }

  obj.setCoords();

  if (layer.type === "text") {
    layer.properties.text = obj.text || "";
  }
}

function renderLayerList() {
  const list = document.getElementById("layerList");
  if (!state.template) {
    list.innerHTML = "";
    return;
  }
  const layers = [...state.template.layers].sort((a, b) => b.zIndex - a.zIndex);

  list.innerHTML = layers
    .map((l) => {
      const selected = l.id === state.selectedLayerId ? "selected" : "";
      const hiddenClass = l.visible ? "" : "hidden";
      return `
        <div class="layer-item ${selected} ${hiddenClass}" data-id="${l.id}">
          <span>${escapeHtml(l.name)} (${l.type})</span>
          <div>
            <button data-action="toggle" title="${l.visible ? "Ocultar" : "Exibir"}">👁</button>
            <button data-action="lock" title="${l.locked ? "Destravar" : "Travar"}">${l.locked ? "🔒" : "🔓"}</button>
            <button data-action="up" title="Subir">↑</button>
            <button data-action="down" title="Descer">↓</button>
            <button data-action="dup" title="Duplicar">⎘</button>
            <button data-action="delete" title="Excluir">×</button>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".layer-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
      selectLayer(el.dataset.id);
    });

    el.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        const action = btn.dataset.action;
        handleLayerAction(id, action);
      });
    });
  });
}

function selectLayer(id) {
  state.selectedLayerId = id;
  const obj = state.canvas.getObjects().find((o) => o.layerId === id);
  if (obj) {
    state.canvas.setActiveObject(obj);
    state.canvas.renderAll();
  }
  renderLayerList();
  renderProperties();
}

function handleLayerAction(id, action) {
  const sorted = [...state.template.layers].sort((a, b) => a.zIndex - b.zIndex);
  const index = sorted.findIndex((l) => l.id === id);
  if (index < 0) return;

  const layer = state.template.layers.find((l) => l.id === id);
  if (!layer) return;

  switch (action) {
    case "toggle":
      layer.visible = !layer.visible;
      syncCanvasFromTemplate();
      break;
    case "lock":
      layer.locked = !layer.locked;
      syncCanvasFromTemplate();
      break;
    case "up":
      moveLayer(id, 1);
      break;
    case "down":
      moveLayer(id, -1);
      break;
    case "dup":
      duplicateLayer(layer);
      break;
    case "delete":
      state.template.layers = state.template.layers.filter((l) => l.id !== id);
      if (state.selectedLayerId === id) state.selectedLayerId = null;
      syncCanvasFromTemplate();
      renderLayerList();
      renderProperties();
      break;
  }
}

function moveLayer(id, direction) {
  const layer = state.template.layers.find((l) => l.id === id);
  if (!layer) return;

  const sorted = [...state.template.layers].sort((a, b) => a.zIndex - b.zIndex);
  const index = sorted.findIndex((l) => l.id === id);
  const swapWith = direction > 0 ? sorted[index + 1] : sorted[index - 1];
  if (!swapWith) return;

  // Swap z-index values in the data model.
  const tmp = layer.zIndex;
  layer.zIndex = swapWith.zIndex;
  swapWith.zIndex = tmp;

  // Apply the same order on the Fabric canvas using moveTo for every visible layer.
  reorderCanvasObjects();

  renderLayerList();
  renderProperties();
}

function reorderCanvasObjects() {
  if (!state.canvas || !state.template) return;
  const visibleSorted = [...state.template.layers]
    .filter((l) => l.visible)
    .sort((a, b) => a.zIndex - b.zIndex);
  const objects = state.canvas.getObjects();
  visibleSorted.forEach((layer, targetIndex) => {
    const obj = objects.find((o) => o.layerId === layer.id);
    if (obj) {
      state.canvas.moveTo(obj, targetIndex);
    }
  });
  state.canvas.renderAll();
}

function duplicateLayer(original) {
  const copy = JSON.parse(JSON.stringify(original));
  copy.id = randomId("layer");
  copy.name = `${original.name} (cópia)`;
  copy.zIndex = Math.max(...state.template.layers.map((l) => l.zIndex)) + 1;
  state.template.layers.push(copy);
  syncCanvasFromTemplate();
  renderLayerList();
}

function addLayer(type) {
  const layer = createEmptyLayer(type);
  layer.zIndex = Math.max(0, ...state.template.layers.map((l) => l.zIndex)) + 1;
  state.template.layers.push(layer);
  state.selectedLayerId = layer.id;
  syncCanvasFromTemplate();
  renderLayerList();
  renderProperties();
}

function renderProperties() {
  const container = document.getElementById("properties");
  if (!state.template) {
    container.innerHTML = "<p>Selecione ou crie um template.</p>";
    return;
  }
  const layer = state.template.layers.find((l) => l.id === state.selectedLayerId);

  if (!layer) {
    container.innerHTML = "<p>Selecione uma camada.</p>";
    return;
  }

  let html = `
    <div class="properties-form">
      <label>Nome
        <input type="text" id="prop-name" value="${escapeHtml(layer.name)}">
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label>X <input type="number" id="prop-x" value="${layer.x}"></label>
        <label>Y <input type="number" id="prop-y" value="${layer.y}"></label>
        <label>Largura <input type="number" id="prop-w" value="${layer.width}"></label>
        <label>Altura <input type="number" id="prop-h" value="${layer.height}"></label>
      </div>
      <label>Rotação (°) <input type="number" id="prop-rot" value="${layer.rotation}"></label>
      <label>Opacidade
        <input type="range" id="prop-opacity" min="0" max="1" step="0.05" value="${layer.opacity}">
      </label>
      <label>zIndex <input type="number" id="prop-z" value="${layer.zIndex}"></label>
      <label style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="prop-visible" ${layer.visible ? "checked" : ""}> Visível
      </label>
      <label style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="prop-locked" ${layer.locked ? "checked" : ""}> Travada
      </label>
      ${renderTypeProperties(layer)}
    </div>
  `;

  container.innerHTML = html;
  attachPropertyListeners(layer);
}

function renderTypeProperties(layer) {
  const p = layer.properties || {};
  let html = "";

  const assetOptions = state.assets
    .map((a) => `<option value="${a.assetId}" ${a.assetId === p.assetId ? "selected" : ""}>${escapeHtml(a.assetId)}</option>`)
    .join("");

  switch (layer.type) {
    case "background":
      html += `
        <label>Cor <input type="color" id="prop-color" value="${p.color || "#ffffff"}"></label>
        <label>Asset
          <select id="prop-asset"><option value="">—</option>${assetOptions}</select>
        </label>`;
      break;
    case "image":
      html += `
        <label>Asset
          <select id="prop-asset"><option value="">—</option>${assetOptions}</select>
        </label>
        <label>Fit
          <select id="prop-fit">
            <option value="cover" ${p.fit === "cover" ? "selected" : ""}>cover</option>
            <option value="contain" ${p.fit === "contain" ? "selected" : ""}>contain</option>
            <option value="fill" ${p.fit === "fill" ? "selected" : ""}>fill</option>
          </select>
        </label>
        <label>Posição
          <select id="prop-position">
            <option value="center" ${p.position === "center" ? "selected" : ""}>center</option>
            <option value="top" ${p.position === "top" ? "selected" : ""}>top</option>
            <option value="bottom" ${p.position === "bottom" ? "selected" : ""}>bottom</option>
            <option value="left" ${p.position === "left" ? "selected" : ""}>left</option>
            <option value="right" ${p.position === "right" ? "selected" : ""}>right</option>
          </select>
        </label>`;
      break;
    case "overlay":
      html += `
        <label>Asset
          <select id="prop-asset"><option value="">—</option>${assetOptions}</select>
        </label>
        <label>Blend
          <select id="prop-blend">
            <option value="normal" ${p.blendMode === "normal" ? "selected" : ""}>normal</option>
            <option value="multiply" ${p.blendMode === "multiply" ? "selected" : ""}>multiply</option>
            <option value="screen" ${p.blendMode === "screen" ? "selected" : ""}>screen</option>
            <option value="overlay" ${p.blendMode === "overlay" ? "selected" : ""}>overlay</option>
          </select>
        </label>`;
      break;
    case "text":
      html += `
        <label>Texto <textarea id="prop-text" rows="2">${escapeHtml(p.text || "")}</textarea></label>
        <label>Fonte <input type="text" id="prop-font" value="${escapeHtml(p.fontFamily || "Arial")}"></label>
        <label>Tamanho <input type="number" id="prop-fontsize" value="${p.fontSize || 16}"></label>
        <label>Mínimo <input type="number" id="prop-minfontsize" value="${p.minFontSize || 8}"></label>
        <label>Peso <input type="number" id="prop-weight" value="${p.fontWeight || 400}"></label>
        <label>Cor <input type="color" id="prop-fill" value="${p.fill || "#000000"}"></label>
        <label>Alinhamento
          <select id="prop-align">
            <option value="left" ${p.align === "left" ? "selected" : ""}>left</option>
            <option value="center" ${p.align === "center" ? "selected" : ""}>center</option>
            <option value="right" ${p.align === "right" ? "selected" : ""}>right</option>
          </select>
        </label>
        <label>Vertical
          <select id="prop-valign">
            <option value="top" ${p.verticalAlign === "top" ? "selected" : ""}>top</option>
            <option value="middle" ${p.verticalAlign === "middle" ? "selected" : ""}>middle</option>
            <option value="bottom" ${p.verticalAlign === "bottom" ? "selected" : ""}>bottom</option>
          </select>
        </label>
        <label>Line-height <input type="number" id="prop-lh" step="0.1" value="${p.lineHeight || 1.2}"></label>
        <label>Max linhas <input type="number" id="prop-maxlines" value="${p.maxLines || 3}"></label>
        <label>Padding <input type="number" id="prop-padding" value="${p.padding || 0}"></label>
        <label>Overflow
          <select id="prop-overflow">
            <option value="shrink" ${p.overflow === "shrink" ? "selected" : ""}>shrink</option>
            <option value="clip" ${p.overflow === "clip" ? "selected" : ""}>clip</option>
          </select>
        </label>
        <label style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="prop-autofit" ${p.autoFit ? "checked" : ""}> Auto-fit
        </label>`;
      break;
    case "shape":
      html += `
        <label>Tipo
          <select id="prop-shapetype">
            <option value="rectangle" ${p.shapeType === "rectangle" ? "selected" : ""}>rectangle</option>
            <option value="circle" ${p.shapeType === "circle" ? "selected" : ""}>circle</option>
            <option value="ellipse" ${p.shapeType === "ellipse" ? "selected" : ""}>ellipse</option>
          </select>
        </label>
        <label>Fill <input type="color" id="prop-fill" value="${p.fill || "#000000"}"></label>
        <label>Stroke <input type="color" id="prop-stroke" value="${p.stroke || ""}"></label>
        <label>Stroke width <input type="number" id="prop-strokewidth" value="${p.strokeWidth || 0}"></label>
        <label>Corner radius <input type="number" id="prop-radius" value="${p.cornerRadius || 0}"></label>`;
      break;
  }

  return html;
}

function attachPropertyListeners(layer) {
  const container = document.getElementById("properties");
  const getVal = (id) => document.getElementById(id)?.value;
  const getNum = (id) => Number(getVal(id));
  const getBool = (id) => document.getElementById(id)?.checked;

  const update = async () => {
    layer.name = getVal("prop-name") || layer.name;
    layer.x = getNum("prop-x");
    layer.y = getNum("prop-y");
    layer.width = getNum("prop-w");
    layer.height = getNum("prop-h");
    layer.rotation = getNum("prop-rot");
    layer.opacity = getNum("prop-opacity");
    layer.zIndex = getNum("prop-z");
    layer.visible = getBool("prop-visible");
    layer.locked = getBool("prop-locked");

    const p = layer.properties;
    switch (layer.type) {
      case "background":
        p.color = getVal("prop-color");
        p.assetId = getVal("prop-asset") || null;
        break;
      case "image":
        p.assetId = getVal("prop-asset") || null;
        p.fit = getVal("prop-fit");
        p.position = getVal("prop-position");
        break;
      case "overlay":
        p.assetId = getVal("prop-asset") || null;
        p.blendMode = getVal("prop-blend");
        break;
      case "text":
        p.text = getVal("prop-text");
        p.fontFamily = getVal("prop-font");
        p.fontSize = getNum("prop-fontsize");
        p.minFontSize = getNum("prop-minfontsize");
        p.fontWeight = getNum("prop-weight");
        p.fill = getVal("prop-fill");
        p.align = getVal("prop-align");
        p.verticalAlign = getVal("prop-valign");
        p.lineHeight = getNum("prop-lh");
        p.maxLines = getNum("prop-maxlines");
        p.padding = getNum("prop-padding");
        p.overflow = getVal("prop-overflow");
        p.autoFit = getBool("prop-autofit");
        break;
      case "shape":
        p.shapeType = getVal("prop-shapetype");
        p.fill = getVal("prop-fill");
        p.stroke = getVal("prop-stroke") || null;
        p.strokeWidth = getNum("prop-strokewidth");
        p.cornerRadius = getNum("prop-radius");
        break;
    }

    await syncObjectFromLayer(layer);
    state.canvas.renderAll();
    renderLayerList();
  };

  container.querySelectorAll("input, select, textarea").forEach((el) => {
    el.addEventListener("change", update);
    if (el.tagName === "INPUT" && el.type !== "checkbox" && el.type !== "color") {
      el.addEventListener("input", update);
    }
  });
}

function needsRecreate(layer, obj) {
  if (!obj) return true;
  if (layer.type === "background" || layer.type === "image" || layer.type === "overlay") {
    if (obj.layerAssetId !== layer.properties.assetId) return true;
  }
  if (layer.type === "image") {
    if (obj.layerFit !== layer.properties.fit) return true;
    if (obj.layerPosition !== layer.properties.position) return true;
  }
  if (layer.type === "shape" && obj.layerShapeType !== layer.properties.shapeType) return true;
  return false;
}

async function syncObjectFromLayer(layer) {
  let obj = state.canvas.getObjects().find((o) => o.layerId === layer.id);
  if (!obj) {
    await syncCanvasFromTemplate();
    return;
  }

  state.isSyncing = true;

  if (needsRecreate(layer, obj)) {
    const oldIndex = state.canvas.getObjects().indexOf(obj);
    state.canvas.remove(obj);
    const newObj = await createFabricObject(layer);
    if (!newObj) {
      state.isSyncing = false;
      state.canvas.renderAll();
      renderLayerList();
      return;
    }
    applyLockedState(newObj, layer.locked);
    newObj.set("layerId", layer.id);
    state.canvas.add(newObj);
    state.canvas.moveTo(newObj, oldIndex);
    state.canvas.setActiveObject(newObj);
    obj = newObj;
  }

  if (layer.type === "image" || layer.type === "overlay") {
    const isOverlay = layer.type === "overlay";
    applyImageFit(
      obj,
      layer,
      isOverlay ? "fill" : layer.properties.fit || "cover",
      isOverlay ? "center" : layer.properties.position || "center"
    );
    obj.set({
      angle: layer.rotation,
      opacity: layer.opacity,
      visible: layer.visible,
    });
  } else {
    obj.set({
      left: layer.x,
      top: layer.y,
      angle: layer.rotation,
      opacity: layer.opacity,
      visible: layer.visible,
    });
    applyObjectGeometry(obj, layer);
  }
  applyLockedState(obj, layer.locked);

  if (layer.type === "text") {
    const renderFont = await loadFontForPreview(layer.properties.fontFamily);
    obj.set({
      text: layer.properties.text || "",
      fontFamily: renderFont,
      fontSize: layer.properties.fontSize || 16,
      fontWeight: layer.properties.fontWeight || 400,
      fill: layer.properties.fill || "#000000",
      textAlign: layer.properties.align || "left",
      lineHeight: layer.properties.lineHeight || 1.2,
    });
    obj.layerFontFamily = layer.properties.fontFamily;
  }

  if (layer.type === "shape") {
    const p = layer.properties;
    obj.set({
      fill: p.fill,
      stroke: p.stroke || null,
      strokeWidth: p.strokeWidth || 0,
    });
    if (obj.type === "rect") {
      obj.set({ rx: p.cornerRadius || 0, ry: p.cornerRadius || 0 });
    }
  }

  if (layer.type === "overlay") {
    const blendMap = { normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay" };
    obj.set("globalCompositeOperation", blendMap[layer.properties.blendMode] || "source-over");
  }

  reorderCanvasObjects();

  obj.setCoords();
  state.canvas.renderAll();
  state.isSyncing = false;
  renderLayerList();
}

function renderVariables() {
  const container = document.getElementById("variables");
  if (!state.template) {
    container.innerHTML = "";
    return;
  }
  const vars = state.template.variables || [];

  if (vars.length === 0) {
    container.innerHTML = "<p>Nenhuma variável definida.</p>";
    return;
  }

  container.innerHTML = vars
    .map(
      (v) => `
      <div class="variable-row">
        <label>${escapeHtml(v.label)} (${escapeHtml(v.key)}) ${v.required ? "*" : ""}</label>
        <input type="text" class="var-input" data-key="${v.key}" value="${escapeHtml(
          v.defaultValue !== undefined ? String(v.defaultValue) : ""
        )}">
      </div>`
    )
    .join("");
}

function collectVariables() {
  const values = {};
  document.querySelectorAll(".var-input").forEach((input) => {
    values[input.dataset.key] = input.value;
  });
  return values;
}

async function saveTemplate() {
  if (!state.template) return;
  state.template.metadata.updatedAt = new Date().toISOString();

  const res = await fetch(`/api/templates/${state.template.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.template),
  });

  if (!res.ok) {
    const data = await res.json();
    alert(`Erro ao salvar: ${data.error}\n${(data.details || []).join("\n")}`);
    return;
  }

  await loadTemplateList();
  document.getElementById("templateSelect").value = state.template.id;
  alert("Template salvo.");
}

async function renderPng() {
  if (!state.template) return;
  const values = collectVariables();

  // Default: render the current unsaved template JSON in memory.
  let res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template: state.template, values }),
  });

  // Fallback to the saved-template render route only if the in-memory route fails.
  if (!res.ok && state.template.id) {
    res = await fetch(`/api/render/${state.template.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Erro desconhecido." }));
    alert(`Erro ao renderizar: ${data.error}`);
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.template.id}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function uploadAsset(e) {
  e.preventDefault();
  const input = e.target.querySelector('input[type="file"]');
  if (!input.files[0]) return;

  const formData = new FormData();
  formData.append("file", input.files[0]);

  const res = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json();
    alert(`Erro no upload: ${data.error}`);
    return;
  }

  input.value = "";
  await loadAssets();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

window.addEventListener("DOMContentLoaded", init);
