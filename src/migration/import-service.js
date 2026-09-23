/**
 * Restaura um ZIP de migração no diretório de runtime.
 * Extrai primeiro em um temporário, valida os caminhos e só então copia.
 * Arquivos idênticos são ignorados. Arquivos diferentes são copiados
 * para um backup e substituídos pela versão do pacote (Windows).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");
const { APP_RUNTIME_DIR, RUNTIME } = require("../config/runtime");
const { ROOT } = require("../collections/schema");
const {
  normalizeRelative,
  isBlockedRelative,
  isAllowedRelative,
} = require("./package-rules");

const POLICY = "windows-wins";
const MAX_FILES = 200000;
const MAX_ERRORS = 100;

function maxUploadBytes() {
  const mb = Number(process.env.MIGRATION_MAX_UPLOAD_MB || 2048);
  return Math.max(1, mb) * 1024 * 1024;
}

function maxUncompressedBytes() {
  const mb = Number(process.env.MIGRATION_MAX_UNCOMPRESSED_MB || 8192);
  return Math.max(1, mb) * 1024 * 1024;
}

function assertImportTarget() {
  if (path.resolve(APP_RUNTIME_DIR) === path.resolve(ROOT)) {
    throw new Error("A importação só grava no volume persistente. APP_RUNTIME_DIR não pode ser a pasta do projeto.");
  }
  return RUNTIME.root;
}

function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (err, zipfile) => {
      if (err) reject(err);
      else resolve(zipfile);
    });
  });
}

function walkFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) walkFiles(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function pushError(errors, message) {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

async function extractZip(zipPath, tempRoot, job) {
  const zipfile = await openZip(zipPath);
  const errors = [];
  let files = 0;
  let uncompressed = 0;
  const limit = maxUncompressedBytes();
  job.filesTotal = zipfile.entryCount || 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      reject(err);
    };

    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch {}
      resolve();
    });

    zipfile.on("entry", (entry) => {
      const next = () => zipfile.readEntry();
      const encrypted = typeof entry.isEncrypted === "function" ? entry.isEncrypted() : Boolean(entry.isEncrypted);
      if (encrypted || isSymlinkEntry(entry)) {
        pushError(errors, `Entrada recusada: ${entry.fileName}`);
        return next();
      }
      const isDir = /\/$/.test(entry.fileName);
      const rel = normalizeRelative(entry.fileName);
      if (!rel) {
        pushError(errors, `Caminho inválido: ${entry.fileName}`);
        return next();
      }
      if (isDir) return next();
      if (!isAllowedRelative(rel) || isBlockedRelative(rel)) {
        pushError(errors, `Arquivo não permitido: ${rel}`);
        return next();
      }
      files += 1;
      if (files > MAX_FILES) {
        return fail(new Error("O ZIP contém arquivos demais."));
      }

      const dest = path.join(tempRoot, ...rel.split("/"));
      const resolved = path.resolve(dest);
      if (!resolved.startsWith(path.resolve(tempRoot) + path.sep)) {
        pushError(errors, `Caminho fora do temporário: ${rel}`);
        return next();
      }

      zipfile.openReadStream(entry, (err, stream) => {
        if (err) return fail(err);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const writer = fs.createWriteStream(dest);
        let written = 0;
        stream.on("data", (chunk) => {
          written += chunk.length;
          uncompressed += chunk.length;
          const declared = entry.uncompressedSize || 0;
          if ((declared > 0 && written > declared + 1024) || uncompressed > limit) {
            stream.destroy(new Error("O ZIP descompactado excede o limite configurado."));
          }
        });
        pipeline(stream, writer).then(() => {
          job.filesDone += 1;
          next();
        }).catch(fail);
      });
    });

    zipfile.readEntry();
  });

  return { errors, files };
}

async function restoreTree(tempRoot, destRoot, job) {
  const rels = [];
  walkFiles(tempRoot, "", rels);
  const backupRoot = path.join(destRoot, ".migration-backups", job.id);
  const added = [];
  const replaced = [];
  let skipped = 0;

  try {
    for (const rel of rels) {
      if (!isAllowedRelative(rel) || isBlockedRelative(rel)) {
        throw new Error(`Arquivo extraído não permitido: ${rel}`);
      }
      const src = path.join(tempRoot, ...rel.split("/"));
      const dest = path.join(destRoot, ...rel.split("/"));
      const destResolved = path.resolve(dest);
      if (!destResolved.startsWith(path.resolve(destRoot) + path.sep)) {
        throw new Error(`Destino fora do volume: ${rel}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        const [srcHash, destHash] = await Promise.all([hashFile(src), hashFile(dest)]);
        if (srcHash === destHash) {
          skipped += 1;
          job.filesDone += 1;
          continue;
        }
        const backup = path.join(backupRoot, ...rel.split("/"));
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(dest, backup);
        fs.copyFileSync(src, dest);
        replaced.push(rel);
      } else {
        fs.copyFileSync(src, dest);
        added.push(rel);
      }
      job.filesDone += 1;
    }
  } catch (err) {
    for (const rel of replaced) {
      const backup = path.join(backupRoot, ...rel.split("/"));
      const dest = path.join(destRoot, ...rel.split("/"));
      if (fs.existsSync(backup)) fs.copyFileSync(backup, dest);
    }
    for (const rel of added) {
      const dest = path.join(destRoot, ...rel.split("/"));
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    }
    throw err;
  }

  return {
    added: added.length,
    replacedCount: replaced.length,
    replacedSample: replaced.slice(0, 50),
    skipped,
    backupDir: replaced.length > 0 ? backupRoot : null,
  };
}

function summarize(destRoot) {
  const cursos = path.join(destRoot, "input", "cursos.xlsx");
  const finishedIndex = path.join(destRoot, "output", "ai-catalog", "finished", "index.json");
  const templates = ["dna-work-vagas.json", "cruzeiro-graduacao-v1.json", "demo.json"].filter((name) =>
    fs.existsSync(path.join(destRoot, "data", "templates", name))
  );
  let finishedCount = 0;
  if (fs.existsSync(finishedIndex)) {
    try {
      const data = JSON.parse(fs.readFileSync(finishedIndex, "utf8"));
      finishedCount = Array.isArray(data.pieces) ? data.pieces.length : 0;
    } catch {
      finishedCount = -1;
    }
  }
  let photoCount = 0;
  const assetsDir = path.join(destRoot, "data", "assets");
  if (fs.existsSync(assetsDir)) {
    photoCount = fs.readdirSync(assetsDir).filter((name) => name.startsWith("dna-work-photo-")).length;
  }
  return {
    cursosXlsx: fs.existsSync(cursos),
    templates,
    finishedCount,
    approvedPhotoCount: photoCount,
  };
}

function saveReport(destRoot, job) {
  const dir = path.join(destRoot, ".migration-reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.json`);
  const payload = publicJob(job);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function publicJob(job) {
  return {
    id: job.id,
    phase: job.phase,
    ok: job.ok,
    done: job.done,
    filesTotal: job.filesTotal,
    filesDone: job.filesDone,
    added: job.added,
    replaced: job.replaced,
    replacedSample: job.replacedSample,
    skipped: job.skipped,
    errors: job.errors,
    backupDir: job.backupDir,
    summary: job.summary,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

async function runImport(zipPath, job) {
  const destRoot = assertImportTarget();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bwipoart-import-"));
  try {
    job.phase = "extracting";
    const extracted = await extractZip(zipPath, tempRoot, job);
    if (extracted.errors.length > 0) {
      job.errors = extracted.errors;
      throw new Error("O ZIP contém caminhos ou arquivos não permitidos.");
    }
    if (extracted.files === 0) {
      throw new Error("O ZIP não contém arquivos de migração.");
    }
    job.phase = "restoring";
    job.filesDone = 0;
    job.filesTotal = extracted.files;
    const result = await restoreTree(tempRoot, destRoot, job);
    job.added = result.added;
    job.replaced = result.replacedCount;
    job.replacedSample = result.replacedSample;
    job.skipped = result.skipped;
    job.backupDir = result.backupDir;
    job.summary = summarize(destRoot);
    job.ok = true;
    job.phase = "done";
  } catch (err) {
    job.ok = false;
    job.phase = "failed";
    if (job.errors.length === 0) pushError(job.errors, err.message || "Falha na importação.");
    throw err;
  } finally {
    job.done = true;
    job.finishedAt = new Date().toISOString();
    try { saveReport(destRoot, job); } catch {}
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}

module.exports = {
  POLICY,
  maxUploadBytes,
  assertImportTarget,
  runImport,
  publicJob,
  summarize,
};
