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
  itemsStatusFilter: "all",
  itemsSort: "recent",
  jobId: null,
  job: null,
  pollTimer: null,
  reviewSelected: new Set(),
  history: [],
};

const LEGACY_ID = "graduacao-cruzeiro";
const COST_PER_CALL = 0.03;
const BATCH_STATUS_LABELS = {
  sem_imagem: "Sem imagem",
  simulacao: "Simulação",
  nao_produzido: "Não produzido",
  produzindo: "Produzindo",
  aguardando_revisao: "Aguardando revisão",
  pronto_revisao: "Aguardando revisão",
  aprovado: "Aprovado",
  rejeitado: "Rejeitado",
  ignorado: "Ignorado",
  erro: "Erro",
  cancelado: "Cancelado",
  pendente: "Pendente",
  gerando_fundo: "Produzindo",
  fundo_gerado: "Produzindo",
  renderizando_card: "Produzindo",
  gerando_whatsapp: "Produzindo",
};

function uiStatus(item) {
  return item?.visual_status || "sem_imagem";
}

function hasSourceImage(item) {
  const url = item?.current_background_url || item?.image_url || item?.sourceImage || "";
  return url.trim().length > 0;
}

function hasPrompt(item) {
  const p = item?.prompt || item?.prompt_imagem || "";
  return p.trim().length > 0;
}

async function init() {
  registerNav("lote");
  setupEvents();
  await loadInitial();
  await loadSystemStatus();
  applySystemStatus();
}

function applySystemStatus() {
  const btn = byId("btnConfigReal");
  if (!btn) return;
  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";
  if (bgSource === "ia" && !isOpenAIConfigured()) {
    btn.disabled = true;
    btn.title = "Configure OPENAI_API_KEY para habilitar geração real.";
    setStatus("status", "warning", "OpenAI não configurada: geração real desabilitada. Use o modo de simulação.");
  } else {
    btn.disabled = false;
    btn.title = "";
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
    const requestedJob = params.get("job");

    if (requestedJob) {
      state.jobId = requestedJob;
      await loadJob();
      state.collectionId = state.job?.collectionId;
      state.collection = state.collections.find((c) => c.id === state.collectionId) || null;
      await loadItems();
      goStep("review");
      return;
    }

    renderBaseMode();
    goStep("base");
  } catch (err) {
    handleApiError(err, "status");
  }
}

function setupEvents() {
  byId("btnSelectFiltered").addEventListener("click", () => {
    for (const item of state.filtered) state.selected.add(item.slug);
    renderItems();
  });
  byId("btnSelectEligible").addEventListener("click", () => {
    for (const item of state.filtered) {
      if (isEligibleForConfig(item)) state.selected.add(item.slug);
    }
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
  byId("itemsStatusFilter").addEventListener("change", () => {
    state.itemsStatusFilter = byId("itemsStatusFilter").value || "all";
    renderItems();
  });
  byId("itemsSort").addEventListener("change", () => {
    state.itemsSort = byId("itemsSort").value || "recent";
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
    el.addEventListener("change", () => {
      updateEstimate();
      updateConfigButtonLabels();
      applySystemStatus();
    });
  });
  byId("templateSelect").addEventListener("change", () => {
    updateEstimate();
    updateConfigButtonLabels();
  });
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

  if (step === "base") renderBaseMode();
  if (step === "items") renderItems();
  if (step === "config") renderConfig();
  if (step === "review") renderReview();
}

function stepOrder(name) {
  return ["base", "items", "config", "review"].indexOf(name);
}

function getItemTitle(item) {
  return item.title || item.curso || item.name || item.slug;
}

// ============================================================
// Step: Base (new production / history)
// ============================================================

function renderBaseMode() {
  const modeContainer = byId("baseModeSelect");
  const historyPanel = byId("historyPanel");
  const newPanel = byId("newProductionPanel");

  modeContainer.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      const mode = card.dataset.mode;
      if (mode === "new") {
        historyPanel.classList.add("hidden");
        newPanel.classList.remove("hidden");
        renderBaseStep();
      } else {
        newPanel.classList.add("hidden");
        historyPanel.classList.remove("hidden");
        loadHistory();
      }
    });
  });

  newPanel.classList.add("hidden");
  historyPanel.classList.add("hidden");
}

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

