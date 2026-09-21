/**
 * Tela de login do editor de templates.
 */

const passwordInput = document.getElementById("password");
const loginForm = document.getElementById("loginForm");
const submitBtn = document.getElementById("submitBtn");
const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.add("visible");
}

function hideError() {
  errorEl.textContent = "";
  errorEl.classList.remove("visible");
}

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.classList.toggle("loading", loading);
  passwordInput.disabled = loading;
}

async function checkStatus() {
  try {
    const res = await fetch("/api/auth/status");
    const data = await res.json();
    if (data.enabled === false) {
      window.location.href = "/";
    }
  } catch {
    // Se a rota não existir ainda, segue normalmente.
  }
}

async function handleLogin(e) {
  e.preventDefault();
  hideError();
  setLoading(true);

  const password = passwordInput.value;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      window.location.href = "/";
      return;
    }

    let message = "Senha incorreta.";
    try {
      const data = await res.json();
      if (data.error) message = data.error;
      if (res.status === 429 && data.retryAfter) {
        message = `Muitas tentativas. Aguarde ${data.retryAfter} segundos.`;
      }
    } catch {}
    showError(message);
  } catch (err) {
    showError("Erro de conexão. Tente novamente.");
  } finally {
    setLoading(false);
    passwordInput.value = "";
    passwordInput.focus();
  }
}

loginForm.addEventListener("submit", handleLogin);
checkStatus();
