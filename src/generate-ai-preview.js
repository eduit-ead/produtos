/**
 * Gera um preview comparativo de card com fundo de IA.
 *
 * Comando:
 *   node src/generate-ai-preview.js --slug=artes-visuais
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const sharp = require("sharp");

const {
  renderCourseCard,
  prepareBackgroundBuffer,
  TEMPLATE,
} = require("./render-card");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const SHEET_NAME = "Graduação";

function parseArgs() {
  const args = process.argv.slice(2);
  let slug = null;
  for (const arg of args) {
    if (arg.startsWith("--slug=")) {
      slug = arg.replace("--slug=", "").trim();
    }
  }
  return { slug };
}

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getValue(row, possibleNames) {
  for (const name of possibleNames) {
    const wanted = normalize(name);
    const key = Object.keys(row).find(
      (k) => normalize(k) === wanted
    );
    if (key && row[key] !== undefined && row[key] !== null) {
      return String(row[key]).trim();
    }
  }
  return "";
}

function cleanUrl(value = "") {
  let url = String(value || "").trim();
  if (!url) return "";
  const markdownMatch = url.match(/\((https?:\/\/[^)]+)\)/);
  if (markdownMatch) {
    url = markdownMatch[1];
  }
  return url;
}

async function findCourse(slug) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada.`);
  }

  const headerMap = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headerMap[cell.value] = colNumber;
  });

  function col(name) {
    const wanted = normalize(name);
    for (const [header, colNumber] of Object.entries(headerMap)) {
      if (normalize(header) === wanted) return colNumber;
    }
    return null;
  }

  const slugCol = col("slug");
  const courseIdCol = col("course_id");
  const cursoCol = col("Curso");
  const formacaoCol = col("Formação");
  const modalidadeCol = col("Modalidade");
  const duracaoCol = col("Duração");
  const imageCol = col("Image");
  const descricaoCol = col("descricao_curta");
  const promptCol = col("prompt_imagem");

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const rowSlug = String(row.getCell(slugCol).value || "").trim();

    if (rowSlug === slug) {
      return {
        course_id: String(
          row.getCell(courseIdCol || slugCol).value || slug
        ).trim(),
        slug: rowSlug,
        curso: String(row.getCell(cursoCol).value || "").trim(),
        formacao: String(row.getCell(formacaoCol).value || "").trim(),
        modalidade: String(row.getCell(modalidadeCol).value || "").trim(),
        duracao: String(row.getCell(duracaoCol).value || "").trim(),
        imageUrl: cleanUrl(
          String(row.getCell(imageCol).value || "").trim()
        ),
        descricao_curta: String(
          row.getCell(descricaoCol).value || ""
        ).trim(),
        prompt_imagem: String(
          row.getCell(promptCol).value || ""
        ).trim(),
      };
    }
  }

  return null;
}

async function downloadImage(url) {
  const cacheHash = Buffer.from(url).toString("base64url");
  const cacheFile = path.join(ROOT, "input", "cache", `${cacheHash}.cache.png`);

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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function generateHtml(data) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comparação - ${escapeHtml(data.curso)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Inter, Arial, Helvetica, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.5;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      color: #ffffff;
    }
    .subtitle {
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 16px;
    }
    .card h2 {
      margin: 0 0 12px 0;
      font-size: 16px;
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
    .data-section {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
    }
    .data-section h2 {
      margin: 0 0 16px 0;
      font-size: 18px;
      color: #ffffff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 8px 0;
      vertical-align: top;
    }
    th {
      color: #94a3b8;
      font-weight: 500;
      width: 180px;
    }
    td {
      color: #e2e8f0;
      word-break: break-word;
    }
    details {
      margin-top: 16px;
      background: #0f172a;
      border-radius: 8px;
      padding: 12px;
    }
    summary {
      cursor: pointer;
      color: #6ea0ff;
      font-weight: 600;
    }
    .prompt {
      margin-top: 12px;
      padding: 12px;
      background: #1e293b;
      border-radius: 6px;
      color: #cbd5e1;
      white-space: pre-wrap;
      font-size: 13px;
    }
    @media (max-width: 700px) {
      body { padding: 16px; }
      th { display: block; width: auto; padding-bottom: 0; }
      td { display: block; padding-top: 0; margin-bottom: 12px; }
      tr { display: block; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(data.curso)}</h1>
  <div class="subtitle">Comparação de fundo atual × fundo gerado por IA</div>

  <div class="grid">
    <div class="card">
      <h2>Fundo atual</h2>
      <a href="${data.fundoAtualFile}" target="_blank" rel="noopener">
        <img src="${data.fundoAtualFile}" alt="Fundo atual de ${escapeHtml(data.curso)}">
      </a>
    </div>
    <div class="card">
      <h2>Fundo gerado por IA</h2>
      <a href="${data.fundoIaFile}" target="_blank" rel="noopener">
        <img src="${data.fundoIaFile}" alt="Fundo gerado por IA para ${escapeHtml(data.curso)}">
      </a>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Card atual</h2>
      <a href="${data.cardAtualFile}" target="_blank" rel="noopener">
        <img src="${data.cardAtualFile}" alt="Card atual de ${escapeHtml(data.curso)}">
      </a>
    </div>
    <div class="card">
      <h2>Card com fundo de IA</h2>
      <a href="${data.cardIaFile}" target="_blank" rel="noopener">
        <img src="${data.cardIaFile}" alt="Card com fundo de IA para ${escapeHtml(data.curso)}">
      </a>
    </div>
  </div>

  <div class="data-section">
    <h2>Dados do curso</h2>
    <table>
      <tr><th>Nome do curso</th><td>${escapeHtml(data.curso)}</td></tr>
      <tr><th>course_id</th><td>${escapeHtml(data.course_id)}</td></tr>
      <tr><th>slug</th><td>${escapeHtml(data.slug)}</td></tr>
      <tr><th>Modalidade</th><td>${escapeHtml(data.modalidade)}</td></tr>
      <tr><th>Formação</th><td>${escapeHtml(data.formacao)}</td></tr>
      <tr><th>Duração</th><td>${escapeHtml(data.duracao)}</td></tr>
      <tr><th>Modelo de imagem</th><td>${escapeHtml(data.modelo)}</td></tr>
      <tr><th>Qualidade</th><td>${escapeHtml(data.qualidade)}</td></tr>
      <tr><th>Tamanho</th><td>${escapeHtml(data.tamanho)}</td></tr>
      <tr><th>Descrição curta</th><td>${escapeHtml(data.descricao_curta)}</td></tr>
    </table>

    <details>
      <summary>Prompt utilizado</summary>
      <div class="prompt">${escapeHtml(data.prompt_imagem)}</div>
    </details>
  </div>
</body>
</html>
`;
}

async function main() {
  const { slug } = parseArgs();

  if (!slug) {
    console.error(
      "Uso: node src/generate-ai-preview.js --slug=<slug>"
    );
    process.exit(1);
  }

  const previewDir = path.join(
    ROOT,
    "output",
    "ai-backgrounds",
    "preview",
    slug
  );

  const aiBackgroundPath = path.join(
    ROOT,
    "output",
    "ai-backgrounds",
    "openai",
    `${slug}.png`
  );

  const currentCardPath = path.join(
    ROOT,
    "output",
    "final",
    `${slug}.png`
  );

  console.log(`Buscando curso: ${slug}`);
  const course = await findCourse(slug);

  if (!course) {
    console.error(`Curso com slug "${slug}" não encontrado.`);
    process.exit(1);
  }

  console.log(`Curso encontrado: ${course.curso}`);

  if (!fs.existsSync(aiBackgroundPath)) {
    console.error(
      `Fundo de IA não encontrado: ${aiBackgroundPath}. Gere primeiro com: npm run image:pilot -- --slug=${slug}`
    );
    process.exit(1);
  }

  if (!fs.existsSync(currentCardPath)) {
    console.error(`Card atual não encontrado: ${currentCardPath}`);
    process.exit(1);
  }

  fs.mkdirSync(previewDir, { recursive: true });

  console.log("Obtendo fundo atual...");
  const { buffer: currentBackgroundBuffer, fromCache } = await downloadImage(
    course.imageUrl
  );
  const currentExt = getExtensionFromUrl(course.imageUrl);
  const currentBackgroundFile = `fundo-atual${currentExt}`;
  fs.writeFileSync(
    path.join(previewDir, currentBackgroundFile),
    currentBackgroundBuffer
  );
  console.log(`  ${fromCache ? "⚡ cache" : "↓ download"}: ${currentBackgroundFile}`);

  console.log("Preparando fundos...");
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

  const aiBackgroundFile = "fundo-ia.png";
  fs.writeFileSync(path.join(previewDir, aiBackgroundFile), aiBackgroundResized);

  const cardData = {
    curso: course.curso,
    formacao: course.formacao,
    modalidade: course.modalidade,
    duracao: course.duracao,
  };

  console.log("Renderizando card atual...");
  const currentCardBuffer = await renderCourseCard(
    currentBackgroundPrepared,
    cardData
  );
  const currentCardFile = "card-atual.png";
  fs.writeFileSync(path.join(previewDir, currentCardFile), currentCardBuffer);

  console.log("Renderizando card com fundo de IA...");
  const iaCardBuffer = await renderCourseCard(aiBackgroundResized, cardData);
  const iaCardFile = "card-ia.png";
  fs.writeFileSync(path.join(previewDir, iaCardFile), iaCardBuffer);

  console.log("Copiando card atual de referência...");
  fs.copyFileSync(currentCardPath, path.join(previewDir, "card-atual-ref.png"));

  const dadosJson = {
    curso: course.curso,
    course_id: course.course_id,
    slug: course.slug,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
    descricao_curta: course.descricao_curta,
    prompt_imagem: course.prompt_imagem,
    modelo: "gpt-image-2.5-flare",
    qualidade: "medium",
    tamanho: "1024x1024",
    fundoAtualFile: currentBackgroundFile,
    fundoIaFile: aiBackgroundFile,
    cardAtualFile: currentCardFile,
    cardIaFile: iaCardFile,
  };

  fs.writeFileSync(
    path.join(previewDir, "dados.json"),
    JSON.stringify(dadosJson, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(previewDir, "index.html"),
    generateHtml(dadosJson),
    "utf8"
  );

  console.log("\n================================");
  console.log("PREVIEW GERADO");
  console.log("================================");
  console.log(`Pasta: ${previewDir}`);
  console.log(`  ${currentBackgroundFile}`);
  console.log(`  ${aiBackgroundFile}`);
  console.log(`  ${currentCardFile}`);
  console.log(`  ${iaCardFile}`);
  console.log(`  dados.json`);
  console.log(`  index.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