async function loadHistory() {
  const list = byId("historyList");
  list.innerHTML = "<p class='hint'>Carregando lotes...</p>";
  try {
    state.history = await api.json("/api/batches");
    renderHistory();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function renderHistory() {
  const list = byId("historyList");
  list.innerHTML = "";
  if (!state.history.length) {
    list.innerHTML = "<p class='hint'>Nenhum lote encontrado.</p>";
    return;
  }

  for (const job of state.history) {
    const item = document.createElement("div");
    item.className = "history-item";
    const stats = job.stats || {};
    item.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(job.id)}</strong>
        <div class="hint">${escapeHtml(job.collectionId || "padrão")} · ${formatDate(job.updated_at)}</div>
        <div class="hint">
          ${stats.ready || 0} aguardando · ${stats.approved || 0} aprovados · ${stats.rejected || 0} rejeitados · ${stats.ignored || 0} ignorados · ${stats.simulation || 0} simulações · ${stats.errors || 0} erros
        </div>
      </div>
      <span class="badge ${job.type === "simulação" ? "simulacao" : "producao"}">${escapeHtml(job.type)}</span>
      <span class="badge ${statusClass(job.status)}">${escapeHtml(formatStatus(job.status))}</span>
      <button type="button" class="btn-secondary btn-small history-open" data-id="${escapeHtml(job.id)}">Revisar</button>
      <button type="button" class="btn-ghost btn-small history-archive" data-id="${escapeHtml(job.id)}" data-archived="${job.archived}">${job.archived ? "Reativar" : "Arquivar"}</button>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll(".history-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.location.href = `/batch.html?job=${encodeURIComponent(btn.dataset.id)}`;
    });
  });
  list.querySelectorAll(".history-archive").forEach((btn) => {
    btn.addEventListener("click", () => archiveJob(btn.dataset.id, btn.dataset.archived !== "true"));
  });
}

