const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");

const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const OUTPUT_DIR = path.join(ROOT, "output");
const OUTPUT_TEST_DIR = path.join(OUTPUT_DIR, "teste-designer");
const OUTPUT_FINAL_DIR = path.join(OUTPUT_DIR, "final");

// =======================================================
// TEMPLATE VISUAL FINAL APROVADO - NÃO ALTERAR SEM SOLICITAÇÃO EXPLÍCITA
// =======================================================
// Configuração central do template de cards 1080x1080.
// Todos os valores abaixo refletem o layout aprovado em 17/09/2026.
// Qualquer mudança aqui afeta diretamente a identidade visual final.
// =======================================================

const TEMPLATE = {
  // Canvas
  width: 1080,
  height: 1080,

  // Assets fixos
  assets: {
    logo: path.join(ROOT, "assets", "logo-cruzeiro-branco.png"),
    gradient: path.join(ROOT, "assets", "gradiente-template.png"),
    frame: path.join(ROOT, "assets", "moldura-template.png"),
  },

  // Logo
  logo: {
    width: 275,
    left: 90,
    top: 561,
    trim: true,
  },

  // Título
  title: {
    x: 85,
    y: 728,
    fontFamily: "Inter, Arial, Helvetica, sans-serif",
    fontWeight: 800,
    fill: "#ffffff",
    letterSpacing: -1.2,
    lineHeight: 1.0,
    maxBlockWidth: 620,
    maxLines: 2,
    fontSizes: {
      upTo16: 78,
      upTo24: 70,
      upTo34: 62,
      upTo48: 56,
      fallback: 50,
    },
  },

  // Linha de informações
  infoLine: {
    yOffsetFromTitle: 44,
    fontFamily: "Inter, Arial, Helvetica, sans-serif",
    fontSize: 34,
    fontWeight: 700,
    fill: "#6EA0FF",
    letterSpacing: 0.5,
    separator: " | ",
    order: ["modalidade", "formacao", "duracao"],
  },

  // Foto
  photo: {
    fit: "cover",
    position: "attention",
    brightness: 0.98,
    saturation: 0.98,
  },
};

// Aliases para compatibilidade com código existente
const WIDTH = TEMPLATE.width;
const HEIGHT = TEMPLATE.height;
const LOGO_FILE = TEMPLATE.assets.logo;
const GRADIENT_FILE = TEMPLATE.assets.gradient;
const FRAME_FILE = TEMPLATE.assets.frame;

// -------------------------------------------------------
// Utilidades
// -------------------------------------------------------

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function slugify(value = "") {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getValue(row, possibleNames) {
  const entries = Object.entries(row);

  for (const possibleName of possibleNames) {
    const wanted = normalize(possibleName);

    const found = entries.find(([key]) => normalize(key) === wanted);

    if (found && found[1] !== undefined && found[1] !== null) {
      return String(found[1]).trim();
    }
  }

  return "";
}

function cleanUrl(value = "") {
  let url = String(value || "").trim();

  if (!url) return "";

  // Caso o Excel tenha algo tipo:
  // [https://site.com/img.png](https://site.com/img.png)
  const markdownMatch = url.match(/\((https?:\/\/[^)]+)\)/);

  if (markdownMatch) {
    url = markdownMatch[1];
  }

  return url;
}

function hasValue(value) {
  if (value === undefined || value === null) return false;

  const v = normalize(value);

  return ![
    "",
    "0",
    "false",
    "nao",
    "não",
    "null",
    "undefined",
  ].includes(v);
}

function normalizeDuration(value = "") {
  return String(value)
    .trim()
    .replace(/Semestres/gi, "semestres")
    .replace(/Semestre/gi, "semestre")
    .replace(/Anos/gi, "anos")
    .replace(/Ano/gi, "ano");
}

function wrapText(text, maxChars = 22) {
  const words = String(text).split(/\s+/);
  const lines = [];

  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  return lines;
}

