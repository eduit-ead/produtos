/**
 * Constrói um ZIP organizado por lote a partir do catálogo local.
 *
 * Inclui apenas itens aprovados por padrão, com nomes determinísticos e
 * relatório de arquivos ausentes. Previne path traversal validando slugs e
 * resolvendo caminhos dentro de catalogDir/<slug>.
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { PassThrough } = require("stream");

const { getCatalogDir, readMetadata } = require("./metadata");
const { readJob } = require("./job");
const { courseFiles } = require("./naming");

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

function resolveFilePath(catalogDir, slug, type) {
  if (!isSafeSlug(slug)) return null;

  const courseDir = path.resolve(catalogDir, slug);

  let filePath;
  if (type === "metadata") {
    filePath = path.join(courseDir, "metadata.json");
  } else {
    const names = courseFiles(slug);
    const fileName = names[type];
    if (!fileName) return null;
    filePath = path.join(courseDir, fileName);
  }

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(courseDir + path.sep) && resolved !== courseDir) {
    return null;
  }
  return resolved;
}

function buildFilenameSuffix(options) {
  const parts = [];
  if (options.includeCards) parts.push("cards");
  if (options.includeWhatsApp) parts.push("whatsapp");
  if (options.includeBackgrounds) parts.push("fundos");
  if (options.includeMetadata) parts.push("pacote");
  return parts.join("-") || "lote";
}

async function buildBatchZip({ catalogDir, jobId, options = {} }) {
  const root = catalogDir || getCatalogDir();
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

  function addEntry(slug, type, entryName) {
    const filePath = resolveFilePath(jobCatalogDir, slug, type);
    if (!filePath) {
      missing.push({ slug, type, reason: "slug inválido ou caminho fora do diretório do curso" });
      return;
    }
    if (!fs.existsSync(filePath)) {
      missing.push({ slug, type, path: filePath });
      return;
    }

    const stat = fs.statSync(filePath);
    included.push({ slug, type, entryName, size: stat.size });
    archive.file(filePath, { name: entryName });
  }

  for (const item of job.courses) {
    const slug = item.slug;
    if (!isSafeSlug(slug)) {
      missing.push({ slug, type: "item", reason: "slug inválido no job" });
      continue;
    }

    const metadata = readMetadata(jobCatalogDir, slug);
    if (approvedOnly && metadata?.status !== "aprovado") continue;

    if (includeBackgrounds) addEntry(slug, "fundo", `${slug}-fundo.png`);
    if (includeCards) addEntry(slug, "card", `${slug}-card.png`);
    if (includeWhatsApp) addEntry(slug, "whatsapp", `${slug}-whatsapp.jpg`);
    if (includeMetadata) addEntry(slug, "metadata", `${slug}/metadata.json`);
  }

  if (missing.length > 0) {
    const lines = missing.map((m) => {
      let line = `${m.slug}: ${m.type}`;
      if (m.path) line += ` (${m.path})`;
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

module.exports = {
  buildBatchZip,
  isSafeSlug,
};
