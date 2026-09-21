/**
 * Rotas da API do editor de templates, catálogo de imagens e coleções.
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
const { renderSavedTemplate } = require("./renderer/render-saved-template");
const { RUNTIME } = require("../config/runtime");
const { generateStudioBackground, estimateImageCost } = require("./ai-background");
const courseService = require("../course-production-service");
const genericProduction = require("../production/generic-production-service");
const { createStorageProvider } = require("../storage");
const downloadRoutes = require("../batch/download-routes");
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
const { getSystemStatus } = require("./system-status");
const { courseFiles } = require("../batch/naming");
const { convertCardToWhatsAppJpeg } = require("../whatsapp-image");
const xlsxSync = require("../xlsx-sync");
const { loadCourseBySlug, loadAllCourses, INPUT_FILE } = require("../read-courses");
const { listCollections, loadCollection, saveCollection, deleteCollection, archiveCollection } = require("../collections/manager");
const ExcelJS = require("exceljs");
const { validateCollection, isSafeRelative, ROOT } = require("../collections/schema");
const { getDataSource } = require("../data-sources");
const { readPreview, readXlsxSheets, validatePrimaryKey } = require("../data-sources/raw-source-reader");

const TEMPLATES_DIR = RUNTIME.templatesDir;
const ASSETS_DIR = RUNTIME.assetsDir;
const IMPORTS_DIR = RUNTIME.importsDir;
const EXPORTS_DIR = RUNTIME.exportsDir;
const BACKUPS_DIR = path.join(__dirname, "..", "..", "input", "backups");
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const IMAGE_MIMETYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const DATA_MIMETYPES = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/json": "json",
  "text/json": "json",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/plain": "plain",
};

const DATA_EXTENSIONS = new Set([".xlsx", ".csv", ".json"]);

const SAVED_MIMETYPES = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
};

function ensureDirs() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.mkdirSync(IMPORTS_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function decodeRuntimeAssets(runtimeAssets = {}) {
  const decoded = {};
  for (const [key, value] of Object.entries(runtimeAssets)) {
    if (typeof value === "string") {
      decoded[key] = Buffer.from(value, "base64");
    } else if (Buffer.isBuffer(value)) {
      decoded[key] = value;
    }
  }
  return decoded;
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
  return sharp(buffer, { density: 144 }).png().toBuffer();
}

function imageFileFilter(req, file, cb) {
  const ext = IMAGE_MIMETYPES[file.mimetype];
  if (!ext) {
    return cb(new Error(`Tipo de imagem não permitido: ${file.mimetype}`));
  }
  cb(null, true);
}

function dataFileFilter(req, file, cb) {
  const lowerExt = path.extname(file.originalname || "").toLowerCase();
  const extFromMime = DATA_MIMETYPES[file.mimetype];
  const isPlainCsv = file.mimetype === "text/plain" && lowerExt === ".csv";
  if (!DATA_EXTENSIONS.has(lowerExt) || (!extFromMime && !isPlainCsv)) {
    return cb(new Error(`Formato de dados não permitido. Use XLSX, CSV ou JSON.`));
  }
  cb(null, true);
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: imageFileFilter,
});

const dataUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: dataFileFilter,
});

const upload = imageUpload;

function createRouter() {
  const router = express.Router();
  ensureDirs();

  const executor = new BatchExecutor({ catalogDir: getCatalogDir() });

  // ============================================================
  // Templates
  // ============================================================

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

  router.post("/templates", express.json({ limit: "2mb" }), (req, res) => {
    const { width = 1080, height = 1080 } = req.body || {};
    const template = createEmptyTemplate(width, height);
    const filePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
    writeFileAtomic(filePath, JSON.stringify(template, null, 2));
    res.json({ ok: true, template });
  });

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
    template.metadata = { ...(template.metadata || {}), updatedAt: new Date().toISOString() };
    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
    writeFileAtomic(filePath, JSON.stringify(template, null, 2));
    res.json({ ok: true, id });
  });

  router.delete("/templates/:id", (req, res) => {
    const id = path.basename(req.params.id);
    const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Template não encontrado." });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  });

  // ============================================================
  // Assets
  // ============================================================

  router.post("/upload", imageUpload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }
    try {
      let buffer = req.file.buffer;
      let ext = IMAGE_MIMETYPES[req.file.mimetype];
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

  router.get("/assets/:assetId", (req, res) => {
    const assetId = path.basename(req.params.assetId);
    const assetPath = path.join(ASSETS_DIR, assetId);
    if (!fs.existsSync(assetPath)) {
      return res.status(404).json({ error: "Asset não encontrado." });
    }
    const ext = path.extname(assetId).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : null;
    if (!mime) {
      return res.status(400).json({ error: "Formato de asset não suportado." });
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(assetPath);
  });

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

  // ============================================================
  // Render
  // ============================================================

  router.post("/render/:id", express.json({ limit: "2mb" }), async (req, res) => {
    const id = path.basename(req.params.id);
    try {
      const body = req.body || {};
      const runtimeAssets = decodeRuntimeAssets(body.runtimeAssets);
      const buffer = await renderSavedTemplate(id, body.values || body, runtimeAssets);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("inválido") || err.message?.includes("obrigatória") || err.message?.includes("não encontrada")
        ? 400
        : 500;
      return res.status(status).json({ error: err.message || "Erro ao renderizar." });
    }
  });

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

  router.post("/render-whatsapp", express.json({ limit: "2mb" }), async (req, res) => {
    const { template, values } = req.body || {};
    const errors = validateTemplate(template);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Template inválido.", details: errors });
    }
    try {
      const png = await renderTemplate(template, values || {});
      const buffer = await convertCardToWhatsAppJpeg(png);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-cache");
      res.send(buffer);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message || "Erro ao renderizar WhatsApp." });
    }
  });

  router.post("/render-whatsapp/:id", express.json({ limit: "2mb" }), async (req, res) => {
    const id = path.basename(req.params.id);
    try {
      const body = req.body || {};
      const runtimeAssets = decodeRuntimeAssets(body.runtimeAssets);
      const png = await renderSavedTemplate(id, body.values || body, runtimeAssets);
      const buffer = await convertCardToWhatsAppJpeg(png);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-cache");
      res.send(buffer);
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("inválido") || err.message?.includes("obrigatória") || err.message?.includes("não encontrada")
        ? 400
        : 500;
      return res.status(status).json({ error: err.message || "Erro ao renderizar WhatsApp." });
    }
  });

  async function archiveIfExists(storage, key, contentType) {
    try {
      if (!(await storage.exists(key))) return;
      const buffer = await storage.read(key);
      const now = Date.now();
      const archiveKey = key.replace(/\/([^/]+)$/, `/versions/${now}-$1`);
      await storage.save(archiveKey, buffer, { contentType });
    } catch (err) {
      console.warn("Falha ao arquivar versão anterior de", key, err.message);
    }
  }

  // ============================================================
  // Studio AI background generation
  // ============================================================

  router.post("/studio/generate-background/estimate", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const { templateId, model, quality, size } = req.body || {};
      const filePath = path.join(TEMPLATES_DIR, `${path.basename(templateId || "")}.json`);
      if (!templateId || !fs.existsSync(filePath)) {
        return res.status(400).json({ error: "Template inválido." });
      }
      const template = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const cfg = template.imageGeneration || {};
      const finalModel = model || cfg.defaultModel || "gpt-image-2.5-flare";
      const finalQuality = quality || cfg.defaultQuality || "medium";
      const finalSize = size || cfg.defaultSize || "1024x1024";
      const cost = estimateImageCost(finalModel, finalQuality, finalSize);
      res.json({ ok: true, cost });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao estimar custo." });
    }
  });

  router.post("/studio/generate-background", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const { templateId, values, visual, collectionId, itemId, dryRun, model, quality, size } = req.body || {};
      const metadata = await generateStudioBackground({
        templateId,
        values: values || {},
        visual: visual || {},
        collectionId,
        itemId,
        dryRun: Boolean(dryRun || !process.env.OPENAI_API_KEY),
        model,
        quality,
        size,
      });
      res.json({ ok: true, metadata });
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("inválido") || err.message?.includes("obrigatório") || err.message?.includes("não encontrada") || err.message?.includes("não possui")
        ? 400
        : 500;
      res.status(status).json({ error: err.message || "Erro ao gerar fundo." });
    }
  });

  router.post("/studio/approve-background", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const { runId, collectionId, itemId, templateId, values } = req.body || {};
      if (!runId || !collectionId || !itemId) {
        return res.status(400).json({ error: "runId, collectionId e itemId são obrigatórios." });
      }
      const slug = itemId;
      const record = await genericProduction.getRecord(collectionId, slug);
      if (!record) return res.status(404).json({ error: "Item não encontrado." });

      const catalogDir = genericProduction.catalogDirFor(collectionId);
      const storage = createStorageProvider({ baseDir: catalogDir });
      const metaPath = path.join(catalogDir, "studio", runId, "metadata.json");
      if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Fundo do estúdio não encontrado." });
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const backgroundKey = meta.storage?.key;
      if (!backgroundKey || !(await storage.exists(backgroundKey))) {
        return res.status(404).json({ error: "Fundo do estúdio não disponível." });
      }

      const backgroundBuffer = await storage.read(backgroundKey);
      const usedTemplateId = templateId || meta.templateId;
      const usedValues = { ...(values || meta.values || {}) };
      usedValues.imagemFundo = genericProduction.PRODUCTION_BACKGROUND_KEY;
      const runtimeAssets = { [genericProduction.PRODUCTION_BACKGROUND_KEY]: backgroundBuffer };
      const png = await renderSavedTemplate(usedTemplateId, usedValues, runtimeAssets);

      const files = courseFiles(slug);
      const backgroundKeyOut = `${slug}/${files.fundo}`;
      const cardKeyOut = `${slug}/${files.card}`;
      const whatsappKeyOut = `${slug}/${files.whatsapp}`;

      // Preserva versões anteriores dos arquivos padrão, se existirem.
      await archiveIfExists(storage, backgroundKeyOut, "image/png");
      await archiveIfExists(storage, cardKeyOut, "image/png");
      await archiveIfExists(storage, whatsappKeyOut, "image/jpeg");

      await storage.save(backgroundKeyOut, backgroundBuffer, { contentType: "image/png" });
      await storage.save(cardKeyOut, png, { contentType: "image/png" });
      const whatsappBuffer = await convertCardToWhatsAppJpeg(png);
      await storage.save(whatsappKeyOut, whatsappBuffer, { contentType: "image/jpeg" });

      const manifest = genericProduction.ensureManifest(collectionId);
      const entry = genericProduction.getManifestEntry(manifest, slug) || {};
      const approvedAt = new Date().toISOString();
      genericProduction.setManifestEntry(manifest, slug, {
        ...entry,
        course_id: record.id,
        curso: record.title,
        status: "aprovado",
        approvedAt,
        approvedVisual: {
          collectionId,
          slug,
          source: "studio",
          runId,
          templateId: usedTemplateId,
          backgroundKey: backgroundKeyOut,
          cardKey: cardKeyOut,
          whatsappKey: whatsappKeyOut,
          approvedAt,
          updatedAt: approvedAt,
        },
      });
      genericProduction.saveManifest(collectionId, manifest);

      res.json({ ok: true, approvedVisual: manifest.courses[slug].approvedVisual });
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("inválido") || err.message?.includes("obrigatório") || err.message?.includes("não encontrada") || err.message?.includes("não possui")
        ? 400
        : 500;
      res.status(status).json({ error: err.message || "Erro ao aprovar fundo do estúdio." });
    }
  });

  // ============================================================
  // Controlled output file serving
  // ============================================================

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

  // ============================================================
  // Health
  // ============================================================

  router.get("/health", async (req, res) => {
    const status = await getSystemStatus();
    res.json({ ...status, timestamp: new Date().toISOString() });
  });

  // ============================================================
  // Coleções
  // ============================================================

  router.get("/collections", (req, res) => {
    try {
      const includeArchived = req.query.archived === "all";
      res.json(listCollections({ includeArchived }));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/collections/:id", (req, res) => {
    try {
      res.json(loadCollection(req.params.id));
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("não encontrada") ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  router.post("/collections", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const body = req.body || {};
      const errors = validateCollection(body);
      if (errors.length > 0) {
        return res.status(400).json({ error: "Coleção inválida.", details: errors });
      }
      const prodErrors = await genericProduction.validateCollectionProduction({ ...body, templateIds: body.templateIds || [body.defaultTemplateId] });
      if (prodErrors.length > 0) {
        return res.status(400).json({ error: "Configuração de produção inválida.", details: prodErrors });
      }
      const collection = saveCollection({ ...body, createdAt: new Date().toISOString() });
      res.status(201).json({ ok: true, collection });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  router.put("/collections/:id", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const id = path.basename(req.params.id);
      const body = req.body || {};
      const existing = loadCollection(id);
      const updated = { ...existing, ...body, id };
      const errors = validateCollection(updated);
      if (errors.length > 0) {
        return res.status(400).json({ error: "Coleção inválida.", details: errors });
      }
      const prodErrors = await genericProduction.validateCollectionProduction(updated);
      if (prodErrors.length > 0) {
        return res.status(400).json({ error: "Configuração de produção inválida.", details: prodErrors });
      }
      const collection = saveCollection(updated);
      res.json({ ok: true, collection });
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("não encontrada") ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  router.delete("/collections/:id", (req, res) => {
    try {
      deleteCollection(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/collections/:id/records", async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const records = await source.listRecords();
      res.json(records);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/collections/:id/records/:slug", async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const records = await source.listRecords();
      const primaryKey = collection.primaryKey || "slug";
      const found = records.find((r) => String(r[primaryKey] || r.slug || r.id) === req.params.slug);
      if (!found) {
        return res.status(404).json({ error: "Registro não encontrado." });
      }
      res.json(found);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/collections/:id/filters/:field/options", async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const options = await source.getFilterOptions(req.params.field);
      res.json({ field: req.params.field, options });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/collections/:id/fields", async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const fields = await source.getFields();
      res.json({ fields });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Upload de arquivo de importação para uma coleção.
  router.post("/collections/:id/import", dataUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
      const id = path.basename(req.params.id);
      const ext = path.extname(req.file.originalname).toLowerCase();
      const allowed = new Set([".csv", ".json", ".xlsx"]);
      if (!allowed.has(ext)) {
        return res.status(400).json({ error: "Extensão não permitida." });
      }
      const dir = path.join(IMPORTS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const destName = `${id}${ext}`;
      const destPath = path.join(dir, destName);
      let buffer = req.file.buffer;
      if (ext === ".svg") {
        // SVG não é permitido como fonte de dados.
        return res.status(400).json({ error: "SVG não é permitido como fonte de dados." });
      }
      fs.writeFileSync(destPath, buffer);
      res.json({ ok: true, collectionId: id, path: path.relative(RUNTIME.root, destPath), filename: destName });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  // Lista abas de uma planilha XLSX.
  router.get("/collections/:id/sheets", async (req, res) => {
    try {
      const relPath = req.query.path;
      if (!relPath) return res.status(400).json({ error: "Caminho do arquivo não informado." });
      const sheets = await readXlsxSheets(relPath);
      res.json(sheets);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao ler abas." });
    }
  });

  // Prévia bruta de registros a partir de fonte temporária (sem depender de primaryKey).
  router.post("/collections/:id/preview", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const source = req.body?.source;
      if (!source?.type || !source?.path) return res.status(400).json({ error: "Fonte não informada." });
      const preview = await readPreview(source);
      res.json(preview);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao gerar prévia." });
    }
  });

  // Valida primaryKey escolhida: IDs vazios e duplicados.
  router.post("/collections/:id/validate-key", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const source = req.body?.source;
      const primaryKey = req.body?.primaryKey;
      if (!source?.type || !source?.path) return res.status(400).json({ error: "Fonte não informada." });
      const result = await validatePrimaryKey(source, primaryKey);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao validar chave." });
    }
  });

  // Validação de configuração de produção de uma coleção (sem salvar).
  router.post("/collections/validate-production", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const errors = await genericProduction.validateCollectionProduction(req.body || {});
      res.json({ ok: true, errors });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao validar configuração." });
    }
  });

  // Arquiva/reativa uma coleção.
  router.post("/collections/:id/archive", async (req, res) => {
    try {
      const archived = req.body?.archived !== false;
      const collection = archiveCollection(req.params.id, archived);
      res.json({ ok: true, collection });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  // Duplica uma coleção existente.
  router.post("/collections/:id/duplicate", async (req, res) => {
    try {
      const original = loadCollection(req.params.id);
      const newId = `${original.id}-copia-${Date.now()}`;
      const copy = {
        ...original,
        id: newId,
        name: `${original.name} (cópia)`,
        archived: false,
        updatedAt: new Date().toISOString(),
      };
      saveCollection(copy);
      res.status(201).json({ ok: true, collection: copy });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  // Exporta configuração de uma coleção.
  router.get("/collections/:id/export-config", async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${collection.id}.json"`);
      res.send(JSON.stringify(collection, null, 2));
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================
  // Itens de produção genérica (fallback legado em /api/courses)
  // ============================================================

  router.get("/items", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const items = await genericProduction.listItems(collectionId);
      res.json(items);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/items/:slug", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const item = await genericProduction.getItem(collectionId, req.params.slug);
      if (!item) return res.status(404).json({ error: "Item não encontrado." });
      res.json(item);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/items/:slug/generate", express.json(), async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const body = req.body || {};
      const record = await genericProduction.generateAIBackground(collectionId, req.params.slug, {
        dryRun: body.dryRun === true,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      });
      res.json({ ok: true, record });
    } catch (err) {
      console.error(err);
      res.status(err.message?.includes("OPENAI_API_KEY") ? 400 : 500).json({ error: err.message });
    }
  });

  router.post("/items/:slug/upload", imageUpload.single("file"), async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const result = await genericProduction.uploadBackground(collectionId, req.params.slug, req.file.buffer, ext);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/items/:slug/render", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const result = await genericProduction.renderItem(collectionId, req.params.slug, {
        templateId: req.query.template,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/items/:slug/approve", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const record = await genericProduction.approveItem(collectionId, req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/items/:slug/reject", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const record = await genericProduction.rejectItem(collectionId, req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/items/:slug/whatsapp", async (req, res) => {
    const collectionId = req.query.collection || genericProduction.LEGACY_COLLECTION_ID;
    try {
      const result = await genericProduction.generateWhatsApp(collectionId, req.params.slug);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // Cursos (API legada compatível)
  // ============================================================

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
      const courses = await courseService.listCourses();
      res.json(courses);
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      res.status(500).json({ error: err.message || "Erro ao listar cursos." });
    }
  });

  router.get("/courses/:slug", async (req, res) => {
    try {
      const course = await courseService.getCourseDetail(req.params.slug);
      if (!course) return res.status(404).json({ error: "Curso não encontrado." });
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
      const result = await courseService.generateAIBackground(req.params.slug, {
        dryRun: body.dryRun === true,
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      });
      res.json({ ok: true, record: result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 400;
      res.status(status).json({ error: err.message || "Erro ao gerar fundo." });
    }
  });

  router.post("/courses/:slug/upload", imageUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const result = await courseService.uploadBackground(req.params.slug, req.file.buffer, ext);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 400;
      res.status(status).json({ error: err.message || "Erro no upload." });
    }
  });

  router.post("/courses/:slug/render", async (req, res) => {
    try {
      const result = await courseService.renderCourse(req.params.slug);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      const status = err.message === "Slug inválido." || err.message === "Curso não encontrado." ? 404 : 500;
      res.status(status).json({ error: err.message || "Erro ao renderizar card." });
    }
  });

  router.post("/courses/:slug/approve", async (req, res) => {
    try {
      const record = await courseService.approveCourse(req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      res.status(400).json({ error: err.message || "Erro ao aprovar." });
    }
  });

  router.post("/courses/:slug/reject", async (req, res) => {
    try {
      const record = await courseService.rejectCourse(req.params.slug);
      res.json({ ok: true, record });
    } catch (err) {
      if (!isExpectedCourseError(err)) console.error(err);
      res.status(400).json({ error: err.message || "Erro ao rejeitar." });
    }
  });

  router.post("/courses/:slug/whatsapp", async (req, res) => {
    try {
      const catalogDir = getCatalogDir();
      const course = await loadCourseBySlug(req.params.slug);
      if (!course) return res.status(404).json({ error: "Curso não encontrado." });

      let metadata = readMetadata(catalogDir, course.slug);
      if (!metadata) metadata = createMetadata(course);

      const storage = createStorageProvider({ baseDir: catalogDir });
      const cardKey = metadata.storage.keys.card;
      if (!(await storage.exists(cardKey))) {
        return res.status(400).json({ error: "Card ainda não foi renderizado." });
      }
      const cardBuffer = await storage.read(cardKey);
      const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
      await storage.save(metadata.storage.keys.whatsapp, whatsappBuffer, { contentType: "image/jpeg" });
      metadata.hashes.whatsapp = sha256(whatsappBuffer);
      metadata.timestamps.whatsapp_at = nowIso();
      metadata.status = metadata.status === "aprovado" ? "aprovado" : "pronto_revisao";
      await updateMetadataUrls(metadata, storage);
      writeMetadata(catalogDir, course.slug, metadata);
      res.json({ ok: true, slug: course.slug, whatsapp_url: metadata.urls.whatsapp, whatsapp_file: metadata.files.whatsapp, size: whatsappBuffer.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao gerar imagem WhatsApp." });
    }
  });

  // ============================================================
  // Catálogo local
  // ============================================================

  async function serveCatalogFile(collectionId, slug, file, res) {
    const files = courseFiles(slug);
    const allowed = new Set([
      `${slug}-fundo-ia.png`,
      `${slug}-card-ia.png`,
      `${slug}-fundo-upload.png`,
      files.fundo,
      files.card,
      files.whatsapp,
    ]);
    if (!SLUG_FILENAME_REGEX.test(slug) || !allowed.has(file)) {
      return res.status(400).json({ error: "Arquivo inválido." });
    }

    const catalogDir =
      collectionId === genericProduction.LEGACY_COLLECTION_ID || !collectionId
        ? getCatalogDir()
        : path.join(getCatalogDir(), "..", collectionId);

    let type = null;
    if (file === files.fundo || file === `${slug}-fundo-ia.png` || file === `${slug}-fundo-upload.png`) type = "fundo";
    else if (file === files.card || file === `${slug}-card-ia.png`) type = "card";
    else if (file === files.whatsapp) type = "whatsapp";

    if (!type) {
      return res.status(400).json({ error: "Arquivo inválido." });
    }

    try {
      const storage = createStorageProvider({ baseDir: catalogDir });
      const buffer = await storage.read(`${slug}/${type}`);
      const ext = path.extname(file).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.end(buffer);
    } catch (err) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
  }

  router.get("/catalog/:slug/:file", async (req, res) => {
    await serveCatalogFile(null, req.params.slug, req.params.file, res);
  });

  router.get("/catalog/:collectionId/:slug/:file", async (req, res) => {
    await serveCatalogFile(req.params.collectionId, req.params.slug, req.params.file, res);
  });

  router.get("/files/:encodedKey", async (req, res) => {
    try {
      const key = Buffer.from(req.params.encodedKey, "base64url").toString("utf8");
      const storage = createStorageProvider({ baseDir: getCatalogDir() });

      if (process.env.STORAGE_PROVIDER === "s3") {
        const publicUrl = await storage.getPublicUrl(key);
        if (publicUrl.startsWith("http://") || publicUrl.startsWith("https://")) {
          return res.redirect(publicUrl);
        }
      }

      const buffer = await storage.read(key);
      const ext = path.extname(key).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.end(buffer);
    } catch (err) {
      console.error(err);
      const status = err.message?.includes("não encontrado") ? 404 : 400;
      res.status(status).json({ error: err.message || "Chave inválida." });
    }
  });

  // ============================================================
  // Lotes
  // ============================================================

  function listAllJobs() {
    const catalogRoot = getCatalogDir();
    const jobs = [...listJobs(catalogRoot)];
    if (fs.existsSync(catalogRoot)) {
      for (const entry of fs.readdirSync(catalogRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subDir = path.join(catalogRoot, entry.name);
        const jobsDir = path.join(subDir, "jobs");
        if (!fs.existsSync(jobsDir)) continue;
        for (const f of fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"))) {
          try {
            jobs.push(JSON.parse(fs.readFileSync(path.join(jobsDir, f), "utf8")));
          } catch {
            // ignora
          }
        }
      }
    }
    return jobs;
  }

  function findJobFile(jobId) {
    const catalogRoot = getCatalogDir();
    const candidates = [path.join(catalogRoot, "jobs", `${jobId}.json`)];
    if (fs.existsSync(catalogRoot)) {
      for (const entry of fs.readdirSync(catalogRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(catalogRoot, entry.name, "jobs", `${jobId}.json`));
      }
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  function summarizeJob(job) {
    const stats = job.stats || {};
    return {
      id: job.id,
      collectionId: job.collectionId,
      status: job.status,
      dryRun: job.dryRun === true,
      type: job.dryRun === true ? "simulação" : "produção",
      background_source: job.background_source,
      template_id: job.template_id,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      updated_at: job.updatedAt || job.completed_at || job.started_at || job.created_at,
      archived: job.archived === true,
      stats: {
        total: stats.total || 0,
        ready: stats.ready || 0,
        approved: stats.approved || 0,
        rejected: stats.rejected || 0,
        ignored: stats.ignored || 0,
        simulation: stats.simulation || 0,
        errors: stats.errors || 0,
      },
    };
  }

  router.get("/batches", (req, res) => {
    try {
      let jobs = listAllJobs().map(summarizeJob);
      jobs.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      res.setHeader("Cache-Control", "no-store");
      res.json(jobs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao listar lotes." });
    }
  });

  router.post("/batches/:id/archive", async (req, res) => {
    try {
      const file = findJobFile(req.params.id);
      if (!file) return res.status(404).json({ error: "Lote não encontrado." });
      const catalogDir = path.dirname(path.dirname(file));
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      const archived = req.body?.archived !== false;
      job.archived = archived;
      job.updatedAt = new Date().toISOString();
      writeJob(catalogDir, job);
      res.json({ ok: true, job: summarizeJob(job) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao arquivar lote." });
    }
  });

  router.post("/batches", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const body = req.body || {};
      const courses = Array.isArray(body.courses) ? body.courses : [];
      if (courses.length === 0) {
        return res.status(400).json({ error: "Lista de itens vazia." });
      }
      const collectionId = body.collection_id || genericProduction.LEGACY_COLLECTION_ID;
      if (collectionId !== genericProduction.LEGACY_COLLECTION_ID) {
        loadCollection(collectionId); // valida existência
      }

      const job = BatchExecutor.createJob(courses, {
        collectionId,
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

      const catalogDir = genericProduction.catalogDirFor(collectionId);
      fs.mkdirSync(path.join(catalogDir, "jobs"), { recursive: true });
      writeJob(catalogDir, job);
      res.status(201).json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao criar lote." });
    }
  });

  function enrichJobWithAvailability(job, catalogDir) {
    return {
      ...job,
      courses: job.courses.map((item) => {
        const meta = readMetadata(catalogDir, item.slug) || {};
        const files = meta.files || {};
        const base = path.join(catalogDir, item.slug);
        return {
          ...item,
          hasBackground: files.fundo ? fs.existsSync(path.join(base, files.fundo)) : false,
          hasCard: files.card ? fs.existsSync(path.join(base, files.card)) : false,
          hasWhatsApp: files.whatsapp ? fs.existsSync(path.join(base, files.whatsapp)) : false,
        };
      }),
    };
  }

  router.get("/batches/:id", (req, res) => {
    try {
      const file = findJobFile(req.params.id);
      if (!file) return res.status(404).json({ error: "Lote não encontrado." });
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      const catalogDir = path.dirname(path.dirname(file));
      res.setHeader("Cache-Control", "no-store");
      res.json(enrichJobWithAvailability(job, catalogDir));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao ler lote." });
    }
  });

  router.get("/batches/:id/items", (req, res) => {
    try {
      const file = findJobFile(req.params.id);
      if (!file) return res.status(404).json({ error: "Lote não encontrado." });
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      const catalogDir = path.dirname(path.dirname(file));
      const enriched = enrichJobWithAvailability(job, catalogDir);
      res.setHeader("Cache-Control", "no-store");
      res.json(enriched.courses);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao ler itens." });
    }
  });

  async function runBatchAction(jobId, action) {
    const file = findJobFile(jobId);
    if (!file) throw new Error("Lote não encontrado.");
    const catalogDir = path.dirname(path.dirname(file));
    const exec = new BatchExecutor({ catalogDir, storageProvider: createStorageProvider({ baseDir: catalogDir }) });
    return exec[action](jobId);
  }

  router.post("/batches/:id/start", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "start");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao iniciar lote." });
    }
  });

  router.post("/batches/:id/pause", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "pause");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao pausar lote." });
    }
  });

  router.post("/batches/:id/resume", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "resume");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao retomar lote." });
    }
  });

  router.post("/batches/:id/cancel", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "cancel");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao cancelar lote." });
    }
  });

  router.post("/batches/:id/retry-errors", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "retryErrors");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao reprocessar erros." });
    }
  });

  router.post("/batches/:id/retry-rejected", async (req, res) => {
    try {
      const job = await runBatchAction(req.params.id, "retryRejected");
      res.json({ ok: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao reprocessar rejeitados." });
    }
  });

  // ============================================================
  // Ações atômicas sobre itens de um lote
  // ============================================================

  const { updateJobItemStatus, resetJobItemForRegeneration } = require("../batch/job-status");

  async function findJobAndCollection(jobId) {
    const file = findJobFile(jobId);
    if (!file) throw new Error("Lote não encontrado.");
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    const collectionId = job.collectionId || genericProduction.LEGACY_COLLECTION_ID;
    return { job, collectionId, file };
  }

  function isConflictApprovalError(err) {
    const msg = err?.message || "";
    return /simulação|ignorado|card ainda não foi gerado|metadata não encontrada/i.test(msg);
  }

  router.post("/batches/:jobId/items/:slug/approve", async (req, res) => {
    try {
      const { job, collectionId } = await findJobAndCollection(req.params.jobId);
      if (job.dryRun === true) {
        return res.status(409).json({ error: "Não é possível aprovar itens de uma simulação/dry-run." });
      }
      const record = await genericProduction.getRecord(collectionId, req.params.slug);
      const result = await updateJobItemStatus(collectionId, req.params.jobId, req.params.slug, "aprovado", {
        course_id: record?.id,
        curso: record?.title,
      });
      res.json({ ok: true, job: result.job, manifest: result.manifestEntry });
    } catch (err) {
      res.status(isConflictApprovalError(err) ? 409 : 400).json({ error: err.message });
    }
  });

  router.post("/batches/:jobId/items/:slug/reject", async (req, res) => {
    try {
      const { collectionId } = await findJobAndCollection(req.params.jobId);
      const record = await genericProduction.getRecord(collectionId, req.params.slug);
      const result = await updateJobItemStatus(collectionId, req.params.jobId, req.params.slug, "rejeitado", {
        course_id: record?.id,
        curso: record?.title,
      });
      res.json({ ok: true, job: result.job, manifest: result.manifestEntry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/batches/:jobId/items/:slug/regenerate", async (req, res) => {
    try {
      const { job, collectionId } = await findJobAndCollection(req.params.jobId);
      await resetJobItemForRegeneration(collectionId, req.params.jobId, req.params.slug);
      const catalogDir = genericProduction.catalogDirFor(collectionId);
      const exec = new BatchExecutor({ catalogDir, storageProvider: createStorageProvider({ baseDir: catalogDir }) });
      const updatedJob = await exec.resume(req.params.jobId);
      res.json({ ok: true, job: updatedJob });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.use("/batches", downloadRoutes);

  // ============================================================
  // XLSX sync (coleção padrão legada)
  // ============================================================

  router.post("/xlsx/sync-preview", express.json(), async (req, res) => {
    try {
      const coursesMetadata = listMetadata(getCatalogDir());
      const workbook = await xlsxSync.loadWorkbook(INPUT_FILE);
      xlsxSync.addImageColumnsIfNeeded(workbook);
      const plan = xlsxSync.buildSyncPlan(coursesMetadata, workbook, { approvedOnly: true });
      const report = xlsxSync.dryRunSyncPlan(plan);
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
      const workbook = await xlsxSync.loadWorkbook(INPUT_FILE);
      xlsxSync.addImageColumnsIfNeeded(workbook);
      const plan = xlsxSync.buildSyncPlan(coursesMetadata, workbook, { approvedOnly: true });
      if (plan.wouldChangeCount === 0) {
        return res.json({ ok: true, mode: "sync", report: xlsxSync.dryRunSyncPlan(plan), backup: null });
      }
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      const backupPath = path.join(BACKUPS_DIR, `cursos-${Date.now()}.xlsx`);
      await xlsxSync.syncWorkbook(workbook, plan, backupPath);
      res.json({ ok: true, mode: "sync", report: xlsxSync.dryRunSyncPlan(plan), backup: backupPath });
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
      const report = await xlsxSync.exportUpdatedSpreadsheet(coursesMetadata, outputPath);
      res.json({ ok: true, mode: "export", report, outputPath });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || "Erro ao exportar planilha." });
    }
  });

  // ============================================================
  // Exportação e sincronização genérica por coleção
  // ============================================================

  router.post("/collections/:id/sync-preview", express.json(), async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const catalogDir = genericProduction.catalogDirFor(collection.id);
      const metadataList = genericProduction.listMetadataForCollection
        ? await genericProduction.listMetadataForCollection(collection.id)
        : [];
      const plan = await source.syncApprovedRecords(metadataList, { approvedOnly: true });
      res.json({ ok: true, collectionId: collection.id, plan });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/collections/:id/sync", express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.confirm !== true) {
        return res.status(400).json({ error: "Confirmação necessária. Envie { confirm: true }." });
      }
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const metadataList = genericProduction.listMetadataForCollection
        ? await genericProduction.listMetadataForCollection(collection.id)
        : [];
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      const backupPath = path.join(BACKUPS_DIR, `${collection.id}-${Date.now()}${path.extname(collection.source.path)}`);
      const result = await source.syncApprovedRecords(metadataList, { backupPath, confirm: true });
      res.json({ ok: true, collectionId: collection.id, result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/collections/:id/export", express.json(), async (req, res) => {
    try {
      const collection = loadCollection(req.params.id);
      const source = getDataSource(collection);
      const metadataList = genericProduction.listMetadataForCollection
        ? await genericProduction.listMetadataForCollection(collection.id)
        : [];
      const body = req.body || {};
      const outputPath = body.outputPath || path.join(EXPORTS_DIR, `${collection.id}-com-imagens${path.extname(collection.source.path) || ".xlsx"}`);
      const plan = await source.exportUpdatedCopy(metadataList, outputPath);
      res.json({ ok: true, collectionId: collection.id, outputPath, plan });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // Middleware de erro
  // ============================================================

  router.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Erro interno.";
    res.status(status >= 100 && status < 600 ? status : 500).json({ error: message });
  });

  return router;
}

module.exports = { createRouter };
