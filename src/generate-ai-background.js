/**
 * Gera imagem de fundo para um curso usando a Image API da OpenAI.
 *
 * Comandos:
 *   node src/generate-ai-background.js --slug=artes-visuais --dry-run
 *   node src/generate-ai-background.js --slug=artes-visuais
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
require("dotenv").config();

const OpenAI = require("openai");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const OUTPUT_DIR = path.join(ROOT, "output", "ai-backgrounds", "openai");
const SHEET_NAME = "Graduação";

const DEFAULT_MODEL = "gpt-image-2.5-flare";
const DEFAULT_QUALITY = "medium";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_FORMAT = "png";

function parseArgs() {
  const args = process.argv.slice(2);
  let slug = null;
  let dryRun = false;
  let force = false;

  for (const arg of args) {
    if (arg.startsWith("--slug=")) {
      slug = arg.replace("--slug=", "").trim();
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
    if (arg === "--force") {
      force = true;
    }
  }

  return { slug, dryRun, force };
}

function getValue(row, possibleNames) {
  for (const name of possibleNames) {
    const wanted = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();

    const key = Object.keys(row).find((k) => {
      return (
        k
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase() === wanted
      );
    });

    if (key && row[key] !== undefined && row[key] !== null) {
      return String(row[key]).trim();
    }
  }
  return "";
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
    const wanted = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    for (const [header, colNumber] of Object.entries(headerMap)) {
      if (
        String(header)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase() === wanted
      ) {
        return colNumber;
      }
    }
    return null;
  }

  const slugCol = col("slug");
  const courseIdCol = col("course_id");
  const cursoCol = col("Curso");
  const promptCol = col("prompt_imagem");

  if (!slugCol) {
    throw new Error("Coluna 'slug' não encontrada na planilha.");
  }
  if (!promptCol) {
    throw new Error("Coluna 'prompt_imagem' não encontrada na planilha.");
  }

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const rowSlug = String(row.getCell(slugCol).value || "").trim();

    if (rowSlug === slug) {
      return {
        course_id: String(row.getCell(courseIdCol || slugCol).value || slug).trim(),
        slug: rowSlug,
        curso: String(row.getCell(cursoCol).value || "").trim(),
        prompt: String(row.getCell(promptCol).value || "").trim(),
      };
    }
  }

  return null;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function generateImage(course, dryRun) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Variável de ambiente OPENAI_API_KEY não configurada.");
  }

  if (!course.prompt) {
    throw new Error("Campo 'prompt_imagem' está vazio.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const pngPath = path.join(OUTPUT_DIR, `${course.slug}.png`);
  const jsonPath = path.join(OUTPUT_DIR, `${course.slug}.json`);

  if (fs.existsSync(pngPath) && !dryRun) {
    throw new Error(
      `Arquivo já existe: ${pngPath}. Use --force para sobrescrever.`
    );
  }

  if (dryRun) {
    return {
      course_id: course.course_id,
      slug: course.slug,
      modelo: DEFAULT_MODEL,
      qualidade: DEFAULT_QUALITY,
      tamanho: DEFAULT_SIZE,
      formato: DEFAULT_FORMAT,
      prompt: course.prompt,
      data: new Date().toISOString(),
      caminho_arquivo: pngPath,
      dry_run: true,
    };
  }

  const openai = new OpenAI({ apiKey });

  const response = await openai.images.generate({
    model: DEFAULT_MODEL,
    prompt: course.prompt,
    n: 1,
    size: DEFAULT_SIZE,
    quality: DEFAULT_QUALITY,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Resposta da OpenAI não contém imagem em b64_json.");
  }

  const buffer = Buffer.from(b64, "base64");
  fs.writeFileSync(pngPath, buffer);

  const record = {
    course_id: course.course_id,
    slug: course.slug,
    curso: course.curso,
    modelo: DEFAULT_MODEL,
    qualidade: DEFAULT_QUALITY,
    tamanho: DEFAULT_SIZE,
    formato: DEFAULT_FORMAT,
    prompt: course.prompt,
    data: new Date().toISOString(),
    caminho_arquivo: pngPath,
    hash_sha256: sha256(buffer),
    uso_api: response.usage || null,
    dry_run: false,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), "utf8");

  return record;
}

async function main() {
  const { slug, dryRun, force } = parseArgs();

  if (!slug) {
    console.error("Uso: node src/generate-ai-background.js --slug=<slug> [--dry-run] [--force]");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERRO: OPENAI_API_KEY não configurada.");
    process.exit(1);
  }

  console.log(`Buscando curso: ${slug}`);
  const course = await findCourse(slug);

  if (!course) {
    console.error(`Curso com slug "${slug}" não encontrado na planilha.`);
    process.exit(1);
  }

  console.log(`Curso encontrado: ${course.curso} (${course.course_id})`);
  console.log(`Prompt: ${course.prompt.slice(0, 120)}...`);

  if (dryRun) {
    console.log("\n[DRY-RUN] Validação OK. Nenhuma chamada à API será feita.");
    const record = await generateImage(course, true);
    console.log("\nRegistro simulado:");
    console.log(JSON.stringify(record, null, 2));
    console.log("\nNenhuma imagem foi gerada.");
    return;
  }

  if (force) {
    console.log("[FORCE] Sobrescrita habilitada.");
  }

  try {
    const record = await generateImage(course, false);
    console.log("\n================================");
    console.log("IMAGEM GERADA");
    console.log("================================");
    console.log(`Arquivo PNG: ${record.caminho_arquivo}`);
    console.log(`Arquivo JSON: ${record.caminho_arquivo.replace(/\.png$/, ".json")}`);
    console.log(`Hash SHA-256: ${record.hash_sha256}`);
  } catch (error) {
    console.error("\nERRO:");
    console.error(error.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
