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
const { getImageBuffer } = require("./image-cache");
const { courseFiles } = require("./batch/naming");
const { readMetadata, writeMetadata } = require("./batch/metadata");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CATALOG_DIR = path.join(ROOT, "output", "ai-catalog");
const CATALOG_DIR = process.env.AI_CATALOG_DIR
  ? path.resolve(process.env.AI_CATALOG_DIR)
  : DEFAULT_CATALOG_DIR;
const MANIFEST_FILE = path.join(CATALOG_DIR, "manifest.json");
const FINAL_DIR = path.join(ROOT, "output", "final");

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

function fundoPath(slug) {
  const files = courseFiles(slug);
  return path.join(courseDir(slug), files.fundo);
}

function cardPath(slug) {
  const files = courseFiles(slug);
  return path.join(courseDir(slug), files.card);
}

function currentCardPath(slug) {
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
    course_id: partial.course_id ?? existing.course_id,
    slug,
    curso: partial.curso ?? existing.curso,
    status: partial.status ?? existing.status ?? "pendente",
    prompt: partial.prompt ?? existing.prompt,
    backgroundPath: partial.backgroundPath ?? existing.backgroundPath,
    cardPath: partial.cardPath ?? existing.cardPath,
    selectedBackground: partial.selectedBackground ?? existing.selectedBackground,
    model: partial.model ?? existing.model,
    quality: partial.quality ?? existing.quality,
    size: partial.size ?? existing.size,
    costUsd: partial.costUsd ?? existing.costUsd ?? 0,
    usage: partial.usage ?? existing.usage,
    dryRun: partial.dryRun ?? existing.dryRun,
    attempts: partial.attempts ?? existing.attempts ?? 0,
    error: partial.error ?? existing.error,
    generatedAt: partial.generatedAt ?? existing.generatedAt,
    uploadedAt: partial.uploadedAt ?? existing.uploadedAt,
    renderedAt: partial.renderedAt ?? existing.renderedAt,
    approvedAt: partial.approvedAt ?? existing.approvedAt,
    rejectedAt: partial.rejectedAt ?? existing.rejectedAt,
    updatedAt: new Date().toISOString(),
  };
}

