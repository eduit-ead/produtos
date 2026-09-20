/**
 * Painel de Produção em Lote genérico.
 * Suporta múltiplas coleções e templates.
 */

const state = {
  collections: [],
  templates: [],
  collectionId: null,
  collection: null,
  courses: [],
  selected: new Set(),
  filters: { query: "" },
  filterDefs: [],
  currentJobId: null,
  pollInterval: null,
  loading: false,
  error: null,
};

function byId(id) {
  return document.getElementById(id);
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text().catch(() => "Erro desconhecido");
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || JSON.stringify(parsed);
    } catch {}
    throw new Error(`${res.status}: ${message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function setStatus(type, message) {
  const el = byId("status");
  if (!el) return;
  el.className = `status ${type}`;
  el.textContent = message;
}

function formatStatus(status) {
  const map = {
    pendente: "Pendente",
    gerando_fundo: "Gerando fundo",
    fundo_gerado: "Fundo gerado",
    renderizando_card: "Renderizando card",
    gerando_whatsapp: "Gerando WhatsApp",
    pronto_revisao: "Pronto para revisão",
    aprovado: "Aprovado",
    rejeitado: "Rejeitado",
    erro: "Erro",
    cancelado: "Cancelado",
  };
  return map[status] || status;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function initials(text) {
  if (!text) return "?";
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function getItemTitle(item) {
  return item.title || item.curso || item.slug || "Sem título";
}

function getFilterFields() {
  if (state.collection?.filters?.length > 0) {
    return state.collection.filters.map((f) => f.field);
  }
  return ["modalidade", "formacao", "conteudo_status"];
}

function matchesFilters(item) {
  const q = state.filters.query.trim().toLowerCase();
  const title = getItemTitle(item);
  const matchesQuery = !q || title.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q);
  if (!matchesQuery) return false;
  for (const field of getFilterFields()) {
    const value = state.filters[field] || "";
    if (!value) continue;
    if ((item[field] || item.fields?.[field] || "") !== value) return false;
  }
  return true;
}

function filteredCourses() {
  return state.courses.filter(matchesFilters);
}

function populateFilters() {
  const fields = getFilterFields();
  const container = byId("filtersBar");
  if (!container) return;

  // Limpa selects dinâmicos antigos, mantendo busca e botões.
  const keep = ["searchInput", "btnSelectAll", "btnClearSelection"];
  for (const child of Array.from(container.children)) {
    if (!keep.includes(child.id)) child.remove();
  }

  for (const field of fields) {
    const label = state.collection?.filters?.find((f) => f.field === field)?.label || field;
    const values = new Set(state.courses.map((c) => c[field] || c.fields?.[field]).filter(Boolean));
    const select = document.createElement("select");
    select.id = `filter-${field}`;
    select.innerHTML =
      `<option value="">Todas(os) ${escapeHtml(label)}</option>` +
      [...values].sort().map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    select.value = state.filters[field] || "";
    select.addEventListener("change", (e) => {
      state.filters[field] = e.target.value;
      renderCatalog();
    });
    container.insertBefore(select, byId("btnSelectAll"));
  }
}

function renderSkeletonGrid(count = 20) {
  const grid = byId("courseGrid");
  grid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    card.innerHTML = `
      <div class="skeleton-thumb"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>
    `;
    grid.appendChild(card);
  }
}

function renderGridError(message) {
  const grid = byId("courseGrid");
  grid.innerHTML = "";
  const msg = byId("gridMessage");
  msg.className = "grid-message error";
  msg.innerHTML = `
    <p>${escapeHtml(message)}</p>
    <button id="btnRetryLoad" class="secondary" style="margin-top:12px">Tentar novamente</button>
  `;
  msg.classList.remove("hidden");
  byId("btnRetryLoad").addEventListener("click", loadCatalog);
}

function hideGridMessage() {
  const msg = byId("gridMessage");
  msg.className = "grid-message hidden";
  msg.innerHTML = "";
}

function thumbnailUrl(item) {
  return item.current_card_url || item.ai_card_url || item.current_background_url || item.ai_background_url || null;
}

function metaText(item) {
  if (item.modalidade || item.formacao || item.duracao) {
    return [item.modalidade, item.formacao, item.duracao].filter(Boolean).join(" · ");
  }
  const fields = state.collection?.filters?.map((f) => item.fields?.[f.field]).filter(Boolean) || [];
  if (fields.length > 0) return fields.join(" · ");
  return item.slug;
}

function renderCatalog() {
  const grid = byId("courseGrid");
  grid.innerHTML = "";
  hideGridMessage();

  if (state.loading) {
    renderSkeletonGrid(20);
    return;
  }

  if (state.error) {
    renderGridError(state.error);
    return;
  }

  const list = filteredCourses();
  byId("summaryFiltered").textContent = list.length;

  if (list.length === 0) {
    grid.innerHTML = "<p class='grid-message'>Nenhum item encontrado.</p>";
    return;
  }

  for (const c of list) {
    const card = document.createElement("div");
    card.className = "course-card" + (state.selected.has(c.slug) ? " selected" : "");
    card.dataset.slug = c.slug;

    const selectWrap = document.createElement("div");
    selectWrap.className = "select-wrap";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(c.slug);
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", (e) => toggleSelection(c.slug, e.target.checked));
    selectWrap.appendChild(checkbox);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const url = thumbnailUrl(c);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = getItemTitle(c);
      img.loading = "lazy";
      img.addEventListener("error", () => {
        thumb.innerHTML = "";
        thumb.appendChild(placeholderThumb(getItemTitle(c)));
      });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(placeholderThumb(getItemTitle(c)));
    }

    const overlay = document.createElement("div");
    overlay.className = "card-overlay";
    overlay.innerHTML = `
      <h3>${escapeHtml(getItemTitle(c))}</h3>
      <div class="meta">${escapeHtml(metaText(c))}</div>
      <span class="status status-${c.status}">${formatStatus(c.status)}</span>
    `;

    card.appendChild(selectWrap);
    card.appendChild(thumb);
    card.appendChild(overlay);
    card.addEventListener("click", () => {
      const checked = !state.selected.has(c.slug);
      toggleSelection(c.slug, checked);
      checkbox.checked = checked;
    });

    grid.appendChild(card);
  }
}

function placeholderThumb(name) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML = `<div class="initial">${escapeHtml(initials(name))}</div>`;
  return div;
}

function updateSummary() {
  byId("summaryTotal").textContent = state.courses.length;
  byId("summarySelected").textContent = state.selected.size;
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const count = state.selected.size;
  const text = count === 0 ? "Nenhum item selecionado" : `${count} item(s) selecionado(s)`;
  byId("summarySelected").textContent = count;
  byId("selectionSummary").textContent = text;
  byId("btnCreateBatch").disabled = count === 0;

  const bar = byId("selectionBar");
  const barText = byId("selectionBarText");
  if (count === 0) {
    bar.classList.add("hidden");
  } else {
    bar.classList.remove("hidden");
    barText.textContent = `${count} selecionado(s)`;
  }
  updateEstimate();
}

function updateEstimate() {
  const selectedCount = state.selected.size;
  const dryRun = byId("dryRun").checked;
  const maxCallsInput = byId("maxCalls").value.trim();
  const costPerCall = 0.03;
  const calls = dryRun
    ? 0
    : maxCallsInput
    ? Math.min(parseInt(maxCallsInput, 10) || 0, selectedCount)
    : selectedCount;
  const cost = dryRun ? 0 : calls * costPerCall;
  byId("estimate").textContent = `${selectedCount} item(s) · até ${calls} chamada(s) · estimativa US$ ${cost.toFixed(2)}`;
}

async function loadCollections() {
  try {
    state.collections = await apiJson("/api/collections");
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("collection");
    const found =
      state.collections.find((c) => c.id === requested) ||
      state.collections.find((c) => c.id === "graduacao-cruzeiro") ||
      state.collections[0];

    const select = byId("collectionSelect");
    select.innerHTML = state.collections
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join("");
    select.value = found?.id || "";
    select.addEventListener("change", () => selectCollection(select.value));
    await selectCollection(select.value);
  } catch (err) {
    state.error = err.message;
    renderCatalog();
    updateSummary();
  }
}

async function loadTemplates() {
  try {
    state.templates = await apiJson("/api/templates");
    const select = byId("templateSelect");
    select.innerHTML = state.templates
      .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`)
      .join("");
    select.addEventListener("change", updateEstimate);
  } catch (err) {
    console.error("Erro ao carregar templates:", err);
  }
}

