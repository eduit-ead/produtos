/**
 * Estúdio de Criação simplificado.
 * Não usa Fabric.js: o preview é renderizado pelo servidor via Sharp.
 */

const state = {
  templates: [],
  assets: [],
  selectedTemplate: null,
  values: {},
  previewAbort: null,
  debounceTimer: null,
};

const DEBOUNCE_MS = 400;

function byId(id) {
  return document.getElementById(id);
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "Erro desconhecido");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

async function apiBlob(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "Erro desconhecido");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.blob();
}

function setStatus(type, message) {
  const el = byId("status");
  el.className = `status ${type}`;
  el.textContent = message;
}

function getDefaultValues(template) {
  const values = {};
  for (const v of template.variables || []) {
    if (Object.hasOwn(v, "defaultValue") && v.defaultValue !== undefined && v.defaultValue !== null) {
      values[v.key] = v.defaultValue;
    } else if (v.type === "boolean") {
      values[v.key] = false;
    } else {
      values[v.key] = "";
    }
  }
  return values;
}

async function loadTemplates() {
  state.templates = await apiJson("/api/templates");
  renderTemplateCards();
}

async function loadAssets() {
  state.assets = await apiJson("/api/assets");
}

async function renderThumbnail(template) {
  try {
    const blob = await apiBlob("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template, values: {} }),
    });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error("Falha ao gerar miniatura:", err);
    return null;
  }
}

function renderTemplateCards() {
  const container = byId("templateCards");
  container.innerHTML = "";

  for (const tpl of state.templates) {
    const card = document.createElement("div");
    card.className = "template-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = "<span class='placeholder'>Gerando miniatura...</span>";
    card.appendChild(thumb);

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<h3>${escapeHtml(tpl.name || tpl.id)}</h3><p>${escapeHtml(tpl.id)}</p>`;
    card.appendChild(info);

    card.addEventListener("click", () => selectTemplate(tpl.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") selectTemplate(tpl.id);
    });

    container.appendChild(card);

    // Carrega miniatura de forma não bloqueante.
    (async () => {
      const fullTemplate = await apiJson(`/api/templates/${tpl.id}`);
      const url = await renderThumbnail(fullTemplate);
      if (url) {
        thumb.innerHTML = "";
        const img = document.createElement("img");
        img.src = url;
        img.alt = tpl.name || tpl.id;
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = "<span class='placeholder'>Sem preview</span>";
      }
    })();
  }
}

async function selectTemplate(id) {
  const tpl = await apiJson(`/api/templates/${id}`);
  state.selectedTemplate = tpl;
  state.values = getDefaultValues(tpl);

  byId("templateName").textContent = tpl.name || tpl.id;
  byId("stageSelect").classList.add("hidden");
  byId("stageEditor").classList.remove("hidden");

  buildForm();
  await loadAssets();
  updateAssetSelectors();
  renderPreview();
}

function showSelect() {
  state.selectedTemplate = null;
  state.values = {};
  byId("stageSelect").classList.remove("hidden");
  byId("stageEditor").classList.add("hidden");
  byId("variablesForm").innerHTML = "";
  byId("previewImg").src = "";
  byId("previewImg").classList.add("hidden");
}

function buildForm() {
  const form = byId("variablesForm");
  form.innerHTML = "";

  const variables = state.selectedTemplate?.variables || [];
  if (variables.length === 0) {
    form.innerHTML = "<p>Nenhuma variável para preencher.</p>";
    return;
  }

  for (const v of variables) {
    const group = document.createElement("div");
    group.className = "field-group";

    const label = document.createElement("label");
    label.textContent = `${v.label}${v.required ? " *" : ""}`;
    group.appendChild(label);

    const input = createInputForVariable(v);
    group.appendChild(input);
    form.appendChild(group);
  }
}

function createInputForVariable(v) {
  const value = state.values[v.key] !== undefined ? state.values[v.key] : (v.defaultValue ?? "");

  if (v.type === "boolean") {
    const wrap = document.createElement("label");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(value);
    cb.dataset.key = v.key;
    cb.addEventListener("change", () => {
      state.values[v.key] = cb.checked;
      scheduleRender();
    });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode("Ativo"));
    return wrap;
  }

  if (v.type === "color") {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "8px";

    const color = document.createElement("input");
    color.type = "color";
    color.value = normalizeColor(value) || "#000000";
    color.dataset.key = v.key;

    const text = document.createElement("input");
    text.type = "text";
    text.value = String(value || "");
    text.style.flex = "1";

    color.addEventListener("input", () => {
      text.value = color.value;
      state.values[v.key] = color.value;
      scheduleRender();
    });
    text.addEventListener("input", () => {
      color.value = normalizeColor(text.value) || color.value;
      state.values[v.key] = text.value;
      scheduleRender();
    });

    wrap.appendChild(color);
    wrap.appendChild(text);
    return wrap;
  }

  if (v.type === "image") {
    return createImageInput(v);
  }

  const input = document.createElement("input");
  input.type = v.type === "number" ? "number" : "text";
  input.value = String(value);
  input.dataset.key = v.key;
  input.addEventListener("input", () => {
    state.values[v.key] = v.type === "number" ? parseFloat(input.value) : input.value;
    scheduleRender();
  });

  if (v.type === "string" && v.required) {
    input.required = true;
  }

  return input;
}

function createImageInput(v) {
  const wrap = document.createElement("div");
  wrap.className = "asset-select";

  const row = document.createElement("div");
  row.className = "asset-row";

  const select = document.createElement("select");
  select.dataset.key = v.key;
  select.dataset.type = "image";
  select.addEventListener("change", () => {
    state.values[v.key] = select.value;
    scheduleRender();
  });
  row.appendChild(select);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".png,.jpg,.jpeg,.svg";
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files[0]) return;
    setStatus("loading", "Enviando imagem...");
    try {
      const data = new FormData();
      data.append("file", fileInput.files[0]);
      const uploaded = await apiJson("/api/upload", { method: "POST", body: data });
      await loadAssets();
      updateAssetSelectors();
      state.values[v.key] = uploaded.assetId;
      select.value = uploaded.assetId;
      scheduleRender();
      setStatus("ready", "Pronto");
    } catch (err) {
      setStatus("error", `Erro no upload: ${err.message}`);
    } finally {
      fileInput.value = "";
    }
  });

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.textContent = "Novo";
  uploadBtn.className = "secondary";
  uploadBtn.addEventListener("click", () => fileInput.click());

  row.appendChild(uploadBtn);
  row.appendChild(fileInput);
  wrap.appendChild(row);

  // Armazena referências para atualização posterior.
  wrap.dataset.key = v.key;
  return wrap;
}

function updateAssetSelectors() {
  document.querySelectorAll("select[data-type='image']").forEach((select) => {
    const key = select.dataset.key;
    const current = state.values[key] || "";
    select.innerHTML = "<option value=''>— Nenhum —</option>" +
      state.assets.map((a) => `<option value="${escapeHtml(a.assetId)}">${escapeHtml(a.assetId)} (${(a.size / 1024).toFixed(1)} KB)</option>`).join("");
    select.value = current;
  });
}

function normalizeColor(value) {
  const str = String(value || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return str;
  if (/^#[0-9A-Fa-f]{3}$/.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`;
  }
  return null;
}

