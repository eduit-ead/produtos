const state = {
  templates: [],
  assets: [],
  selectedTemplate: null,
  values: {},
  previewUrl: null,
  previewAbort: null,
  debounceTimer: null,
};

const DEBOUNCE_MS = 400;

function normalizeColor(value) {
  const str = String(value || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return str;
  if (/^#[0-9A-Fa-f]{3}$/.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`;
  }
  return null;
}

async function loadTemplates() {
  state.templates = await api.json("/api/templates");
  renderTemplateCards();
}

async function loadAssets() {
  state.assets = await api.json("/api/assets");
}

async function renderThumbnail(template) {
  try {
    const values = getDefaultValues(template);
    const blob = await api.blob(`/api/render/${encodeURIComponent(template.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
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

  if (state.templates.length === 0) {
    showEmpty(container, "Nenhum template", "Crie um template na biblioteca para começar.", {
      label: "Ir para biblioteca",
      onClick: () => (window.location.href = "/biblioteca.html?tab=templates"),
    });
    return;
  }

  for (const tpl of state.templates) {
    const card = document.createElement("div");
    card.className = "card card-hover template-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = "<span class='placeholder'>Gerando miniatura...</span>";
    card.appendChild(thumb);

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<h3>${escapeHtml(tpl.name || tpl.id)}</h3><p>${tpl.canvas?.width || 0}×${tpl.canvas?.height || 0} px · ${(tpl.variables || []).length} campo(s)</p>`;
    card.appendChild(info);

    card.addEventListener("click", () => selectTemplate(tpl.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") selectTemplate(tpl.id);
    });

    container.appendChild(card);

    (async () => {
      const fullTemplate = await api.json(`/api/templates/${tpl.id}`);
      info.innerHTML = `<h3>${escapeHtml(fullTemplate.name || fullTemplate.id)}</h3><p>${fullTemplate.canvas?.width || 0}×${fullTemplate.canvas?.height || 0} px · ${(fullTemplate.variables || []).length} campo(s)</p>`;
      const url = await renderThumbnail(fullTemplate);
      if (url) {
        thumb.innerHTML = "";
        const img = document.createElement("img");
        img.src = url;
        img.alt = fullTemplate.name || fullTemplate.id;
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = "<span class='placeholder'>Sem preview</span>";
      }
    })();
  }
}

async function selectTemplate(id) {
  const tpl = await api.json(`/api/templates/${id}`);
  state.selectedTemplate = tpl;
  state.values = getDefaultValues(tpl);

  byId("templateName").textContent = tpl.name || tpl.id;
  byId("templateMeta").textContent = `${tpl.canvas?.width || 0}×${tpl.canvas?.height || 0} px · ${(tpl.variables || []).length} campo(s)`;

  const badge = byId("templateBadge");
  const advanced = byId("advancedLink");
  if (tpl.editable === false) {
    badge.classList.remove("hidden");
    advanced.classList.add("hidden");
  } else {
    badge.classList.add("hidden");
    advanced.classList.remove("hidden");
  }

  byId("stageSelect").classList.add("hidden");
  byId("stageEditor").classList.remove("hidden");

  buildForm();
  await loadAssets();
  updateAssetSelectors();
  renderPreview();
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

function buildForm() {
  const form = byId("variablesForm");
  form.innerHTML = "";
  const variables = state.selectedTemplate?.variables || [];

  if (variables.length === 0) {
    form.innerHTML = "<p class='hint'>Nenhuma variável para preencher.</p>";
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

    if (v.hint) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = v.hint;
      group.appendChild(hint);
    }

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
    cb.addEventListener("change", () => {
      state.values[v.key] = cb.checked;
      scheduleRender();
    });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(v.label));
    return wrap;
  }

  if (v.type === "color") {
    const wrap = document.createElement("div");
    wrap.className = "color-row";

    const color = document.createElement("input");
    color.type = "color";
    color.value = normalizeColor(value) || "#000000";

    const text = document.createElement("input");
    text.type = "text";
    text.value = String(value || "");

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
  input.addEventListener("input", () => {
    state.values[v.key] = v.type === "number" ? parseFloat(input.value) : input.value;
    scheduleRender();
  });
  if (v.type === "string" && v.required) input.required = true;
  return input;
}

function createImageInput(v) {
  const wrap = document.createElement("div");
  wrap.className = "asset-select";

  const row = document.createElement("div");
  row.className = "asset-row";

  const select = document.createElement("select");
  select.dataset.type = "image";
  select.dataset.key = v.key;
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
    setStatus("status", "loading", "Enviando imagem...");
    try {
      const data = new FormData();
      data.append("file", fileInput.files[0]);
      const uploaded = await api.json("/api/upload", { method: "POST", body: data });
      await loadAssets();
      updateAssetSelectors();
      state.values[v.key] = uploaded.assetId;
      select.value = uploaded.assetId;
      scheduleRender();
      setStatus("status", "ready", "Pronto");
    } catch (err) {
      handleApiError(err, "status");
    } finally {
      fileInput.value = "";
    }
  });

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.textContent = "Enviar";
  uploadBtn.className = "btn-secondary";
  uploadBtn.addEventListener("click", () => fileInput.click());

  row.appendChild(uploadBtn);
  row.appendChild(fileInput);
  wrap.appendChild(row);
  wrap.dataset.key = v.key;
  return wrap;
}

