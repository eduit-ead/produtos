const state = {
  collections: [],
  templates: [],
  assets: [],
  baseStats: {},
  activeTab: "bases",
};

async function init() {
  registerNav("biblioteca");
  initTabs();

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tab");
  if (requested && ["bases", "templates", "assets"].includes(requested)) {
    switchTab(requested);
  }

  await loadAll();

  byId("btnNewTemplate").addEventListener("click", () => {
    window.open("/editor.html", "_blank");
  });

  byId("assetUpload").addEventListener("change", handleAssetUpload);
  byId("assetSearch").addEventListener("input", renderAssets);
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((el) => el.classList.toggle("active", el.id === `tab-${tab}`));
}

async function loadAll() {
  try {
    const [collections, templates, assets] = await Promise.all([
      api.json("/api/collections"),
      api.json("/api/templates"),
      api.json("/api/assets"),
    ]);
    state.collections = collections;
    state.templates = templates;
    state.assets = assets;
    await loadBaseStats();
    renderBases();
    renderTemplates();
    renderAssets();
    setStatus("status", "ready", `${collections.length} bases · ${templates.length} templates · ${assets.length} assets`);
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function loadBaseStats() {
  state.baseStats = {};
  for (const c of state.collections) {
    try {
      const records = await api.json(`/api/collections/${encodeURIComponent(c.id)}/records`);
      state.baseStats[c.id] = records.length;
    } catch {
      state.baseStats[c.id] = "—";
    }
  }
}

function renderBases() {
  const container = byId("basesList");
  byId("basesCount").textContent = `${state.collections.length} base(s)`;

  if (state.collections.length === 0) {
    showEmpty(container, "Nenhuma base", "Importe uma planilha, CSV ou JSON para começar.", {
      label: "Importar base",
      onClick: () => (window.location.href = "/importar.html"),
    });
    return;
  }

  container.innerHTML = "";
  for (const c of state.collections) {
    const card = document.createElement("div");
    card.className = "card base-card";

    const status = c.archived ? "Arquivada" : "Ativa";
    const statusClassName = c.archived ? "badge-neutral" : "badge-success";

    card.innerHTML = `
      <div class="meta"><span class="badge ${statusClassName}">${status}</span> · ${escapeHtml(c.sourceType?.toUpperCase() || "—")}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <p class="description">${escapeHtml(c.description || "Sem descrição.")}</p>
      <div class="meta">
        ${state.baseStats[c.id] ?? "—"} itens · template ${escapeHtml(c.defaultTemplateId || "—")} · atualizado ${formatDate(c.updatedAt)}
      </div>
      <div class="actions">
        <a class="btn-primary" href="/batch.html?collection=${encodeURIComponent(c.id)}">Produzir imagens</a>
        <a class="btn-secondary" href="/biblioteca.html?tab=bases&base=${encodeURIComponent(c.id)}">Ver itens</a>
        <div class="spacer"></div>
        <div class="menu">
          <button type="button" class="menu-btn btn-ghost" data-id="${escapeHtml(c.id)}">⋮</button>
          <div class="menu-body" id="menu-${escapeHtml(c.id)}">
            <button type="button" class="btn-ghost duplicate-base" data-id="${escapeHtml(c.id)}">Duplicar configuração</button>
            <button type="button" class="btn-ghost archive-base" data-id="${escapeHtml(c.id)}">${c.archived ? "Reativar" : "Arquivar"}</button>
            <button type="button" class="btn-ghost export-base" data-id="${escapeHtml(c.id)}">Exportar configuração</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  }

  document.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const menu = byId(`menu-${id}`).parentElement;
      document.querySelectorAll(".menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
      menu.classList.toggle("open");
    });
  });

  document.querySelectorAll(".duplicate-base").forEach((btn) => btn.addEventListener("click", () => duplicateBase(btn.dataset.id)));
  document.querySelectorAll(".archive-base").forEach((btn) => btn.addEventListener("click", () => archiveBase(btn.dataset.id)));
  document.querySelectorAll(".export-base").forEach((btn) => btn.addEventListener("click", () => exportBase(btn.dataset.id)));
}

async function duplicateBase(id) {
  setStatus("status", "loading", "Duplicando...");
  try {
    const original = await api.json(`/api/collections/${encodeURIComponent(id)}`);
    const newId = `${original.id}-copia-${Date.now()}`;
    const copy = { ...original, id: newId, name: `${original.name} (cópia)`, archived: false };
    await api.json("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(copy),
    });
    setStatus("status", "success", `Base duplicada como ${newId}.`);
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function archiveBase(id) {
  setStatus("status", "loading", "Atualizando...");
  try {
    await api.json(`/api/collections/${encodeURIComponent(id)}/archive`, { method: "POST" });
    setStatus("status", "success", "Status atualizado.");
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function exportBase(id) {
  try {
    const collection = await api.json(`/api/collections/${encodeURIComponent(id)}`);
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${collection.id}.json`);
  } catch (err) {
    handleApiError(err, "status");
  }
}

function renderTemplates() {
  const container = byId("templatesList");
  if (state.templates.length === 0) {
    showEmpty(container, "Nenhum template", "Crie um template pelo editor avançado.");
    return;
  }

  container.innerHTML = "";
  for (const t of state.templates) {
    const card = document.createElement("div");
    card.className = "card template-card";
    card.innerHTML = `
      <div class="thumb" style="aspect-ratio:1/1;background:var(--surface-2);display:grid;place-items:center">
        <span class="placeholder">${escapeHtml(t.id)}</span>
      </div>
      <div>
        <h3>${escapeHtml(t.name || t.id)}</h3>
        <div class="meta">${t.canvas?.width || 0}×${t.canvas?.height || 0} px · ${(t.variables || []).length} variáveis</div>
      </div>
      <div class="actions">
        <a class="btn-primary" href="/criar.html?template=${encodeURIComponent(t.id)}">Usar</a>
        <button type="button" class="btn-secondary duplicate-template" data-id="${escapeHtml(t.id)}">Duplicar</button>
        <a class="btn-ghost" href="/editor.html?template=${encodeURIComponent(t.id)}" target="_blank">Editar</a>
      </div>
    `;
    container.appendChild(card);
  }

  document.querySelectorAll(".duplicate-template").forEach((btn) => btn.addEventListener("click", () => duplicateTemplate(btn.dataset.id)));
}

async function duplicateTemplate(id) {
  setStatus("status", "loading", "Duplicando template...");
  try {
    const tpl = await api.json(`/api/templates/${encodeURIComponent(id)}`);
    const newId = `${tpl.id}-copia-${Date.now()}`;
    tpl.id = newId;
    tpl.name = `${tpl.name || tpl.id} (cópia)`;
    await api.json(`/api/templates/${encodeURIComponent(newId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tpl),
    });
    setStatus("status", "success", "Template duplicado.");
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function renderAssets() {
  const container = byId("assetsList");
  const q = (byId("assetSearch").value || "").toLowerCase();
  const filtered = q ? state.assets.filter((a) => a.assetId.toLowerCase().includes(q)) : state.assets;

  if (filtered.length === 0) {
    container.innerHTML = `<p class="hint">Nenhum asset encontrado.</p>`;
    return;
  }

  container.innerHTML = "";
  for (const a of filtered) {
    const card = document.createElement("div");
    card.className = "card asset-card";
    card.innerHTML = `
      <div class="thumb"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.assetId)}" loading="lazy"></div>
      <div class="name">${escapeHtml(a.assetId)}</div>
      <div class="meta">${formatBytes(a.size)}</div>
    `;
    container.appendChild(card);
  }
}

async function handleAssetUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("status", "loading", "Enviando asset...");
  try {
    const data = new FormData();
    data.append("file", file);
    await api.json("/api/upload", { method: "POST", body: data });
    setStatus("status", "success", "Asset enviado.");
    e.target.value = "";
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu")) {
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