function scheduleRender() {
  setStatus("loading", "Atualizando preview...");
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => renderPreview(), DEBOUNCE_MS);
}

async function renderPreview() {
  if (!state.selectedTemplate) return;

  if (state.previewAbort) {
    state.previewAbort.abort();
  }
  const controller = new AbortController();
  state.previewAbort = controller;

  try {
    const blob = await apiBlob("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: state.selectedTemplate, values: state.values }),
      signal: controller.signal,
    });

    if (controller.signal.aborted) return;

    const url = URL.createObjectURL(blob);
    const img = byId("previewImg");
    img.src = url;
    img.classList.remove("hidden");
    setStatus("ready", "Pronto");
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    setStatus("error", `Erro no preview: ${err.message}`);
  } finally {
    if (state.previewAbort === controller) {
      state.previewAbort = null;
    }
  }
}

async function downloadPng() {
  if (!state.selectedTemplate) return;
  setStatus("loading", "Gerando PNG...");
  try {
    const blob = await apiBlob("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: state.selectedTemplate, values: state.values }),
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.selectedTemplate.id}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("ready", "PNG baixado");
  } catch (err) {
    setStatus("error", `Erro ao baixar: ${err.message}`);
  }
}

function resetValues() {
  state.values = getDefaultValues(state.selectedTemplate);
  buildForm();
  updateAssetSelectors();
  renderPreview();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function init() {
  byId("btnBack").addEventListener("click", showSelect);
  byId("btnReset").addEventListener("click", resetValues);
  byId("btnDownload").addEventListener("click", downloadPng);

  loadTemplates();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
