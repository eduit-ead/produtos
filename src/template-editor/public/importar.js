const state = {
  step: 1,
  name: "",
  id: "",
  file: null,
  sourceType: null,
  sourcePath: null,
  filename: null,
  sheet: null,
  sheets: [],
  preview: null,
  headers: [],
  total: 0,
  primaryKey: "",
  validation: { emptyIds: 0, duplicateIds: [], missingColumn: false },
  mappings: {
    primaryKey: "",
    title: "",
    subtitle: "",
    slug: "",
    prompt: "",
    sourceImage: "",
    status: "",
  },
  extraFields: [],
  templateId: "",
  templates: [],
  filters: [],
  filenamePattern: "{{slug}}",
  productionErrors: [],
};

const ESSENTIAL_FIELDS = [
  { key: "primaryKey", label: "Identificador único *", hint: "Ex: SKU, ID, código" },
  { key: "title", label: "Título principal *", hint: "Ex: nome do produto, título do post" },
  { key: "subtitle", label: "Subtítulo ou descrição", hint: "Texto complementar" },
  { key: "slug", label: "Slug/nome do arquivo", hint: "Se vazio, será gerado a partir do identificador ou título" },
  { key: "prompt", label: "Prompt de imagem", hint: "Descrição para gerar a imagem com IA" },
  { key: "sourceImage", label: "Imagem atual", hint: "URL ou caminho de uma imagem existente" },
  { key: "status", label: "Status", hint: "Coluna de status do conteúdo" },
];

function init() {
  registerNav("biblioteca");
  setupStep1();
  setupStep2();
  setupStep3();
  setupStep4();
  loadTemplates();
}

function setupStep1() {
  const nameInput = byId("baseName");
  const fileInput = byId("baseFile");
  const dropZone = byId("dropZone");

  nameInput.addEventListener("input", () => {
    state.name = nameInput.value.trim();
    state.id = slugify(state.name);
    validateStep1();
  });

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  byId("sheetName").addEventListener("change", () => {
    state.sheet = byId("sheetName").value;
    validateStep1();
  });

  byId("btnStep1Next").addEventListener("click", uploadAndPreview);
}

function handleFile(file) {
  const allowed = [".xlsx", ".csv", ".json"];
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!allowed.includes(ext)) {
    setStatus("status", "error", "Formato não suportado. Use XLSX, CSV ou JSON.");
    return;
  }
  state.file = file;
  state.sourceType = ext === ".xlsx" ? "xlsx" : ext === ".csv" ? "csv" : "json";
  state.filename = file.name;

  byId("fileInfo").textContent = `${file.name} · ${formatBytes(file.size)}`;
  byId("fileInfo").classList.remove("hidden");
  byId("sheetGroup").classList.toggle("hidden", state.sourceType !== "xlsx");

  if (state.sourceType === "xlsx") {
    loadSheets();
  }
  validateStep1();
}

