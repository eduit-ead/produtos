/**
 * Orquestrador de piloto para geração de fundos por IA e comparação de cards.
 *
 * Comando:
 *   npm run image:pilot-batch -- --slugs=ciberseguranca,nutricao,gestao-publica
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { findCourse, generateImage } = require("./generate-ai-background");
const { estimateCost } = require("./ai-pricing");
const {
  renderCourseCard,
  prepareBackgroundBuffer,
  TEMPLATE,
} = require("./render-card");

require("dotenv").config();

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const CACHE_DIR = path.join(ROOT, "input", "cache");
const PILOT_DIR = path.join(ROOT, "output", "ai-pilot");
const FINAL_DIR = path.join(ROOT, "output", "final");

function parseArgs() {
  const args = process.argv.slice(2);
  let slugs = [];
  let force = false;

  for (const arg of args) {
    if (arg.startsWith("--slugs=")) {
      slugs = arg
        .replace("--slugs=", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (arg === "--force") {
      force = true;
    }
  }

  return { slugs, force };
}

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length > 1 && ext.length <= 5) {
      return ext.toLowerCase();
    }
  } catch {
    // ignore
  }
  return ".jpg";
}

async function downloadImage(url) {
  const cacheHash = Buffer.from(url).toString("base64url");
  const cacheFile = path.join(CACHE_DIR, `${cacheHash}.cache.png`);

  if (fs.existsSync(cacheFile)) {
    return {
      buffer: fs.readFileSync(cacheFile),
      fromCache: true,
    };
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Download falhou: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, buffer);

  return { buffer, fromCache: false };
}

function hash(buffer) {
  return require("crypto").createHash("sha256").update(buffer).digest("hex");
}

function fileSize(buffer) {
  return buffer.length;
}

async function renderCardsForCourse(course, pilotDir) {
  const base = course.slug;
  const currentCardPath = path.join(FINAL_DIR, `${base}.png`);

  if (!fs.existsSync(currentCardPath)) {
    throw new Error(`Card atual não encontrado: ${currentCardPath}`);
  }

  const aiBackgroundPath = path.join(pilotDir, `${base}-fundo-ia.png`);
  if (!fs.existsSync(aiBackgroundPath)) {
    throw new Error(`Fundo de IA não encontrado: ${aiBackgroundPath}`);
  }

  console.log(`  Obtendo fundo atual de ${course.curso}...`);
  const { buffer: currentBackgroundBuffer, fromCache } = await downloadImage(
    course.imageUrl
  );
  const currentExt = getExtensionFromUrl(course.imageUrl);
  const currentBackgroundFile = `${base}-fundo-atual${currentExt}`;
  fs.writeFileSync(
    path.join(pilotDir, currentBackgroundFile),
    currentBackgroundBuffer
  );
  console.log(`    ${fromCache ? "⚡ cache" : "↓ download"}: ${currentBackgroundFile}`);

  const currentBackgroundPrepared = await prepareBackgroundBuffer(
    currentBackgroundBuffer
  );

  const aiBackgroundBuffer = fs.readFileSync(aiBackgroundPath);
  const aiBackgroundResized = await sharp(aiBackgroundBuffer)
    .resize(TEMPLATE.width, TEMPLATE.height, {
      fit: "cover",
      position: "attention",
    })
    .png()
    .toBuffer();

  const cardData = {
    curso: course.curso,
    formacao: course.formacao,
    modalidade: course.modalidade,
    duracao: course.duracao,
  };

  console.log(`  Renderizando cards de ${course.curso}...`);
  const currentCardRendered = await renderCourseCard(
    currentBackgroundPrepared,
    cardData
  );
  const aiCardRendered = await renderCourseCard(
    aiBackgroundResized,
    cardData
  );

  const currentCardFile = `${base}-card-atual.png`;
  const aiCardFile = `${base}-card-ia.png`;

  fs.writeFileSync(path.join(pilotDir, currentCardFile), currentCardRendered);
  fs.writeFileSync(path.join(pilotDir, aiCardFile), aiCardRendered);

  const currentCardMetadata = await sharp(currentCardRendered).metadata();
  const aiCardMetadata = await sharp(aiCardRendered).metadata();

  return {
    currentBackgroundFile,
    aiBackgroundFile: `${base}-fundo-ia.png`,
    currentCardFile,
    aiCardFile,
    currentBackgroundHash: hash(currentBackgroundBuffer),
    aiBackgroundHash: hash(aiBackgroundBuffer),
    currentCardHash: hash(currentCardRendered),
    aiCardHash: hash(aiCardRendered),
    currentBackgroundSize: fileSize(currentBackgroundBuffer),
    aiBackgroundSize: fileSize(aiBackgroundBuffer),
    currentCardSize: fileSize(currentCardRendered),
    aiCardSize: fileSize(aiCardRendered),
    currentBackgroundDimensions: `${currentCardMetadata.width}x${currentCardMetadata.height}`,
    aiBackgroundDimensions: `${aiCardMetadata.width}x${aiCardMetadata.height}`,
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateHtml(coursesData) {
  const totalCost = coursesData.reduce(
    (sum, c) => sum + (c.custo_estimado_usd?.totalCostUsd || 0),
    0
  );

  let sections = "";

  for (const c of coursesData) {
    const usage = c.uso_api || {};
    const inputText = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? "-";
    const imageTokens = usage.output_tokens_details?.image_tokens ?? usage.output_tokens ?? "-";
    const totalTokens = usage.total_tokens ?? "-";

    sections += `
    <section class="course">
      <div class="course-header">
        <h2>${escapeHtml(c.curso)}</h2>
        <div class="meta">
          <span><strong>course_id:</strong> ${escapeHtml(c.course_id)}</span>
          <span><strong>slug:</strong> ${escapeHtml(c.slug)}</span>
          <span><strong>modalidade:</strong> ${escapeHtml(c.modalidade)}</span>
          <span><strong>formação:</strong> ${escapeHtml(c.formacao)}</span>
          <span><strong>duração:</strong> ${escapeHtml(c.duracao)}</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h3>Fundo atual</h3>
          <a href="${c.files.currentBackgroundFile}" target="_blank" rel="noopener">
            <img src="${c.files.currentBackgroundFile}" alt="Fundo atual de ${escapeHtml(c.curso)}">
          </a>
        </div>
        <div class="card">
          <h3>Fundo gerado por IA</h3>
          <a href="${c.files.aiBackgroundFile}" target="_blank" rel="noopener">
            <img src="${c.files.aiBackgroundFile}" alt="Fundo gerado por IA para ${escapeHtml(c.curso)}">
          </a>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h3>Card atual</h3>
          <a href="${c.files.currentCardFile}" target="_blank" rel="noopener">
            <img src="${c.files.currentCardFile}" alt="Card atual de ${escapeHtml(c.curso)}">
          </a>
        </div>
        <div class="card">
          <h3>Card com fundo de IA</h3>
          <a href="${c.files.aiCardFile}" target="_blank" rel="noopener">
            <img src="${c.files.aiCardFile}" alt="Card com fundo de IA para ${escapeHtml(c.curso)}">
          </a>
        </div>
      </div>

      <details open>
        <summary>Prompt utilizado</summary>
        <pre class="prompt">${escapeHtml(c.prompt)}</pre>
      </details>

      <div class="usage">
        <h3>Uso da API</h3>
        <ul>
          <li><strong>Modelo:</strong> ${escapeHtml(c.modelo)}</li>
          <li><strong>Qualidade:</strong> ${escapeHtml(c.qualidade)}</li>
          <li><strong>Tamanho:</strong> ${escapeHtml(c.tamanho)}</li>
          <li><strong>Tokens de texto (input):</strong> ${inputText}</li>
          <li><strong>Tokens de imagem (output):</strong> ${imageTokens}</li>
          <li><strong>Total de tokens:</strong> ${totalTokens}</li>
          <li><strong>Custo estimado:</strong> ${c.custo_estimado_usd !== null && c.custo_estimado_usd.totalCostUsd !== undefined ? `$${c.custo_estimado_usd.totalCostUsd.toFixed(4)} USD` : "a confirmar"}</li>
          <li><strong>Tempo de geração:</strong> ${c.tempo_geracao_ms} ms</li>
        </ul>
      </div>
    </section>
    `;
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Piloto de Fundos por IA</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Inter, Arial, Helvetica, sans-serif;
      background: #0b1120;
      color: #e2e8f0;
      line-height: 1.6;
    }
    header {
      margin-bottom: 32px;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 28px;
      color: #ffffff;
    }
    .subtitle {
      color: #94a3b8;
      font-size: 14px;
    }
    .course {
      background: #1e293b;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .course-header {
      margin-bottom: 20px;
      border-bottom: 1px solid #334155;
      padding-bottom: 16px;
    }
    .course-header h2 {
      margin: 0 0 12px 0;
      font-size: 22px;
      color: #6ea0ff;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 13px;
      color: #94a3b8;
    }
    .meta span {
      background: #0f172a;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: #0f172a;
      border-radius: 12px;
      padding: 12px;
    }
    .card h3 {
      margin: 0 0 10px 0;
      font-size: 13px;
      color: #6ea0ff;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .card a {
      display: block;
    }
    .card img {
      width: 100%;
      height: auto;
      border-radius: 8px;
      display: block;
    }
    details {
      background: #0f172a;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 16px;
    }
    summary {
      cursor: pointer;
      color: #6ea0ff;
      font-weight: 600;
      font-size: 14px;
    }
    .prompt {
      margin: 12px 0 0 0;
      padding: 12px;
      background: #1e293b;
      border-radius: 8px;
      color: #cbd5e1;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.5;
    }
    .usage {
      background: #0f172a;
      border-radius: 12px;
      padding: 16px;
    }
    .usage h3 {
      margin: 0 0 10px 0;
      font-size: 14px;
      color: #ffffff;
    }
    .usage ul {
      margin: 0;
      padding-left: 18px;
      font-size: 13px;
      color: #cbd5e1;
    }
    .usage li {
      margin-bottom: 4px;
    }
    footer {
      text-align: center;
      color: #64748b;
      font-size: 12px;
      padding: 24px 0;
    }
    @media (max-width: 600px) {
      body { padding: 16px; }
      .course { padding: 16px; }
      .meta span { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Piloto de Fundos por IA</h1>
    <div class="subtitle">Comparação entre fundo atual e fundo gerado por IA para ${coursesData.length} curso(s)</div>
    <div class="subtitle">Custo total estimado: <strong>$${totalCost.toFixed(4)} USD</strong></div>
  </header>

  ${sections}

  <footer>
    Imagens carregadas localmente. Nenhuma dependência externa.
  </footer>
</body>
</html>
`;
}

async function main() {
  const { slugs, force } = parseArgs();

  if (slugs.length === 0) {
    console.error(
      "Uso: node src/generate-ai-pilot.js --slugs=slug1,slug2,slug3 [--force]"
    );
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERRO: OPENAI_API_KEY não configurada.");
    process.exit(1);
  }

  console.log("\n================================");
  console.log("VALIDAÇÃO DOS CURSOS");
  console.log("================================\n");

  const courses = [];
  for (const slug of slugs) {
    const course = await findCourse(slug);
    if (!course) {
      console.error(`Curso com slug "${slug}" não encontrado.`);
      process.exit(1);
    }
    if (!course.prompt) {
      console.error(
        `Curso "${course.curso}" não possui prompt_imagem preenchido.`
      );
      process.exit(1);
    }
    courses.push(course);
    console.log(`✓ ${course.curso} (${course.course_id})`);
    console.log(`  prompt: ${course.prompt.slice(0, 100)}...`);
  }

  console.log("\n================================");
  console.log(`CONFIRMAÇÃO: ${courses.length} CHAMADAS À API`);
  console.log("================================\n");

  fs.mkdirSync(PILOT_DIR, { recursive: true });

  const generatedRecords = [];

  for (const course of courses) {
    const aiFile = path.join(PILOT_DIR, `${course.slug}-fundo-ia.png`);
    if (fs.existsSync(aiFile) && !force) {
      console.log(`⚡ Fundo de IA já existe para ${course.curso}, pulando geração.`);
      const buffer = fs.readFileSync(aiFile);
      const jsonPath = path.join(PILOT_DIR, `${course.slug}.json`);
      let record = null;
      if (fs.existsSync(jsonPath)) {
        try {
          record = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        } catch {
          // ignore
        }
      }
      if (!record) {
        record = {
          course_id: course.course_id,
          slug: course.slug,
          curso: course.curso,
          modelo: "gpt-image-2.5-flare",
          qualidade: "medium",
          tamanho: "1024x1024",
          prompt: course.prompt,
          hash_sha256: hash(buffer),
          tempo_geracao_ms: 0,
        };
      }
      if (!record.custo_estimado_usd && record.uso_api) {
        record.custo_estimado_usd = estimateCost(record.modelo || "gpt-image-2.5-flare", record.uso_api);
      }
      generatedRecords.push({ course, record, skipped: true });
      continue;
    }

    console.log(`\n→ Gerando fundo de IA para ${course.curso}...`);
    const start = Date.now();
    try {
      const record = await generateImage(course, {
        outputDir: PILOT_DIR,
        force,
      });
      const elapsed = Date.now() - start;
      record.tempo_geracao_ms = elapsed;
      if (!record.custo_estimado_usd && record.uso_api) {
        record.custo_estimado_usd = estimateCost(record.modelo || "gpt-image-2.5-flare", record.uso_api);
      }
      generatedRecords.push({ course, record, skipped: false });
      console.log(`  ✓ gerado em ${elapsed}ms`);
    } catch (error) {
      console.error(`  ✗ erro em ${course.curso}: ${error.message}`);
      generatedRecords.push({
        course,
        record: {
          course_id: course.course_id,
          slug: course.slug,
          curso: course.curso,
          erro: error.message,
          tempo_geracao_ms: Date.now() - start,
        },
        skipped: false,
        error: true,
      });
    }
  }

  if (generatedRecords.some((r) => r.error)) {
    console.error("\n================================");
    console.log("UMA OU MAIS GERAÇÕES FALHARAM");
    console.log("================================");
  }

  console.log("\n================================");
  console.log("RENDERIZAÇÃO DOS CARDS");
  console.log("================================\n");

  const coursesData = [];

  for (const { course, record, skipped, error } of generatedRecords) {
    if (error) {
      coursesData.push({
        ...course,
        erro: record.erro,
        modelo: record.modelo || "gpt-image-2.5-flare",
        qualidade: record.qualidade || "medium",
        tamanho: record.tamanho || "1024x1024",
        prompt: course.prompt,
        tempo_geracao_ms: record.tempo_geracao_ms,
        uso_api: record.uso_api || null,
      custo_estimado_usd: record.custo_estimado_usd || null,
      files: {},
      });
      continue;
    }

    console.log(`→ Renderizando ${course.curso}...`);
    const files = await renderCardsForCourse(course, PILOT_DIR);

    coursesData.push({
      ...course,
      modelo: record.modelo,
      qualidade: record.qualidade,
      tamanho: record.tamanho,
      prompt: course.prompt,
      tempo_geracao_ms: record.tempo_geracao_ms,
      uso_api: record.uso_api,
      custo_estimado_usd: record.custo_estimado_usd || null,
      ja_existente: skipped,
      files,
    });
  }

  const totalCost = coursesData.reduce(
    (sum, c) => sum + (c.custo_estimado_usd?.totalCostUsd || 0),
    0
  );

  const dadosJson = {
    gerado_em: new Date().toISOString(),
    total_cursos: coursesData.length,
    custo_total_estimado_usd: totalCost,
    custo_por_curso_usd: coursesData.map((c) => ({
      slug: c.slug,
      curso: c.curso,
      custo_estimado_usd: c.custo_estimado_usd?.totalCostUsd || null,
    })),
    cursos: coursesData.map((c) => ({
      course_id: c.course_id,
      slug: c.slug,
      curso: c.curso,
      modalidade: c.modalidade,
      formacao: c.formacao,
      duracao: c.duracao,
      descricao_curta: c.descricao_curta,
      modelo: c.modelo,
      qualidade: c.qualidade,
      tamanho: c.tamanho,
      prompt: c.prompt,
      tempo_geracao_ms: c.tempo_geracao_ms,
      uso_api: c.uso_api,
      custo_estimado_usd: c.custo_estimado_usd,
      ja_existente: c.ja_existente || false,
      erro: c.erro || null,
      arquivos: c.files,
    })),
  };

  fs.writeFileSync(
    path.join(PILOT_DIR, "dados.json"),
    JSON.stringify(dadosJson, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(PILOT_DIR, "index.html"),
    generateHtml(coursesData),
    "utf8"
  );

  console.log("\n================================");
  console.log("PILOTO CONCLUÍDO");
  console.log("================================");
  console.log(`Pasta: ${PILOT_DIR}`);
  console.log(`Cursos processados: ${coursesData.length}`);
  console.log(`dados.json gerado`);
  console.log(`index.html gerado`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
