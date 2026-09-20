/**
 * Rotas da API do editor de templates.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { validateTemplate, createEmptyTemplate } = require("./schema/template-schema");
const { renderTemplate } = require("./renderer");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const TEMPLATES_DIR = path.join(DATA_DIR, "templates");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_MIMETYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
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
    const errors = validateTemplate(template);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Template inválido.", details: errors });
    }

    template.metadata = {
      ...(template.metadata || {}),
      updatedAt: new Date().toISOString(),
    };

    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), "utf8");
    res.json({ ok: true, id });
  });

  // Criar template vazio
  router.post("/templates", express.json({ limit: "2mb" }), (req, res) => {
    const { width = 1080, height = 1080 } = req.body || {};
    const template = createEmptyTemplate(width, height);
    const filePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), "utf8");
    res.json({ ok: true, template });
  });

  // Upload de asset
  router.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }

    const ext = ALLOWED_MIMETYPES[req.file.mimetype];
    const assetId = generateAssetId(req.file.buffer, ext);
    const assetPath = path.join(ASSETS_DIR, assetId);

    fs.writeFileSync(assetPath, req.file.buffer);

    res.json({
      ok: true,
      assetId,
      originalName: sanitizeFilename(req.file.originalname),
      mimetype: req.file.mimetype,
      size: req.file.buffer.length,
      url: `/api/assets/${assetId}`,
    });
  });

  // Servir asset
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
        : ext === ".svg"
        ? "image/svg+xml"
        : "application/octet-stream";

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(assetPath);
  });

  // Listar assets
  router.get("/assets", (req, res) => {
    const files = fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => [".png", ".jpg", ".jpeg", ".svg"].includes(path.extname(f).toLowerCase()))
      .map((f) => ({
        assetId: f,
        url: `/api/assets/${f}`,
        size: fs.statSync(path.join(ASSETS_DIR, f)).size,
      }));
    res.json(files);
  });

  // Renderizar template
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createRouter };