async function selectCollection(id) {
  state.collectionId = id;
  state.collection = state.collections.find((c) => c.id === id) || null;
  if (state.collection?.defaultTemplateId) {
    byId("templateSelect").value = state.collection.defaultTemplateId;
  }
  state.filters = { query: "" };
  state.selected.clear();
  await loadCatalog();
}

async function loadCatalog() {
  state.loading = true;
  state.error = null;
  renderCatalog();
  try {
    state.courses = await apiJson(`/api/items?collection=${encodeURIComponent(state.collectionId || "graduacao-cruzeiro")}`);
    state.loading = false;
    populateFilters();
    renderCatalog();
    updateSummary();
  } catch (err) {
    state.loading = false;
    state.error = err.message;
    renderCatalog();
    updateSummary();
  }
}

async function loadBatches() {
  try {
    const batches = await apiJson("/api/batches");
    const list = byId("batchList");
    list.innerHTML = "";
    if (batches.length === 0) {
      list.innerHTML = "<p class='grid-message'>Nenhum lote criado.</p>";
      return;
    }
    for (const b of batches.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "batch-row";
      const collectionName = state.collections.find((c) => c.id === b.collectionId)?.name || b.collectionId || "padrão";
      row.innerHTML = `
        <div class="batch-id">${escapeHtml(b.id)}</div>
        <div class="batch-meta">
          ${escapeHtml(formatStatus(b.status))} · ${b.courses?.length || 0} itens · ${escapeHtml(collectionName)}
          ${b.dryRun ? "· dry-run" : ""}
        </div>
      `;
      row.addEventListener("click", () => openBatch(b.id));
      list.appendChild(row);
    }
  } catch (err) {
    byId("batchList").innerHTML = `<p class='grid-message error'>Erro ao listar lotes: ${escapeHtml(err.message)}</p>`;
  }
}