async function loadSheets() {
  if (!state.id || !state.file) return;
  try {
    const formData = new FormData();
    formData.append("file", state.file);
    const uploaded = await api.json(`/api/collections/${encodeURIComponent(state.id)}/import`, {
      method: "POST",
      body: formData,
    });
    state.sourcePath = uploaded.path;

    const sheets = await api.json(`/api/collections/${encodeURIComponent(state.id)}/sheets?path=${encodeURIComponent(uploaded.path)}`);
    state.sheets = sheets;
    const select = byId("sheetName");
    select.innerHTML = sheets.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    state.sheet = sheets[0] || "";
    select.value = state.sheet;
    validateStep1();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function validateStep1() {
  const ok = state.name && state.id && state.file && (state.sourceType !== "xlsx" || state.sheet);
  byId("btnStep1Next").disabled = !ok;
}

async function uploadAndPreview() {
  if (byId("btnStep1Next").disabled) return;
  setStatus("status", "loading", "Enviando e analisando arquivo...");

  try {
    if (!state.sourcePath) {
      const formData = new FormData();
      formData.append("file", state.file);
      const uploaded = await api.json(`/api/collections/${encodeURIComponent(state.id)}/import`, {
        method: "POST",
        body: formData,
      });
      state.sourcePath = uploaded.path;
    }

    const preview = await api.json(`/api/collections/${encodeURIComponent(state.id)}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: {
          type: state.sourceType,
          path: state.sourcePath,
          sheet: state.sheet,
        },
      }),
    });

    state.preview = preview;
    state.headers = preview.headers || [];
    state.total = preview.total || 0;
    goToStep(2);
  } catch (err) {
    handleApiError(err, "status");
  }
}

function setupStep2() {
  byId("btnStep2Back").addEventListener("click", () => goToStep(1));
  byId("btnStep2Next").addEventListener("click", () => goToStep(3));
}

function renderStep2() {
  byId("previewStats").innerHTML = `
    <div class="stat"><strong>${state.total}</strong> registros</div>
    <div class="stat"><strong>${state.headers.length}</strong> colunas</div>
  `;

  const table = byId("previewTable");
  let html = "<tr>";
  for (const h of state.headers) html += `<th>${escapeHtml(h)}</th>`;
  html += "</tr>";
  for (const row of state.preview?.rows || []) {
    html += "<tr>";
    for (const h of state.headers) {
      const cell = row[h];
      html += `<td title="${escapeHtml(cell)}">${escapeHtml(String(cell ?? "").slice(0, 80))}</td>`;
    }
    html += "</tr>";
  }
  table.innerHTML = html;

  byId("previewIssues").innerHTML = `<div class="status ready">Revise os cabeçalhos e avance para mapear os campos.</div>`;
}

function setupStep3() {
  byId("btnStep3Back").addEventListener("click", () => goToStep(2));
  byId("btnStep3Next").addEventListener("click", () => goToStep(4));
  byId("btnAddExtra").addEventListener("click", () => addExtraField());
}

function renderStep3() {
  const grid = byId("mappingGrid");
  grid.innerHTML = "";

  for (const f of ESSENTIAL_FIELDS) {
    const group = document.createElement("div");
    group.className = "field-group";
    group.innerHTML = `
      <label for="map-${f.key}">${f.label}</label>
      <select id="map-${f.key}">
        <option value="">— Nenhum —</option>
        ${state.headers.map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join("")}
      </select>
      <div class="hint">${f.hint}</div>
    `;
    grid.appendChild(group);
  }

  for (const f of ESSENTIAL_FIELDS) {
    const el = byId(`map-${f.key}`);
    if (state.mappings[f.key]) el.value = state.mappings[f.key];
    el.addEventListener("change", () => {
      state.mappings[f.key] = el.value;
      if (f.key === "primaryKey") {
        validatePrimaryKeyField();
      }
    });
  }

  renderExtraFields();
  validatePrimaryKeyField();
}

async function validatePrimaryKeyField() {
  const pk = state.mappings.primaryKey;
  if (!pk || !state.sourcePath) {
    state.validation = { emptyIds: 0, duplicateIds: [], missingColumn: !pk };
    renderValidation();
    return;
  }
  setStatus("status", "loading", "Validando identificador...");
  try {
    const result = await api.json(`/api/collections/${encodeURIComponent(state.id)}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { type: state.sourceType, path: state.sourcePath, sheet: state.sheet },
        primaryKey: pk,
      }),
    });
    state.validation = result;
    renderValidation();
    setStatus("status", "ready", "Pronto");
  } catch (err) {
    handleApiError(err, "status");
  }
}

function renderValidation() {
  const el = byId("previewIssues");
  const v = state.validation;
  if (v.missingColumn) {
    el.innerHTML = `<div class="status warning">Escolha uma coluna como identificador único.</div>`;
  } else if (v.emptyIds === 0 && v.duplicateIds.length === 0) {
    el.innerHTML = `<div class="status success">Identificador válido: ${state.total} registros.</div>`;
  } else {
    el.innerHTML = `
      <div class="status warning">
        ${v.emptyIds} registro(s) com identificador vazio · ${v.duplicateIds.length} duplicado(s)
        ${v.duplicateIds.length > 0 ? `<br><small>${escapeHtml(v.duplicateIds.slice(0, 10).join(", "))}</small>` : ""}
      </div>
    `;
  }
}

function addExtraField(header = "") {
  state.extraFields.push(header);
  renderExtraFields();
}

function renderExtraFields() {
  const container = byId("extraFields");
  container.innerHTML = "";
  state.extraFields.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "extra-field-row";
    row.innerHTML = `
      <select data-index="${index}">
        <option value="">— Escolher coluna —</option>
        ${state.headers.map((h) => `<option value="${escapeHtml(h)}" ${h === value ? "selected" : ""}>${escapeHtml(h)}</option>`).join("")}
      </select>
      <button type="button" class="btn-danger remove-extra" data-index="${index}">Remover</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll("select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.index, 10);
      state.extraFields[idx] = sel.value;
    });
  });

  container.querySelectorAll(".remove-extra").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.extraFields.splice(parseInt(btn.dataset.index, 10), 1);
      renderExtraFields();
    });
  });
}

function setupStep4() {
  byId("btnStep4Back").addEventListener("click", () => goToStep(3));
  byId("btnCreateBase").addEventListener("click", createBase);
  byId("templateId").addEventListener("change", () => {
    state.templateId = byId("templateId").value;
    validateProduction();
  });
  byId("filenamePattern").addEventListener("input", () => {
    state.filenamePattern = byId("filenamePattern").value;
  });
}

async function loadTemplates() {
  try {
    state.templates = await api.json("/api/templates");
    const select = byId("templateId");
    select.innerHTML = state.templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join("");
    state.templateId = state.templates[0]?.id || "";
    select.value = state.templateId;
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function validateProduction() {
  if (!state.templateId || !state.mappings.title) return;
  const collection = buildCollection(false);
  try {
    const result = await api.json("/api/collections/validate-production", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collection),
    });
    state.productionErrors = result.errors || [];
    renderSummary();
  } catch (err) {
    state.productionErrors = [err.message];
    renderSummary();
  }
}

function renderStep4() {
  const container = byId("filterFields");
  container.innerHTML = "";
  for (const header of state.headers) {
    const label = document.createElement("label");
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(header)}" ${state.filters.includes(header) ? "checked" : ""}>
      ${escapeHtml(header)}
    `;
    label.querySelector("input").addEventListener("change", () => {
      const checked = Array.from(container.querySelectorAll("input:checked")).map((cb) => cb.value);
      state.filters = checked;
      renderSummary();
    });
    container.appendChild(label);
  }
  validateProduction();
}

