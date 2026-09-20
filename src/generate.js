const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const sharp = require("sharp");

const {
  TEMPLATE,
  WIDTH,
  HEIGHT,
  createTextOverlay,
  loadFrameAssets,
  composeCourseCard,
  renderCourseCard,
  prepareBackgroundBuffer,
  normalizeDuration,
} = require("./render-card");
const { cleanUrl, downloadImage, getImageBuffer } = require("./image-cache");

const ROOT = path.resolve(__dirname, "..");

const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const OUTPUT_DIR = path.join(ROOT, "output");
const OUTPUT_TEST_DIR = path.join(OUTPUT_DIR, "teste-designer");
const OUTPUT_FINAL_DIR = path.join(OUTPUT_DIR, "final");

// =======================================================
// TEMPLATE VISUAL FINAL APROVADO - NÃO ALTERAR SEM SOLICITAÇÃO EXPLÍCITA
// =======================================================
// A configuração central do template de cards 1080x1080 está em
// src/render-card.js. Os valores abaixo são mantidos aqui apenas
// como referência local para facilitar leitura.
// =======================================================

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

  const background = await prepareBackgroundBuffer(sourceBuffer);

  const finalBuffer = await renderCourseCard(background, course);

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