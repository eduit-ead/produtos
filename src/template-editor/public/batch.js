const state = {
  collections: [],
  templates: [],
  collectionId: null,
  collection: null,
  items: [],
  filtered: [],
  selected: new Set(),
  filters: {},
  query: "",
  jobId: null,
  job: null,
  pollTimer: null,
  reviewSelected: new Set(),
};

const LEGACY_ID = "graduacao-cruzeiro";
const COST_PER_CALL = 0.03;

async function init() {
  registerNav("lote");
  setupEvents();
  await loadInitial();
  applySystemStatus();
}

function applySystemStatus() {
  const btn = byId("btnConfigReal");
  if (!btn) return;
  if (!isOpenAIConfigured()) {
    btn.disabled = true;
    btn.title = "Configure OPENAI_API_KEY para habilitar geração real.";
    setStatus("status", "warning", "OpenAI não configurada: geração real desabilitada. Use o modo de teste.");
  }
}

async function loadInitial() {
  try {
    const [collections, templates] = await Promise.all([
      api.json("/api/collections"),
      api.json("/api/templates"),
    ]);
    state.collections = collections;
    state.templates = templates;

    const params = new URLSearchParams(window.location.search);
    const requestedCollection = params.get("collection");
    const requestedJob = params.get("job");

    if (requestedJob) {
      state.jobId = requestedJob;
      await loadJob();
      if (state.job?.collectionId) {
        state.collectionId = state.job.collectionId;
        state.collection = state.collections.find((c) => c.id === state.collectionId) || null;
        await loadItems();
      }
      goStep("review");
      return;
    }

    if (requestedCollection && state.collections.some((c) => c.id === requestedCollection)) {
      state.collectionId = requestedCollection;
    } else {
      state.collectionId = state.collections.find((c) => c.id === LEGACY_ID)?.id || state.collections[0]?.id || null;
    }

    renderBaseStep();
    goStep("base");
    if (params.get("autostart") === "1" && state.collectionId) {
      await selectCollection(state.collectionId);
    }
  } catch (err) {
    handleApiError(err, "status");
  }
}

function setupEvents() {
  byId("btnSelectFiltered").addEventListener("click", () => {
    for (const item of state.filtered) state.selected.add(item.slug);
    renderItems();
  });
  byId("btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    renderItems();
  });
  byId("searchInput").addEventListener("input", () => {
    state.query = byId("searchInput").value.trim().toLowerCase();
    renderItems();
  });
  byId("btnItemsBack").addEventListener("click", () => goStep("base"));
  byId("btnItemsNext").addEventListener("click", () => goStep("config"));
  byId("btnConfigBack").addEventListener("click", () => goStep("items"));
  byId("btnConfigTest").addEventListener("click", () => createBatch(true));
  byId("btnConfigReal").addEventListener("click", () => createBatch(false));
  byId("btnReviewBack").addEventListener("click", () => {
    stopPolling();
    goStep("config");
  });
  byId("btnApproveSelected").addEventListener("click", () => bulkAction("approve"));
  byId("btnRejectSelected").addEventListener("click", () => bulkAction("reject"));
  byId("btnDownloadCards").addEventListener("click", () => downloadBatchZip({ approvedOnly: true, includeCards: true }, "cards-aprovados.zip"));
  byId("btnDownloadWhatsApp").addEventListener("click", () => downloadBatchZip({ approvedOnly: true, includeWhatsApp: true }, "whatsapp-aprovados.zip"));
  byId("btnDownloadPackage").addEventListener("click", () => downloadBatchZip({ approvedOnly: true, includeCards: true, includeWhatsApp: true, includeBackgrounds: true, includeMetadata: true }, "pacote-completo.zip"));
  byId("btnExportXlsx").addEventListener("click", exportSource);
  byId("btnSyncXlsx").addEventListener("click", syncSource);

  document.querySelectorAll('input[name="dryRun"], input[name="bgSource"], #batchSize, #maxCalls, #maxCostUsd').forEach((el) => {
    el.addEventListener("change", updateEstimate);
  });
  byId("templateSelect").addEventListener("change", updateEstimate);
}

