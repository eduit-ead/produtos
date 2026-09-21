async function init() {
  registerNav("inicio");
  await Promise.all([loadDashboard(), renderSystemStatusBlock()]);
}

async function renderSystemStatusBlock() {
  const container = byId("systemStatus");
  const grid = byId("systemStatusGrid");
  const hint = byId("systemStatusHint");

  try {
    const status = await api.json("/api/health");
    container.classList.remove("hidden");

    const items = [
      { label: "OpenAI", value: status.openaiConfigured ? "Configurada" : "Não configurada", ok: status.openaiConfigured, warn: !status.openaiConfigured },
      { label: "Storage", value: status.storageProvider === "local" ? "Local" : status.storageProvider, ok: status.storageHealthy },
      { label: "Autenticação", value: status.authActive ? "Ativa" : "Desativada", ok: status.authActive || !status.authActive, warn: false },
      { label: "Diretório persistente", value: status.runtimeDirAvailable ? "OK" : "Indisponível", ok: status.runtimeDirAvailable, warn: !status.runtimeDirAvailable },
    ];

    grid.innerHTML = items.map((item) => {
      const cls = item.ok ? "ok" : item.warn ? "warn" : "error";
      return `
        <div class="status-item">
          <span class="dot ${cls}"></span>
          <span class="label">${escapeHtml(item.label)}</span>
          <span class="value">${escapeHtml(item.value)}</span>
        </div>
      `;
    }).join("");

    if (!status.openaiConfigured) {
      hint.className = "status-hint warning";
      hint.textContent = "A OpenAI não está configurada. Geração real de imagens está desabilitada; use previews/dry-run ou configure OPENAI_API_KEY.";
    } else if (!status.runtimeDirAvailable) {
      hint.className = "status-hint warning";
      hint.textContent = "Diretório de dados persistente não está disponível. Verifique o volume de dados.";
    } else {
      hint.className = "status-hint info";
      hint.textContent = "Sistema pronto para uso.";
    }
  } catch (err) {
    container.classList.remove("hidden");
    grid.innerHTML = `<div class="status-item"><span class="dot error"></span><span class="label">Status</span><span class="value">Indisponível</span></div>`;
    hint.className = "status-hint warning";
    hint.textContent = "Não foi possível carregar o status do sistema.";
  }
}

async function loadDashboard() {
  try {
    const [jobs, collections] = await Promise.all([
      api.json("/api/batches").catch(() => []),
      api.json("/api/collections").catch(() => []),
    ]);

    renderRecentJobs(jobs.slice().reverse().slice(0, 5));
    renderRecentCollections(collections.slice().reverse().slice(0, 5));

    let approved = 0;
    let errors = 0;
    let pendingReview = 0;
    for (const job of jobs) {
      const stats = job.stats || {};
      approved += stats.approved || 0;
      errors += stats.errors || 0;
      pendingReview += (job.courses || []).filter((c) => c.status === "pronto_revisao").length;
    }
    byId("statApproved").textContent = approved;
    byId("statErrors").textContent = errors;
    byId("statPending").textContent = pendingReview;
  } catch (err) {
    handleApiError(err);
  }
}

function renderRecentJobs(jobs) {
  const container = byId("recentJobs");
  if (jobs.length === 0) {
    container.innerHTML = `<p class="hint">Nenhuma produção ainda.</p>`;
    return;
  }
  container.innerHTML = "";
  for (const job of jobs) {
    const pending = (job.courses || []).filter((c) => c.status === "pronto_revisao").length;
    const div = document.createElement("div");
    div.className = "recent-item";
    div.innerHTML = `
      <div>
        <div>${escapeHtml(job.id)}</div>
        <div class="meta">${formatStatus(job.status)} · ${job.courses?.length || 0} itens · ${pending} aguardando revisão · ${formatDate(job.created_at)}</div>
      </div>
      <a href="/batch.html?job=${encodeURIComponent(job.id)}">Ver</a>
    `;
    container.appendChild(div);
  }
}

function renderRecentCollections(collections) {
  const container = byId("recentCollections");
  if (collections.length === 0) {
    container.innerHTML = `<p class="hint">Nenhuma base configurada.</p>`;
    return;
  }
  container.innerHTML = "";
  for (const c of collections) {
    const div = document.createElement("div");
    div.className = "recent-item";
    div.innerHTML = `
      <div>
        <div>${escapeHtml(c.name)}</div>
        <div class="meta">${escapeHtml(c.sourceType || "—")} · atualizado ${formatDate(c.updatedAt)}</div>
      </div>
      <a href="/biblioteca.html?tab=bases&base=${encodeURIComponent(c.id)}">Ver</a>
    `;
    container.appendChild(div);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