/**
 * Quebra o título do curso em linhas equilibradas para o card.
 * Prioriza 2 linhas; usa 3 apenas quando necessário.
 * Evita linha final muito curta ou com uma palavra solta pequena.
 */
function wrapTitle(text, fontSize, maxLines = 2) {
  const cleaned = String(text).trim();
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (words.length <= 1) {
    return words;
  }

  // Largura máxima do bloco de texto em px
  const maxBlockWidth = TEMPLATE.title.maxBlockWidth;
  // Estimativa conservadora para sans-serif bold extrapesado
  const charWidth = fontSize * 0.56;
  const idealChars = Math.floor(maxBlockWidth / charWidth);

  // Se cabe em uma linha, não quebra
  if (cleaned.length <= idealChars) {
    return [cleaned];
  }

  const totalChars = cleaned.length;
  const targetLines = Math.min(
    maxLines,
    Math.ceil(totalChars / idealChars)
  );

  const targetChars = totalChars / targetLines;

  // Gera todas as divisões possíveis em N linhas
  function splitIntoN(n) {
    const partitions = [];

    function build(start, depth, current) {
      if (depth === n - 1) {
        const last = words.slice(start).join(" ");
        if (last) {
          partitions.push([...current, last]);
        }
        return;
      }

      for (let i = start + 1; i < words.length - (n - depth - 2); i++) {
        const line = words.slice(start, i).join(" ");
        build(i, depth + 1, [...current, line]);
      }
    }

    build(0, 0, []);
    return partitions;
  }

  function score(lines) {
    const lengths = lines.map((l) => l.length);
    const max = Math.max(...lengths);
    const last = lengths[lengths.length - 1];
    const lastWords = lines[lines.length - 1].split(/\s+/).length;

    // Penalidade se última linha muito curta ou com palavra solta pequena
    const lastTooShort = last < Math.max(6, max * 0.38) ? 80 : 0;
    const lastSingleTinyWord =
      lastWords === 1 && last < max * 0.45 ? 120 : 0;

    // Penalizar linhas que estourem o bloco
    const overfill = lines.reduce(
      (sum, l) => sum + Math.max(0, l.length - idealChars) * 3,
      0
    );

    // Preferir linhas equilibradas em torno do targetChars
    const imbalance = lengths.reduce(
      (sum, len) => sum + Math.abs(len - targetChars),
      0
    );

    return imbalance + lastTooShort + lastSingleTinyWord + overfill;
  }

  // Tenta 2 linhas, depois 3, depois fallback greedy
  let candidates = [];

  for (let lines = 2; lines <= maxLines + 1; lines++) {
    const partitions = splitIntoN(lines);
    const valid = partitions.filter(
      (p) => p.length <= maxLines || lines <= maxLines
    );
    candidates = candidates.concat(valid);
  }

  candidates.sort((a, b) => score(a) - score(b));

  const bestWithinLimit = candidates.find((c) => c.length <= maxLines);

  if (bestWithinLimit) {
    return bestWithinLimit;
  }

  if (candidates.length > 0) {
    return candidates[0].slice(0, maxLines + 1);
  }

  // Fallback seguro
  return wrapText(cleaned, idealChars).slice(0, maxLines + 1);
}