function toggleSelection(slug, checked) {
  if (checked) state.selected.add(slug);
  else state.selected.delete(slug);
  renderCatalog();
  updateSelectionSummary();
}

async function createBatch() {
  const selectedCourses = state.courses.filter((c) => state.selected.has(c.slug));
  if (selectedCourses.length === 0) return;

  const dryRun = byId("dryRun").checked;
  const maxCalls = byId("maxCalls").value.trim();
  const maxCostUsd = byId("maxCostUsd").value.trim();

  const body = {
    collection_id: state.collectionId || "graduacao-cruzeiro",
    courses: selectedCourses.map((c) => ({ course_id: c.course_id || c.record_id || c.slug, slug: c.slug })),
    template_id: byId("templateSelect").value.trim() || state.collection?.defaultTemplateId || "demo",
    background_source: byId("backgroundSource").value,
    batch_size: parseInt(byId("batchSize").value, 10) || 1,
    max_calls: maxCalls ? parseInt(maxCalls, 10) : null,
    max_cost_usd: maxCostUsd ? parseFloat(maxCostUsd) : null,
    model: byId("model").value.trim(),
    quality: byId("quality").value,
    size: byId("size").value,
    dryRun,
  };

  setStatus("loading", "Criando lote...");
  try {
    const result = await apiJson("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.selected.clear();
    updateSummary();
    renderCatalog();
    await loadBatches();
    openBatch(result.job.id);
  } catch (err) {
    setStatus("error", `Erro ao criar lote: ${err.message}`);
  }
}

function showCatalog() {
  stopPolling();
  state.currentJobId = null;
  byId("batchStage").classList.add("hidden");
  byId("batchPage").classList.remove("hidden");
  loadCatalog();
  loadBatches();
}

function openBatch(jobId) {
  state.currentJobId = jobId;
  byId("batchPage").classList.add("hidden");
  byId("batchStage").classList.remove("hidden");
  byId("batchTitle").textContent = jobId;
  startPolling();
}

async function refreshBatch() {
  if (!state.currentJobId) return;
  try {
    const job = await apiJson(`/api/batches/${state.currentJobId}`);
    renderBatch(job);
  } catch (err) {
    setStatus("error", `Erro ao carregar lote: ${err.message}`);
  }
}

function startPolling() {
  stopPolling();
  refreshBatch();
  state.pollInterval = setInterval(refreshBatch, 2000);
}

function stopPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

function renderBatch(job) {
  byId("batchStatusBadge").textContent = formatStatus(job.status);
  byId("batchStatusBadge").className = `status-badge status-${job.status}`;

  const stats = job.stats || {};
  const total = job.courses?.length || 0;
  const completed = stats.completed || 0;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  byId("batchProgressText").textContent = `${completed} / ${total}`;
  byId("progressFill").style.width = `${progress}%`;

  byId("statCompleted").textContent = completed;
  byId("statErrors").textContent = stats.errors || 0;
  byId("statApproved").textContent = stats.approved || 0;
  byId("statRejected").textContent = stats.rejected || 0;
  byId("statCalls").textContent = stats.calls || 0;
  byId("statCost").textContent = (stats.cost_usd || 0).toFixed(2);

  const running = job.status === "executando";
  const createdOrPaused = job.status === "criado" || job.status === "pausado";
  const final = ["concluido", "concluido_com_erros", "cancelado", "bloqueado"].includes(job.status);
  byId("btnStart").disabled = !createdOrPaused;
  byId("btnResume").disabled = !createdOrPaused;
  byId("btnPause").disabled = !running;
  byId("btnCancel").disabled = final;
  byId("btnRetryErrors").disabled = running;
  byId("btnRetryRejected").disabled = running;

  renderItems(job);
}

function catalogFileUrl(item, file) {
  if (item.ai_background_url) {
    const url = new URL(item.ai_background_url, window.location.origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 4) {
      return `/api/catalog/${encodeURIComponent(parts[2])}/${encodeURIComponent(item.slug)}/${encodeURIComponent(file)}`;
    }
    return `/api/catalog/${encodeURIComponent(item.slug)}/${encodeURIComponent(file)}`;
  }
  return `/api/catalog/${encodeURIComponent(item.slug)}/${encodeURIComponent(file)}`;
}

function renderItems(job) {
  const list = byId("itemsList");
  list.innerHTML = "";
  const courses = job.courses || [];
  if (courses.length === 0) {
    list.innerHTML = "<p class='grid-message'>Nenhum item no lote.</p>";
    return;
  }

  for (const item of courses) {
    const card = document.createElement("div");
    card.className = "item-card";
    const course = state.courses.find((c) => c.slug === item.slug);
    const name = course ? getItemTitle(course) : item.slug;

    const header = document.createElement("div");
    header.className = "item-header";
    header.innerHTML = `
      <span class="item-name">${escapeHtml(name)}</span>
      <span class="item-status status-${item.status}">${formatStatus(item.status)}</span>
    `;
    card.appendChild(header);

    if (item.error) {
      const err = document.createElement("div");
      err.className = "item-error";
      err.textContent = item.error;
      card.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const hasBackground = ["fundo_gerado", "renderizando_card", "gerando_whatsapp", "pronto_revisao", "aprovado", "rejeitado"].includes(item.status);
    const hasCard = ["pronto_revisao", "aprovado", "rejeitado", "gerando_whatsapp"].includes(item.status);

    if (hasBackground) {
      actions.appendChild(linkButton("Fundo", catalogFileUrl(course || item, `${item.slug}-fundo.png`)));
    }
    if (hasCard) {
      actions.appendChild(linkButton("Card", catalogFileUrl(course || item, `${item.slug}-card.png`)));
      actions.appendChild(linkButton("WhatsApp", catalogFileUrl(course || item, `${item.slug}-whatsapp.jpg`)));
    }
    if (item.status === "pronto_revisao" || item.status === "gerando_whatsapp") {
      actions.appendChild(actionButton("Aprovar", () => approveItem(item.slug), "success"));
      actions.appendChild(actionButton("Rejeitar", () => rejectItem(item.slug), "danger"));
    }

    if (actions.children.length === 0) {
      actions.innerHTML = `<span style="font-size:12px;color:#64748b">Aguardando processamento</span>`;
    }

    card.appendChild(actions);
    list.appendChild(card);
  }
}

function linkButton(label, url) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.textContent = label;
  a.className = "secondary button-link";
  return a;
}

function actionButton(label, onClick, cls) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.className = cls || "secondary";
  btn.addEventListener("click", onClick);
  return btn;
}

