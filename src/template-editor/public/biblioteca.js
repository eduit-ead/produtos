const state = {
  collections: [],
  templates: [],
  assets: [],
  finished: { items: [], total: 0, page: 1, limit: 12 },
  baseStats: {},
  activeTab: "finished",
  showArchived: false,
  viewItemsId: null,
  viewItemsRecords: null,
  editCollectionId: null,
};

async function init() {
  registerNav("biblioteca");
  initTabs();

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tab");
  if (requested && ["finished", "bases", "templates", "assets"].includes(requested)) {
    switchTab(requested);
  }
  const baseParam = params.get("base");
  if (baseParam) {
    state.viewItemsId = baseParam;
  }

  await loadAll();

  byId("btnNewTemplate").addEventListener("click", () => {
    window.open("/editor.html", "_blank");
  });

  byId("assetUpload").addEventListener("change", handleAssetUpload);
  byId("assetSearch").addEventListener("input", renderAssets);

  byId("finishedSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFinished(); });
  byId("btnFinishedFilter").addEventListener("click", loadFinished);
  byId("finishedTemplateFilter").addEventListener("change", loadFinished);
  byId("finishedSourceFilter").addEventListener("change", loadFinished);
  byId("finishedFrom").addEventListener("change", loadFinished);
  byId("finishedTo").addEventListener("change", loadFinished);
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
  if (tab === "finished") renderFinished();
  if (tab === "bases") renderBases();
  if (tab === "templates") renderTemplates();
  if (tab === "assets") renderAssets();
}

async function loadAll() {
  try {
    const [collections, templates, assets] = await Promise.all([
      api.json("/api/collections?archived=all"),
      api.json("/api/templates"),
      api.json("/api/assets"),
    ]);
    state.collections = collections;
    state.templates = templates;
    state.assets = assets;
    populateFinishedTemplateFilter();
    await Promise.all([loadFinished(), loadBaseStats()]);
    renderBases();
    renderTemplates();
    renderAssets();
    if (state.activeTab === "finished") renderFinished();
    setStatus("status", "ready", `${collections.length} bases · ${templates.length} templates · ${assets.length} assets · ${state.finished.total} peças finalizadas`);

    if (state.viewItemsId) {
      openItemsModal(state.viewItemsId);
    }
  } catch (err) {
    handleApiError(err, "status");
  }
}

function populateFinishedTemplateFilter() {
  const select = byId("finishedTemplateFilter");
  if (!select) return;
  select.innerHTML = `<option value="">Todos os templates</option>` +
    state.templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join("");
}

async function loadFinished(page = state.finished.page) {
  try {
    const q = byId("finishedSearch").value.trim();
    const templateId = byId("finishedTemplateFilter").value;
    const source = byId("finishedSourceFilter").value;
    const from = byId("finishedFrom").value;
    const to = byId("finishedTo").value;
    const params = new URLSearchParams({ page: String(page), limit: String(state.finished.limit) });
    if (q) params.set("q", q);
    if (templateId) params.set("templateId", templateId);
    if (source) params.set("source", source);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const result = await api.json(`/api/finished-pieces?${params.toString()}`);
    state.finished = { ...state.finished, ...result, page };
    if (state.activeTab === "finished") renderFinished();
    byId("finishedCount").textContent = `${state.finished.total} peça(s) finalizada(s)`;
  } catch (err) {
    handleApiError(err, "status");
  }
}

function publishButtonLabel(piece) {
  if (!piece.publication) return "Publicar";
  if (piece.publication.finishedPieceId === piece.id) return "Copiar link público";
  return "Substituir imagem publicada";
}

function absolutePublicUrl(publicUrl) {
  return new URL(publicUrl, window.location.origin).href;
}

async function copyPublicLink(publicUrl) {
  const link = absolutePublicUrl(publicUrl);
  try {
    await navigator.clipboard.writeText(link);
    setStatus("status", "success", "Link público copiado.");
  } catch {
    setStatus("status", "success", `Imagem publicada. Link: ${link}`);
  }
  return link;
}

function sourceLabel(source) {
  const map = { criar: "Criar imagem", batch: "Produção em lote", migration: "Migração" };
  return map[source] || source;
}

function renderFinished() {
  const container = byId("finishedList");
  const { items, total, page, limit } = state.finished;
  if (items.length === 0) {
    container.innerHTML = `<p class="hint">Nenhuma peça finalizada encontrada.</p>`;
    byId("finishedPagination").innerHTML = "";
    return;
  }
  container.innerHTML = "";
  for (const piece of items) {
    const card = document.createElement("div");
    card.className = "card finished-card";
    card.innerHTML = `
      <div class="thumb"><img src="${escapeHtml(piece.url)}" alt="${escapeHtml(piece.title)}" loading="lazy"></div>
      <div class="name" title="${escapeHtml(piece.title)}">${escapeHtml(piece.title)}</div>
      <div class="meta">${escapeHtml(piece.templateName || piece.templateId)} · ${sourceLabel(piece.source)}</div>
      <div class="meta">${formatDate(piece.createdAt)} · ${piece.dimensions?.width || 0}×${piece.dimensions?.height || 0} px</div>
      ${piece.publication?.finishedPieceId === piece.id ? `<div class="meta"><span class="badge badge-success">Publicada</span></div>` : ""}
      <div class="actions">
        <button type="button" class="btn-secondary view-piece" data-id="${escapeHtml(piece.id)}">Visualizar</button>
        <button type="button" class="btn-primary publish-piece" data-id="${escapeHtml(piece.id)}">${publishButtonLabel(piece)}</button>
        <a class="btn-secondary" href="${escapeHtml(piece.url)}?download=1" download="${escapeHtml((piece.title || piece.id).replace(/[^\w.-]/g, "_"))}.png">Baixar</a>
        <a class="btn-secondary" href="/criar.html?duplicate=${encodeURIComponent(piece.id)}">Duplicar</a>
        <button type="button" class="btn-danger delete-piece" data-id="${escapeHtml(piece.id)}">Excluir</button>
      </div>
    `;
    container.appendChild(card);
  }
  document.querySelectorAll(".view-piece").forEach((btn) => btn.addEventListener("click", () => openFinishedPieceModal(btn.dataset.id)));
  document.querySelectorAll(".publish-piece").forEach((btn) => btn.addEventListener("click", () => publishFinishedPiece(btn.dataset.id)));
  document.querySelectorAll(".delete-piece").forEach((btn) => btn.addEventListener("click", () => deleteFinishedPiece(btn.dataset.id)));
  renderFinishedPagination(total, page, limit);
}

function renderFinishedPagination(total, page, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const container = byId("finishedPagination");
  if (pages <= 1) {
    container.innerHTML = "";
    return;
  }
  let html = `<span>Página ${page} de ${pages}</span>`;
  if (page > 1) html += `<button type="button" class="btn-ghost prev-page">&larr; Anterior</button>`;
  if (page < pages) html += `<button type="button" class="btn-ghost next-page">Próxima &rarr;</button>`;
  container.innerHTML = html;
  container.querySelector(".prev-page")?.addEventListener("click", () => loadFinished(page - 1));
  container.querySelector(".next-page")?.addEventListener("click", () => loadFinished(page + 1));
}

async function openFinishedPieceModal(id) {
  try {
    setStatus("status", "loading", "Carregando peça...");
    const piece = await api.json(`/api/finished-pieces/${encodeURIComponent(id)}`);
    const body = document.createElement("div");
    body.innerHTML = `
      <p><img src="${escapeHtml(piece.url)}" alt="${escapeHtml(piece.title)}" style="width:100%;border-radius:8px"></p>
      <div class="meta">Template: ${escapeHtml(piece.templateName || piece.templateId)}</div>
      <div class="meta">Origem: ${sourceLabel(piece.source)}</div>
      <div class="meta">Finalizado em: ${formatDate(piece.createdAt)}</div>
      <div class="meta">Dimensões: ${piece.dimensions?.width || 0}×${piece.dimensions?.height || 0} px</div>
      ${piece.collectionId ? `<div class="meta">Base: ${escapeHtml(piece.collectionTitle || piece.collectionId)} · Item: ${escapeHtml(piece.itemId || "—")}</div>` : ""}
      ${piece.publication?.finishedPieceId === piece.id ? `<div class="meta"><span class="badge badge-success">Publicada</span></div>` : ""}
    `;
    const footer = [
      { label: "Fechar", className: "btn-secondary", close: true },
      { label: publishButtonLabel(piece), className: "btn-primary", close: false, onClick: () => publishFinishedPiece(piece.id) },
      { label: "Baixar", className: "btn-secondary", close: false, onClick: () => downloadBlobUrl(piece.url, `${(piece.title || piece.id).replace(/[^\w.-]/g, "_")}.png`) },
    ];
    createModal({
      title: piece.title || "Peça finalizada",
      body,
      footer,
    });
    setStatus("status", "ready", "Peça carregada.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function publishFinishedPiece(id) {
  try {
    setStatus("status", "loading", "Preparando publicação...");
    const preview = await api.json(`/api/finished-pieces/${encodeURIComponent(id)}/publish-preview`);
    if (!preview.ok) {
      setStatus("status", "warning", preview.message || "Não foi possível publicar esta peça.");
      return;
    }
    if (preview.publication && preview.publication.finishedPieceId === id) {
      await copyPublicLink(preview.publication.publicUrl);
      return;
    }
    const message = preview.publication
      ? `Substituir a imagem publicada de "${preview.recordTitle}"?\n\nPublicada agora: ${preview.publication.pieceTitle || "peça anterior"}\nNova imagem: ${preview.pieceTitle}\n\nO link público permanece o mesmo.`
      : `Publicar "${preview.pieceTitle}" no registro "${preview.recordTitle}"?\n\nSerá criado um link público permanente.`;
    const ok = await confirmModal(message, {
      confirmText: preview.publication ? "Substituir" : "Publicar",
    });
    if (!ok) {
      setStatus("status", "ready", "Publicação cancelada.");
      return;
    }
    setStatus("status", "loading", "Publicando imagem...");
    const result = await api.json(`/api/finished-pieces/${encodeURIComponent(id)}/publish`, { method: "POST" });
    await copyPublicLink(result.publication.publicUrl);
    await loadFinished(state.finished.page);
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function deleteFinishedPiece(id) {
  const piece = state.finished.items.find((p) => p.id === id);
  if (!piece) return;
  if (!confirm(`Excluir "${piece.title}" do histórico de peças finalizadas?\n\nO arquivo final será removido, mas os assets compartilhados não serão apagados.`)) return;
  try {
    setStatus("status", "loading", "Excluindo peça...");
    await api.json(`/api/finished-pieces/${encodeURIComponent(id)}`, { method: "DELETE" });
    setStatus("status", "success", "Peça excluída.");
    await loadFinished();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function downloadBlobUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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

function getSourceTypeLabel(type) {
  const map = { xlsx: "XLSX", csv: "CSV", json: "JSON" };
  return map[type] || type?.toUpperCase() || "—";
}

function renderBases() {
  const container = byId("basesList");
  const visible = state.showArchived ? state.collections : state.collections.filter((c) => !c.archived);
  byId("basesCount").textContent = `${visible.length} base(s)${state.showArchived ? " (incluindo arquivadas)" : ""}`;

  if (state.collections.length === 0) {
    container.innerHTML = "";
    showEmpty(container, "Nenhuma base", "Importe uma planilha, CSV ou JSON para começar.", {
      label: "Importar base",
      onClick: () => (window.location.href = "/importar.html"),
    });
    return;
  }

  container.innerHTML = "";
  for (const c of visible) {
    const card = document.createElement("div");
    card.className = "card base-card" + (c.archived ? " archived" : "");
    const status = c.archived ? "Arquivada" : "Ativa";
    const statusClassName = c.archived ? "badge-neutral" : "badge-success";

    card.innerHTML = `
      <div class="meta"><span class="badge ${statusClassName}">${status}</span> · ${getSourceTypeLabel(c.sourceType)}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <p class="description">${escapeHtml(c.description || "Sem descrição.")}</p>
      <div class="meta">
        ${state.baseStats[c.id] ?? "—"} itens · template ${escapeHtml(c.defaultTemplateId || "—")} · atualizado ${formatDate(c.updatedAt)}
      </div>
      <div class="actions">
        <a class="btn-primary" href="/batch.html?collection=${encodeURIComponent(c.id)}&autostart=1">Produzir imagens</a>
        <button type="button" class="btn-secondary view-items" data-id="${escapeHtml(c.id)}">Ver itens</button>
        <button type="button" class="btn-secondary publish-collection" data-id="${escapeHtml(c.id)}">Publicar imagens da coleção</button>
        <button type="button" class="btn-secondary export-collection" data-id="${escapeHtml(c.id)}">Exportar coleção</button>
        <button type="button" class="btn-secondary configure-base" data-id="${escapeHtml(c.id)}">Configurar</button>
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

  document.querySelectorAll(".view-items").forEach((btn) => btn.addEventListener("click", () => openItemsModal(btn.dataset.id)));
  document.querySelectorAll(".publish-collection").forEach((btn) => btn.addEventListener("click", () => openPublishCollection(btn.dataset.id)));
  document.querySelectorAll(".export-collection").forEach((btn) => btn.addEventListener("click", () => openExportCollection(btn.dataset.id)));
  document.querySelectorAll(".configure-base").forEach((btn) => btn.addEventListener("click", () => openConfigModal(btn.dataset.id)));
  document.querySelectorAll(".duplicate-base").forEach((btn) => btn.addEventListener("click", () => duplicateBase(btn.dataset.id)));
  document.querySelectorAll(".archive-base").forEach((btn) => btn.addEventListener("click", () => archiveBase(btn.dataset.id)));
  document.querySelectorAll(".export-base").forEach((btn) => btn.addEventListener("click", () => exportBase(btn.dataset.id)));

  // Toggle arquivadas
  if (!byId("archivedToggle")) {
    const bar = byId("basesList").previousElementSibling;
    if (bar) {
      const toggle = document.createElement("button");
      toggle.id = "archivedToggle";
      toggle.className = "btn-ghost";
      toggle.textContent = "Mostrar arquivadas";
      toggle.addEventListener("click", () => {
        state.showArchived = !state.showArchived;
        toggle.textContent = state.showArchived ? "Ocultar arquivadas" : "Mostrar arquivadas";
        renderBases();
      });
      bar.insertBefore(toggle, bar.firstChild);
    }
  }
  byId("archivedToggle").textContent = state.showArchived ? "Ocultar arquivadas" : "Mostrar arquivadas";
}

async function openItemsModal(id) {
  try {
    setStatus("status", "loading", "Carregando itens...");
    const records = await api.json(`/api/collections/${encodeURIComponent(id)}/records`);
    state.viewItemsId = id;
    state.viewItemsRecords = records;
    renderItemsModal(id, records);
    setStatus("status", "ready", `${records.length} itens carregados.`);
  } catch (err) {
    handleApiError(err, "status");
  }
}

function renderItemsModal(id, records) {
  const collection = state.collections.find((c) => c.id === id);
  const body = document.createElement("div");
  body.innerHTML = `<p class="hint">${escapeHtml(collection?.name || id)} · ${records.length} registros</p>`;

  if (records.length === 0) {
    body.innerHTML += `<p>Nenhum item nesta base.</p>`;
  } else {
    const tableWrap = document.createElement("div");
    tableWrap.className = "items-table-wrap";
    const table = document.createElement("table");
    table.className = "items-table";
    const keys = new Set(["id", "title", "slug", "sourceStatus"]);
    for (const r of records.slice(0, 10)) {
      for (const k of Object.keys(r.fields || {})) keys.add(k);
    }
    const headers = [...keys];
    table.innerHTML = `
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>
        ${records.slice(0, 50).map((r) => `
          <tr>
            ${headers.map((h) => {
              const value = h === "id" ? r.id : h === "title" ? r.title : h === "slug" ? r.slug : h === "sourceStatus" ? r.sourceStatus : (r.fields || {})[h];
              return `<td>${escapeHtml(String(value ?? "").slice(0, 80))}</td>`;
            }).join("")}
          </tr>
        `).join("")}
      </tbody>
    `;
    tableWrap.appendChild(table);
    body.appendChild(tableWrap);
    if (records.length > 50) {
      body.innerHTML += `<p class="hint">Mostrando 50 de ${records.length} registros.</p>`;
    }
  }

  createModal({
    title: "Itens da base",
    body,
    footer: [{ label: "Fechar", className: "btn-secondary", close: true }],
  });
}

async function openConfigModal(id) {
  const collection = state.collections.find((c) => c.id === id);
  if (!collection) return;

  const allFields = await api.json(`/api/collections/${encodeURIComponent(id)}/fields`).catch(() => []);

  const body = document.createElement("div");
  body.innerHTML = `
    <div class="field-group">
      <label>Nome</label>
      <input type="text" id="cfg-name" value="${escapeHtml(collection.name)}">
    </div>
    <div class="field-group">
      <label>Descrição</label>
      <textarea id="cfg-description">${escapeHtml(collection.description || "")}</textarea>
    </div>
    <div class="field-group">
      <label>Identificador único (primaryKey)</label>
      <select id="cfg-primaryKey">${allFields.map((f) => `<option value="${escapeHtml(f)}" ${f === collection.primaryKey ? "selected" : ""}>${escapeHtml(f)}</option>`).join("")}</select>
    </div>
    <div class="field-group">
      <label>Título principal (displayField)</label>
      <select id="cfg-displayField">${allFields.map((f) => `<option value="${escapeHtml(f)}" ${f === collection.displayField ? "selected" : ""}>${escapeHtml(f)}</option>`).join("")}</select>
    </div>
    <div class="field-group">
      <label>Template padrão</label>
      <select id="cfg-template">${state.templates.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === collection.defaultTemplateId ? "selected" : ""}>${escapeHtml(t.name || t.id)}</option>`).join("")}</select>
    </div>
    <div class="field-group">
      <label>Padrão do nome do arquivo</label>
      <input type="text" id="cfg-filenamePattern" value="${escapeHtml(collection.filenamePattern)}">
      <div class="hint">Use {{slug}} para o identificador.</div>
    </div>
  `;

  createModal({
    title: `Configurar: ${collection.name}`,
    body,
    footer: [
      { label: "Cancelar", className: "btn-secondary", close: true },
      { label: "Salvar", className: "btn-primary", close: false, onClick: () => saveCollectionConfig(id) },
    ],
  });
}

async function saveCollectionConfig(id) {
  const collection = state.collections.find((c) => c.id === id);
  if (!collection) return;
  const updated = {
    ...collection,
    name: byId("cfg-name").value.trim(),
    description: byId("cfg-description").value.trim(),
    primaryKey: byId("cfg-primaryKey").value,
    displayField: byId("cfg-displayField").value,
    defaultTemplateId: byId("cfg-template").value,
    templateIds: [byId("cfg-template").value],
    filenamePattern: byId("cfg-filenamePattern").value.trim() || "{{slug}}",
  };
  setStatus("status", "loading", "Salvando configuração...");
  try {
    await api.json(`/api/collections/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setStatus("status", "success", "Configuração salva.");
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function duplicateBase(id) {
  setStatus("status", "loading", "Duplicando...");
  try {
    const result = await api.json(`/api/collections/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
    setStatus("status", "success", `Base duplicada como ${result.collection.id}.`);
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function archiveBase(id) {
  setStatus("status", "loading", "Atualizando...");
  try {
    const c = state.collections.find((x) => x.id === id);
    await api.json(`/api/collections/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !c?.archived }),
    });
    setStatus("status", "success", "Status atualizado.");
    await loadAll();
  } catch (err) {
    handleApiError(err, "status");
  }
}

function listPreview(items, empty) {
  if (!items.length) return `<p class="meta">${empty}</p>`;
  const shown = items.slice(0, 8).map((item) => `<li>${escapeHtml(item.title || item.itemId)}</li>`).join("");
  const extra = items.length > 8 ? `<li>e mais ${items.length - 8}</li>` : "";
  return `<ul>${shown}${extra}</ul>`;
}

function choiceFields(items, name) {
  return items.map((item) => {
    const options = item.pieces.map((piece) => (
      `<option value="${escapeHtml(piece.id)}">${escapeHtml(piece.title || piece.id)}</option>`
    )).join("");
    return `<label class="meta">${escapeHtml(item.title)}<select data-choice="${escapeHtml(item.itemId)}" data-choice-group="${name}"><option value="">Escolher peça</option>${options}</select></label>`;
  }).join("");
}

function readChoices(root, group) {
  const choices = {};
  root.querySelectorAll(`select[data-choice-group="${group}"]`).forEach((select) => {
    if (select.value) choices[select.dataset.choice] = select.value;
  });
  return choices;
}

async function openPublishCollection(id) {
  setStatus("status", "loading", "Preparando publicação...");
  try {
    const preview = await api.json(`/api/collections/${encodeURIComponent(id)}/publish-preview`);
    clearStatus("status");
    const body = document.createElement("div");
    body.innerHTML = `
      <p>${preview.ready.length} com peça finalizada vinculada. ${preview.published.length} já publicados. ${preview.missing.length} sem peça finalizada. ${preview.choices.length} com mais de uma peça elegível.</p>
      <h4>Prontos para publicar</h4>
      ${listPreview(preview.ready, "Nenhum curso pendente.")}
      <h4>Já publicados</h4>
      ${listPreview(preview.published, "Nenhum curso publicado.")}
      <h4>Sem peça finalizada</h4>
      ${listPreview(preview.missing, "Todos os cursos têm peça ou exigem escolha.")}
      <h4>Escolha necessária</h4>
      ${preview.choices.length ? choiceFields(preview.choices, "pending") : "<p class=\"meta\">Nenhum curso com mais de uma peça.</p>"}
      ${preview.published.some((item) => item.pieces.length > 1) ? `<h4>Substituir: escolha a peça</h4>${choiceFields(preview.published.filter((item) => item.pieces.length > 1), "replace")}` : ""}
    `;
    const overlay = createModal({
      title: "Publicar imagens da coleção",
      body,
      footer: [
        { label: "Fechar", className: "btn-secondary" },
        {
          label: "Publicar pendentes",
          className: "btn-primary",
          close: false,
          onClick: async () => {
            const choices = readChoices(body, "pending");
            const confirmed = await confirmModal(
              "Publicar somente os cursos ainda sem imagem pública? Imagens já publicadas permanecem.",
              { confirmText: "Publicar" }
            );
            if (!confirmed) return;
            await runCollectionPublish(id, { confirm: true, replace: false, choices }, overlay);
          },
        },
        {
          label: "Substituir imagens já publicadas",
          className: "btn-danger",
          close: false,
          onClick: async () => {
            const confirmed = await confirmModal(
              "Substituir as imagens já publicadas pelas peças escolhidas? A URL pública de cada curso permanece a mesma.",
              { confirmText: "Substituir", danger: true }
            );
            if (!confirmed) return;
            await runCollectionPublish(id, {
              confirm: true,
              replace: true,
              confirmReplace: true,
              choices: readChoices(body, "replace"),
            }, overlay);
          },
        },
      ],
    });
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function runCollectionPublish(id, payload, overlay) {
  setStatus("status", "loading", "Publicando...");
  try {
    const result = await api.json(`/api/collections/${encodeURIComponent(id)}/publish-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (overlay) overlay.remove();
    setStatus(
      "status",
      result.errors.length ? "error" : "success",
      `Publicados: ${result.published}. Substituídos: ${result.replaced}. Já publicados: ${result.alreadyPublished}. Sem peça: ${result.missing}. Aguardando escolha: ${result.needsChoice}. Erros: ${result.errors.length}.`
    );
  } catch (err) {
    handleApiError(err, "status");
  }
}

function openExportCollection(id) {
  const body = document.createElement("div");
  body.innerHTML = "<p>A exportação inclui todos os cursos da coleção, com ou sem imagem publicada.</p>";
  createModal({
    title: "Exportar coleção",
    body,
    footer: [
      { label: "Fechar", className: "btn-secondary" },
      { label: "XLSX", className: "btn-primary", close: false, onClick: () => downloadCollection(id, "xlsx") },
      { label: "CSV", className: "btn-primary", close: false, onClick: () => downloadCollection(id, "csv") },
    ],
  });
}

async function downloadCollection(id, format) {
  setStatus("status", "loading", "Exportando...");
  try {
    const response = await fetch(`/api/collections/${encodeURIComponent(id)}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Erro ao exportar a coleção.");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    downloadBlob(blob, match ? match[1] : `${id}-colecao.${format}`);
    setStatus("status", "success", "Coleção exportada.");
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function exportBase(id) {
  try {
    const response = await fetch(`/api/collections/${encodeURIComponent(id)}/export-config`);
    if (!response.ok) throw new Error("Erro ao exportar");
    const blob = await response.blob();
    downloadBlob(blob, `${id}.json`);
  } catch (err) {
    handleApiError(err, "status");
  }
}

async function renderTemplates() {
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

    (async () => {
      try {
        const full = await api.json(`/api/templates/${encodeURIComponent(t.id)}`);
        const values = {};
        for (const v of full.variables || []) {
          values[v.key] = v.defaultValue !== undefined ? v.defaultValue : (v.type === "boolean" ? false : "");
        }
        const blob = await api.blob("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: full, values }),
        });
        const url = URL.createObjectURL(blob);
        const thumb = card.querySelector(".thumb");
        thumb.innerHTML = `<img src="${url}" alt="${escapeHtml(t.name || t.id)}">`;
      } catch (err) {
        // mantém placeholder
      }
    })();
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