function updateAssetSelectors() {
  document.querySelectorAll("select[data-type='image']").forEach((select) => {
    const key = select.dataset.key;
    const current = state.values[key] || "";
    select.innerHTML =
      "<option value=''>— Nenhum —</option>" +
      state.assets
        .map((a) => `<option value="${escapeHtml(a.assetId)}">${escapeHtml(a.assetId)} · ${formatBytes(a.size)}</option>`)
        .join("");
    select.value = current;
  });
}

function scheduleRender() {
  setStatus("status", "loading", "Atualizando preview...");
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

  const hasRequired = validateRequired();
  byId("btnDownload").disabled = !hasRequired;
  byId("btnDownloadWhatsapp").disabled = !hasRequired;
  if (!hasRequired) {
    setStatus("status", "warning", "Preencha os campos obrigatórios.");
    return;
  }

  try {
    const blob = await api.blob(`/api/render/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.values),
      signal: controller.signal,
    });

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    const img = byId("previewImg");
    img.src = state.previewUrl;
    img.classList.remove("hidden");
    setStatus("status", "ready", "Pronto");
  } catch (err) {
    if (err.name !== "AbortError") {
      handleApiError(err, "status");
    }
  }
}

function validateRequired() {
  if (!state.selectedTemplate) return false;
  for (const v of state.selectedTemplate.variables || []) {
    if (!v.required) continue;
    const val = state.values[v.key];
    if (val === undefined || val === null || String(val).trim() === "") return false;
  }
  return true;
}

function showSelect() {
  state.selectedTemplate = null;
  state.values = {};
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  byId("previewImg").src = "";
  byId("previewImg").classList.add("hidden");
  byId("stageSelect").classList.remove("hidden");
  byId("stageEditor").classList.add("hidden");
  byId("variablesForm").innerHTML = "";
}

async function downloadPng() {
  if (!validateRequired()) return;
  setStatus("status", "loading", "Gerando PNG...");
  try {
    const blob = await api.blob(`/api/render/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.values),
    });
    downloadBlob(blob, `${slugify(state.selectedTemplate.name || state.selectedTemplate.id)}.png`);
    setStatus("status", "success", "PNG baixado.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function downloadWhatsapp() {
  if (!validateRequired()) return;
  setStatus("status", "loading", "Gerando WhatsApp...");
  try {
    const blob = await api.blob(`/api/render-whatsapp/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.values),
    });
    downloadBlob(blob, `${slugify(state.selectedTemplate.name || state.selectedTemplate.id)}-whatsapp.jpg`);
    setStatus("status", "success", "WhatsApp baixado.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

function init() {
  registerNav("criar");
  loadTemplates();
  byId("btnBack").addEventListener("click", showSelect);
  byId("btnReset").addEventListener("click", () => {
    state.values = getDefaultValues(state.selectedTemplate);
    buildForm();
    updateAssetSelectors();
    renderPreview();
  });
  byId("btnDownload").addEventListener("click", downloadPng);
  byId("btnDownloadWhatsapp").addEventListener("click", downloadWhatsapp);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
