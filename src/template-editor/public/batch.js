/**
 * Painel de Produção em Lote.
 * Seleção, criação, acompanhamento e exportação de lotes.
 */

const state = {
  courses: [],
  selected: new Set(),
  filters: { query: "", modalidade: "", formacao: "", status: "" },
  currentJobId: null,
  pollInterval: null,
};

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

function matchesFilters(course) {
  const q = state.filters.query.trim().toLowerCase();
  const matchesQuery = !q || course.curso.toLowerCase().includes(q) || course.slug.toLowerCase().includes(q);
  const matchesModalidade = !state.filters.modalidade || course.modalidade === state.filters.modalidade;
  const matchesFormacao = !state.filters.formacao || course.formacao === state.filters.formacao;
  const matchesStatus = !state.filters.status || course.status === state.filters.status;
  return matchesQuery && matchesModalidade && matchesFormacao && matchesStatus;
}

function filteredCourses() {
  return state.courses.filter(matchesFilters);
}

function populateFilters() {
  const modalidades = new Set(state.courses.map((c) => c.modalidade).filter(Boolean));
  const formacoes = new Set(state.courses.map((c) => c.formacao).filter(Boolean));

  byId("filterModalidade").innerHTML = `<option value="">Todas as modalidades</option>` +
    [...modalidades].sort().map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  byId("filterFormacao").innerHTML = `<option value="">Todas as formações</option>` +
    [...formacoes].sort().map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
}

