/**
 * Geração sequencial do catálogo completo de fundos e cards por IA.
 *
 * Comandos:
 *   npm run image:catalog -- --dry-run --limit=10 --max-cost=0.20
 *   npm run image:catalog -- --all --max-cost=5.00
 *   npm run image:catalog -- --limit=20 --max-cost=1.00 --resume
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { generateImage, DEFAULT_MODEL } = require("./generate-ai-background");
const {
  renderCourseCard,
  prepareBackgroundBuffer,
} = require("./render-card");
const { loadAllCourses } = require("./read-courses");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output", "ai-catalog");
const FINAL_DIR = path.join(ROOT, "output", "final");

const MANIFEST_FILE = path.join(OUTPUT_DIR, "manifest.json");
const HTML_FILE = path.join(OUTPUT_DIR, "index.html");

const PILOT_SLUGS = [
  "artes-visuais",
  "ciberseguranca",
  "nutricao",
  "gestao-publica",
];

const PILOT_SOURCE_DIRS = [
  path.join(ROOT, "output", "ai-pilot"),
  path.join(ROOT, "output", "ai-backgrounds", "openai"),
  path.join(ROOT, "output", "ai-backgrounds", "preview"),
];

const MIN_SECONDS_BETWEEN_CALLS = 13;
const API_RETRIES = 3;
const ESTIMATED_MAX_COST_PER_IMAGE_USD = 0.05;

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let limit = null;
  let all = false;
  let resume = false;
  let maxCost = null;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    }
    if (arg === "--all") {
      all = true;
    }
    if (arg === "--resume") {
      resume = true;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.replace("--limit=", ""), 10);
      if (Number.isNaN(limit) || limit <= 0) {
        throw new Error(`--limit inválido: ${arg}`);
      }
    }
    if (arg.startsWith("--max-cost=")) {
      maxCost = parseFloat(arg.replace("--max-cost=", ""));
      if (Number.isNaN(maxCost) || maxCost < 0) {
        throw new Error(`--max-cost inválido: ${arg}`);
      }
    }
  }

  return { dryRun, limit, all, resume, maxCost };
}

function pathsForCourse(slug) {
  return {
    fundo: path.join(OUTPUT_DIR, `${slug}-fundo-ia.png`),
    card: path.join(OUTPUT_DIR, `${slug}-card-ia.png`),
  };
}

function findExistingPilotFiles(slug) {
  const candidates = {
    fundo: [
      ...PILOT_SOURCE_DIRS.map((dir) => path.join(dir, `${slug}-fundo-ia.png`)),
      ...PILOT_SOURCE_DIRS.map((dir) => path.join(dir, `${slug}.png`)),
    ],
    card: [
      ...PILOT_SOURCE_DIRS.map((dir) => path.join(dir, `${slug}-card-ia.png`)),
      ...PILOT_SOURCE_DIRS.map((dir) => path.join(dir, slug, "card-ia.png")),
    ],
  };

  const result = { fundo: null, card: null };
  for (const p of candidates.fundo) {
    if (fs.existsSync(p)) {
      result.fundo = p;
      break;
    }
  }
  for (const p of candidates.card) {
    if (fs.existsSync(p)) {
      result.card = p;
      break;
    }
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFatalError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || "").toLowerCase();

  if (status === 401 || status === 403) return true;
  if (status === 400) {
    if (/billing|quota|insufficient|model|invalid_model|model not found/i.test(msg)) {
      return true;
    }
  }
  if (/authentication|api key|billing|insufficient_quota|invalid model|model not found/i.test(msg)) {
    return true;
  }
  return false;
}

function isTransientError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || "").toLowerCase();
  if (status === 429 || status >= 500) return true;
  if (/timeout|network|fetch failed|eai_again|connection|temporarily unavailable/i.test(msg)) {
    return true;
  }
  return false;
}

function createEmptyManifest(dryRun, maxCost) {
  return {
    createdAt: new Date().toISOString(),
    dryRun: !!dryRun,
    maxCost: maxCost ?? null,
    model: DEFAULT_MODEL,
    totalCostUsd: 0,
    totalCourses: 0,
    completed: 0,
    simulated: 0,
    skipped: 0,
    reused: 0,
    errors: 0,
    courses: [],
  };
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveManifestAtomic(manifest) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const tmp = `${MANIFEST_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, MANIFEST_FILE);
}

function findManifestEntry(manifest, slug) {
  return manifest.courses.find((c) => c.slug === slug);
}

function upsertManifestEntry(manifest, entry) {
  const idx = manifest.courses.findIndex((c) => c.slug === entry.slug);
  if (idx >= 0) {
    manifest.courses[idx] = entry;
  } else {
    manifest.courses.push(entry);
  }

  manifest.completed = manifest.courses.filter(
    (c) => c.status === "done" || c.status === "reused"
  ).length;
  manifest.simulated = manifest.courses.filter((c) => c.status === "simulated").length;
  manifest.skipped = manifest.courses.filter((c) => c.status === "skipped").length;
  manifest.reused = manifest.courses.filter((c) => c.status === "reused").length;
  manifest.errors = manifest.courses.filter((c) => c.status === "error").length;
  manifest.totalCostUsd = manifest.courses.reduce(
    (sum, c) => sum + (Number(c.costUsd) || 0),
    0
  );
  manifest.totalCourses = manifest.courses.length;
}

async function renderAndSaveCard(course, backgroundPath, cardPath) {
  const backgroundBuffer = await prepareBackgroundBuffer(fs.readFileSync(backgroundPath));
  const cardBuffer = await renderCourseCard(backgroundBuffer, {
    curso: course.curso,
    formacao: course.formacao,
    modalidade: course.modalidade,
    duracao: course.duracao,
  });
  fs.writeFileSync(cardPath, cardBuffer);
  return cardBuffer.length;
}

async function copyPilotFiles(course, files, dryRun) {
  const paths = pathsForCourse(course.slug);
  if (dryRun) {
    return {
      copiedFundo: false,
      copiedCard: false,
      fundoSize: 0,
      cardSize: 0,
      note: "dry-run: reuso de piloto simulado",
    };
  }

  let fundoSize = 0;
  let cardSize = 0;
  let copiedFundo = false;
  let copiedCard = false;

  if (files.fundo) {
    fs.copyFileSync(files.fundo, paths.fundo);
    fundoSize = fs.statSync(paths.fundo).size;
    copiedFundo = true;
  }

  if (files.card) {
    fs.copyFileSync(files.card, paths.card);
    cardSize = fs.statSync(paths.card).size;
    copiedCard = true;
  } else if (copiedFundo) {
    cardSize = await renderAndSaveCard(course, paths.fundo, paths.card);
    copiedCard = true;
  }

  return { copiedFundo, copiedCard, fundoSize, cardSize, note: null };
}

async function generateBackgroundAndCard(course, dryRun, outputDir) {
  const paths = pathsForCourse(course.slug);

  if (dryRun) {
    return {
      modelo: DEFAULT_MODEL,
      qualidade: "medium",
      tamanho: "1024x1024",
      formato: "png",
      prompt: course.prompt_imagem,
      data: new Date().toISOString(),
      caminho_arquivo: paths.fundo,
      dry_run: true,
      costUsd: 0,
      usage: null,
      cardSize: 0,
    };
  }

  const record = await generateImage(
    {
      course_id: course.course_id,
      slug: course.slug,
      curso: course.curso,
      prompt: course.prompt_imagem,
    },
    { outputDir }
  );

  const cardSize = await renderAndSaveCard(course, paths.fundo, paths.card);

  const cost =
    record.custo_estimado_usd && record.custo_estimado_usd.totalCostUsd !== undefined
      ? record.custo_estimado_usd.totalCostUsd
      : null;

  return {
    modelo: record.modelo,
    qualidade: record.qualidade,
    tamanho: record.tamanho,
    formato: record.formato,
    prompt: record.prompt,
    data: record.data,
    caminho_arquivo: record.caminho_arquivo,
    hash_sha256: record.hash_sha256,
    usage: record.uso_api,
    costUsd: cost ?? 0,
    dry_run: false,
    cardSize,
  };
}

async function callApiWithRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= API_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isFatalError(err)) {
        throw err;
      }
      if (!isTransientError(err)) {
        throw err;
      }
      const wait = MIN_SECONDS_BETWEEN_CALLS * 1000 * attempt;
      console.log(`    ⚠️ tentativa ${attempt}/${API_RETRIES} falhou (${err.message}). Aguardando ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${Number(value).toFixed(4)} USD`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateHtml(manifest) {
  const totalCost = formatMoney(manifest.totalCostUsd);
  const cards = manifest.courses
    .map((c) => {
      const statusLabel = {
        done: "Gerado",
        reused: "Piloto reaproveitado",
        skipped: "Já existia",
        error: "Erro",
        simulated: "Simulação",
      }[c.status] || c.status;

      return `
      <div class="card">
        <div class="status">${escapeHtml(statusLabel)}</div>
        <img src="${escapeHtml(c.files.card)}" alt="${escapeHtml(c.curso)}">
        <div class="info">
          <h3>${escapeHtml(c.curso)}</h3>
          <p>${escapeHtml(c.course_id)}</p>
          <p>Custo: ${formatMoney(c.costUsd)}</p>
          ${c.error ? `<p class="error">${escapeHtml(c.error)}</p>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Catálogo de Cards com IA</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Inter, Arial, Helvetica, sans-serif;
      background: #0b1120;
      color: #e2e8f0;
    }
    header {
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 28px;
    }
    .summary {
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .summary span {
      margin-right: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 24px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      overflow: hidden;
      position: relative;
    }
    .card img {
      width: 100%;
      height: auto;
      display: block;
    }
    .status {
      position: absolute;
      top: 12px;
      left: 12px;
      background: rgba(15, 23, 42, 0.85);
      color: #6ea0ff;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .info {
      padding: 16px;
    }
    .info h3 {
      margin: 0 0 8px 0;
      font-size: 15px;
      color: #fff;
    }
    .info p {
      margin: 4px 0;
      font-size: 12px;
      color: #94a3b8;
    }
    .error {
      color: #ef4444;
    }
  </style>
</head>
<body>
  <header>
    <h1>Catálogo de Cards com IA</h1>
    <div class="summary">
      <span>Total: ${manifest.totalCourses}</span>
      <span>Concluídos: ${manifest.completed}</span>
      <span>Simulados: ${manifest.simulated}</span>
      <span>Reaproveitados: ${manifest.reused}</span>
      <span>Pulados: ${manifest.skipped}</span>
      <span>Erros: ${manifest.errors}</span>
      <span>Custo: ${totalCost}</span>
      ${manifest.dryRun ? "<span>[DRY-RUN]</span>" : ""}
    </div>
  </header>
  <div class="grid">
    ${cards}
  </div>
</body>
</html>`;

  fs.writeFileSync(HTML_FILE, html, "utf8");
}

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(`ERRO: ${err.message}`);
    process.exit(1);
  }

  const { dryRun, limit, all, resume, maxCost } = args;

  if (!dryRun && !maxCost) {
    console.error("ERRO: execução real exige --max-cost=<USD>. Use --dry-run para simular.");
    process.exit(1);
  }

  const targetLimit = all ? Infinity : limit;
  if (!all && !limit) {
    console.error("ERRO: informe --all ou --limit=N.");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY && dryRun) {
    process.env.OPENAI_API_KEY = "dry-run";
  }

  if (!process.env.OPENAI_API_KEY && !dryRun) {
    console.error("ERRO: OPENAI_API_KEY não configurada.");
    process.exit(1);
  }

  console.log("Carregando cursos da planilha...");
  const allCourses = await loadAllCourses();
  console.log(`  ${allCourses.length} cursos encontrados.`);

  const targetCourses = allCourses.slice(0, targetLimit === Infinity ? allCourses.length : targetLimit);

  let manifest = createEmptyManifest(dryRun, maxCost);
  const existingManifest = loadManifest();
  if (resume && existingManifest && existingManifest.dryRun === dryRun) {
    manifest = existingManifest;
    console.log("  Manifesto anterior carregado (resume).");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let lastApiCallTime = 0;
  let stoppedByCost = false;

  for (const course of targetCourses) {
    const paths = pathsForCourse(course.slug);
    const existingEntry = findManifestEntry(manifest, course.slug);

    if (
      resume &&
      existingEntry &&
      (existingEntry.status === "done" || existingEntry.status === "reused") &&
      fs.existsSync(paths.fundo) &&
      fs.existsSync(paths.card)
    ) {
      console.log(`[SKIP] ${course.slug} já gerado e arquivos existem.`);
      continue;
    }

    if (!dryRun && fs.existsSync(paths.fundo) && fs.existsSync(paths.card)) {
      console.log(`[SKIP] ${course.slug} arquivos já existem.`);
      if (!existingEntry || existingEntry.status !== "skipped") {
        const entry = {
          course_id: course.course_id,
          slug: course.slug,
          curso: course.curso,
          status: "skipped",
          files: {
            fundo: path.basename(paths.fundo),
            card: path.basename(paths.card),
          },
          costUsd: 0,
          timestamp: new Date().toISOString(),
          error: null,
          usage: null,
          reused: false,
        };
        upsertManifestEntry(manifest, entry);
        saveManifestAtomic(manifest);
      }
      continue;
    }

    const entry = {
      course_id: course.course_id,
      slug: course.slug,
      curso: course.curso,
      status: "pending",
      files: {
        fundo: path.basename(paths.fundo),
        card: path.basename(paths.card),
      },
      costUsd: 0,
      timestamp: new Date().toISOString(),
      error: null,
      usage: null,
      reused: false,
      pilot: PILOT_SLUGS.includes(course.slug),
    };

    try {
      if (PILOT_SLUGS.includes(course.slug)) {
        console.log(`[PILOTO] ${course.slug}: reaproveitando sem chamada à API...`);
        const pilotFiles = findExistingPilotFiles(course.slug);

        if (!dryRun && !pilotFiles.fundo && !pilotFiles.card) {
          throw new Error(`Arquivos piloto não encontrados para ${course.slug}.`);
        }

        const result = await copyPilotFiles(course, pilotFiles, dryRun);
        entry.status = "reused";
        entry.reused = true;
        entry.files.fundoSize = result.fundoSize || 0;
        entry.files.cardSize = result.cardSize || 0;
        entry.note = result.note || null;
        entry.timestamp = new Date().toISOString();
        console.log(`  ✅ piloto reaproveitado${dryRun ? " (simulado)" : ""}`);
      } else {
        if (!dryRun) {
          const elapsed = Date.now() - lastApiCallTime;
          const waitMs = Math.max(0, MIN_SECONDS_BETWEEN_CALLS * 1000 - elapsed);
          if (waitMs > 0) {
            console.log(`  ⏳ aguardando ${(waitMs / 1000).toFixed(1)}s entre chamadas...`);
            await sleep(waitMs);
          }

          if (
            maxCost !== null &&
            manifest.totalCostUsd + ESTIMATED_MAX_COST_PER_IMAGE_USD > maxCost
          ) {
            console.log(
              `  ⛔ parado por custo: total ${formatMoney(manifest.totalCostUsd)} + estimado ${formatMoney(ESTIMATED_MAX_COST_PER_IMAGE_USD)} > limite ${formatMoney(maxCost)}`
            );
            stoppedByCost = true;
            break;
          }
        }

        console.log(`[API] ${course.slug}: gerando fundo...`);
        const result = await callApiWithRetry(() =>
          generateBackgroundAndCard(course, dryRun, OUTPUT_DIR)
        );

        entry.status = dryRun ? "simulated" : "done";
        entry.costUsd = result.costUsd ?? 0;
        entry.usage = result.usage;
        entry.modelo = result.modelo;
        entry.qualidade = result.qualidade;
        entry.tamanho = result.tamanho;
        entry.files.fundoSize = fs.existsSync(paths.fundo) ? fs.statSync(paths.fundo).size : 0;
        entry.files.cardSize = fs.existsSync(paths.card) ? fs.statSync(paths.card).size : result.cardSize || 0;
        entry.timestamp = new Date().toISOString();

        if (!dryRun) {
          lastApiCallTime = Date.now();
          console.log(`  ✅ gerado em ${formatMoney(entry.costUsd)}`);
        } else {
          console.log(`  ✅ simulado (dry-run)`);
        }
      }
    } catch (err) {
      entry.status = "error";
      entry.error = err.message;
      entry.timestamp = new Date().toISOString();
      console.error(`  ❌ erro em ${course.slug}: ${err.message}`);

      upsertManifestEntry(manifest, entry);
      saveManifestAtomic(manifest);

      if (isFatalError(err)) {
        console.error("\nERRO FATAL. Encerrando catálogo.");
        break;
      }
      continue;
    }

    upsertManifestEntry(manifest, entry);
    saveManifestAtomic(manifest);
  }

  generateHtml(manifest);
  saveManifestAtomic(manifest);

  console.log("\n================================");
  console.log("CATÁLOGO CONCLUÍDO");
  console.log("================================");
  console.log(`Cursos processados: ${manifest.totalCourses}`);
  console.log(`Concluídos: ${manifest.completed}`);
  console.log(`Simulados: ${manifest.simulated}`);
  console.log(`Reaproveitados (pilotos): ${manifest.reused}`);
  console.log(`Pulados: ${manifest.skipped}`);
  console.log(`Erros: ${manifest.errors}`);
  console.log(`Custo total estimado: ${formatMoney(manifest.totalCostUsd)}`);
  if (stoppedByCost) {
    console.log("Execução interrompida ao atingir --max-cost.");
  }
  console.log(`Manifesto: ${MANIFEST_FILE}`);
  console.log(`HTML:      ${HTML_FILE}`);
  console.log(`Diretório: ${OUTPUT_DIR}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
