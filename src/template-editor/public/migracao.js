registerNav("migracao");

const fileInput = document.getElementById("zipFile");
const confirmPolicy = document.getElementById("confirmPolicy");
const startButton = document.getElementById("startImport");
const progressText = document.getElementById("progressText");
const progressBar = document.getElementById("progressBar");
const errorList = document.getElementById("errorList");
const resultBox = document.getElementById("resultBox");

function canStart() {
  return Boolean(fileInput.files?.[0] && confirmPolicy.checked);
}

function refreshButton() {
  startButton.disabled = !canStart();
}

fileInput.addEventListener("change", refreshButton);
confirmPolicy.addEventListener("change", refreshButton);

function setProgress(value, text) {
  progressBar.value = value;
  progressText.textContent = text;
}

function showErrors(errors) {
  errorList.innerHTML = "";
  for (const message of errors || []) {
    const item = document.createElement("li");
    item.textContent = message;
    errorList.appendChild(item);
  }
}

function phaseLabel(job) {
  const labels = {
    queued: "Na fila",
    extracting: "Extraindo e validando",
    restoring: "Restaurando no volume",
    done: "Concluída",
    failed: "Falhou",
  };
  const label = labels[job.phase] || job.phase;
  const total = job.filesTotal || 0;
  const done = job.filesDone || 0;
  if (total > 0 && job.phase !== "done" && job.phase !== "failed") {
    return `${label}: ${done} de ${total}`;
  }
  return label;
}

async function poll(jobId) {
  for (;;) {
    const res = await fetch(`/api/admin/migration/jobs/${jobId}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "Falha ao consultar a importação.");
    const total = job.filesTotal || 1;
    const percent = job.done ? (job.ok ? 100 : progressBar.value) : Math.min(99, Math.round((job.filesDone / total) * 100));
    setProgress(percent, phaseLabel(job));
    showErrors(job.errors);
    if (job.done) {
      resultBox.textContent = JSON.stringify({
        ok: job.ok,
        adicionados: job.added,
        substituidos: job.replaced,
        ignorados: job.skipped,
        backup: job.backupDir,
        resumo: job.summary,
      }, null, 2);
      if (!job.ok) throw new Error(job.errors?.[0] || "A importação falhou.");
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

startButton.addEventListener("click", () => {
  const file = fileInput.files?.[0];
  if (!file || !confirmPolicy.checked) return;
  startButton.disabled = true;
  resultBox.textContent = "";
  showErrors([]);
  setProgress(0, "Enviando o ZIP…");

  const body = new FormData();
  body.append("file", file);
  body.append("confirmPolicy", "windows-wins");

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/admin/migration/import");
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    setProgress(Math.min(90, percent), `Enviando o ZIP… ${percent}%`);
  };
  xhr.onload = async () => {
    let payload = {};
    try { payload = JSON.parse(xhr.responseText || "{}"); } catch {}
    if (xhr.status < 200 || xhr.status >= 300) {
      setProgress(0, "Envio não aceito.");
      showErrors([payload.error || "Falha no upload."]);
      refreshButton();
      return;
    }
    try {
      setProgress(95, "Processando no servidor…");
      await poll(payload.jobId);
      setProgress(100, "Migração concluída.");
    } catch (err) {
      setProgress(progressBar.value, err.message);
    } finally {
      refreshButton();
    }
  };
  xhr.onerror = () => {
    setProgress(0, "Falha de rede no envio.");
    refreshButton();
  };
  xhr.send(body);
});