function renderSummary() {
  const errors = state.productionErrors.length > 0
    ? `<div class="status error">${state.productionErrors.map((e) => escapeHtml(e)).join("<br>")}</div>`
    : "";
  byId("summaryBox").innerHTML = `
    <h4>Resumo</h4>
    <p><strong>Nome:</strong> ${escapeHtml(state.name)}</p>
    <p><strong>ID:</strong> ${escapeHtml(state.id)}</p>
    <p><strong>Fonte:</strong> ${escapeHtml(state.filename)}${state.sheet ? " · aba " + escapeHtml(state.sheet) : ""}</p>
    <p><strong>Registros:</strong> ${state.total}</p>
    <p><strong>Identificador:</strong> ${escapeHtml(state.mappings.primaryKey || "—")}</p>
    <p><strong>Título:</strong> ${escapeHtml(state.mappings.title || "—")}</p>
    <p><strong>Template:</strong> ${escapeHtml(state.templateId || "—")}</p>
    <p><strong>Nome do arquivo:</strong> ${escapeHtml(state.filenamePattern)}</p>
    ${errors}
  `;
}

function buildCollection(includeProductionBinding = true) {
  const fieldMappings = {
    title: state.mappings.title,
    slug: state.mappings.slug || state.mappings.primaryKey,
  };
  if (state.mappings.subtitle) fieldMappings.subtitle = state.mappings.subtitle;
  if (state.mappings.prompt) fieldMappings.prompt = state.mappings.prompt;
  if (state.mappings.sourceImage) fieldMappings.sourceImage = state.mappings.sourceImage;
  if (state.mappings.status) fieldMappings.status = state.mappings.status;

  const filters = state.filters.map((f) => ({ field: f, label: f }));
  if (state.mappings.status && !filters.find((f) => f.field === state.mappings.status)) {
    filters.push({ field: state.mappings.status, label: "Status" });
  }
  for (const extra of state.extraFields) {
    if (extra && !filters.find((f) => f.field === extra)) filters.push({ field: extra, label: extra });
  }

  const collection = {
    id: state.id,
    name: state.name,
    description: `Base importada de ${state.filename}.`,
    source: {
      type: state.sourceType,
      path: state.sourcePath,
      sheet: state.sheet,
    },
    primaryKey: state.mappings.primaryKey,
    displayField: state.mappings.title,
    searchFields: [state.mappings.title, state.mappings.subtitle].filter(Boolean),
    fieldMappings,
    filters,
    templateIds: [state.templateId],
    defaultTemplateId: state.templateId,
    filenamePattern: state.filenamePattern,
    outputColumns: {
      backgroundFilename: "bg_file",
      cardFilename: "card_file",
      whatsappFilename: "wa_file",
      backgroundUrl: "bg_url",
      cardUrl: "card_url",
      whatsappUrl: "wa_url",
      productionStatus: "prod_status",
      templateId: "tpl_id",
      updatedAt: "updated_at",
    },
    templateBindings: [
      { templateVariable: "titulo", sourceField: state.mappings.title },
      ...(state.mappings.subtitle ? [{ templateVariable: "subtitulo", sourceField: state.mappings.subtitle }] : []),
    ],
  };

  // Se o template tem uma variável de imagem chamada imagemFundo ou similar,
  // preferimos binding automático. O usuário pode ajustar depois na configuração.
  if (includeProductionBinding && state.templateId) {
    collection.productionBackgroundBinding = { variable: "imagemFundo" };
  }

  return collection;
}

async function createBase() {
  if (!state.mappings.primaryKey || !state.mappings.title) {
    setStatus("status", "warning", "Preencha o identificador único e o título principal.");
    return;
  }
  if (!state.templateId) {
    setStatus("status", "warning", "Escolha um template padrão.");
    return;
  }

  const collection = buildCollection();
  setStatus("status", "loading", "Criando base...");

  try {
    await api.json("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collection),
    });
    setStatus("status", "success", "Base criada com sucesso.");
    setTimeout(() => {
      window.location.href = `/batch.html?collection=${encodeURIComponent(state.id)}&autostart=1`;
    }, 600);
  } catch (err) {
    handleApiError(err, "status");
  }
}

function goToStep(step) {
  state.step = step;

  document.querySelectorAll(".wizard-step").forEach((el) => {
    const s = parseInt(el.dataset.step, 10);
    el.classList.toggle("active", s === step);
    el.classList.toggle("done", s < step);
  });

  document.querySelectorAll(".step-panel").forEach((el) => {
    const s = parseInt(el.id.replace("step-", ""), 10);
    el.classList.toggle("active", s === step);
  });

  if (step === 2) renderStep2();
  if (step === 3) renderStep3();
  if (step === 4) renderStep4();

  setStatus("status", "ready", "Pronto");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
