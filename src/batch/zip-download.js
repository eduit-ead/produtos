/**
 * Constrói um ZIP organizado por lote a partir do provider de storage ativo.
 *
 * Inclui apenas itens aprovados por padrão, com nomes determinísticos e
 * relatório de arquivos ausentes. Previne path traversal validando slugs.
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { PassThrough } = require("stream");

const { getCatalogDir, readMetadata } = require("./metadata");
const { readJob } = require("./job");
const { courseFiles } = require("./naming");
const { createStorageProvider } = require("../storage");

const SAFE_SLUG_REGEX = /^[A-Za-z0-9_-]+$/;

function isSafeSlug(slug) {
  return typeof slug === "string" && SAFE_SLUG_REGEX.test(slug);
}

function findJobFile(catalogRoot, jobId) {
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

function buildFilenameSuffix(options) {
  const parts = [];
  if (options.includeCards) parts.push("cards");
  if (options.includeWhatsApp) parts.push("whatsapp");
  if (options.includeBackgrounds) parts.push("fundos");
  if (options.includeMetadata) parts.push("pacote");
  return parts.join("-") || "lote";
}

async function buildBatchZip({ catalogDir, storageProvider, jobId, options = {} }) {
  const root = catalogDir || getCatalogDir();
  const storage = storageProvider || createStorageProvider({ baseDir: root });
  const jobFile = findJobFile(root, jobId);
  if (!jobFile) {
    throw new Error(`Lote não encontrado: ${jobId}`);
  }

  const jobCatalogDir = path.dirname(path.dirname(jobFile));
  const job = readJob(jobCatalogDir, jobId);
  if (!job) {
    throw new Error(`Lote não encontrado: ${jobId}`);
  }

  const {
    approvedOnly = true,
    includeCards = false,
    includeWhatsApp = false,
    includeBackgrounds = false,
    includeMetadata = false,
  } = options;

  const included = [];
  const missing = [];

  const archive = archiver("zip", { zlib: { level: 6 } });
  const output = new PassThrough();
  archive.pipe(output);
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  archive.on("warning", (err) => {
    console.warn("Aviso ao montar ZIP:", err.message);
  });

  async function addBufferEntry(slug, type, entryName) {
    try {
      const buffer = await storage.read(`${slug}/${type}`);
      included.push({ slug, type, entryName, size: buffer.length });
      archive.append(buffer, { name: entryName });
    } catch (err) {
      missing.push({ slug, type, reason: err.message || "arquivo ausente" });
    }
  }

  async function addMetadataEntry(slug, entryName) {
    try {
      const metadata = readMetadata(jobCatalogDir, slug);
      const buffer = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");
      included.push({ slug, type: "metadata", entryName, size: buffer.length });
      archive.append(buffer, { name: entryName });
    } catch (err) {
      missing.push({ slug, type: "metadata", reason: err.message || "metadata ausente" });
    }
  }

  const pending = [];
  for (const item of job.courses) {
    const slug = item.slug;
    if (!isSafeSlug(slug)) {
      missing.push({ slug, type: "item", reason: "slug inválido no job" });
      continue;
    }

    const metadata = readMetadata(jobCatalogDir, slug);
    if (approvedOnly && metadata?.status !== "aprovado") continue;

    if (includeBackgrounds) pending.push(addBufferEntry(slug, "fundo", `${slug}-fundo.png`));
    if (includeCards) pending.push(addBufferEntry(slug, "card", `${slug}-card.png`));
    if (includeWhatsApp) pending.push(addBufferEntry(slug, "whatsapp", `${slug}-whatsapp.jpg`));
    if (includeMetadata) pending.push(addMetadataEntry(slug, `${slug}/metadata.json`));
  }
  await Promise.all(pending);

  if (missing.length > 0) {
    const lines = missing.map((m) => {
      let line = `${m.slug}: ${m.type}`;
      if (m.reason) line += ` [${m.reason}]`;
      return line;
    });
    archive.append(lines.join("\n"), { name: "missing.txt" });
  }

  const report = { included, missing };
  archive.append(JSON.stringify(report, null, 2), { name: "report.json" });

  const buffer = await new Promise((resolve, reject) => {
    archive.on("error", reject);
    output.on("error", reject);
    output.on("end", () => resolve(Buffer.concat(chunks)));
    archive.finalize();
  });

  const suffix = buildFilenameSuffix({ includeCards, includeWhatsApp, includeBackgrounds, includeMetadata });
  const filename = `${jobId}-${suffix}.zip`;

  return { buffer, filename, report };
}

function findJobCatalogDir(catalogRoot, jobId) {
  const jobFile = findJobFile(catalogRoot, jobId);
  if (!jobFile) return null;
  return path.dirname(path.dirname(jobFile));
}

module.exports = {
  buildBatchZip,
  isSafeSlug,
  findJobCatalogDir,
};
