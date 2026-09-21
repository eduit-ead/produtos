const state = {
  templates: [],
  assets: [],
  collections: [],
  selectedTemplate: null,
  values: {},
  visual: {},
  generatedVersions: [],
  activeBackgroundKey: null,
  backgroundBuffers: {},
  collectionsRecords: {},
  collectionSearchQuery: "",
  selectedCollectionId: null,
  selectedItemId: null,
  selectedItemRecord: null,
  openAiConfigured: false,
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function loadStudioSystemStatus() {
  try {
    const status = await api.json("/api/health");
    state.openAiConfigured = status.openaiConfigured === true;
  } catch {
    state.openAiConfigured = false;
  }
}

async function loadTemplates() {
  state.templates = await api.json("/api/templates");
  renderTemplateCards();
}

async function loadAssets() {
  state.assets = await api.json("/api/assets");
}

async function loadCollections() {
  try {
    state.collections = await api.json("/api/collections");
  } catch {
    state.collections = [];
  }
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
  state.visual = {};
  state.generatedVersions = [];
  state.activeBackgroundKey = null;
  state.backgroundBuffers = {};
  state.collectionSearchQuery = "";
  state.selectedCollectionId = null;
  state.selectedItemId = null;
  state.selectedItemRecord = null;

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
  setupBackgroundSection();
  setupBaseFill();
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

  const bgSelect = byId("bgAssetSelect");
  if (bgSelect) {
    bgSelect.innerHTML =
      "<option value=''>— escolher asset —</option>" +
      state.assets
        .map((a) => `<option value="${escapeHtml(a.assetId)}">${escapeHtml(a.assetId)} · ${formatBytes(a.size)}</option>`)
        .join("");
  }
}

function scheduleRender() {
  setStatus("status", "loading", "Atualizando preview...");
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => renderPreview(), DEBOUNCE_MS);
}