function getTitleFontSize(title) {
  const len = title.length;
  const sizes = TEMPLATE.title.fontSizes;

  if (len <= 16) return sizes.upTo16;
  if (len <= 24) return sizes.upTo24;
  if (len <= 34) return sizes.upTo34;
  if (len <= 48) return sizes.upTo48;

  return sizes.fallback;
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

// -------------------------------------------------------
// Download
// -------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 60000;
const DOWNLOAD_RETRIES = 3;
const IMAGE_CONTENT_TYPES = [
  "image/",
  "application/octet-stream",
];

const CACHE_DIR = path.join(ROOT, "input", "cache");

function getCacheFile(url) {
  const hash = Buffer.from(url).toString("base64url");
  return path.join(CACHE_DIR, `${hash}.cache.png`);
}

async function downloadImage(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cacheFile = getCacheFile(url);

  if (fs.existsSync(cacheFile)) {
    console.log(`  ⚡ usando cache: ${cacheFile}`);
    return {
      buffer: fs.readFileSync(cacheFile),
      finalUrl: url,
      fromCache: true,
    };
  }

  let lastError;
  let finalUrl = url;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    console.log(
      `  ↓ download tentativa ${attempt}/${DOWNLOAD_RETRIES}: ${url}`
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        DOWNLOAD_TIMEOUT_MS
      );

      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          Referer: "https://www.google.com/",
        },
      });

      clearTimeout(timeoutId);

      finalUrl = response.url || url;

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} - ${response.statusText}`
        );
      }

      const contentType =
        response.headers.get("content-type") || "";

      const isImage = IMAGE_CONTENT_TYPES.some((prefix) =>
        contentType.toLowerCase().includes(prefix)
      );

      if (!isImage) {
        throw new Error(
          `Content-Type inválido (${contentType || "vazio"})`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      fs.writeFileSync(cacheFile, buffer);

      console.log(`  ✓ download OK | URL original: ${url}`);
      console.log(`  ✓ URL final:    ${finalUrl}`);

      return {
        buffer,
        finalUrl,
        fromCache: false,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `  ✗ download tentativa ${attempt} falhou: ${error.message}`
      );

      if (attempt < DOWNLOAD_RETRIES) {
        const delay = attempt * 1500;
        console.log(
          `  ⟳ aguardando ${delay}ms antes de tentar novamente...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, delay)
        );
      }
    }
  }

  throw new Error(
    `Falha após ${DOWNLOAD_RETRIES} tentativas: ${lastError.message} | original: ${url} | final: ${finalUrl}`
  );
}

// -------------------------------------------------------
// SVG da arte
// -------------------------------------------------------

function createTextOverlay({
  curso,
  formacao,
  modalidade,
  duracao,
}) {
  const fontSize = getTitleFontSize(curso);

  // Quebra inteligente do título
  const titleLines = wrapTitle(
    curso,
    fontSize,
    TEMPLATE.title.maxLines
  ).slice(0, 3);

  const lineHeight = fontSize * TEMPLATE.title.lineHeight;

  const infoValues = {
    modalidade,
    formacao,
    duracao: normalizeDuration(duracao),
  };

  const infoLine = TEMPLATE.infoLine.order
    .map((key) => infoValues[key])
    .filter(Boolean)
    .join(TEMPLATE.infoLine.separator);

  const titleBlockHeight =
    titleLines.length * lineHeight;

  // Título na parte inferior-esquerda do card
  const titleStartY = TEMPLATE.title.y;
  const titleX = TEMPLATE.title.x;

  const titleBlockBottom =
    titleStartY + titleBlockHeight;

  const infoY =
    titleBlockBottom + TEMPLATE.infoLine.yOffsetFromTitle;

  const tspans = titleLines
    .map(
      (line, index) => `
        <tspan
          x="${titleX}"
          dy="${index === 0 ? 0 : lineHeight}"
        >${escapeXml(line)}</tspan>
      `
    )
    .join("");

  return `
  <svg width="${WIDTH}" height="${HEIGHT}"
       viewBox="0 0 ${WIDTH} ${HEIGHT}"
       xmlns="http://www.w3.org/2000/svg">

    <!-- título -->
    <text
      x="${titleX}"
      y="${titleStartY}"
      font-family="${TEMPLATE.title.fontFamily}"
      font-size="${fontSize}"
      font-weight="${TEMPLATE.title.fontWeight}"
      fill="${TEMPLATE.title.fill}"
      letter-spacing="${TEMPLATE.title.letterSpacing}"
    >
      ${tspans}
    </text>

    <!-- linha de informações -->
    <text
      x="${titleX}"
      y="${infoY}"
      font-family="${TEMPLATE.infoLine.fontFamily}"
      font-size="${TEMPLATE.infoLine.fontSize}"
      font-weight="${TEMPLATE.infoLine.fontWeight}"
      fill="${TEMPLATE.infoLine.fill}"
      letter-spacing="${TEMPLATE.infoLine.letterSpacing}"
    >
      ${escapeXml(infoLine)}
    </text>

  </svg>
  `;
}

