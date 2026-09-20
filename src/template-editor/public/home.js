async function init() {
  registerNav("inicio");
  await loadDashboard();
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
    let pending = 0;
    for (const job of jobs) {
      const stats = job.stats || {};
      approved += stats.approved || 0;
      errors += stats.errors || 0;
      pending += (stats.total || 0) - (stats.approved || 0) - (stats.rejected || 0) - (stats.errors || 0);
    }
    byId("statApproved").textContent = approved;
    byId("statErrors").textContent = errors;
    byId("statPending").textContent = pending;
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
    const div = document.createElement("div");
    div.className = "recent-item";
    div.innerHTML = `
      <div>
        <div>${escapeHtml(job.id)}</div>
        <div class="meta">${formatStatus(job.status)} · ${job.courses?.length || 0} itens · ${formatDate(job.created_at)}</div>
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