function resolveStatus(manifestEntry, slug) {
  if (manifestEntry?.status === "aprovado") return "aprovado";
  if (manifestEntry?.status === "rejeitado") return "rejeitado";
  if (manifestEntry?.status === "erro") return "erro";
  if (manifestEntry?.status === "gerando") return "gerando";
  const hasBg = fs.existsSync(fundoPath(slug));
  const hasCard = fs.existsSync(cardPath(slug));
  if (hasCard || hasBg) return "gerado";
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

function catalogFileUrl(slug, filename) {
  const filePath = path.join(CATALOG_DIR, slug, filename);
  if (!fs.existsSync(filePath)) return null;
  return `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
}

function fileUrl(relPath) {
  if (!relPath || !fs.existsSync(relPath)) return null;
  const relative = path.relative(path.join(ROOT, "output"), relPath);
  if (relative && !relative.startsWith("..")) {
    const posix = relative.replace(/\\/g, "/");
    // Serve output files only through controlled API routes.
    return `/api/output/${posix}`;
  }
  return null;
}

function isPathInsideCourseDir(slug, candidatePath) {
  if (!candidatePath) return false;
  const resolved = path.resolve(CATALOG_DIR, candidatePath);
  const course = path.resolve(courseDir(slug));
  return resolved === course || resolved.startsWith(course + path.sep);
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
      current_background_url: course.image_url || null,
      ai_background_url: catalogFileUrl(slug, `${slug}-fundo.png`),
      ai_card_url: catalogFileUrl(slug, `${slug}-card.png`),
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
    current_background_url: course.image_url || null,
    ai_background_url: catalogFileUrl(validSlug, `${validSlug}-fundo.png`),
    ai_card_url: catalogFileUrl(validSlug, `${validSlug}-card.png`),
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

async function generateAIBackground(slug, { dryRun = false, prompt = null } = {}) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  const usedPrompt = typeof prompt === "string" && prompt.trim() ? prompt.trim() : course.prompt_imagem;

  if (!dryRun && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada. Configure a chave para gerar imagens reais.");
  }

  const manifest = loadManifest();
  setManifestEntry(manifest, validSlug, {
    course_id: course.course_id,
    curso: course.curso,
    status: "gerando",
    prompt: usedPrompt,
    error: null,
  });
  saveManifest(manifest);

  const outputDir = courseDir(validSlug);
  const outputPath = fundoPath(validSlug);

  try {
    if (dryRun) {
      await createMockBackground(outputPath);
      setManifestEntry(manifest, validSlug, {
        course_id: course.course_id,
        curso: course.curso,
        status: "gerado",
        prompt: usedPrompt,
        backgroundPath: path.relative(CATALOG_DIR, outputPath),
        selectedBackground: "ai",
        model: "mock",
        quality: "mock",
        size: "1080x1080",
        costUsd: 0,
        dryRun: true,
        generatedAt: new Date().toISOString(),
        error: null,
      });
    } else {
      const record = await generateImage(
        { course_id: course.course_id, slug: validSlug, curso: course.curso, prompt: usedPrompt },
        { outputDir }
      );
      setManifestEntry(manifest, validSlug, {
        course_id: course.course_id,
        curso: course.curso,
        status: "gerado",
        prompt: record.prompt,
        backgroundPath: path.relative(CATALOG_DIR, record.caminho_arquivo),
        selectedBackground: "ai",
        model: record.modelo,
        quality: record.qualidade,
        size: record.tamanho,
        costUsd: record.custo_estimado_usd?.totalCostUsd ?? 0,
        usage: record.uso_api,
        dryRun: false,
        generatedAt: record.data,
        error: null,
      });
    }
    saveManifest(manifest);
    return getManifestEntry(manifest, validSlug);
  } catch (err) {
    const entry = getManifestEntry(manifest, validSlug) || {};
    setManifestEntry(manifest, validSlug, {
      ...entry,
      status: "erro",
      error: err.message,
      attempts: (entry.attempts || 0) + 1,
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

  // Normaliza para PNG verdadeiro, independentemente do formato de entrada.
  const normalizedBuffer = await sharp(buffer, lowerExt === ".svg" ? { density: 144 } : undefined)
    .png()
    .toBuffer();

  const outputPath = fundoPath(validSlug);
  fs.writeFileSync(outputPath, normalizedBuffer);

  const manifest = loadManifest();
  const entry = getManifestEntry(manifest, validSlug) || {};
  setManifestEntry(manifest, validSlug, {
    ...entry,
    course_id: course.course_id,
    curso: course.curso,
    status: resolveStatus(entry, validSlug),
    backgroundPath: path.relative(CATALOG_DIR, outputPath),
    selectedBackground: "upload",
    uploadedAt: new Date().toISOString(),
    error: null,
  });
  saveManifest(manifest);

  return { path: outputPath, size: normalizedBuffer.length };
}

async function resolveBackgroundBuffer(slug, manifestEntry, course) {
  // 1. Fundo selecionado explicitamente no manifesto (upload ou ia), se válido.
  if (manifestEntry?.selectedBackground && manifestEntry?.backgroundPath) {
    const candidate = path.resolve(CATALOG_DIR, manifestEntry.backgroundPath);
    if (isPathInsideCourseDir(slug, candidate) && fs.existsSync(candidate)) {
      return fs.readFileSync(candidate);
    }
  }

  // 2. Fundo gerado ou enviado (nome determinístico único).
  const bgPath = fundoPath(slug);
  if (fs.existsSync(bgPath)) {
    return fs.readFileSync(bgPath);
  }

  // 3. Imagem original da planilha (nunca output/final ou output/whatsapp).
  if (course?.image_url) {
    return getImageBuffer(course.image_url);
  }

  throw new Error("Nenhum fundo disponível para renderizar o card.");
}

async function renderCourse(slug) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  const manifest = loadManifest();
  const entry = getManifestEntry(manifest, validSlug);

  const backgroundBuffer = await resolveBackgroundBuffer(validSlug, entry, course);
  const prepared = await prepareBackgroundBuffer(backgroundBuffer);
  const cardBuffer = await renderCourseCard(prepared, {
    curso: course.curso,
    modalidade: course.modalidade,
    formacao: course.formacao,
    duracao: course.duracao,
  });

  const cardFile = cardPath(validSlug);
  fs.writeFileSync(cardFile, cardBuffer);

  const nextStatus = resolveStatus(entry, validSlug) === "aprovado" ? "aprovado" : "gerado";
  setManifestEntry(manifest, validSlug, {
    course_id: course.course_id,
    curso: course.curso,
    status: nextStatus,
    cardPath: path.relative(CATALOG_DIR, cardFile),
    cardSize: cardBuffer.length,
    renderedAt: new Date().toISOString(),
    error: null,
  });
  saveManifest(manifest);

  return { cardPath: cardFile, size: cardBuffer.length };
}

async function setCourseStatus(slug, newStatus) {
  const validSlug = validateSlug(slug);
  const course = await loadCourseBySlug(validSlug);
  if (!course) {
    throw new Error("Curso não encontrado.");
  }

  if (newStatus === "aprovado" && !fs.existsSync(cardPath(validSlug))) {
    throw new Error("Não é possível aprovar sem card renderizado.");
  }

  const manifest = loadManifest();
  const entry = getManifestEntry(manifest, validSlug) || {};
  const now = new Date().toISOString();
  setManifestEntry(manifest, validSlug, {
    ...entry,
    course_id: course.course_id,
    curso: course.curso,
    status: newStatus,
    approvedAt: newStatus === "aprovado" ? now : entry.approvedAt,
    rejectedAt: newStatus === "rejeitado" ? now : entry.rejectedAt,
    error: null,
  });
  saveManifest(manifest);
  return getManifestEntry(manifest, validSlug);
}

function syncMetadataStatus(slug, newStatus) {
  const metadata = readMetadata(CATALOG_DIR, slug);
  if (metadata) {
    metadata.status = newStatus;
    metadata.timestamps = metadata.timestamps || {};
    metadata.timestamps.approved_at = metadata.timestamps.approved_at || new Date().toISOString();
    metadata.timestamps.rejected_at = metadata.timestamps.rejected_at || new Date().toISOString();
    if (newStatus === "aprovado") metadata.timestamps.approved_at = new Date().toISOString();
    if (newStatus === "rejeitado") metadata.timestamps.rejected_at = new Date().toISOString();
    writeMetadata(CATALOG_DIR, slug, metadata);
  }
}

async function approveCourse(slug) {
  const record = await setCourseStatus(slug, "aprovado");
  syncMetadataStatus(slug, "aprovado");
  return record;
}

async function rejectCourse(slug) {
  const record = await setCourseStatus(slug, "rejeitado");
  syncMetadataStatus(slug, "rejeitado");
  return record;
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
