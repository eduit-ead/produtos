/**
 * Serviço de produção individual de cursos.
 * Integra leitura da planilha, geração de fundo IA, upload manual e
 * renderização de cards usando o template Cruzeiro aprovado.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const { loadAllCourses, loadCourseBySlug } = require("./read-courses");
const { generateImage } = require("./generate-ai-background");
const { renderCourseCard, prepareBackgroundBuffer } = require("./render-card");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_DIR = path.join(ROOT, "output", "ai-catalog");
const MANIFEST_FILE = path.join(CATALOG_DIR, "manifest.json");
const FINAL_DIR = path.join(ROOT, "output", "final");
const WHATSAPP_DIR = path.join(ROOT, "output", "whatsapp");
const ASSETS_DIR = path.join(ROOT, "assets");

const ALLOWED_BG_EXT = new Set([".png", ".jpg", ".jpeg", ".svg"]);
const SLUG_REGEX = /^[a-zA-Z0-9_-]+$/;

function ensureCatalogDir() {
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
}

function courseDir(slug) {
  const dir = path.join(CATALOG_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fundoIaPath(slug) {
  return path.join(courseDir(slug), `${slug}-fundo-ia.png`);
}

function cardIaPath(slug) {
  return path.join(courseDir(slug), `${slug}-card-ia.png`);
}

function fundoUploadPath(slug) {
  return path.join(courseDir(slug), `${slug}-fundo-upload.png`);
}

function currentCardPath(slug) {
  const png = path.join(FINAL_DIR, `${slug}.png`);
  if (fs.existsSync(png)) return png;
  const jpg = path.join(WHATSAPP_DIR, `${slug}.jpg`);
  if (fs.existsSync(jpg)) return jpg;
  return null;
}

function currentBackgroundPath(slug) {
  // Prioriza JPG como fundo original; fallback para card final.
  const jpg = path.join(WHATSAPP_DIR, `${slug}.jpg`);
  if (fs.existsSync(jpg)) return jpg;
  const png = path.join(FINAL_DIR, `${slug}.png`);
  if (fs.existsSync(png)) return png;
  return null;
}

function loadManifest() {
  ensureCatalogDir();
  if (!fs.existsSync(MANIFEST_FILE)) {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    if (!manifest.courses) {
      manifest.courses = {};
    } else if (Array.isArray(manifest.courses)) {
      // Migra manifesto legado (array) para mapa por slug.
      const map = {};
      for (const entry of manifest.courses) {
        if (entry && entry.slug) {
          map[entry.slug] = entry;
        }
      }
      manifest.courses = map;
    }
    return manifest;
  } catch {
    return { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), courses: {} };
  }
}

function saveManifest(manifest) {
  ensureCatalogDir();
  manifest.updatedAt = new Date().toISOString();
  const tmp = path.join(CATALOG_DIR, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, MANIFEST_FILE);
}

function getManifestEntry(manifest, slug) {
  return manifest.courses[slug] || null;
}

function setManifestEntry(manifest, slug, partial) {
  const existing = manifest.courses[slug] || {};
  manifest.courses[slug] = {
    ...existing,
    slug,
    ...partial,
  };
}

function resolveStatus(manifestEntry, slug) {
  if (manifestEntry?.status === "aprovado") return "aprovado";
  if (manifestEntry?.status === "rejeitado") return "rejeitado";
  if (manifestEntry?.status === "erro") return "erro";
  if (manifestEntry?.status === "gerando") return "gerando";
  const hasCard = fs.existsSync(cardIaPath(slug));
  const hasBg = fs.existsSync(fundoIaPath(slug)) || fs.existsSync(fundoUploadPath(slug));
  if (hasCard) return "gerado";
  if (hasBg) return "gerado";
  return "pendente";
}

function validateSlug(slug) {
  if (!slug || !SLUG_REGEX.test(slug)) {
    throw new Error("Slug inválido.");
  }
  if (slug.includes("..") || path.basename(slug) !== slug) {
    throw new Error("Slug inválido.");
  }
  return slug;
}

function fileUrl(relPath) {
  if (!relPath || !fs.existsSync(relPath)) return null;
  return "/output/" + path.relative(path.join(ROOT, "output"), relPath).replace(/\\/g, "/");
}

async function listCourses() {
  const [courses, manifest] = await Promise.all([loadAllCourses(), loadManifest()]);
  return courses.map((course) => {
    const slug = course.slug;
    const entry = getManifestEntry(manifest, slug);
    const status = resolveStatus(entry, slug);
    return {
      course_id: course.course_id,
      slug,
      curso: course.curso,
      modalidade: course.modalidade,
      formacao: course.formacao,
      duracao: course.duracao,
      conteudo_status: course.conteudo_status,
      status,
      current_card_url: fileUrl(currentCardPath(slug)),
      current_background_url: fileUrl(currentBackgroundPath(slug)),
      ai_background_url: fileUrl(fundoIaPath(slug)),
      ai_card_url: fileUrl(cardIaPath(slug)),
      updated_at: entry?.updatedAt || null,
    };
  });
}

async function getCourseDetail(slug) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    return null;
  }
  const manifest = loadManifest();
  const entry = getManifestEntry(manifest, validSlug);
  const status = resolveStatus(entry, validSlug);

  return {
    course_id: course.course_id,
    slug: course.slug,
    curso: course.curso,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
    descricao_curta: course.descricao_curta,
    prompt_imagem: course.prompt_imagem,
    conteudo_status: course.conteudo_status,
    status,
    current_card_url: fileUrl(currentCardPath(validSlug)),
    current_background_url: fileUrl(currentBackgroundPath(validSlug)),
    ai_background_url: fileUrl(fundoIaPath(validSlug)),
    ai_card_url: fileUrl(cardIaPath(validSlug)),
    ai_upload_url: fileUrl(fundoUploadPath(validSlug)),
    manifest: entry || null,
  };
}

async function createMockBackground(outputPath) {
  const buffer = await sharp({
    create: { width: 1080, height: 1080, channels: 3, background: { r: 11, g: 17, b: 32 } },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(outputPath, buffer);
  return buffer;
}

async function generateAIBackground(slug, { dryRun = false } = {}) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  const manifest = loadManifest();
  setManifestEntry(manifest, validSlug, {
    course_id: course.course_id,
    slug: validSlug,
    curso: course.curso,
    status: "gerando",
    prompt: course.prompt_imagem,
    error: null,
    updatedAt: new Date().toISOString(),
  });
  saveManifest(manifest);

  const outputDir = courseDir(validSlug);
  const outputPath = fundoIaPath(validSlug);

  try {
    if (dryRun || !process.env.OPENAI_API_KEY) {
      // Sem chamada real: gera um fundo placeholder para permitir testes de renderização.
      await createMockBackground(outputPath);
      setManifestEntry(manifest, validSlug, {
        course_id: course.course_id,
        slug: validSlug,
        curso: course.curso,
        status: "gerado",
        prompt: course.prompt_imagem,
        backgroundPath: path.relative(CATALOG_DIR, outputPath),
        model: "mock",
        quality: "mock",
        size: "1080x1080",
        costUsd: 0,
        dryRun: true,
        generatedAt: new Date().toISOString(),
        error: null,
        updatedAt: new Date().toISOString(),
      });
    } else {
      const record = await generateImage(
        { course_id: course.course_id, slug: validSlug, curso: course.curso, prompt: course.prompt_imagem },
        { outputDir }
      );
      setManifestEntry(manifest, validSlug, {
        course_id: course.course_id,
        slug: validSlug,
        curso: course.curso,
        status: "gerado",
        prompt: record.prompt,
        backgroundPath: path.relative(CATALOG_DIR, record.caminho_arquivo),
        model: record.modelo,
        quality: record.qualidade,
        size: record.tamanho,
        costUsd: record.custo_estimado_usd?.totalCostUsd ?? 0,
        dryRun: false,
        generatedAt: record.data,
        error: null,
        updatedAt: new Date().toISOString(),
      });
    }
    saveManifest(manifest);
    return getManifestEntry(manifest, validSlug);
  } catch (err) {
    setManifestEntry(manifest, validSlug, {
      status: "erro",
      error: err.message,
      updatedAt: new Date().toISOString(),
    });
    saveManifest(manifest);
    throw err;
  }
}

async function uploadBackground(slug, buffer, ext) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  const lowerExt = String(ext || "").toLowerCase();
  if (!ALLOWED_BG_EXT.has(lowerExt)) {
    throw new Error("Formato de imagem não permitido.");
  }

  let finalBuffer = buffer;
  if (lowerExt === ".svg") {
    finalBuffer = await sharp(buffer, { density: 144 }).png().toBuffer();
  }

  const outputPath = fundoUploadPath(validSlug);
  fs.writeFileSync(outputPath, finalBuffer);

  const manifest = loadManifest();
  setManifestEntry(manifest, validSlug, {
    course_id: course.course_id,
    slug: validSlug,
    curso: course.curso,
    status: "gerado",
    backgroundPath: path.relative(CATALOG_DIR, outputPath),
    uploadPath: path.relative(CATALOG_DIR, outputPath),
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveManifest(manifest);

  return { path: outputPath, size: finalBuffer.length };
}

async function renderCourse(slug) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  let backgroundBuffer = null;
  let source = "ai";

  const aiPath = fundoIaPath(validSlug);
  const uploadPath = fundoUploadPath(validSlug);
  const fallbackPath = currentBackgroundPath(validSlug);

  if (fs.existsSync(aiPath)) {
    backgroundBuffer = fs.readFileSync(aiPath);
  } else if (fs.existsSync(uploadPath)) {
    backgroundBuffer = fs.readFileSync(uploadPath);
    source = "upload";
  } else if (fallbackPath) {
    backgroundBuffer = fs.readFileSync(fallbackPath);
    source = "fallback";
  } else {
    throw new Error("Nenhum fundo disponível para renderizar o card.");
  }

  const prepared = await prepareBackgroundBuffer(backgroundBuffer);
  const cardBuffer = await renderCourseCard(prepared, {
    curso: course.curso,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
  });

  const cardPath = cardIaPath(validSlug);
  fs.writeFileSync(cardPath, cardBuffer);

  const manifest = loadManifest();
  setManifestEntry(manifest, validSlug, {
    course_id: course.course_id,
    slug: validSlug,
    curso: course.curso,
    status: resolveStatus(getManifestEntry(manifest, validSlug), validSlug) === "aprovado" ? "aprovado" : "gerado",
    cardPath: path.relative(CATALOG_DIR, cardPath),
    cardSize: cardBuffer.length,
    cardSource: source,
    renderedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveManifest(manifest);

  return { cardPath, size: cardBuffer.length };
}

function setStatus(slug, newStatus) {
  const validSlug = validateSlug(slug);
  const manifest = loadManifest();
  const entry = getManifestEntry(manifest, validSlug) || {};
  const now = new Date().toISOString();
  setManifestEntry(manifest, validSlug, {
    ...entry,
    status: newStatus,
    updatedAt: now,
    ...(newStatus === "aprovado" ? { approvedAt: now } : {}),
    ...(newStatus === "rejeitado" ? { rejectedAt: now } : {}),
  });
  saveManifest(manifest);
  return getManifestEntry(manifest, validSlug);
}

async function approveCourse(slug) {
  return setStatus(slug, "aprovado");
}

async function rejectCourse(slug) {
  return setStatus(slug, "rejeitado");
}

module.exports = {
  listCourses,
  getCourseDetail,
  generateAIBackground,
  uploadBackground,
  renderCourse,
  approveCourse,
  rejectCourse,
  loadManifest,
  saveManifest,
  validateSlug,
  CATALOG_DIR,
  MANIFEST_FILE,
};
