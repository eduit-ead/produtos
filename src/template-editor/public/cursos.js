/**
 * Painel de Produção de Cursos.
 * Catálogo, busca, filtros e detalhe individual.
 */

const state = {
  courses: [],
  currentCourse: null,
  filters: { query: "", modalidade: "", formacao: "", status: "" },
  objectUrls: [],
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
  el.className = `status ${type}`;
  el.textContent = message;
}

function registerObjectUrl(url) {
  if (url && url.startsWith("blob:")) {
    state.objectUrls.push(url);
  }
}

function revokeObjectUrls() {
  for (const url of state.objectUrls) {
    URL.revokeObjectURL(url);
  }
  state.objectUrls = [];
}

function showImage(imgId, url) {
  const img = byId(imgId);
  if (!url) {
    img.src = "";
    img.classList.add("hidden");
    return;
  }
  img.src = url;
  img.classList.remove("hidden");
}

async function loadCatalog() {
  setStatus("loading", "Carregando catálogo...");
  try {
    state.courses = await apiJson("/api/courses");
    populateFilters();
    renderCatalog();
    setStatus("ready", `${state.courses.length} cursos carregados`);
  } catch (err) {
    setStatus("error", `Erro: ${err.message}`);
  }
}

function populateFilters() {
  const modalidades = new Set(state.courses.map((c) => c.modalidade).filter(Boolean));
  const formacoes = new Set(state.courses.map((c) => c.formacao).filter(Boolean));

  const modSelect = byId("filterModalidade");
  const formSelect = byId("filterFormacao");

  modSelect.innerHTML = `<option value="">Todas as modalidades</option>` +
    [...modalidades].sort().map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  formSelect.innerHTML = `<option value="">Todas as formações</option>` +
    [...formacoes].sort().map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
}

function matchesFilters(course) {
  const q = state.filters.query.trim().toLowerCase();
  const matchesQuery = !q || course.curso.toLowerCase().includes(q) || course.slug.toLowerCase().includes(q);
  const matchesModalidade = !state.filters.modalidade || course.modalidade === state.filters.modalidade;
  const matchesFormacao = !state.filters.formacao || course.formacao === state.filters.formacao;
  const matchesStatus = !state.filters.status || course.status === state.filters.status;
  return matchesQuery && matchesModalidade && matchesFormacao && matchesStatus;
}

function renderCatalog() {
  const grid = byId("courseGrid");
  grid.innerHTML = "";

  const filtered = state.courses.filter(matchesFilters);
  if (filtered.length === 0) {
    grid.innerHTML = "<p>Nenhum curso encontrado.</p>";
    return;
  }

  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "course-card";

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

    const btn = document.createElement("button");
    btn.textContent = "Abrir curso";
    btn.addEventListener("click", () => openCourse(c.slug));

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(btn);
    grid.appendChild(card);
  }
}

function formatStatus(status) {
  const map = {
    pendente: "Pendente",
    gerando: "Gerando",
    gerado: "Gerado",
    aprovado: "Aprovado",
    rejeitado: "Rejeitado",
    erro: "Erro",
  };
  return map[status] || status;
}

async function openCourse(slug) {
  setStatus("loading", "Carregando curso...");
  try {
    state.currentCourse = await apiJson(`/api/courses/${slug}`);
    revokeObjectUrls();
    renderDetail();
    byId("catalogStage").classList.add("hidden");
    byId("detailStage").classList.remove("hidden");
    setStatus("ready", "Pronto");
  } catch (err) {
    setStatus("error", `Erro: ${err.message}`);
  }
}

function backToCatalog() {
  revokeObjectUrls();
  state.currentCourse = null;
  byId("detailStage").classList.add("hidden");
  byId("catalogStage").classList.remove("hidden");
  loadCatalog();
}

function renderDetail() {
  const c = state.currentCourse;
  byId("courseTitle").textContent = c.curso;
  byId("courseInfo").innerHTML = `
    <strong>Slug:</strong> ${escapeHtml(c.slug)}<br>
    <strong>Modalidade:</strong> ${escapeHtml(c.modalidade)}<br>
    <strong>Formação:</strong> ${escapeHtml(c.formacao)}<br>
    <strong>Duração:</strong> ${escapeHtml(c.duracao)}<br>
    <strong>Status:</strong> ${formatStatus(c.status)}<br>
    <strong>Conteúdo:</strong> ${escapeHtml(c.conteudo_status || "—")}
  `;
  byId("promptInput").value = c.prompt_imagem;

  showImage("currentCardImg", c.current_card_url);
  showImage("currentBgImg", c.current_background_url);
  showImage("aiBgImg", c.ai_background_url || c.ai_upload_url);
  showImage("aiCardImg", c.ai_card_url);
}

async function withLoading(label, fn) {
  setStatus("loading", `${label}...`);
  try {
    const result = await fn();
    setStatus("ready", `${label} concluído`);
    return result;
  } catch (err) {
    setStatus("error", `${label} falhou: ${err.message}`);
    throw err;
  }
}

async function generateBackground() {
  if (!state.currentCourse) return;
  await withLoading("Gerando fundo", () =>
    apiJson(`/api/courses/${state.currentCourse.slug}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    })
  );
  await openCourse(state.currentCourse.slug);
}

async function uploadBackground(file) {
  if (!state.currentCourse || !file) return;
  const data = new FormData();
  data.append("file", file);
  await withLoading("Enviando fundo", () =>
    apiJson(`/api/courses/${state.currentCourse.slug}/upload`, { method: "POST", body: data })
  );
  await openCourse(state.currentCourse.slug);
}

async function renderCard() {
  if (!state.currentCourse) return;
  await withLoading("Renderizando card", () =>
    apiJson(`/api/courses/${state.currentCourse.slug}/render`, { method: "POST" })
  );
  await openCourse(state.currentCourse.slug);
}

async function approve() {
  if (!state.currentCourse) return;
  await withLoading("Aprovando", () =>
    apiJson(`/api/courses/${state.currentCourse.slug}/approve`, { method: "POST" })
  );
  await openCourse(state.currentCourse.slug);
}

async function reject() {
  if (!state.currentCourse) return;
  await withLoading("Rejeitando", () =>
    apiJson(`/api/courses/${state.currentCourse.slug}/reject`, { method: "POST" })
  );
  await openCourse(state.currentCourse.slug);
}

async function downloadPng() {
  if (!state.currentCourse) return;
  const url = state.currentCourse.ai_card_url || state.currentCourse.current_card_url;
  if (!url) {
    setStatus("error", "Nenhum card disponível para download.");
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    registerObjectUrl(objectUrl);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${state.currentCourse.slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("ready", "PNG baixado");
  } catch (err) {
    setStatus("error", `Erro no download: ${err.message}`);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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

  byId("btnBack").addEventListener("click", backToCatalog);
  byId("btnGenerate").addEventListener("click", generateBackground);
  byId("uploadInput").addEventListener("change", (e) => uploadBackground(e.target.files[0]));
  byId("btnRender").addEventListener("click", renderCard);
  byId("btnApprove").addEventListener("click", approve);
  byId("btnReject").addEventListener("click", reject);
  byId("btnDownload").addEventListener("click", downloadPng);

  loadCatalog();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
