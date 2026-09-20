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