async function batchAction(method, pathSuffix, confirmMsg) {
  if (!state.currentJobId) return;
  if (confirmMsg && !window.confirm(confirmMsg)) return;
  setStatus("loading", "Aguarde...");
  try {
    const result = await apiJson(`/api/batches/${state.currentJobId}/${pathSuffix}`, { method });
    renderBatch(result.job || result);
    setStatus("ready", "Ação concluída");
  } catch (err) {
    setStatus("error", `Erro: ${err.message}`);
  }
}

async function approveItem(slug) {
  if (!window.confirm(`Aprovar card de "${slug}"?`)) return;
  await apiJson(`/api/items/${encodeURIComponent(slug)}/approve?collection=${encodeURIComponent(state.collectionId || "graduacao-cruzeiro")}`, { method: "POST" });
  await refreshBatch();
}

async function rejectItem(slug) {
  if (!window.confirm(`Rejeitar card de "${slug}"?`)) return;
  await apiJson(`/api/items/${encodeURIComponent(slug)}/reject?collection=${encodeURIComponent(state.collectionId || "graduacao-cruzeiro")}`, { method: "POST" });
  await refreshBatch();
}

async function dryRunSync() {
  setStatus("loading", "Analisando sincronização...");
  try {
    const result = await apiJson("/api/xlsx/sync-preview", { method: "POST" });
    const report = result.report;
    const msg = `Dry-run: ${report.summary.wouldChange} alterações, ${report.summary.skipped} ignorados, ${report.summary.notFound} não encontrados.`;
    setStatus(report.summary.wouldChange > 0 ? "loading" : "ready", msg);
  } catch (err) {
    setStatus("error", `Erro no dry-run: ${err.message}`);
  }
}

