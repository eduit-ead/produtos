/**
 * Importação administrativa do ZIP de migração.
 * O arquivo chega em disco, sem passar pelo limite global de JSON.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const {
  POLICY,
  maxUploadBytes,
  assertImportTarget,
  runImport,
  publicJob,
} = require("./import-service");

const jobs = new Map();
let running = false;

const uploadDir = path.join(os.tmpdir(), "bwipoart-migration-uploads");

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename(req, file, cb) {
      cb(null, `upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.zip`);
    },
  }),
  limits: { fileSize: maxUploadBytes(), files: 1, fields: 4 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || "").toLowerCase();
    if (!name.endsWith(".zip") || name.includes(".env")) {
      return cb(new Error("Envie o arquivo ZIP gerado pela exportação."));
    }
    cb(null, true);
  },
});

function createJob() {
  return {
    id: `mig-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    phase: "queued",
    ok: false,
    done: false,
    filesTotal: 0,
    filesDone: 0,
    added: 0,
    replaced: 0,
    replacedSample: [],
    skipped: 0,
    errors: [],
    backupDir: null,
    summary: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function createMigrationRouter() {
  const router = express.Router();

  router.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Importação não encontrada." });
    res.json(publicJob(job));
  });

  router.post("/import", (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ error: err.message || "Falha no upload." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Selecione o arquivo ZIP." });
      }
      if (req.body?.confirmPolicy !== POLICY) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({
          error: "Confirme a política de conflitos: a versão do Windows substitui a do volume, depois de um backup.",
        });
      }
      try {
        assertImportTarget();
      } catch (targetErr) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(403).json({ error: targetErr.message });
      }
      if (running) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(409).json({ error: "Já existe uma importação em andamento." });
      }

      const job = createJob();
      jobs.set(job.id, job);
      running = true;
      const zipPath = req.file.path;
      res.status(202).json({ ok: true, jobId: job.id });

      runImport(zipPath, job).catch(() => {}).finally(() => {
        running = false;
      });
    });
  });

  return router;
}

module.exports = { createMigrationRouter };