function goStep(step) {
  document.querySelectorAll(".wizard-step").forEach((el) => {
    el.classList.toggle("active", el.dataset.step === step);
    el.classList.toggle("done", stepOrder(el.dataset.step) < stepOrder(step));
  });
  document.querySelectorAll(".step-panel").forEach((el) => {
    el.classList.toggle("active", el.id === `step-${step}`);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (step === "items") renderItems();
  if (step === "config") renderConfig();
  if (step === "review") renderReview();
}

function stepOrder(name) {
  return ["base", "items", "config", "review"].indexOf(name);
}

function getItemTitle(item) {
  return item.title || item.curso || item.slug;
}

// ============================================================
// Step: Base
// ============================================================

function renderBaseStep() {
  const container = byId("baseCards");
  const empty = byId("baseEmpty");
  if (state.collections.length === 0) {
    container.innerHTML = "";
    empty.classList.remove("hidden");
    showEmpty(empty, "Nenhuma base", "Importe uma base de conteúdo primeiro.", {
      label: "Importar base",
      onClick: () => (window.location.href = "/importar.html"),
    });
    return;
  }

  container.innerHTML = "";
  empty.classList.add("hidden");
  for (const c of state.collections) {
    const card = document.createElement("div");
    card.className = "card base-card card-hover";
    card.innerHTML = `
      <div class="meta"><span class="badge badge-primary">${escapeHtml(c.sourceType?.toUpperCase() || "—")}</span></div>
      <h4>${escapeHtml(c.name)}</h4>
      <p class="hint">${escapeHtml(c.description || "Sem descrição.")}</p>
      <div class="meta">Template padrão: ${escapeHtml(c.defaultTemplateId || "—")}</div>
    `;
    card.addEventListener("click", () => selectCollection(c.id));
    container.appendChild(card);
  }
}

async function selectCollection(id) {
  state.collectionId = id;
  state.collection = state.collections.find((c) => c.id === id);
  state.selected.clear();
  state.filters = {};
  state.query = "";
  setStatus("status", "loading", "Carregando itens...");
  await loadItems();
  goStep("items");
  setStatus("status", "ready", `${state.items.length} itens carregados.`);
}

async function loadItems() {
  state.items = await api.json(`/api/items?collection=${encodeURIComponent(state.collectionId || LEGACY_ID)}`);
}

// ============================================================
// Step: Items
// ============================================================

function applyFilters() {
  const q = state.query;
  state.filtered = state.items.filter((item) => {
    const title = getItemTitle(item).toLowerCase();
    const slug = item.slug.toLowerCase();
    if (q && !title.includes(q) && !slug.includes(q)) return false;
    for (const field of Object.keys(state.filters)) {
      const value = state.filters[field];
      if (!value) continue;
      const itemValue = item[field] || item.fields?.[field] || "";
      if (itemValue !== value) return false;
    }
    return true;
  });
}

function renderItems() {
  applyFilters();

  const filtersContainer = byId("itemsFilters");
  filtersContainer.innerHTML = "";
  const filterDefs = state.collection?.filters || [];
  for (const def of filterDefs) {
    const values = new Set(state.items.map((i) => i.fields?.[def.field] || i[def.field]).filter(Boolean));
    const select = document.createElement("select");
    select.innerHTML = `<option value="">${escapeHtml(def.label)}</option>` +
      [...values].sort().map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    select.value = state.filters[def.field] || "";
    select.addEventListener("change", () => {
      state.filters[def.field] = select.value;
      renderItems();
    });
    filtersContainer.appendChild(select);
  }

  const grid = byId("itemsGrid");
  grid.innerHTML = "";
  for (const item of state.filtered) {
    const card = document.createElement("div");
    card.className = "item-card" + (state.selected.has(item.slug) ? " selected" : "");
    card.innerHTML = `
      <div class="select-marker"></div>
      <div class="thumb">
        ${item.current_card_url
          ? `<img src="${escapeHtml(item.current_card_url)}" alt="" loading="lazy">`
          : `<span class="placeholder">${initials(getItemTitle(item))}</span>`}
      </div>
      <div class="info">
        <h4>${escapeHtml(getItemTitle(item))}</h4>
        <div class="meta">${escapeHtml(item.modalidade || item.formacao || item.source_status || "")}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      if (state.selected.has(item.slug)) state.selected.delete(item.slug);
      else state.selected.add(item.slug);
      renderItems();
    });
    grid.appendChild(card);
  }

  const bar = byId("selectionBar");
  const count = state.selected.size;
  byId("selectionText").textContent = count === 0
    ? "Nenhum item selecionado"
    : `${count} item${count === 1 ? "" : "s"} selecionado${count === 1 ? "" : "s"}`;
  bar.classList.toggle("hidden", count === 0);
  byId("btnItemsNext").disabled = count === 0;
}

// ============================================================
// Step: Config
// ============================================================

function renderConfig() {
  const select = byId("templateSelect");
  select.innerHTML = state.templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join("");
  const defaultTemplate = state.collection?.defaultTemplateId;
  if (defaultTemplate && state.templates.some((t) => t.id === defaultTemplate)) {
    select.value = defaultTemplate;
  }
  updateEstimate();
}

function updateEstimate() {
  const count = state.selected.size;
  const dryRun = document.querySelector('input[name="dryRun"]:checked')?.value === "true";
  const maxCalls = byId("maxCalls").value.trim();
  const calls = dryRun
    ? 0
    : maxCalls
    ? Math.min(parseInt(maxCalls, 10) || 0, count)
    : count;
  const cost = dryRun ? 0 : calls * COST_PER_CALL;
  byId("estimateSummary").textContent = `${count} item${count === 1 ? "" : "s"} · até ${calls} chamada${calls === 1 ? "" : "s"} · ${formatCurrency(cost)}`;
  byId("estimateHint").textContent = dryRun
    ? "Modo de teste: nenhuma chamada real à OpenAI."
    : "Geração real: as chamadas só começam após confirmação.";
}

async function createBatch(dryRun) {
  if (state.selected.size === 0) return;

  if (!dryRun && !isOpenAIConfigured()) {
    setStatus("status", "warning", "OpenAI não configurada. Geração real desabilitada.");
    return;
  }

  if (!dryRun) {
    const ok = await confirmModal(
      `Você está prestes a gerar imagens reais para ${state.selected.size} item(s). Isso consumirá créditos da OpenAI. Deseja continuar?`,
      { confirmText: "Confirmar geração", danger: true }
    );
    if (!ok) return;
  }

  const templateId = byId("templateSelect").value;
  const backgroundSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";
  const batchSize = parseInt(byId("batchSize").value, 10) || 1;
  const maxCalls = byId("maxCalls").value.trim();
  const maxCostUsd = byId("maxCostUsd").value.trim();
  const model = byId("modelInput").value;
  const quality = byId("qualitySelect").value;
  const size = byId("sizeSelect").value;

  const courses = state.items
    .filter((i) => state.selected.has(i.slug))
    .map((i) => ({ course_id: i.course_id || i.record_id || i.slug, slug: i.slug }));

  setStatus("status", "loading", dryRun ? "Criando lote de teste..." : "Criando lote de produção...");

  try {
    const create = await api.json("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collection_id: state.collectionId,
        courses,
        template_id: templateId,
        background_source: backgroundSource,
        batch_size: batchSize,
        max_calls: maxCalls ? parseInt(maxCalls, 10) : null,
        max_cost_usd: maxCostUsd ? parseFloat(maxCostUsd) : null,
        model,
        quality,
        size,
        dryRun,
      }),
    });

    state.jobId = create.job.id;
    const start = await api.json(`/api/batches/${encodeURIComponent(state.jobId)}/start`, { method: "POST" });
    state.job = start.job;
    state.reviewSelected.clear();
    goStep("review");
    startPolling();
  } catch (err) {
    handleApiError(err, "status");
  }
}

// ============================================================
// Step: Review
// ============================================================

async function loadJob() {
  state.job = await api.json(`/api/batches/${encodeURIComponent(state.jobId)}`);
}

function startPolling() {
  stopPolling();
  refreshReview();
  state.pollTimer = setInterval(refreshReview, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function refreshReview() {
  try {
    await loadJob();
    renderReview();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function getCatalogUrl(slug, file) {
  if (state.collectionId && state.collectionId !== LEGACY_ID) {
    return `/api/catalog/${encodeURIComponent(state.collectionId)}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
  }
  return `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

function renderReview() {
  const job = state.job;
  const stats = job?.stats || {};
  byId("reviewStats").innerHTML = `
    <div class="stat"><strong>${stats.total || 0}</strong> total</div>
    <div class="stat"><strong>${stats.completed || 0}</strong> concluídos</div>
    <div class="stat"><strong>${stats.approved || 0}</strong> aprovados</div>
    <div class="stat"><strong>${stats.rejected || 0}</strong> rejeitados</div>
    <div class="stat"><strong>${stats.errors || 0}</strong> erros</div>
    <div class="stat"><strong>${stats.calls || 0}</strong> chamadas</div>
    <div class="stat"><strong>${formatCurrency(stats.cost_usd)}</strong> custo</div>
    <div class="stat"><span class="badge ${statusClass(job?.status)}">${formatStatus(job?.status)}</span></div>
  `;

  const running = job?.status === "executando";
  const hasApproved = (job?.stats?.approved || 0) > 0;
  byId("btnApproveSelected").disabled = state.reviewSelected.size === 0;
  byId("btnRejectSelected").disabled = state.reviewSelected.size === 0;
  byId("btnDownloadCards").disabled = !hasApproved || running;
  byId("btnDownloadWhatsApp").disabled = !hasApproved || running;
  byId("btnDownloadPackage").disabled = !hasApproved || running;
  byId("btnExportXlsx").textContent = exportButtonLabel();
  byId("btnSyncXlsx").textContent = syncButtonLabel();
  byId("btnSyncXlsx").disabled = !isLegacyXlsx() && sourceType() !== "xlsx";

  const container = byId("reviewItems");
  container.innerHTML = "";

  const courses = job?.courses || [];
  if (courses.length === 0) {
    container.innerHTML = "<p class='hint'>Nenhum item no lote.</p>";
    return;
  }

  for (const item of courses) {
    const record = state.items.find((i) => i.slug === item.slug);
    const title = record ? getItemTitle(record) : item.slug;
    const hasBackground = item.hasBackground || false;
    const hasCard = item.hasCard || false;
    const hasWhatsApp = item.hasWhatsApp || false;
    const hasError = item.status === "erro";
    const isReviewable = ["pronto_revisao", "gerando_whatsapp"].includes(item.status);

    const div = document.createElement("div");
    div.className = "review-item";
    const placeholderText = (type) => {
      if (hasError) return `${type} não gerado`;
      if (item.status === "pendente") return "Aguardando processamento";
      return "Card não gerado";
    };
    div.innerHTML = `
      <div class="review-item-header">
        <input type="checkbox" class="review-select" data-slug="${escapeHtml(item.slug)}" ${state.reviewSelected.has(item.slug) ? "checked" : ""}>
        <h4>${escapeHtml(title)}</h4>
        <span class="badge ${statusClass(item.status)}">${formatStatus(item.status)}</span>
        ${item.error ? `<span class="hint">${escapeHtml(item.error)}</span>` : ""}
        <span class="spacer"></span>
        <div class="review-item-actions">
          ${hasCard ? `<button class="btn-secondary download-png" data-slug="${escapeHtml(item.slug)}">PNG</button>` : ""}
          ${hasWhatsApp ? `<button class="btn-secondary download-wa" data-slug="${escapeHtml(item.slug)}">WhatsApp</button>` : ""}
          ${isReviewable && hasCard
            ? `<button class="btn-success approve-item" data-slug="${escapeHtml(item.slug)}">Aprovar</button>
               <button class="btn-danger reject-item" data-slug="${escapeHtml(item.slug)}">Rejeitar</button>`
            : ""}
          ${isReviewable && !hasCard
            ? `<button class="btn-success approve-item" data-slug="${escapeHtml(item.slug)}" disabled title="Card ainda não foi gerado">Aprovar</button>
               <button class="btn-danger reject-item" data-slug="${escapeHtml(item.slug)}">Rejeitar</button>`
            : ""}
          ${hasError || item.status === "rejeitado"
            ? `<button class="btn-secondary retry-item" data-slug="${escapeHtml(item.slug)}">Gerar novamente</button>`
            : ""}
        </div>
      </div>
      <div class="review-comparison">
        <div class="review-column">
          <h5>Card atual</h5>
          <div class="thumb">
            ${record?.current_card_url
              ? `<img src="${escapeHtml(record.current_card_url)}" alt="Card atual">`
              : `<div class="missing">Sem card atual</div>`}
          </div>
        </div>
        <div class="review-column">
          <h5>Fundo novo</h5>
          <div class="thumb">
            ${hasBackground
              ? `<img src="${getCatalogUrl(item.slug, `${item.slug}-fundo.png`)}" alt="Novo fundo">`
              : `<div class="missing">${placeholderText("Fundo")}</div>`}
          </div>
        </div>
        <div class="review-column">
          <h5>Card novo</h5>
          <div class="thumb">
            ${hasCard
              ? `<img src="${getCatalogUrl(item.slug, `${item.slug}-card.png`)}" alt="Novo card">`
              : `<div class="missing">${placeholderText("Card")}</div>`}
          </div>
        </div>
        <div class="review-column">
          <h5>WhatsApp</h5>
          <div class="thumb">
            ${hasWhatsApp
              ? `<img src="${getCatalogUrl(item.slug, `${item.slug}-whatsapp.jpg`)}" alt="WhatsApp">`
              : `<div class="missing">${placeholderText("WhatsApp")}</div>`}
          </div>
        </div>
      </div>
    `;
    container.appendChild(div);
  }

  document.querySelectorAll(".review-select").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.reviewSelected.add(cb.dataset.slug);
      else state.reviewSelected.delete(cb.dataset.slug);
      renderReview();
    });
  });

  document.querySelectorAll(".approve-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "approve")));
  document.querySelectorAll(".reject-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "reject")));
  document.querySelectorAll(".retry-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "regenerate")));
  document.querySelectorAll(".download-png").forEach((btn) => btn.addEventListener("click", () => downloadItem(btn.dataset.slug, "card")));
  document.querySelectorAll(".download-wa").forEach((btn) => btn.addEventListener("click", () => downloadItem(btn.dataset.slug, "whatsapp")));

  if (running) {
    setStatus("status", "loading", `Produção em andamento · ${stats.completed}/${stats.total}`);
  } else {
    setStatus("status", "ready", "Produção concluída.");
  }
}

async function itemAction(slug, action) {
  if (!state.jobId) return;
  const url = `/api/batches/${encodeURIComponent(state.jobId)}/items/${encodeURIComponent(slug)}/${action}`;
  setStatus("status", "loading", "Atualizando item...");
  try {
    await api.json(url, { method: "POST" });
    setStatus("status", "success", "Item atualizado.");
    await refreshReview();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function bulkAction(action) {
  if (state.reviewSelected.size === 0 || !state.jobId) return;
  const label = action === "approve" ? "aprovar" : "rejeitar";
  const ok = await confirmModal(`${state.reviewSelected.size} item(s) serão ${label}(s). Continuar?`, { danger: action === "reject" });
  if (!ok) return;

  setStatus("status", "loading", "Atualizando itens...");
  try {
    for (const slug of state.reviewSelected) {
      await api.json(`/api/batches/${encodeURIComponent(state.jobId)}/items/${encodeURIComponent(slug)}/${action}`, { method: "POST" });
    }
    state.reviewSelected.clear();
    setStatus("status", "success", "Itens atualizados.");
    await refreshReview();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function downloadItem(slug, type) {
  const file = type === "whatsapp" ? `${slug}-whatsapp.jpg` : `${slug}-card.png`;
  const url = getCatalogUrl(slug, file);
  const filename = file;
  setStatus("status", "loading", "Preparando download...");
  try {
    await downloadUrl(url, filename);
    setStatus("status", "success", "Download iniciado.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function downloadBatchZip(options, defaultFilename) {
  if (!state.jobId) return;
  const url = `/api/batches/${encodeURIComponent(state.jobId)}/download`;
  setStatus("status", "loading", "Preparando ZIP...");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "Erro desconhecido");
      let message = text;
      try { message = JSON.parse(text).error || message; } catch {}
      throw new Error(`${res.status}: ${message}`);
    }

    const blob = await res.blob();
    const reportHeader = res.headers.get("X-Download-Report");
    let report = { included: [], missing: [] };
    if (reportHeader) {
      try { report = JSON.parse(decodeURIComponent(reportHeader)); } catch {}
    }

    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || defaultFilename;

    downloadBlob(blob, filename);
    const included = report.included?.length || 0;
    const missing = report.missing?.length || 0;
    setStatus(
      "status",
      missing > 0 ? "warning" : "success",
      `Download iniciado: ${included} arquivo(s) incluído(s).${missing > 0 ? ` ${missing} ausente(s) (ver missing.txt).` : ""}`
    );
  } catch (err) {
    handleApiError(err, "status");
  }
}

function isLegacyXlsx() {
  return state.collectionId === LEGACY_ID;
}

function sourceType() {
  return state.collection?.sourceType;
}

function exportButtonLabel() {
  if (isLegacyXlsx()) return "Exportar planilha";
  const type = sourceType();
  if (type === "csv") return "Exportar CSV";
  if (type === "json") return "Exportar JSON";
  if (type === "xlsx") return "Exportar planilha";
  return "Exportar";
}

function syncButtonLabel() {
  const type = sourceType();
  if (type === "csv") return "Exportar CSV atualizado";
  if (type === "json") return "Exportar JSON atualizado";
  return "Sincronizar fonte";
}

async function exportSource() {
  setStatus("status", "loading", "Exportando...");
  try {
    let result;
    if (isLegacyXlsx()) {
      result = await api.json("/api/xlsx/export", { method: "POST" });
    } else {
      result = await api.json(`/api/collections/${encodeURIComponent(state.collectionId)}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }
    setStatus("status", "success", `Exportado para ${result.outputPath || result.path || "output/exports"}.`);
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function syncSource() {
  if (!isLegacyXlsx() && sourceType() !== "xlsx") {
    setStatus("status", "warning", "Sincronização in-place só está disponível para XLSX. Use exportar.");
    return;
  }

  const ok = await confirmModal("Isso atualizará a planilha fonte com os itens aprovados. Um backup será feito antes. Continuar?", { danger: true });
  if (!ok) return;
  setStatus("status", "loading", "Sincronizando planilha...");
  try {
    let result;
    if (isLegacyXlsx()) {
      result = await api.json("/api/xlsx/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      setStatus("status", "success", `${result.report?.summary?.wouldChange || 0} alterações sincronizadas.`);
    } else {
      result = await api.json(`/api/collections/${encodeURIComponent(state.collectionId)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      setStatus("status", "success", `${result.report?.summary?.wouldChange || 0} alterações sincronizadas.`);
    }
  } catch (err) {
    handleApiError(err, "status");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