function getRenderPayload() {
  const payload = { values: state.values };
  const runtimeAssets = {};
  if (state.activeBackgroundKey && state.backgroundBuffers[state.activeBackgroundKey]) {
    runtimeAssets[state.activeBackgroundKey] = state.backgroundBuffers[state.activeBackgroundKey];
  }
  if (Object.keys(runtimeAssets).length > 0) {
    payload.runtimeAssets = runtimeAssets;
  }
  return payload;
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
    const payload = getRenderPayload();
    const blob = await api.blob(`/api/render/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  state.visual = {};
  state.generatedVersions = [];
  state.activeBackgroundKey = null;
  state.backgroundBuffers = {};
  state.selectedCollectionId = null;
  state.selectedItemId = null;
  state.selectedItemRecord = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  byId("previewImg").src = "";
  byId("previewImg").classList.add("hidden");
  byId("stageSelect").classList.remove("hidden");
  byId("stageEditor").classList.add("hidden");
  byId("variablesForm").innerHTML = "";
  byId("backgroundSection")?.classList.add("hidden");
  byId("baseFillSection")?.classList.add("hidden");
}

async function downloadPng() {
  if (!validateRequired()) return;
  setStatus("status", "loading", "Gerando PNG...");
  try {
    const payload = getRenderPayload();
    const blob = await api.blob(`/api/render/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    const payload = getRenderPayload();
    const blob = await api.blob(`/api/render-whatsapp/${encodeURIComponent(state.selectedTemplate.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    downloadBlob(blob, `${slugify(state.selectedTemplate.name || state.selectedTemplate.id)}-whatsapp.jpg`);
    setStatus("status", "success", "WhatsApp baixado.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

// ============================================================
// Base fill
// ============================================================

function setupBaseFill() {
  const section = byId("baseFillSection");
  const select = byId("baseFillCollection");
  const search = byId("baseFillSearch");
  const results = byId("baseFillResults");

  section.classList.add("hidden");
  select.innerHTML = "<option value=''>— escolher base —</option>";
  search.value = "";
  results.innerHTML = "";

  if (!state.collections.length) return;

  section.classList.remove("hidden");
  for (const col of state.collections) {
    const opt = document.createElement("option");
    opt.value = col.id;
    opt.textContent = col.name || col.id;
    select.appendChild(opt);
  }

  let debounce;
  select.addEventListener("change", () => {
    state.collectionsRecords = {};
    search.value = "";
    results.innerHTML = "";
  });
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => searchBaseFill(select.value, search.value.trim()), 300);
  });
}

async function searchBaseFill(collectionId, query) {
  const results = byId("baseFillResults");
  results.innerHTML = "";
  if (!collectionId || !query) return;

  try {
    if (!state.collectionsRecords[collectionId]) {
      const records = await api.json(`/api/collections/${encodeURIComponent(collectionId)}/records`);
      state.collectionsRecords[collectionId] = records;
    }
    const records = state.collectionsRecords[collectionId];
    const col = state.collections.find((c) => c.id === collectionId);
    const displayField = col?.displayField || "name";
    const searchFields = col?.searchFields || [displayField];
    const q = query.toLowerCase();
    const matched = records
      .filter((r) => searchFields.some((f) => String(r[f] || "").toLowerCase().includes(q)))
      .slice(0, 10);

    for (const r of matched) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-result-item";
      btn.textContent = String(r[displayField] || r[col?.primaryKey || "slug"] || "Sem nome");
      btn.addEventListener("click", () => applyBaseFill(collectionId, r));
      results.appendChild(btn);
    }
  } catch (err) {
    handleApiError(err, "status");
  }
}

function applyBaseFill(collectionId, record) {
  const collection = state.collections.find((c) => c.id === collectionId);
  if (!collection || !state.selectedTemplate) return;

  state.selectedCollectionId = collectionId;
  state.selectedItemId = record[collection.primaryKey] || record.slug || record.id || null;
  state.selectedItemRecord = record;

  for (const mapping of collection.templateBindings || []) {
    const source = record[mapping.sourceField];
    if (source !== undefined && source !== null) {
      state.values[mapping.templateVariable] = String(source);
    }
  }

  const igBindings = collection.imageGenerationBindings || {};
  const cfg = state.selectedTemplate.imageGeneration || {};
  const promptField = cfg.promptField || "prompt_imagem";

  if (igBindings.descriptionField && record[igBindings.descriptionField] !== undefined) {
    state.visual.description = String(record[igBindings.descriptionField]);
    state.values[promptField] = state.visual.description;
  }
  if (igBindings.environmentField && record[igBindings.environmentField] !== undefined) {
    state.visual.environment = String(record[igBindings.environmentField]);
  }
  if (igBindings.activityField && record[igBindings.activityField] !== undefined) {
    state.visual.activity = String(record[igBindings.activityField]);
  }
  if (igBindings.peopleField && record[igBindings.peopleField] !== undefined) {
    state.visual.people = String(record[igBindings.peopleField]);
  }
  if (igBindings.compositionField && record[igBindings.compositionField] !== undefined) {
    state.visual.composition = String(record[igBindings.compositionField]);
  }
  if (igBindings.avoidField && record[igBindings.avoidField] !== undefined) {
    state.visual.avoid = String(record[igBindings.avoidField]);
  }
  if (igBindings.detailsField && record[igBindings.detailsField] !== undefined) {
    state.visual.details = String(record[igBindings.detailsField]);
  }

  buildForm();
  updateAssetSelectors();
  updateBackgroundInputs();
  scheduleRender();
  byId("baseFillSearch").value = "";
  byId("baseFillResults").innerHTML = "";
  setStatus("status", "success", "Campos preenchidos pela base.");
}

// ============================================================
// Background generation
// ============================================================

function setupBackgroundSection() {
  const section = byId("backgroundSection");
  const cfg = state.selectedTemplate?.imageGeneration;

  if (!cfg || !cfg.enabled) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");

  byId("bgTabs").querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setBgMode(tab.dataset.mode);
    });
  });

  byId("bgDescription").addEventListener("input", () => {
    state.visual.description = byId("bgDescription").value;
    const cfg = state.selectedTemplate.imageGeneration;
    if (cfg.promptField) state.values[cfg.promptField] = state.visual.description;
    updateFinalPrompt();
    updateEstimate();
  });
  ["bgEnvironment", "bgActivity", "bgPeople", "bgComposition", "bgDetails", "bgAvoid"].forEach((id) => {
    byId(id).addEventListener("input", () => {
      const key = id.replace("bg", "").replace(/^./, (c) => c.toLowerCase());
      state.visual[key] = byId(id).value;
      updateFinalPrompt();
    });
  });
  byId("bgQuality").addEventListener("change", updateEstimate);
  byId("bgSize").addEventListener("change", updateEstimate);

  byId("btnGenerateBg").addEventListener("click", () => generateBackground(false));
  byId("btnDryRunBg").addEventListener("click", () => generateBackground(true));

  byId("bgUploadInput").addEventListener("change", async () => {
    const file = byId("bgUploadInput").files[0];
    if (!file) return;
    setStatus("status", "loading", "Enviando imagem de fundo...");
    try {
      const data = new FormData();
      data.append("file", file);
      const uploaded = await api.json("/api/upload", { method: "POST", body: data });
      await loadAssets();
      updateAssetSelectors();
      state.values.imagemFundo = uploaded.assetId;
      setBgMode("asset");
      byId("bgAssetSelect").value = uploaded.assetId;
      scheduleRender();
      setStatus("status", "ready", "Pronto");
    } catch (err) {
      handleApiError(err, "status");
    } finally {
      byId("bgUploadInput").value = "";
    }
  });

  byId("bgAssetSelect").addEventListener("change", () => {
    state.values.imagemFundo = byId("bgAssetSelect").value;
    scheduleRender();
  });

  setBgMode("ai");
  updateBackgroundInputs();
  updateEstimate();
  updateFinalPrompt();

  const btnGenerate = byId("btnGenerateBg");
  if (!state.openAiConfigured) {
    btnGenerate.disabled = true;
    btnGenerate.title = "OPENAI_API_KEY não configurada. Use o teste sem créditos.";
  } else {
    btnGenerate.disabled = false;
    btnGenerate.title = "";
  }
}

function setBgMode(mode) {
  byId("bgTabs").querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  ["bgPanelAi", "bgPanelAsset", "bgPanelUpload"].forEach((id, idx) => {
    byId(id).classList.toggle("active", ["ai", "asset", "upload"][idx] === mode);
  });
}

function updateBackgroundInputs() {
  const v = state.visual;
  byId("bgDescription").value = v.description || "";
  byId("bgEnvironment").value = v.environment || "";
  byId("bgActivity").value = v.activity || "";
  byId("bgPeople").value = v.people || "";
  byId("bgComposition").value = v.composition || "";
  byId("bgDetails").value = v.details || "";
  byId("bgAvoid").value = v.avoid || "";
}

async function updateFinalPrompt() {
  const cfg = state.selectedTemplate?.imageGeneration;
  if (!cfg) return;
  const promptBox = byId("bgFinalPrompt");
  const lines = [];
  if (cfg.basePrompt) lines.push(cfg.basePrompt);
  if (state.visual.description) lines.push(state.visual.description);
  [state.visual.environment, state.visual.activity, state.visual.people, state.visual.composition, state.visual.details].forEach((val) => {
    if (val) lines.push(val);
  });
  if (cfg.negativePrompt) lines.push(`(elementos a evitar: ${cfg.negativePrompt}${state.visual.avoid ? "; " + state.visual.avoid : ""})`);
  promptBox.textContent = lines.join("\n\n");
}

async function updateEstimate() {
  const cfg = state.selectedTemplate?.imageGeneration;
  const box = byId("bgEstimate");
  if (!cfg) {
    box.textContent = "";
    return;
  }
  try {
    const res = await api.json("/api/studio/generate-background/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: state.selectedTemplate.id,
        quality: byId("bgQuality").value,
        size: byId("bgSize").value,
      }),
    });
    if (res.cost && res.cost.totalCostUsd != null) {
      box.textContent = `Custo estimado: US$ ${res.cost.totalCostUsd.toFixed(4)} · ${byId("bgSize").value}`;
    } else {
      box.textContent = "Custo estimado indisponível para este modelo.";
    }
  } catch (err) {
    box.textContent = "Não foi possível estimar o custo.";
  }
}

let generatingBackground = false;

async function generateBackground(dryRun) {
  const cfg = state.selectedTemplate?.imageGeneration;
  if (!cfg) return;
  if (generatingBackground) return;
  if (!dryRun && !state.openAiConfigured) return;

  generatingBackground = true;
  setStatus("bgGenerationStatus", "loading", dryRun ? "Gerando fundo de teste..." : "Gerando fundo com IA...");
  byId("btnGenerateBg").disabled = true;
  byId("btnDryRunBg").disabled = true;

  try {
    const collectionId = byId("baseFillCollection").value || state.selectedCollectionId || null;
    const itemRecord = collectionId ? state.collectionsRecords[collectionId]?.find((r) => {
      const col = state.collections.find((c) => c.id === collectionId);
      const pk = col?.primaryKey || "slug";
      return String(r[pk]) === String(state.values[col?.templateBindings?.find((m) => m.templateVariable === "titulo")?.sourceField]);
    }) : null;
    const itemId = itemRecord ? String(itemRecord[state.collections.find((c) => c.id === collectionId)?.primaryKey || "slug"]) : null;

    if (collectionId && itemId) {
      state.selectedCollectionId = collectionId;
      state.selectedItemId = itemId;
      state.selectedItemRecord = itemRecord;
    }

    const res = await api.json("/api/studio/generate-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: state.selectedTemplate.id,
        values: state.values,
        visual: state.visual,
        collectionId,
        itemId,
        dryRun,
        quality: byId("bgQuality").value,
        size: byId("bgSize").value,
      }),
    });

    const key = res.metadata?.storage?.key || res.metadata?.runId;
    const url = res.metadata?.urls?.fundo;
    if (!url) throw new Error("Resposta não trouxe URL do fundo.");

    const fetchRes = await fetch(url);
    if (!fetchRes.ok) throw new Error("Falha ao carregar fundo gerado.");
    const buffer = await fetchRes.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    state.backgroundBuffers[key] = base64;
    const version = {
      key,
      runId: res.metadata.runId,
      generatedAt: res.metadata.generatedAt,
      dryRun,
      cost: res.metadata.cost,
      collectionId: state.selectedCollectionId,
      itemId: state.selectedItemId,
      approved: false,
    };
    const existing = state.generatedVersions.find((v) => v.key === key);
    if (!existing) {
      state.generatedVersions.push(version);
    }
    state.activeBackgroundKey = key;
    state.values.imagemFundo = key;

    renderVersions();
    setBgMode("ai");
    scheduleRender();
    setStatus("bgGenerationStatus", "success", `Fundo ${dryRun ? "de teste" : "gerado"} salvo. ${res.metadata.cost?.totalCostUsd != null ? `Custo: US$ ${res.metadata.cost.totalCostUsd.toFixed(4)}` : ""}`);
  } catch (err) {
    handleApiError(err, "bgGenerationStatus");
  } finally {
    generatingBackground = false;
    byId("btnDryRunBg").disabled = false;
    if (state.openAiConfigured) byId("btnGenerateBg").disabled = false;
  }
}

function renderVersions() {
  const container = byId("bgVersions");
  container.innerHTML = "";
  if (!state.generatedVersions.length) return;

  const needsSelection = !state.selectedCollectionId || !state.selectedItemId;

  for (const v of state.generatedVersions) {
    const chip = document.createElement("div");
    chip.className = `version-chip${v.key === state.activeBackgroundKey ? " active" : ""}${v.approved ? " approved" : ""}${v.dryRun ? " simulation" : ""}`;
    const label = v.dryRun ? "Simulação" : "v." + v.runId.slice(-4);

    let action = "";
    if (v.approved) {
      action = `<span class="version-approved">Aprovada</span>`;
    } else if (v.dryRun) {
      action = `<span class="version-hint">Simulação · não aprovável</span>`;
    } else if (needsSelection) {
      action = `<span class="version-hint">Selecione um item da base para aprovar</span>`;
    } else {
      action = `<button type="button" class="btn-primary btn-small btn-approve-version" data-key="${escapeHtml(v.key)}">Usar como imagem oficial</button>`;
    }

    chip.innerHTML = `
      <div class="version-main">
        <button type="button" class="btn-select-version" data-key="${escapeHtml(v.key)}">${escapeHtml(label)} · ${new Date(v.generatedAt).toLocaleTimeString()}</button>
        ${action}
      </div>
    `;
    chip.querySelector(".btn-select-version").addEventListener("click", () => {
      state.activeBackgroundKey = v.key;
      state.values.imagemFundo = v.key;
      renderVersions();
      scheduleRender();
    });
    const approveBtn = chip.querySelector(".btn-approve-version");
    if (approveBtn) {
      approveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        approveVersion(v.key);
      });
    }
    container.appendChild(chip);
  }
}

async function approveVersion(key) {
  const version = state.generatedVersions.find((v) => v.key === key);
  if (!version) return;
  if (version.dryRun) {
    setStatus("bgGenerationStatus", "warning", "Versões de simulação não podem ser aprovadas.");
    return;
  }
  if (!state.selectedCollectionId || !state.selectedItemId) {
    setStatus("bgGenerationStatus", "warning", "Selecione um item da base para aprovar esta imagem.");
    return;
  }

  const ok = await confirmModal("Definir esta versão como imagem oficial aprovada?");
  if (!ok) return;

  setStatus("bgGenerationStatus", "loading", "Aprovando imagem...");
  try {
    await api.json("/api/studio/approve-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: version.runId,
        collectionId: state.selectedCollectionId,
        itemId: state.selectedItemId,
        templateId: state.selectedTemplate.id,
        values: state.values,
      }),
    });
    version.approved = true;
    state.activeBackgroundKey = key;
    state.values.imagemFundo = key;
    renderVersions();
    scheduleRender();
    setStatus("bgGenerationStatus", "success", "Imagem aprovada e definida como atual.");
  } catch (err) {
    handleApiError(err, "bgGenerationStatus");
  }
}

async function init() {
  registerNav("criar");
  await loadStudioSystemStatus();
  loadCollections();
  loadTemplates();
  byId("btnBack").addEventListener("click", showSelect);
  byId("btnReset").addEventListener("click", () => {
    state.values = getDefaultValues(state.selectedTemplate);
    state.visual = {};
    buildForm();
    updateAssetSelectors();
    updateBackgroundInputs();
    updateFinalPrompt();
    scheduleRender();
  });
  byId("btnDownload").addEventListener("click", downloadPng);
  byId("btnDownloadWhatsapp").addEventListener("click", downloadWhatsapp);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