async function archiveJob(jobId, archived) {
  try {
    await api.json(`/api/batches/${encodeURIComponent(jobId)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    await loadHistory();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function selectCollection(id) {
  state.collectionId = id;
  state.collection = state.collections.find((c) => c.id === id);
  state.selected.clear();
  state.filters = {};
  state.query = "";
  state.itemsStatusFilter = "all";
  state.itemsSort = "recent";
  setStatus("status", "loading", "Carregando itens...");
  await loadItems();
  byId("searchInput").value = "";
  byId("itemsStatusFilter").value = "all";
  byId("itemsSort").value = "recent";
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
  let filtered = state.items.filter((item) => {
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

  const statusFilter = state.itemsStatusFilter;
  if (statusFilter !== "all") {
    filtered = filtered.filter((item) => {
      switch (statusFilter) {
        case "sem_imagem":
          return uiStatus(item) === "sem_imagem";
        case "com_imagem":
          return hasSourceImage(item);
        case "original":
          return uiStatus(item) === "original";
        case "aguardando_revisao":
          return uiStatus(item) === "aguardando_revisao";
        case "aprovado":
          return uiStatus(item) === "aprovado";
        case "rejeitado":
          return uiStatus(item) === "rejeitado";
        case "erro":
          return uiStatus(item) === "erro";
        default:
          return true;
      }
    });
  }

  filtered.sort((a, b) => {
    switch (state.itemsSort) {
      case "az":
        return getItemTitle(a).localeCompare(getItemTitle(b));
      case "za":
        return getItemTitle(b).localeCompare(getItemTitle(a));
      case "status":
        return uiStatus(a).localeCompare(uiStatus(b));
      case "revisao_primeiro":
        return (uiStatus(a) === "aguardando_revisao" ? -1 : 1) - (uiStatus(b) === "aguardando_revisao" ? -1 : 1);
      case "recent":
      default:
        return 0;
    }
  });

  state.filtered = filtered;
}

function isEligibleForConfig(item) {
  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";
  if (bgSource === "original") return hasSourceImage(item);
  if (bgSource === "ia") return hasPrompt(item);
  return true;
}

function renderItems() {
  applyFilters();

  const filtersContainer = byId("itemsFilters");
  filtersContainer.innerHTML = "";
  const filterDefs = state.collection?.filters || [];
  for (const def of filterDefs) {
    const values = new Set(state.items.map((i) => i.fields?.[def.field] || i[def.field]).filter(Boolean));
    const select = document.createElement("select");
    select.className = "input";
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
    const sourceOk = hasSourceImage(item);
    const status = uiStatus(item);
    const hasCandidate = item.candidate_background_url && status !== "aprovado";
    const thumbUrl = item.current_card_url || item.current_background_url || null;
    const candidateThumbUrl = hasCandidate
      ? (item.candidate_card_url || item.candidate_background_url)
      : null;
    const updatedAt = item.visual_updated_at ? formatDate(item.visual_updated_at) : "nunca";
    const sourceLabel = { studio: "estúdio", batch: "lote", upload: "upload", spreadsheet: "planilha", null: null }[item.visual_source] || null;

    let badges = `<span class="status-tag ${status}">${escapeHtml(BATCH_STATUS_LABELS[status] || status)}</span>`;
    if (status === "aprovado") badges += `<span class="source-badge">aprovada</span>`;
    else if (status === "simulacao") badges += `<span class="source-badge" style="background:rgba(124,58,237,0.9);color:#fff;">simulação</span>`;
    else if (hasCandidate) badges += `<span class="source-badge" style="background:rgba(245,158,11,0.9);color:#000;">nova imagem</span>`;

    card.innerHTML = `
      <div class="select-marker"></div>
      ${sourceOk ? `<span class="source-badge">imagem</span>` : `<span class="source-badge missing">sem imagem</span>`}
      <div class="thumb">
        ${thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy">`
          : `<span class="placeholder">${initials(getItemTitle(item))}</span>`}
        ${candidateThumbUrl
          ? `<div class="candidate-overlay"><img src="${escapeHtml(candidateThumbUrl)}" alt="Nova" loading="lazy"><span>Nova</span></div>`
          : ""}
      </div>
      <div class="info">
        <h4>${escapeHtml(getItemTitle(item))}</h4>
        <div class="meta">${escapeHtml(item.modalidade || item.formacao || item.fields?.categoria || item.fields?.Categoria || item.source_status || "")}</div>
        <div class="meta">${escapeHtml(item.fields?.modalidade || "")} ${escapeHtml(item.fields?.formacao || "")} ${escapeHtml(item.fields?.duracao || "")}</div>
        <div class="meta">atualizado: ${escapeHtml(updatedAt)}${sourceLabel ? ` · ${escapeHtml(sourceLabel)}` : ""}</div>
      </div>
      ${badges}
    `;
    card.addEventListener("click", () => {
      if (state.selected.has(item.slug)) state.selected.delete(item.slug);
      else state.selected.add(item.slug);
      renderItems();
    });
    grid.appendChild(card);
  }

  renderItemsInfo();

  const bar = byId("selectionBar");
  const count = state.selected.size;
  const eligible = state.filtered.filter(isEligibleForConfig).length;
  const ignored = state.filtered.length - eligible;
  byId("selectionText").textContent = count === 0
    ? `${eligible} elegíveis · ${ignored} serão ignorados`
    : `${count} selecionado${count === 1 ? "" : "s"} · ${eligible} elegíveis · ${ignored} ignorados`;
  bar.classList.remove("hidden");
  byId("btnItemsNext").disabled = count === 0;
}

function renderItemsInfo() {
  const box = byId("itemsInfo");
  const total = state.items.length;
  const approved = state.items.filter((i) => uiStatus(i) === "aprovado").length;
  const review = state.items.filter((i) => uiStatus(i) === "aguardando_revisao").length;
  const noImage = state.items.filter((i) => uiStatus(i) === "sem_imagem").length;
  const rejected = state.items.filter((i) => uiStatus(i) === "rejeitado").length;
  const errors = state.items.filter((i) => uiStatus(i) === "erro").length;
  box.innerHTML = `
    <strong>${total}</strong> itens ·
    <strong>${approved}</strong> aprovados ·
    <strong>${review}</strong> aguardando revisão ·
    <strong>${rejected}</strong> rejeitados ·
    <strong>${errors}</strong> erros ·
    <strong>${noImage}</strong> sem imagem
  `;
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
  updateConfigButtonLabels();
  renderPreValidation();
  applySystemStatus();
}

function updateConfigButtonLabels() {
  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";
  const dryRun = document.querySelector('input[name="dryRun"]:checked')?.value === "true";
  const testBtn = byId("btnConfigTest");
  const realBtn = byId("btnConfigReal");

  if (bgSource === "original") {
    testBtn.classList.add("hidden");
    realBtn.textContent = dryRun ? "Executar simulação" : "Produzir cards com imagens existentes";
  } else {
    testBtn.classList.remove("hidden");
    testBtn.textContent = "Executar simulação";
    realBtn.textContent = dryRun ? "Executar simulação" : "Gerar fundos e produzir cards";
  }
}

function renderPreValidation() {
  const box = byId("preValidationBox");
  const content = byId("preValidationContent");
  const selectedItems = state.items.filter((i) => state.selected.has(i.slug));
  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";

  const total = selectedItems.length;
  const withImage = selectedItems.filter(hasSourceImage).length;
  const withoutImage = total - withImage;
  const withPrompt = selectedItems.filter(hasPrompt).length;
  const withoutPrompt = total - withPrompt;
  const alreadyApproved = selectedItems.filter((i) => uiStatus(i) === "aprovado").length;

  let eligible = 0;
  let reason = "";
  if (bgSource === "original") {
    eligible = withImage;
    reason = `${withoutImage} sem imagem de origem`;
  } else {
    eligible = withPrompt;
    reason = `${withoutPrompt} sem prompt`;
  }

  const dryRun = document.querySelector('input[name="dryRun"]:checked')?.value === "true";
  const calls = dryRun ? 0 : (bgSource === "original" ? 0 : eligible);
  const cost = dryRun || bgSource === "original" ? 0 : calls * COST_PER_CALL;

  content.innerHTML = `
    <ul>
      <li><strong>${total}</strong> selecionados</li>
      <li><strong>${eligible}</strong> elegíveis · ${reason}</li>
      ${bgSource === "original" ? "" : `<li><strong>${withImage}</strong> possuem imagem de origem (não usada no modo IA)</li>`}
      ${alreadyApproved > 0 ? `<li><strong>${alreadyApproved}</strong> já aprovados</li>` : ""}
      <li><strong>${calls}</strong> chamadas à OpenAI</li>
      <li>custo estimado: <strong>${formatCurrency(cost)}</strong></li>
    </ul>
  `;
  box.classList.toggle("hidden", total === 0);
}

function updateEstimate() {
  const count = state.selected.size;
  const dryRun = document.querySelector('input[name="dryRun"]:checked')?.value === "true";
  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";
  const maxCalls = byId("maxCalls").value.trim();
  let calls = 0;
  if (!dryRun && bgSource === "ia") {
    calls = maxCalls ? Math.min(parseInt(maxCalls, 10) || 0, count) : count;
  }
  const cost = calls * COST_PER_CALL;
  const label = dryRun ? "simulação" : bgSource === "original" ? "imagens existentes" : "chamadas à OpenAI";
  byId("estimateSummary").textContent = `${count} item${count === 1 ? "" : "s"} · ${calls} ${label} · ${formatCurrency(cost)}`;
  byId("estimateHint").textContent = dryRun
    ? "Modo de teste: nenhuma chamada real é feita."
    : bgSource === "original"
      ? "As imagens da base serão reutilizadas sem chamadas à OpenAI."
      : "Geração real: as chamadas só começam após confirmação.";
  renderPreValidation();
}

async function createBatch(dryRun) {
  if (state.selected.size === 0) return;

  const bgSource = document.querySelector('input[name="bgSource"]:checked')?.value || "ia";

  if (!dryRun && bgSource === "ia" && !isOpenAIConfigured()) {
    setStatus("status", "warning", "OpenAI não configurada. Geração real desabilitada.");
    return;
  }

  if (!dryRun && bgSource === "ia") {
    const ok = await confirmModal(
      `Você está prestes a gerar imagens reais para ${state.selected.size} item(s). Isso consumirá créditos da OpenAI. Deseja continuar?`,
      { confirmText: "Confirmar geração", danger: true }
    );
    if (!ok) return;
  }

  const templateId = byId("templateSelect").value;
  const batchSize = parseInt(byId("batchSize").value, 10) || 1;
  const maxCalls = byId("maxCalls").value.trim();
  const maxCostUsd = byId("maxCostUsd").value.trim();
  const model = byId("modelInput").value;
  const quality = byId("qualitySelect").value;
  const size = byId("sizeSelect").value;

  const courses = state.items
    .filter((i) => state.selected.has(i.slug))
    .map((i) => ({ course_id: i.course_id || i.record_id || i.slug, slug: i.slug }));

  setStatus("status", "loading", dryRun ? "Criando simulação..." : "Criando lote de produção...");

  try {
    const create = await api.json("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collection_id: state.collectionId,
        courses,
        template_id: templateId,
        background_source: bgSource,
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
    <div class="stat"><strong>${stats.ready || 0}</strong> aguardando revisão</div>
    <div class="stat"><strong>${stats.approved || 0}</strong> aprovados</div>
    <div class="stat"><strong>${stats.rejected || 0}</strong> rejeitados</div>
    <div class="stat"><strong>${stats.ignored || 0}</strong> ignorados</div>
    <div class="stat"><strong>${stats.simulation || 0}</strong> simulações</div>
    <div class="stat"><strong>${stats.errors || 0}</strong> erros</div>
    <div class="stat"><strong>${stats.calls || 0}</strong> chamadas</div>
    <div class="stat"><strong>${formatCurrency(stats.cost_usd)}</strong> custo</div>
    <div class="stat"><span class="badge ${statusClass(job?.status)}">${formatStatus(job?.status)}</span></div>
  `;

  const running = job?.status === "executando";
  const hasApproved = (job?.stats?.approved || 0) > 0;
  const hasReady = (job?.stats?.ready || 0) > 0;
  byId("btnApproveSelected").disabled = state.reviewSelected.size === 0 || running;
  byId("btnRejectSelected").disabled = state.reviewSelected.size === 0 || running;
  byId("btnDownloadCards").disabled = !hasApproved || running;
  byId("btnDownloadWhatsApp").disabled = !hasApproved || running;
  byId("btnDownloadPackage").disabled = !hasApproved || running;
  byId("btnExportXlsx").textContent = exportButtonLabel();
  byId("btnSyncXlsx").textContent = syncButtonLabel();
  byId("btnSyncXlsx").disabled = !isLegacyXlsx() && sourceType() !== "xlsx";

  const sections = {
    ready: byId("reviewReady"),
    approved: byId("reviewApproved"),
    rejected: byId("reviewRejected"),
    errors: byId("reviewErrors"),
    simulation: byId("reviewSimulation"),
  };
  Object.values(sections).forEach((el) => el.innerHTML = "");

  const courses = job?.courses || [];
  const isSimulation = (item) =>
    item.status === "simulacao" || item.dryRun === true || (job?.dryRun === true && item.status === "pronto_revisao");

  const bySection = {
    ready: [],
    approved: [],
    rejected: [],
    errors: [],
    simulation: [],
  };
  for (const item of courses) {
    if (isSimulation(item)) {
      bySection.simulation.push(item);
    } else if (item.status === "pronto_revisao") {
      bySection.ready.push(item);
    } else if (item.status === "aprovado") {
      bySection.approved.push(item);
    } else if (item.status === "rejeitado") {
      bySection.rejected.push(item);
    } else if (item.status === "erro") {
      bySection.errors.push(item);
    }
  }

  for (const [key, list] of Object.entries(bySection)) {
    const container = sections[key];
    if (!container) continue;
    if (list.length === 0) {
      container.innerHTML = "<p class='hint'>Nenhum item nesta seção.</p>";
    } else {
      for (const item of list) {
        container.appendChild(buildReviewItem(item));
      }
    }
  }

  document.querySelectorAll(".review-select").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.reviewSelected.add(cb.dataset.slug);
      else state.reviewSelected.delete(cb.dataset.slug);
      renderReview();
    });
  });

  document.querySelectorAll(".review-item-title").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.href = link.getAttribute("href");
    });
  });

  document.querySelectorAll(".approve-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "approve")));
  document.querySelectorAll(".reject-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "reject")));
  document.querySelectorAll(".retry-item").forEach((btn) => btn.addEventListener("click", () => itemAction(btn.dataset.slug, "regenerate")));
  document.querySelectorAll(".download-png").forEach((btn) => btn.addEventListener("click", () => downloadItem(btn.dataset.slug, "card")));
  document.querySelectorAll(".download-wa").forEach((btn) => btn.addEventListener("click", () => downloadItem(btn.dataset.slug, "whatsapp")));

  if (running) {
    setStatus("status", "loading", `Produção em andamento · ${stats.completed || 0}/${stats.total || 0}`);
  } else {
    setStatus("status", "ready", "Produção concluída.");
  }
}

function buildReviewItem(item) {
  const record = state.items.find((i) => i.slug === item.slug);
  const title = record ? getItemTitle(record) : item.slug;
  const hasBackground = item.hasBackground || false;
  const hasCard = item.hasCard || false;
  const hasWhatsApp = item.hasWhatsApp || false;
  const hasError = item.status === "erro";
  const isSimulation =
    item.status === "simulacao" || item.dryRun === true || (state.job?.dryRun === true && item.status === "pronto_revisao");
  const isReviewable = item.status === "pronto_revisao" && !isSimulation;
  const reviewUrl = state.jobId
    ? `/cursos.html?slug=${encodeURIComponent(item.slug)}&job=${encodeURIComponent(state.jobId)}&return=batch`
    : `/cursos.html?slug=${encodeURIComponent(item.slug)}`;

  const div = document.createElement("div");
  div.className = "review-item";
  const placeholderText = (type) => {
    if (hasError) return `${type} não gerado`;
    if (item.status === "pendente") return "Aguardando processamento";
    return "Card não gerado";
  };

  let actions = "";
  if (isReviewable && hasCard) {
    actions = `
      <button class="btn-success approve-item" data-slug="${escapeHtml(item.slug)}">Aprovar</button>
      <button class="btn-danger reject-item" data-slug="${escapeHtml(item.slug)}">Rejeitar</button>
    `;
  } else if (isReviewable && !hasCard) {
    actions = `
      <button class="btn-success" disabled title="Card ainda não foi gerado">Aprovar</button>
      <button class="btn-danger reject-item" data-slug="${escapeHtml(item.slug)}">Rejeitar</button>
    `;
  }
  if (hasCard) {
    actions += `<button class="btn-secondary download-png" data-slug="${escapeHtml(item.slug)}">PNG</button>`;
  }
  if (hasWhatsApp) {
    actions += `<button class="btn-secondary download-wa" data-slug="${escapeHtml(item.slug)}">WhatsApp</button>`;
  }
  if (hasError || item.status === "rejeitado") {
    actions += `<button class="btn-secondary retry-item" data-slug="${escapeHtml(item.slug)}">Gerar novamente</button>`;
  }
  if (isSimulation) {
    actions = `<span class="hint">Simulação: não pode ser aprovada.</span>`;
  }

  const checkbox = !isSimulation && item.status !== "ignorado"
    ? `<input type="checkbox" class="review-select" data-slug="${escapeHtml(item.slug)}" ${state.reviewSelected.has(item.slug) ? "checked" : ""}>`
    : "";

  div.innerHTML = `
    <div class="review-item-header">
      ${checkbox}
      <a href="${escapeHtml(reviewUrl)}" class="review-item-title" data-slug="${escapeHtml(item.slug)}">${escapeHtml(title)}</a>
      <span class="status-pill ${uiStatus(item)}">${escapeHtml(BATCH_STATUS_LABELS[item.status] || item.status)}</span>
      ${item.error ? `<span class="hint">${escapeHtml(item.error)}</span>` : ""}
      ${item.dryRun ? `<span class="hint">dry-run</span>` : ""}
      <span class="spacer"></span>
      <div class="review-item-actions">${actions}</div>
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
  return div;
}

async function itemAction(slug, action) {
  if (!state.jobId) return;
  setStatus("status", "loading", "Atualizando item...");
  try {
    await api.json(`/api/batches/${encodeURIComponent(state.jobId)}/items/${encodeURIComponent(slug)}/${action}`, { method: "POST" });
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
  setStatus("status", "loading", "Preparando download...");
  try {
    await downloadUrl(url, file);
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