// -------------------------------------------------------
// Assets visuais fixos do designer
// -------------------------------------------------------

async function loadFrameAssets() {
  const loadPng = async (file, width, height) => {
    if (!fs.existsSync(file)) {
      throw new Error(`Asset não encontrado: ${file}`);
    }

    const pipeline = sharp(file).png();

    if (width && height) {
      pipeline.resize(width, height, {
        fit: "cover",
      });
    }

    return pipeline.toBuffer();
  };

  const [gradientBuffer, frameBuffer, logoBuffer] =
    await Promise.all([
      loadPng(GRADIENT_FILE, WIDTH, HEIGHT),
      loadPng(FRAME_FILE, WIDTH, HEIGHT),
      (async () => {
        if (!fs.existsSync(LOGO_FILE)) {
          return null;
        }

        const logoPipeline = sharp(LOGO_FILE);

        if (TEMPLATE.logo.trim) {
          logoPipeline.trim();
        }

        return logoPipeline
          .resize({
            width: TEMPLATE.logo.width,
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
      })(),
    ]);

  return {
    gradientBuffer,
    frameBuffer,
    logoBuffer,
  };
}

// -------------------------------------------------------
// Composição final do card
// -------------------------------------------------------

function composeCourseCard(
  backgroundBuffer,
  textOverlayBuffer,
  assets
) {
  const { gradientBuffer, frameBuffer, logoBuffer } = assets;

  const composites = [
    {
      input: gradientBuffer,
      left: 0,
      top: 0,
    },
    {
      input: frameBuffer,
      left: 0,
      top: 0,
    },
    {
      input: textOverlayBuffer,
      left: 0,
      top: 0,
    },
  ];

  if (logoBuffer) {
    composites.push({
      input: logoBuffer,
      left: TEMPLATE.logo.left,
      top: TEMPLATE.logo.top,
    });
  }

  return sharp(backgroundBuffer)
    .composite(composites)
    .png({
      compressionLevel: 9,
    })
    .toBuffer();
}

// -------------------------------------------------------
// Gerar uma imagem
// -------------------------------------------------------

async function generateCourseImage(course, outputDir = OUTPUT_DIR) {
  const {
    curso,
    slug: courseSlug,
    formacao,
    modalidade,
    duracao,
    imageUrl,
  } = course;

  if (!curso) {
    throw new Error("Curso sem nome");
  }

  if (!imageUrl) {
    throw new Error("Curso sem imagem_base_url / Image");
  }

  const slug = courseSlug || slugify(curso);

  const outputFile = path.join(
    outputDir,
    `${slug}.png`
  );

  console.log(`↓ Baixando imagem para: ${curso}`);

  const { buffer: sourceBuffer } = await downloadImage(imageUrl);

  console.log(`  → processando: ${curso}`);

  const background = await sharp(sourceBuffer)
    .resize(WIDTH, HEIGHT, {
      fit: TEMPLATE.photo.fit,
      position: TEMPLATE.photo.position,
    })
    .modulate({
      brightness: TEMPLATE.photo.brightness,
      saturation: TEMPLATE.photo.saturation,
    })
    .png()
    .toBuffer();

  const textOverlay = Buffer.from(
    createTextOverlay(course)
  );

  const assets = await loadFrameAssets();

  const finalBuffer = await composeCourseCard(
    background,
    textOverlay,
    assets
  );

  fs.writeFileSync(outputFile, finalBuffer);

  return outputFile;
}

function normalizeYesNo(value = "") {
  const v = normalize(value);

  if (["sim", "s", "yes", "true", "1"].includes(v)) {
    return "SIM";
  }

  return "NÃO";
}

// -------------------------------------------------------
// Ler planilha
// -------------------------------------------------------

function readCourses() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Planilha não encontrada:\n${INPUT_FILE}`
    );
  }

  const workbook = XLSX.readFile(INPUT_FILE);

  const graduationSheet = workbook.SheetNames.find(
    (name) => normalize(name) === "graduacao"
  );

  if (!graduationSheet) {
    throw new Error(
      `Aba "Graduação" não encontrada na planilha.`
    );
  }

  console.log(`Planilha usada: ${graduationSheet}`);

  const sheet = workbook.Sheets[graduationSheet];

  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
  });

  return rows.map((row) => {
    const curso = getValue(row, ["Curso"]);

    let slug = getValue(row, ["slug"]);
    if (!slug && curso) {
      slug = slugify(curso);
    }

    const courseId = getValue(row, ["course_id"]) || slug;

    const formacao = getValue(row, ["Formação"]);
    const modalidade = getValue(row, ["Modalidade"]);
    const duracao = getValue(row, ["Duração"]);
    const imageUrl = cleanUrl(getValue(row, ["Image"]));
    const prontoImagem = normalizeYesNo(
      getValue(row, ["pronto_imagem"])
    );

    return {
      curso,
      slug,
      courseId,
      formacao,
      modalidade,
      duracao,
      imageUrl,
      prontoImagem,
    };
  });
}

// -------------------------------------------------------
// Validação de cursos
// -------------------------------------------------------

function validateCourse(course) {
  const errors = [];

  if (!course.curso?.trim()) {
    errors.push("Curso não preenchido");
  }

  if (!course.slug?.trim()) {
    errors.push("Slug não preenchido");
  }

  if (!course.formacao?.trim()) {
    errors.push("Formação não preenchida");
  }

  if (!course.modalidade?.trim()) {
    errors.push("Modalidade não preenchida");
  }

  if (!course.duracao?.trim()) {
    errors.push("Duração não preenchida");
  }

  if (!course.imageUrl?.trim()) {
    errors.push("Image não preenchida");
  }

  if (course.prontoImagem !== "SIM") {
    errors.push("pronto_imagem diferente de SIM");
  }

  return errors;
}

function findDuplicates(courses) {
  const slugCounts = {};
  const nameCounts = {};

  for (const course of courses) {
    if (course.slug) {
      slugCounts[course.slug] = (slugCounts[course.slug] || 0) + 1;
    }
    if (course.curso) {
      nameCounts[course.curso] = (nameCounts[course.curso] || 0) + 1;
    }
  }

  const duplicateSlugs = Object.entries(slugCounts)
    .filter(([_, count]) => count > 1)
    .map(([slug]) => slug);

  const duplicateNames = Object.entries(nameCounts)
    .filter(([_, count]) => count > 1)
    .map(([name]) => name);

  return { duplicateSlugs, duplicateNames };
}

// -------------------------------------------------------
// Dry-run
// -------------------------------------------------------

async function dryRun() {
  console.log("");
  console.log("================================");
  console.log("DRY-RUN DE GERAÇÃO EM MASSA");
  console.log("================================");
  console.log("");

  const courses = readCourses();

  const { duplicateSlugs, duplicateNames } = findDuplicates(courses);

  let readyCount = 0;
  let problemCount = 0;
  let eadCount = 0;
  let semipresencialCount = 0;
  const problems = [];

  for (const course of courses) {
    const validationErrors = validateCourse(course);
    const modality = normalize(course.modalidade);

    if (modality === "ead") eadCount++;
    if (modality === "semipresencial") semipresencialCount++;

    if (validationErrors.length === 0) {
      readyCount++;
    } else {
      problemCount++;
      problems.push({
        curso: course.curso || "(sem nome)",
        slug: course.slug || "(sem slug)",
        erros: validationErrors,
      });
    }
  }

  console.log(`TOTAL DE CURSOS: ${courses.length}`);
  console.log(`PRONTOS: ${readyCount}`);
  console.log(`COM PROBLEMAS: ${problemCount}`);
  console.log(`EAD: ${eadCount}`);
  console.log(`SEMIPRESENCIAL: ${semipresencialCount}`);
  console.log("");

  if (duplicateSlugs.length > 0) {
    console.log("--------------------------------");
    console.log("SLUGS DUPLICADOS:");
    console.log("--------------------------------");
    for (const slug of duplicateSlugs) {
      const names = courses
        .filter((c) => c.slug === slug)
        .map((c) => c.curso);
      console.log(`  [DUPLICADO] slug: "${slug}"`);
      console.log(`    usado por: ${names.join(", ")}`);
    }
    console.log("");
  }

  if (duplicateNames.length > 0) {
    console.log("--------------------------------");
    console.log("NOMES DUPLICADOS:");
    console.log("--------------------------------");
    for (const name of duplicateNames) {
      const slugs = courses
        .filter((c) => c.curso === name)
        .map((c) => c.slug);
      console.log(`  [DUPLICADO] curso: "${name}"`);
      console.log(`    slugs: ${slugs.join(", ")}`);
    }
    console.log("");
  }

  if (problems.length > 0) {
    console.log("--------------------------------");
    console.log("CURSOS COM PROBLEMA:");
    console.log("--------------------------------");
    for (const problem of problems) {
      console.log(`[ERRO] ${problem.curso}`);
      console.log(`  slug: ${problem.slug}`);
      console.log(`  Motivo: ${problem.erros.join("; ")}`);
      console.log("");
    }
  }

  console.log("================================");
  console.log("DRY-RUN FINALIZADO");
  console.log("================================");
  console.log("");
  console.log(`TOTAL ENCONTRADO: ${courses.length}`);
  console.log(`TOTAL PRONTO: ${readyCount}`);
  console.log(`TOTAL COM PROBLEMA: ${problemCount}`);
  console.log(`EAD: ${eadCount}`);
  console.log(`SEMIPRESENCIAL: ${semipresencialCount}`);
  console.log(`DUPLICIDADES: ${duplicateSlugs.length + duplicateNames.length}`);
  console.log("");
  console.log("NENHUMA IMAGEM FOI GERADA.");
}

// -------------------------------------------------------
// Geração em massa
// -------------------------------------------------------

async function generateAll() {
  fs.mkdirSync(OUTPUT_FINAL_DIR, {
    recursive: true,
  });

  const args = process.argv.slice(2);
  const forceOverwrite = args.includes("--force");

  const courses = readCourses();
  const results = [];

  let generatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let ignoredCount = 0;

  console.log("");
  console.log("================================");
  console.log("GERAÇÃO EM MASSA DE CARDS");
  console.log("================================");
  console.log("");
  console.log(`TOTAL: ${courses.length}`);
  console.log("");

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const indexLabel = `[${i + 1}/${courses.length}]`;

    if (course.prontoImagem !== "SIM") {
      ignoredCount++;
      console.log(`${indexLabel} ${course.curso} ⊘ (pronto_imagem = ${course.prontoImagem})`);
      continue;
    }

    const validationErrors = validateCourse(course);

    if (validationErrors.length > 0) {
      errorCount++;
      console.error(
        `${indexLabel} ${course.curso} ✗ ${validationErrors.join("; ")}`
      );

      results.push(buildResultRow(course, "erro", "", validationErrors.join("; ")));
      continue;
    }

    const outputFile = path.join(
      OUTPUT_FINAL_DIR,
      `${course.slug}.png`
    );

    const alreadyExists = fs.existsSync(outputFile);

    if (alreadyExists && !forceOverwrite) {
      skippedCount++;
      console.log(`${indexLabel} ${course.curso} ⊘ (já existe: ${path.basename(outputFile)})`);

      results.push(buildResultRow(course, "ignorado", outputFile, "Arquivo já existe"));
      continue;
    }

    try {
      const finalFile = await generateCourseImage(
        course,
        OUTPUT_FINAL_DIR
      );

      generatedCount++;
      console.log(`${indexLabel} ${course.curso} ✓`);

      results.push(buildResultRow(course, "ok", finalFile, ""));
    } catch (error) {
      errorCount++;
      console.error(
        `${indexLabel} ${course.curso} ✗ ${error.message}`
      );

      results.push(buildResultRow(course, "erro", "", error.message));
    }
  }

  // Manifest JSON
  const manifestJson = path.join(
    OUTPUT_FINAL_DIR,
    "resultado.json"
  );

  fs.writeFileSync(
    manifestJson,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  // Manifest CSV
  const manifestCsv = path.join(
    OUTPUT_FINAL_DIR,
    "resultado.csv"
  );

  const csvHeader = [
    "course_id",
    "curso",
    "slug",
    "modalidade",
    "formacao",
    "duracao",
    "imagem_origem",
    "arquivo_final",
    "status",
    "erro",
  ];

  const csvRows = results.map((row) =>
    [
      row.course_id,
      row.curso,
      row.slug,
      row.modalidade,
      row.formacao,
      row.duracao,
      row.imagem_origem,
      row.arquivo_final,
      row.status,
      row.erro,
    ]
      .map(csvEscape)
      .join(",")
  );

  const csv = [csvHeader, ...csvRows].join("\n");

  fs.writeFileSync(manifestCsv, "\uFEFF" + csv, "utf8");

  console.log("");
  console.log("--------------------------------");
  console.log("GERAÇÃO EM MASSA FINALIZADA");
  console.log("--------------------------------");
  console.log(`TOTAL: ${courses.length}`);
  console.log(`GERADOS: ${generatedCount}`);
  console.log(`IGNORADOS: ${ignoredCount + skippedCount}`);
  console.log(`ERROS: ${errorCount}`);
  console.log("");
  console.log(`Relatório: ${manifestJson}`);
  console.log(`Relatório: ${manifestCsv}`);
}

function buildResultRow(course, status, arquivoFinal, erro) {
  return {
    course_id: course.courseId || course.slug,
    curso: course.curso,
    slug: course.slug,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
    imagem_origem: course.imageUrl,
    arquivo_final: arquivoFinal,
    status,
    erro,
  };
}

// -------------------------------------------------------
// Execução de teste (3 cursos)
// -------------------------------------------------------

async function runTest() {
  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true,
  });
  fs.mkdirSync(OUTPUT_TEST_DIR, {
    recursive: true,
  });

  const allCourses = readCourses();

  const allowed = [
    "Administração",
    "Jornalismo",
    "Design de Interiores",
  ];

  const courses = allCourses.filter((course) =>
    allowed.includes(course.curso)
  );

  console.log("");
  console.log(
    `Cursos encontrados: ${allCourses.length} | Teste: ${courses.length}`
  );
  console.log("");

  const results = [];

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];

    console.log(`[${i + 1}/${courses.length}] ${course.curso}`);

    try {
      const outputFile = await generateCourseImage(
        course,
        OUTPUT_TEST_DIR
      );

      console.log(`✓ ${outputFile}`);
      console.log("");

      results.push({
        curso: course.curso,
        status: "ok",
        arquivo: outputFile,
        erro: "",
      });
    } catch (error) {
      console.error(
        `✗ Erro em ${course.curso}: ${error.message}`
      );
      console.log("");

      results.push({
        curso: course.curso,
        status: "erro",
        arquivo: "",
        erro: error.message,
      });
    }
  }

  // Manifest JSON
  const manifestJson = path.join(OUTPUT_DIR, "resultado.json");

  fs.writeFileSync(
    manifestJson,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  // Manifest CSV
  const manifestCsv = path.join(OUTPUT_DIR, "resultado.csv");

  const csv = [
    ["curso", "status", "arquivo", "erro"]
      .map(csvEscape)
      .join(","),

    ...results.map((row) =>
      [
        row.curso,
        row.status,
        row.arquivo,
        row.erro,
      ]
        .map(csvEscape)
        .join(",")
    ),
  ].join("\n");

  fs.writeFileSync(manifestCsv, "\uFEFF" + csv, "utf8");

  const success = results.filter((r) => r.status === "ok").length;
  const errors = results.length - success;

  console.log("--------------------------------");
  console.log("GERAÇÃO FINALIZADA");
  console.log("--------------------------------");
  console.log(`Sucesso: ${success}`);
  console.log(`Erros:   ${errors}`);
  console.log("");
  console.log(`Saída: ${OUTPUT_DIR}`);
}

// -------------------------------------------------------
// Geração de um único curso por slug
// -------------------------------------------------------

function parseSlugArg(args) {
  const prefix = "--slug=";
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function updateFinalManifest(result) {
  const manifestJson = path.join(OUTPUT_FINAL_DIR, "resultado.json");
  const manifestCsv = path.join(OUTPUT_FINAL_DIR, "resultado.csv");

  let results = [];

  if (fs.existsSync(manifestJson)) {
    try {
      results = JSON.parse(fs.readFileSync(manifestJson, "utf8"));
    } catch {
      results = [];
    }
  } else {
    // Se não existe, gera a partir dos dados atuais da planilha
    results = readCourses()
      .filter((c) => c.curso)
      .map((course) =>
        buildResultRow(course, "pendente", "", "Não processado")
      );
  }

  const index = results.findIndex(
    (r) => r.slug === result.slug
  );

  if (index >= 0) {
    results[index] = result;
  } else {
    results.push(result);
  }

  fs.writeFileSync(
    manifestJson,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  const csvHeader = [
    "course_id",
    "curso",
    "slug",
    "modalidade",
    "formacao",
    "duracao",
    "imagem_origem",
    "arquivo_final",
    "status",
    "erro",
  ];

  const csvRows = results.map((row) =>
    [
      row.course_id,
      row.curso,
      row.slug,
      row.modalidade,
      row.formacao,
      row.duracao,
      row.imagem_origem,
      row.arquivo_final,
      row.status,
      row.erro,
    ]
      .map(csvEscape)
      .join(",")
  );

  const csv = [csvHeader.join(","), ...csvRows].join("\n");

  fs.writeFileSync(manifestCsv, "\uFEFF" + csv, "utf8");
}

async function generateSingle(slug) {
  fs.mkdirSync(OUTPUT_FINAL_DIR, { recursive: true });

  const courses = readCourses();
  const course = courses.find((c) => c.slug === slug);

  if (!course) {
    console.error(`Curso com slug "${slug}" não encontrado.`);
    process.exit(1);
  }

  console.log(`Processando: ${course.curso} (${slug})`);

  const validationErrors = validateCourse(course);

  if (validationErrors.length > 0) {
    console.error(
      `✗ ${course.curso}: ${validationErrors.join("; ")}`
    );

    const result = buildResultRow(
      course,
      "erro",
      "",
      validationErrors.join("; ")
    );
    await updateFinalManifest(result);
    return;
  }

  try {
    const outputFile = await generateCourseImage(
      course,
      OUTPUT_FINAL_DIR
    );

    console.log(`✓ ${outputFile}`);

    const result = buildResultRow(course, "ok", outputFile, "");
    await updateFinalManifest(result);
  } catch (error) {
    console.error(`✗ Erro em ${course.curso}: ${error.message}`);

    const result = buildResultRow(course, "erro", "", error.message);
    await updateFinalManifest(result);
  }
}

// -------------------------------------------------------
// Entrypoint
// -------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes("--all");
  const isDryRun = args.includes("--dry-run");
  const slug = parseSlugArg(args);

  if (isDryRun) {
    await dryRun();
    return;
  }

  if (slug) {
    await generateSingle(slug);
    return;
  }

  if (isAll) {
    await generateAll();
    return;
  }

  await runTest();
}

main().catch((error) => {
  console.error("");
  console.error("ERRO FATAL:");
  console.error(error);
  process.exit(1);
});