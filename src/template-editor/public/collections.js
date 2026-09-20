const state = {
  collections: [],
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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setStatus(type, message) {
  const el = byId("status");
  el.className = `status ${type}`;
  el.textContent = message;
}

async function loadCollections() {
  try {
    state.collections = await apiJson("/api/collections");
    renderCollections();
    setStatus("ready", `${state.collections.length} coleção(ões) carregada(s)`);
  } catch (err) {
    setStatus("error", `Erro ao carregar coleções: ${err.message}`);
  }
}

function renderCollections() {
  const list = byId("collectionsList");
  list.innerHTML = "";
  if (state.collections.length === 0) {
    list.innerHTML = "<p class='empty'>Nenhuma coleção configurada.</p>";
    return;
  }
  for (const c of state.collections) {
    const card = document.createElement("div");
    card.className = "collection-card";
    card.innerHTML = `
      <h3>${escapeHtml(c.name)}</h3>
      <div class="meta">${escapeHtml(c.id)} · ${escapeHtml(c.sourceType || "-")}</div>
      <p>${escapeHtml(c.description || "")}</p>
      <div class="actions">
        <a class="primary" href="/batch.html?collection=${encodeURIComponent(c.id)}">Produzir</a>
      </div>
    `;
    list.appendChild(card);
  }
}

async function handleImport(e) {
  e.preventDefault();
  const id = byId("importId").value.trim();
  const name = byId("importName").value.trim();
  const fileInput = byId("importFile");
  if (!id || !name || !fileInput.files.length) return;

  setStatus("loading", "Enviando arquivo...");
  try {
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    const upload = await apiJson(`/api/collections/${encodeURIComponent(id)}/import`, {
      method: "POST",
      body: formData,
    });

    const ext = upload.filename.split(".").pop().toLowerCase();
    const config = {
      id,
      name,
      description: `Coleção importada de ${upload.filename}.`,
      source: {
        type: ext === "xlsx" ? "xlsx" : ext,
        path: upload.path,
        sheet: ext === "xlsx" ? "Planilha1" : undefined,
      },
      primaryKey: "id",
      displayField: "nome",
      searchFields: ["nome"],
      fieldMappings: { title: "nome", slug: "id", prompt: "prompt", sourceImage: "imagem" },
      filters: [],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
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
        { templateVariable: "titulo", sourceField: "nome" },
      ],
    };

    await apiJson("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    setStatus("ready", `Coleção "${name}" importada. Ajuste mapeamentos em data/collections/${id}.json.`);
    byId("importForm").reset();
    await loadCollections();
  } catch (err) {
    setStatus("error", `Erro na importação: ${err.message}`);
  }
}

function init() {
  byId("importForm").addEventListener("submit", handleImport);
  loadCollections();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
