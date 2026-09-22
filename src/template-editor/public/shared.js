const api = {
  async json(url, options = {}) {
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
  },

  async blob(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text().catch(() => "Erro desconhecido");
      let message = text;
      try { message = JSON.parse(text).error || message; } catch {}
      throw new Error(`${res.status}: ${message}`);
    }
    return res.blob();
  },
};

let cachedSystemStatus = null;
let systemStatusPromise = null;

async function loadSystemStatus() {
  if (cachedSystemStatus) return cachedSystemStatus;
  if (systemStatusPromise) return systemStatusPromise;
  systemStatusPromise = api.json("/api/health")
    .then((status) => {
      cachedSystemStatus = status;
      return status;
    })
    .catch((err) => {
      cachedSystemStatus = { ok: false, openaiConfigured: false, storageProvider: "local", storageHealthy: false, authActive: false, runtimeDirAvailable: false };
      return cachedSystemStatus;
    })
    .finally(() => {
      systemStatusPromise = null;
    });
  return systemStatusPromise;
}

function isOpenAIConfigured() {
  return cachedSystemStatus?.openaiConfigured === true;
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : text;
  return div.innerHTML;
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatCurrency(n) {
  const num = Number(n);
  return Number.isFinite(num) ? `US$ ${num.toFixed(2)}` : "US$ 0.00";
}

function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(id, type, message) {
  const el = byId(id || "status");
  if (!el) return;
  el.className = `status ${type}`;
  el.textContent = message;
}

function clearStatus(id) {
  setStatus(id, "ready", "Pronto");
}

function showError(message, id) {
  setStatus(id, "error", message);
  console.error(message);
}

function handleApiError(err, id) {
  const text = err?.message || "Erro inesperado";
  if (text.startsWith("401") || text.includes("Não autenticado")) {
    window.location.replace("/login.html");
    return;
  }
  if (text.includes("404") || text.includes("Cannot")) {
    showError("Não foi possível carregar os dados. Reinicie o servidor e tente novamente.", id);
  } else {
    showError(text, id);
  }
}

function initials(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function createSkeletonCard() {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <div class="skeleton" style="height:160px;margin-bottom:12px"></div>
    <div class="skeleton" style="height:14px;width:70%;margin-bottom:8px"></div>
    <div class="skeleton" style="height:12px;width:45%"></div>
  `;
  return div;
}

function showSkeleton(container, count = 6) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) container.appendChild(createSkeletonCard());
}

function showEmpty(container, title, subtitle, action = null) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty-state card";
  div.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(subtitle)}</p>
  `;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    div.appendChild(document.createElement("br"));
    div.appendChild(btn);
  }
  container.appendChild(div);
}

function createModal({ title, body, footer, onClose }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      if (onClose) onClose();
    }
  });

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-header">
      <h3>${escapeHtml(title)}</h3>
      <button class="btn-ghost close-modal" aria-label="Fechar">&times;</button>
    </div>
    <div class="modal-body"></div>
    <div class="modal-footer"></div>
  `;
  modal.querySelector(".modal-body").appendChild(body);
  const footerEl = modal.querySelector(".modal-footer");
  if (footer && footer.length > 0) {
    for (const f of footer) {
      const btn = document.createElement("button");
      btn.className = f.className || "btn-secondary";
      btn.textContent = f.label;
      btn.disabled = !!f.disabled;
      btn.addEventListener("click", () => {
        if (f.onClick) f.onClick();
        if (f.close !== false) {
          overlay.remove();
          if (onClose) onClose();
        }
      });
      footerEl.appendChild(btn);
    }
  }
  modal.querySelector(".close-modal").addEventListener("click", () => {
    overlay.remove();
    if (onClose) onClose();
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  return overlay;
}

function confirmModal(message, { confirmText = "Confirmar", cancelText = "Cancelar", danger = false } = {}) {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    body.textContent = message;
    createModal({
      title: "Confirmação",
      body,
      footer: [
        { label: cancelText, className: "btn-secondary", onClick: () => resolve(false) },
        { label: confirmText, className: danger ? "btn-danger" : "btn-primary", onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

async function downloadUrl(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Download falhou");
    const blob = await res.blob();
    downloadBlob(blob, filename);
  } catch (err) {
    showError(`Erro ao baixar ${filename}: ${err.message}`);
  }
}

function registerNav(active) {
  const header = byId("appHeader");
  if (!header) return;
  header.innerHTML = `
    <a href="/" class="brand" aria-label="BwipoArt">
      <img src="/assets/bwipoart-logo.png" alt="BwipoArt">
    </a>
    <nav>
      <a href="/" class="${active === "inicio" ? "active" : ""}">Início</a>
      <a href="/criar.html" class="${active === "criar" ? "active" : ""}">Criar imagem</a>
      <a href="/batch.html" class="${active === "lote" ? "active" : ""}">Produção em lote</a>
      <a href="/biblioteca.html" class="${active === "biblioteca" ? "active" : ""}">Biblioteca</a>
      <a href="#" id="logoutLink" class="nav-logout">Sair</a>
    </nav>
  `;

  const logoutLink = header.querySelector("#logoutLink");
  if (logoutLink) {
    logoutLink.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {}
      window.location.replace("/login.html");
    });
  }
}

const STATUS_LABELS = {
  pendente: "Pendente",
  gerando_fundo: "Gerando fundo",
  fundo_gerado: "Fundo gerado",
  renderizando_card: "Renderizando card",
  gerando_whatsapp: "Gerando WhatsApp",
  pronto_revisao: "Pronto para revisão",
  aprovado: "Aprovado",
  rejeitado: "Rejeitado",
  ignorado: "Ignorado",
  simulacao: "Simulação",
  sem_imagem: "Sem imagem",
  erro: "Erro",
  cancelado: "Cancelado",
  concluido: "Concluído",
  concluido_com_erros: "Concluído com erros",
  bloqueado: "Bloqueado",
  executando: "Executando",
};

function formatStatus(status) {
  return STATUS_LABELS[status] || status || "—";
}

function statusClass(status) {
  if (["aprovado", "concluido"].includes(status)) return "badge-success";
  if (["erro", "rejeitado", "bloqueado", "concluido_com_erros"].includes(status)) return "badge-danger";
  if (["pronto_revisao", "fundo_gerado", "renderizando_card", "gerando_whatsapp"].includes(status)) return "badge-warning";
  if (status === "executando") return "badge-primary";
  return "badge-neutral";
}
