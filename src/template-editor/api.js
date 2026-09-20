/**
 * Rotas da API do editor de templates.
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

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const TEMPLATES_DIR = path.join(DATA_DIR, "templates");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
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

  // Servir arquivos do catálogo de forma segura, independentemente de onde o
  // CATALOG_DIR esteja localizado (padrão ou temporário de teste).
  router.get("/catalog/:slug/:file", (req, res) => {
    const slug = req.params.slug;
    const file = req.params.file;
    const ALLOWED_FILES = new Set([
      `${slug}-fundo-ia.png`,
      `${slug}-card-ia.png`,
      `${slug}-fundo-upload.png`,
    ]);
    if (!slug || !file || !ALLOWED_FILES.has(file)) {
      return res.status(400).json({ error: "Arquivo inválido." });
    }
    const filePath = path.join(CATALOG_DIR, slug, file);
    const resolved = path.resolve(filePath);
    const courseDirResolved = path.resolve(path.join(CATALOG_DIR, slug));
    if (
      !resolved.startsWith(courseDirResolved + path.sep) &&
      resolved !== courseDirResolved
    ) {
      return res.status(400).json({ error: "Caminho inválido." });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.sendFile(filePath);
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
