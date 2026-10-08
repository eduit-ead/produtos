/**
 * Uploads manuais de imagem.
 * Os bytes ficam no storage já usado pelo catálogo.
 * A URL pública é /api/public/uploads/:id e não depende de Postgres.
 */

const path = require("path");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { createStorageProvider } = require("../storage");
const { getCatalogDir } = require("../batch/metadata");

const INDEX_KEY = "uploads/index.json";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const PUBLIC_PREFIX = "/api/public/uploads";

const ALLOWED_MIME = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

const EXT = { png: "png", jpeg: "jpg", webp: "webp" };
const CONTENT_TYPE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

let service = null;

function storageOf(explicit) {
  return explicit || createStorageProvider({ baseDir: getCatalogDir() });
}

function getService() {
  if (!service) service = createImageUploadService();
  return service;
}

function setUploadStorageForTests(storage) {
  service = createImageUploadService({ storage });
}

function slugifyUploadName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function displayOriginalName(name) {
  const base = path.basename(String(name || "imagem")).replace(/[\0\r\n]/g, "");
  return base.slice(0, 180) || "imagem";
}

function reject(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function inspectImage(buffer, declaredMime) {
  const format = ALLOWED_MIME[declaredMime];
  if (!format) {
    throw reject(400, "Formato não permitido. Use PNG, JPEG ou WebP.");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw reject(400, "Arquivo vazio.");
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw reject(400, "Arquivo acima do limite de 5 MB.");
  }
  const head = buffer.slice(0, 512).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<") || head.includes("<svg") || head.includes("<html") || head.includes("<!doctype")) {
    throw reject(400, "O arquivo não é uma imagem PNG, JPEG ou WebP.");
  }
  let meta;
  try {
    meta = await sharp(buffer, { failOn: "error", limitInputPixels: MAX_PIXELS, pages: 1 }).metadata();
  } catch {
    throw reject(400, "O arquivo não é uma imagem PNG, JPEG ou WebP.");
  }
  if (meta.format !== format || !meta.width || !meta.height) {
    throw reject(400, "O conteúdo do arquivo não corresponde a uma imagem PNG, JPEG ou WebP.");
  }
  return { format, width: meta.width, height: meta.height };
}

function createImageUploadService({ storage } = {}) {
  const store = storageOf(storage);
  let queue = Promise.resolve();

  function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function readIndex() {
    if (!(await store.exists(INDEX_KEY))) return [];
    const raw = await store.read(INDEX_KEY);
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter((item) => item && typeof item.id === "string");
  }

  async function writeIndex(items) {
    await store.save(INDEX_KEY, Buffer.from(JSON.stringify({ items }), "utf8"), {
      contentType: "application/json",
    });
  }

  function present(item) {
    return {
      id: item.id,
      name: item.name,
      originalName: item.originalName,
      uploadedAt: item.uploadedAt,
      format: item.format,
      width: item.width,
      height: item.height,
      size: item.size,
      publicUrl: `${PUBLIC_PREFIX}/${item.id}`,
    };
  }

  async function list() {
    const items = await readIndex();
    return { items: items.map(present) };
  }

  async function create({ buffer, declaredMime, originalName, friendlyName }) {
    return enqueue(async () => {
      const inspected = await inspectImage(buffer, declaredMime);
      const original = displayOriginalName(originalName);
      const friendly = String(friendlyName || "").trim().slice(0, 120);
      const sourceName = friendly || original.replace(/\.[^.]+$/, "");
      const id = slugifyUploadName(sourceName);
      if (!id || id === "index") {
        throw reject(400, "Informe um nome com letras ou números.");
      }
      const ext = EXT[inspected.format];
      const fileKey = `uploads/${id}.${ext}`;
      const items = await readIndex();
      if (items.some((item) => item.id === id) || (await store.exists(fileKey))) {
        throw reject(409, `Já existe um upload com o identificador "${id}".`);
      }
      await store.save(fileKey, buffer, { contentType: CONTENT_TYPE[inspected.format] });
      const record = {
        id,
        name: friendly || sourceName,
        originalName: original,
        uploadedAt: new Date().toISOString(),
        format: inspected.format,
        width: inspected.width,
        height: inspected.height,
        size: buffer.length,
        fileKey,
      };
      items.unshift(record);
      await writeIndex(items);
      return present(record);
    });
  }

  async function readPublic(id) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(id || ""))) return null;
    const items = await readIndex();
    const item = items.find((entry) => entry.id === id);
    if (!item || typeof item.fileKey !== "string") return null;
    if (!item.fileKey.startsWith("uploads/") || item.fileKey.includes("..")) return null;
    let buffer;
    try {
      buffer = await store.read(item.fileKey);
    } catch {
      return null;
    }
    return {
      buffer,
      contentType: CONTENT_TYPE[item.format] || "application/octet-stream",
    };
  }

  return { list, create, readPublic };
}

const uploadParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME[file.mimetype]) {
      cb(new Error("Formato não permitido. Use PNG, JPEG ou WebP."));
      return;
    }
    cb(null, true);
  },
});

function receiveImage(req, res, next) {
  uploadParser.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Arquivo acima do limite de 5 MB."
      : (err.message || "Upload inválido.");
    res.status(400).json({ error: message });
  });
}

function createUploadRouter() {
  const router = express.Router();

  router.get("/uploads/images", async (req, res) => {
    try {
      res.json(await getService().list());
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || "Falha ao listar uploads." });
    }
  });

  router.post("/uploads/images", receiveImage, async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }
    try {
      const item = await getService().create({
        buffer: req.file.buffer,
        declaredMime: req.file.mimetype,
        originalName: req.file.originalname,
        friendlyName: req.body?.name,
      });
      res.status(201).json(item);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message || "Falha ao enviar imagem." });
    }
  });

  return router;
}

async function sendUploadedImage(req, res) {
  try {
    const image = await getService().readPublic(req.params.id);
    if (!image) return res.status(404).json({ error: "Upload não encontrado." });
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(image.buffer);
  } catch {
    res.status(404).json({ error: "Upload não encontrado." });
  }
}

module.exports = {
  INDEX_KEY,
  MAX_FILE_SIZE,
  PUBLIC_PREFIX,
  ALLOWED_MIME,
  slugifyUploadName,
  createImageUploadService,
  setUploadStorageForTests,
  createUploadRouter,
  sendUploadedImage,
};