async function syncSpreadsheet() {
  if (!window.confirm("Sincronizar a planilha input/cursos.xlsx com os itens aprovados? Será feito backup antes.")) return;
  setStatus("loading", "Sincronizando planilha...");
  try {
    const result = await apiJson("/api/xlsx/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const report = result.report;
    setStatus("ready", `Sincronizado: ${report.summary.wouldChange} alterações. Backup: ${result.backup || "nenhum"}`);
  } catch (err) {
    setStatus("error", `Erro ao sincronizar: ${err.message}`);
  }
}

async function exportSpreadsheet() {
  setStatus("loading", "Exportando planilha...");
  try {
    const result = await apiJson("/api/xlsx/export", { method: "POST" });
    setStatus("ready", `Exportado para: ${result.outputPath || "output/ai-catalog/cursos-export.xlsx"}`);
  } catch (err) {
    setStatus("error", `Erro ao exportar: ${err.message}`);
  }
}

async function init() {
  byId("searchInput").addEventListener("input", (e) => {
    state.filters.query = e.target.value;
    renderCatalog();
  });

  byId("btnSelectAll").addEventListener("click", () => {
    for (const c of filteredCourses()) state.selected.add(c.slug);
    renderCatalog();
    updateSelectionSummary();
  });
  byId("btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    renderCatalog();
    updateSelectionSummary();
  });
  byId("btnBarClear").addEventListener("click", () => {
    state.selected.clear();
    renderCatalog();
    updateSelectionSummary();
  });

  byId("btnCreateBatch").addEventListener("click", createBatch);
  byId("dryRun").addEventListener("change", updateEstimate);
  byId("maxCalls").addEventListener("input", updateEstimate);
  byId("maxCostUsd").addEventListener("input", updateEstimate);
  byId("batchSize").addEventListener("input", updateEstimate);

  byId("btnBackToCatalog").addEventListener("click", showCatalog);
  byId("btnStart").addEventListener("click", () => batchAction("POST", "start"));
  byId("btnPause").addEventListener("click", () => batchAction("POST", "pause"));
  byId("btnResume").addEventListener("click", () => batchAction("POST", "resume"));
  byId("btnCancel").addEventListener("click", () => batchAction("POST", "cancel", "Cancelar este lote?"));
  byId("btnRetryErrors").addEventListener("click", () => batchAction("POST", "retry-errors", "Reprocessar itens com erro?"));
  byId("btnRetryRejected").addEventListener("click", () => batchAction("POST", "retry-rejected", "Reprocessar itens rejeitados?"));

  byId("btnDryRunSync").addEventListener("click", dryRunSync);
  byId("btnSync").addEventListener("click", syncSpreadsheet);
  byId("btnExport").addEventListener("click", exportSpreadsheet);

  await loadTemplates();
  await loadCollections();
  loadBatches();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
