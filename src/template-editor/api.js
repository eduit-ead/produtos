/**
 * Rotas da API do editor de templates e do catálogo de imagens.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { validateTemplate, createEmptyTemplate } = require("./schema/template-schema");
const { renderTemplate } = require("./renderer");
const {
  listCourses,
  getCourseDetail,
  generateAIBackground,
  uploadBackground,
  renderCourse,
  approveCourse,
  rejectCourse,
  CATALOG_DIR,
} = require("../course-production-service");
const { LocalStorageProvider } = require("../storage/local-storage-provider");
const { BatchExecutor } = require("../batch/executor");
const { listJobs, readJob, writeJob } = require("../batch/job");
const {
  getCatalogDir,
  listMetadata,
  readMetadata,
  writeMetadata,
  updateMetadataUrls,
  createMetadata,
  sha256,
} = require("../batch/metadata");
const { courseFiles } = require("../batch/naming");
const { convertCardToWhatsAppJpeg } = require("../whatsapp-image");
const {
  addImageColumnsIfNeeded,
  buildSyncPlan,
  dryRunSyncPlan,
  syncWorkbook,
  exportUpdatedSpreadsheet,
  loadWorkbook,
} = require("../xlsx-sync");
const { loadCourseBySlug, loadAllCourses, INPUT_FILE } = require("../read-courses");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const TEMPLATES_DIR = path.join(DATA_DIR, "templates");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const BACKUPS_DIR = path.join(__dirname, "..", "..", "input", "backups");
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Apenas PNG/JPEG são armazenados. SVG é rasterizado para PNG no upload.
const ALLOWED_MIMETYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const SAVED_MIMETYPES = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
};

function ensureDirs() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || "asset").normalize("NFD"));
  const safe = base
    .replace(/[^\w.\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/\.(?![^.]*$)/g, "_")
    .slice(0, 100);
  return safe || "asset";
}

function generateAssetId(buffer, ext) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  return `asset-${Date.now()}-${hash}.${ext}`;
}

function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  fs.writeFileSync(tmpFile, data, "utf8");
  fs.renameSync(tmpFile, filePath);
}

async function rasterizeSvg(buffer) {
  // Usa densidade razoável para SVG; limite de dimensões é aplicado pelo sharp por padrão.
  return sharp(buffer, { density: 144 })
    .png()
    .toBuffer();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = ALLOWED_MIMETYPES[file.mimetype];
    if (!ext) {
      return cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

function createRouter() {
  const router = express.Router();
  ensureDirs();

  const catalogDir = getCatalogDir();
  const storage = new LocalStorageProvider(catalogDir);
  const executor = new BatchExecutor({ catalogDir, storageProvider: storage });

  // Listar templates
  router.get("/templates", (req, res) => {
    const files = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = path.basename(f, ".json");
        return { id, name: id };
      });
    res.json(files);
  });

  // Carregar template
  router.get("/templates/:id", (req, res) => {
    const id = path.basename(req.params.id);
    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Template não encontrado." });
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Erro ao ler template." });
    }
  });

  // Salvar template
  router.post("/templates/:id", express.json({ limit: "2mb" }), (req, res) => {
    const id = path.basename(req.params.id);
    if (!id || id.startsWith(".")) {
      return res.status(400).json({ error: "ID de template inválido." });
    }

    const template = req.body;
    const errors = validateTemplate(template, { routeId: id });
    if (errors.length > 0) {
      return res.status(400).json({ error: "Template inválido.", details: errors });
    }

    template.metadata = {
      ...(template.metadata || {}),
      updatedAt: new Date().toISOString(),
    };

    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
    writeFileAtomic(filePath, JSON.stringify(template, null, 2));
    res.json({ ok: true, id });
  });

  // Criar template vazio
  router.post("/templates", express.json({ limit: "2mb" }), (req, res) => {
    const { width = 1080, height = 1080 } = req.body || {};
    const template = createEmptyTemplate(width, height);
    const filePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
    writeFileAtomic(filePath, JSON.stringify(template, null, 2));
    res.json({ ok: true, template });
  });

  // Upload de asset
  router.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }

    try {
      let buffer = req.file.buffer;
      let ext = ALLOWED_MIMETYPES[req.file.mimetype];
      let mimetype = req.file.mimetype;

      if (req.file.mimetype === "image/svg+xml") {
        buffer = await rasterizeSvg(buffer);
        ext = "png";
        mimetype = "image/png";
      }

      const assetId = generateAssetId(buffer, ext);
      const assetPath = path.join(ASSETS_DIR, assetId);

      fs.writeFileSync(assetPath, buffer);

      res.json({
        ok: true,
        assetId,
        originalName: sanitizeFilename(req.file.originalname),
        mimetype,
        size: buffer.length,
        url: `/api/assets/${assetId}`,
      });
    } catch (err) {
      console.error(err);
      return res.status(400).json({ error: "Falha ao processar imagem.", details: err.message });
    }
  });

  // Servir asset (apenas PNG/JPEG; nunca SVG bruto)
  router.get("/assets/:assetId", (req, res) => {
    const assetId = path.basename(req.params.assetId);
    const assetPath = path.join(ASSETS_DIR, assetId);

    if (!fs.existsSync(assetPath)) {
      return res.status(404).json({ error: "Asset não encontrado." });
    }

    const ext = path.extname(assetId).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : null;

    if (!mime) {
      return res.status(400).json({ error: "Formato de asset não suportado." });
    }

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(assetPath);
  });

  // Listar assets
  router.get("/assets", (req, res) => {
    const files = fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => [".png", ".jpg", ".jpeg"].includes(path.extname(f).toLowerCase()))
      .map((f) => ({
        assetId: f,
        url: `/api/assets/${f}`,
        size: fs.statSync(path.join(ASSETS_DIR, f)).size,
      }));
    res.json(files);
  });

  // Renderizar template salvo
  router.post("/render/:id", express.json({ limit: "1mb" }), async (req, res) => {
    const id = path.basename(req.params.id);
    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Template não encontrado." });
    }

    try {
      const template = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const buffer = await renderTemplate(template, req.body || {});
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch (err) {
      console.error(err);
      const status = err.message && err.message.startsWith("Template inválido") ? 400 : 500;
      return res.status(status).json({ error: err.message || "Erro ao renderizar." });
    }
  });

  // Renderizar template JSON em memória
  router.post("/render", express.json({ limit: "2mb" }), async (req, res) => {
    const { template, values } = req.body || {};
    const errors = validateTemplate(template);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Template inválido.", details: errors });
    }

    try {
      const buffer = await renderTemplate(template, values || {});
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message || "Erro ao renderizar." });
    }
  });

  // === Controlled output file serving ===
  const OUTPUT_DIR = path.join(__dirname, "..", "..", "output");
  const SLUG_FILENAME_REGEX = /^[A-Za-z0-9_-]+$/;
  function serveOutputFile(req, res, subPathFn) {
    const slug = req.params.slug;
    if (!slug || !SLUG_FILENAME_REGEX.test(slug)) {
      return res.status(400).json({ error: "Slug inválido." });
    }
    const filePath = path.join(OUTPUT_DIR, subPathFn(slug));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) {
      return res.status(400).json({ error: "Caminho inválido." });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(filePath);
  }

  router.get("/output/final/:slug.png", (req, res) => {
    serveOutputFile(req, res, (slug) => path.join("final", `${slug}.png`));
  });

  router.get("/output/whatsapp/:slug.jpg", (req, res) => {
    serveOutputFile(req, res, (slug) => path.join("whatsapp", `${slug}.jpg`));
  });

  // === Health ===
  router.get("/health", async (req, res) => {
    const storageHealth = await storage.healthCheck();
    res.json({
      ok: storageHealth.ok,
      storage: storageHealth,
      timestamp: new Date().toISOString(),
    });
  });

  // === Cursos ===
  const EXPECTED_COURSE_ERRORS = new Set([
    "Slug inválido.",
    "Curso não encontrado.",
    "Nenhum fundo disponível para renderizar o card.",
    "Não é possível aprovar sem card renderizado.",
    "OPENAI_API_KEY não configurada. Configure a chave para gerar imagens reais.",
    "Formato de imagem não permitido.",
    "URL de imagem inválida.",
  ]);

  function isExpectedCourseError(err) {
    return EXPECTED_COURSE_ERRORS.has(err.message);
  }

  router.get("/courses", async (req, res) => {
    try {
      const courses = await listCourses();
      res.json(courses);
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      res.status(500).json({ error: err.message || "Erro ao listar cursos." });
    }
  });

  router.get("/courses/:slug", async (req, res) => {
    try {
      const course = await getCourseDetail(req.params.slug);
      if (!course) {
        return res.status(404).json({ error: "Curso não encontrado." });
      }
      res.json(course);
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." ? 400 : 500;
      res.status(status).json({ error: err.message || "Erro ao carregar curso." });
    }
  });

  router.post("/courses/:slug/generate", express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await generateAIBackground(req.params.slug, {
        dryRun: body.dryRun === true,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      });
      res.json({ ok: true, record: result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status =
        err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 400;
      res.status(status).json({ error: err.message || "Erro ao gerar fundo." });
    }
  });

  router.post("/courses/:slug/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const result = await uploadBackground(req.params.slug, req.file.buffer, ext);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 400;
      res.status(status).json({ error: err.message || "Erro no upload." });
    }
  });

  router.post("/courses/:slug/render", async (req, res) => {
    try {
      const result = await renderCourse(req.params.slug);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 500;
      res.status(status).json({ error: err.message || "Erro ao renderizar card." });
    }
  });

  router.post("/courses/:slug/approve", async (req, res) => {
    try {
      const record = await approveCourse(req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." ? 400 : 400;
      res.status(status).json({ error: err.message || "Erro ao aprovar." });
    }
  });

  router.post("/courses/:slug/reject", async (req, res) => {
    try {
      const record = await rejectCourse(req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." ? 400 : 400;
      res.status(status).json({ error: err.message || "Erro ao rejeitar." });
    }
  });

  // Gerar imagem WhatsApp a partir do card renderizado no catálogo.
  router.post("/courses/:slug/whatsapp", async (req, res) => {
    try {
      const catalogDir = getCatalogDir();
      const course = await loadCourseBySlug(req.params.slug);
      if (!course) {
        return res.status(404).json({ error: "Curso não encontrado." });
      }

      let metadata = readMetadata(catalogDir, course.slug);
      if (!metadata) {
        metadata = createMetadata(course);
      }

      const cardKey = metadata.storage.keys.card;
      if (!(await storage.exists(cardKey))) {
        return res.status(400).json({ error: "Card ainda não foi renderizado." });
      }

      const cardPath = storage.resolveLocalPath(cardKey);
      const cardBuffer = fs.readFileSync(cardPath);
      const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);

      await storage.save(metadata.storage.keys.whatsapp, whatsappBuffer, {
        contentType: "image/jpeg",
      });

      metadata.hashes.whatsapp = sha256(whatsappBuffer);
      metadata.timestamps.whatsapp_at = new Date().toISOString();
      metadata.status = metadata.status === "aprovado" ? "aprovado" : "pronto_revisao";
      await updateMetadataUrls(metadata, storage);
      writeMetadata(catalogDir, course.slug, metadata);

      res.json({
        ok: true,
        slug: course.slug,
        whatsapp_url: metadata.urls.whatsapp,
        whatsapp_file: metadata.files.whatsapp,
        size: whatsappBuffer.length,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao gerar imagem WhatsApp." });
    }
  });

  // === Catálogo local ===
  router.get("/catalog/:slug/:file", (req, res) => {
    const slug = req.params.slug;
    const file = req.params.file;
    const files = courseFiles(slug);
    const ALLOWED_FILES = new Set([
      `${slug}-fundo-ia.png`,
      `${slug}-card-ia.png`,
      `${slug}-fundo-upload.png`,
      files.fundo,
      files.card,
      files.whatsapp,
    ]);
    if (!slug || !file || !ALLOWED_FILES.has(file)) {
      return res.status(400).json({ error: "Arquivo inválido." });
    }
    const filePath = path.join(getCatalogDir(), slug, file);
    const resolved = path.resolve(filePath);
    const courseDirResolved = path.resolve(path.join(getCatalogDir(), slug));
    if (
      !resolved.startsWith(courseDirResolved + path.sep) &&
      resolved !== courseDirResolved
    ) {
      return res.status(400).json({ error: "Caminho inválido." });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.sendFile(filePath);
  });

  // === Arquivos via StorageProvider ===
  router.get("/files/:encodedKey", (req, res) => {
    try {
      const key = Buffer.from(req.params.encodedKey, "base64url").toString("utf8");
      const filePath = storage.resolveLocalPath(key);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Arquivo não encontrado." });
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.sendFile(filePath);
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: "Chave inválida." });
    }
  });

  // === Lotes ===
  router.get("/batches", (req, res) => {
    try {
      const jobs = listJobs(getCatalogDir());
      res.json(jobs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao listar lotes." });
    }
  });

  router.post("/batches", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const body = req.body || {};
      const courses = Array.isArray(body.courses) ? body.courses : [];
      if (courses.length === 0) {
        return res.status(400).json({ error: "Lista de cursos vazia." });
      }
      const job = BatchExecutor.createJob(courses, {
        template_id: body.template_id,
        background_source: body.background_source,
        batch_size: body.batch_size,
        concurrency: body.concurrency,
        max_calls: body.max_calls,
        max_cost_usd: body.max_cost_usd,
        model: body.model,
        quality: body.quality,
        size: body.size,
        dryRun: body.dryRun !== false,
      });
      fs.mkdirSync(path.join(getCatalogDir(), "jobs"), { recursive: true });
      writeJob(getCatalogDir(), job);
      res.status(201).json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao criar lote." });
    }
  });

  router.get("/batches/:id", (req, res) => {
    try {
      const job = readJob(getCatalogDir(), req.params.id);
      if (!job) return res.status(404).json({ error: "Lote não encontrado." });
      res.json(job);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao ler lote." });
    }
  });

  router.get("/batches/:id/items", (req, res) => {
    try {
      const job = readJob(getCatalogDir(), req.params.id);
      if (!job) return res.status(404).json({ error: "Lote não encontrado." });
      res.json(job.courses);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao ler itens." });
    }
  });

  router.post("/batches/:id/start", async (req, res) => {
    try {
      const job = await executor.start(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao iniciar lote." });
    }
  });

  router.post("/batches/:id/pause", async (req, res) => {
    try {
      const job = await executor.pause(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao pausar lote." });
    }
  });

  router.post("/batches/:id/resume", async (req, res) => {
    try {
      const job = await executor.resume(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao retomar lote." });
    }
  });

  router.post("/batches/:id/cancel", async (req, res) => {
    try {
      const job = await executor.cancel(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao cancelar lote." });
    }
  });

  router.post("/batches/:id/retry-errors", async (req, res) => {
    try {
      const job = await executor.retryErrors(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao reprocessar erros." });
    }
  });

  router.post("/batches/:id/retry-rejected", async (req, res) => {
    try {
      const job = await executor.retryRejected(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao reprocessar rejeitados." });
    }
  });

  // === XLSX sync ===
  router.post("/xlsx/sync-preview", express.json(), async (req, res) => {
    try {
      const coursesMetadata = listMetadata(getCatalogDir());
      const workbook = await loadWorkbook(INPUT_FILE);
      addImageColumnsIfNeeded(workbook);
      const plan = buildSyncPlan(coursesMetadata, workbook, { approvedOnly: true });
      const report = dryRunSyncPlan(plan);
      res.json({ ok: true, mode: "dry-run", report });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao gerar preview de sincronização." });
    }
  });

  router.post("/xlsx/sync", express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return res.status(400).json({
          error: "Confirmação necessária. Envie { confirm: true } para sincronizar.",
        });
      }
      const coursesMetadata = listMetadata(getCatalogDir());
      const workbook = await loadWorkbook(INPUT_FILE);
      addImageColumnsIfNeeded(workbook);
      const plan = buildSyncPlan(coursesMetadata, workbook, { approvedOnly: true });

      if (plan.wouldChangeCount === 0) {
        return res.json({ ok: true, mode: "sync", report: dryRunSyncPlan(plan), backup: null });
      }

      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      const backupPath = path.join(BACKUPS_DIR, `cursos-${Date.now()}.xlsx`);
      await syncWorkbook(workbook, plan, backupPath);

      res.json({ ok: true, mode: "sync", report: dryRunSyncPlan(plan), backup: backupPath });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao sincronizar planilha." });
    }
  });

  router.post("/xlsx/export", express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const outputPath = body.outputPath || path.join(getCatalogDir(), "cursos-export.xlsx");
      const coursesMetadata = listMetadata(getCatalogDir());
      const report = await exportUpdatedSpreadsheet(coursesMetadata, outputPath);
      res.json({ ok: true, mode: "export", report, outputPath });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao exportar planilha." });
    }
  });

  // Middleware de erro: garante respostas JSON
  router.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) {
      return next(err);
    }
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Erro interno.";
    res.status(status >= 100 && status < 600 ? status : 500).json({ error: message });
  });

  return router;
}

module.exports = { createRouter };