function renderCatalog() {
  const grid = byId("courseGrid");
  grid.innerHTML = "";
  const list = filteredCourses();
  byId("summaryFiltered").textContent = list.length;

  if (list.length === 0) {
    grid.innerHTML = "<p class='empty-msg'>Nenhum curso encontrado.</p>";
    return;
  }

  for (const c of list) {
    const card = document.createElement("div");
    card.className = "course-card";

    const selectWrap = document.createElement("div");
    selectWrap.className = "select-wrap";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(c.slug);
    checkbox.addEventListener("change", () => toggleSelection(c.slug, checkbox.checked));
    selectWrap.appendChild(checkbox);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (c.current_card_url) {
      const img = document.createElement("img");
      img.src = c.current_card_url;
      img.alt = c.curso;
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = "<span class='placeholder'>Sem imagem</span>";
    }

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <h3>${escapeHtml(c.curso)}</h3>
      <div class="meta">${escapeHtml(c.modalidade)} · ${escapeHtml(c.formacao)} · ${escapeHtml(c.duracao)}</div>
      <span class="status status-${c.status}">${formatStatus(c.status)}</span>
    `;

    card.appendChild(selectWrap);
    card.appendChild(thumb);
    card.appendChild(info);
    grid.appendChild(card);
  }
}

function updateSummary() {
  byId("summaryTotal").textContent = state.courses.length;
  byId("summarySelected").textContent = state.selected.size;
}

function toggleSelection(slug, checked) {
  if (checked) state.selected.add(slug);
  else state.selected.delete(slug);
  updateSummary();
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const selectedCourses = state.courses.filter((c) => state.selected.has(c.slug));
  const el = byId("selectionSummary");
  if (selectedCourses.length === 0) {
    el.textContent = "Nenhum curso selecionado";
    byId("btnCreateBatch").disabled = true;
  } else {
    el.textContent = `${selectedCourses.length} curso(s) selecionado(s)`;
    byId("btnCreateBatch").disabled = false;
  }
  updateEstimate();
}

function updateEstimate() {
  const selectedCount = state.selected.size;
  const dryRun = byId("dryRun").checked;
  const calls = dryRun ? 0 : selectedCount;
  // Custo aproximado por chamada: ~0.03 USD para 1024x1024 (ajustar conforme pricing real).
  const costPerCall = 0.03;
  const cost = dryRun ? 0 : selectedCount * costPerCall;
  byId("estimate").textContent = `Estimativa: ${calls} chamada(s) · USD ${cost.toFixed(2)}`;
}

async function loadCatalog() {
  setStatus("loading", "Carregando catálogo...");
  try {
    state.courses = await apiJson("/api/courses");
    populateFilters();
    renderCatalog();
    updateSummary();
    setStatus("ready", `${state.courses.length} cursos carregados`);
  } catch (err) {
    setStatus("error", `Erro: ${err.message}`);
  }
}

async function loadBatches() {
  try {
    const batches = await apiJson("/api/batches");
    const list = byId("batchList");
    list.innerHTML = "";
    if (batches.length === 0) {
      list.innerHTML = "<p class='empty-msg'>Nenhum lote criado.</p>";
      return;
    }
    for (const b of batches.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "batch-row";
      row.innerHTML = `
        <div class="batch-id">${escapeHtml(b.id)}</div>
        <div class="batch-meta">
          ${escapeHtml(b.status)} · ${b.courses?.length || 0} cursos
          ${b.dryRun ? "· dry-run" : ""}
        </div>
      `;
      row.addEventListener("click", () => openBatch(b.id));
      list.appendChild(row);
    }
  } catch (err) {
    setStatus("error", `Erro ao listar lotes: ${err.message}`);
  }
}

async function createBatch() {
  const selectedCourses = state.courses.filter((c) => state.selected.has(c.slug));
  if (selectedCourses.length === 0) return;

  const dryRun = byId("dryRun").checked;
  const maxCalls = byId("maxCalls").value.trim();
  const maxCostUsd = byId("maxCostUsd").value.trim();

  const body = {
    courses: selectedCourses.map((c) => ({ course_id: c.course_id, slug: c.slug })),
    template_id: byId("templateId").value.trim() || "cruzeiro-graduacao-v1",
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
    updateSelectionSummary();
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
  byId("catalogStage").classList.remove("hidden");
  byId("configStage").classList.remove("hidden");
  loadCatalog();
  loadBatches();
}

function openBatch(jobId) {
  state.currentJobId = jobId;
  byId("catalogStage").classList.add("hidden");
  byId("configStage").classList.add("hidden");
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
  byId("batchStatusBadge").textContent = job.status;
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

  // Botões
  const running = job.status === "executando";
  const createdOrPaused = job.status === "criado" || job.status === "pausado";
  byId("btnStart").disabled = !createdOrPaused;
  byId("btnResume").disabled = !createdOrPaused;
  byId("btnPause").disabled = !running;
  byId("btnCancel").disabled = job.status === "concluido" || job.status === "cancelado" || job.status === "bloqueado";
  byId("btnRetryErrors").disabled = running;
  byId("btnRetryRejected").disabled = running;

  renderItems(job);
}

function catalogFileUrl(slug, file) {
  return `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
}

function renderItems(job) {
  const list = byId("itemsList");
  list.innerHTML = "";
  const courses = job.courses || [];
  if (courses.length === 0) {
    list.innerHTML = "<p class='empty-msg'>Nenhum item no lote.</p>";
    return;
  }

  for (const item of courses) {
    const card = document.createElement("div");
    card.className = "item-card";
    const course = state.courses.find((c) => c.slug === item.slug);
    const name = course ? course.curso : item.slug;

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

    const files = {
      fundo: `${item.slug}-fundo.png`,
      card: `${item.slug}-card.png`,
      whatsapp: `${item.slug}-whatsapp.jpg`,
    };

    if (["pronto_revisao", "aprovado", "rejeitado", "gerando_whatsapp", "fundo_gerado", "renderizando_card"].includes(item.status)) {
      actions.appendChild(linkButton("Fundo", catalogFileUrl(item.slug, files.fundo)));
    }
    if (["pronto_revisao", "aprovado", "rejeitado", "gerando_whatsapp"].includes(item.status)) {
      actions.appendChild(linkButton("Card", catalogFileUrl(item.slug, files.card)));
      actions.appendChild(linkButton("WhatsApp", catalogFileUrl(item.slug, files.whatsapp)));
    }
    if (item.status === "pronto_revisao" || item.status === "gerando_whatsapp") {
      actions.appendChild(actionButton("Aprovar", () => approveItem(item.slug), "success"));
      actions.appendChild(actionButton("Rejeitar", () => rejectItem(item.slug), "danger"));
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
  a.className = "secondary";
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
  await apiJson(`/api/courses/${encodeURIComponent(slug)}/approve`, { method: "POST" });
  await refreshBatch();
}

async function rejectItem(slug) {
  if (!window.confirm(`Rejeitar card de "${slug}"?`)) return;
  await apiJson(`/api/courses/${encodeURIComponent(slug)}/reject`, { method: "POST" });
  await refreshBatch();
}

async function dryRunSync() {
  setStatus("loading", "Analisando sincronização...");
  try {
    const result = await apiJson("/api/xlsx/sync-preview", { method: "POST" });
    const report = result.report;
    const msg = `Dry-run: ${report.summary.wouldChange} alterações, ${report.summary.skipped} ignorados, ${report.summary.notFound} não encontrados.`;
    setStatus(report.summary.wouldChange > 0 ? "loading" : "ready", msg);
    console.log("dry-run sync", report);
  } catch (err) {
    setStatus("error", `Erro no dry-run: ${err.message}`);
  }
}

async function syncSpreadsheet() {
  if (!window.confirm("Sincronizar a planilha input/cursos.xlsx com os cursos aprovados? Será feito backup antes.")) return;
  setStatus("loading", "Sincronizando planilha...");
  try {
    const result = await apiJson("/api/xlsx/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const report = result.report;
    setStatus("ready", `Sincronizado: ${report.summary.wouldChange} alterações. Backup: ${result.backup || "nenhum"}`);
    console.log("sync", report);
  } catch (err) {
    setStatus("error", `Erro ao sincronizar: ${err.message}`);
  }
}

async function exportSpreadsheet() {
  setStatus("loading", "Exportando planilha...");
  try {
    const result = await apiJson("/api/xlsx/export", { method: "POST" });
    setStatus("ready", `Exportado para: ${result.outputPath || result.reportPath || "output/ai-catalog/cursos-export.xlsx"}`);
    console.log("export", result);
  } catch (err) {
    setStatus("error", `Erro ao exportar: ${err.message}`);
  }
}

function init() {
  byId("searchInput").addEventListener("input", (e) => {
    state.filters.query = e.target.value;
    renderCatalog();
  });
  byId("filterModalidade").addEventListener("change", (e) => {
    state.filters.modalidade = e.target.value;
    renderCatalog();
  });
  byId("filterFormacao").addEventListener("change", (e) => {
    state.filters.formacao = e.target.value;
    renderCatalog();
  });
  byId("filterStatus").addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    renderCatalog();
  });

  byId("btnSelectAll").addEventListener("click", () => {
    for (const c of filteredCourses()) state.selected.add(c.slug);
    renderCatalog();
    updateSummary();
    updateSelectionSummary();
  });
  byId("btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    renderCatalog();
    updateSummary();
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

  loadCatalog();
  loadBatches();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
