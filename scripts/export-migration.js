/**
 * Gera um ZIP com os dados de produção para migração ao Easypanel.
 *
 * Não altera nem apaga os arquivos de origem.
 *
 * Uso:
 *   node scripts/export-migration.js
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const {
  ALLOWED_DIRS,
  ALLOWED_FILES,
  shouldSkipExportName,
} = require("../src/migration/package-rules");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output", "migration-packages");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function walkFiles(absDir, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Ignorado (não foi possível ler): ${relDir} (${err.message})`);
    return;
  }
  for (const entry of entries) {
    if (shouldSkipExportName(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (stat.isFile()) {
      out.push({ abs, rel: rel.replace(/\\/g, "/") });
    }
  }
}

function collect() {
  const files = [];
  const missing = [];
  for (const dir of ALLOWED_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) {
      missing.push(dir);
      continue;
    }
    walkFiles(abs, dir, files);
  }
  for (const rel of ALLOWED_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      missing.push(rel);
      continue;
    }
    if (!shouldSkipExportName(path.basename(rel))) {
      files.push({ abs, rel: rel.replace(/\\/g, "/") });
    }
  }
  return { files, missing };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function main() {
  const { files, missing } = collect();
  if (files.length === 0) {
    console.error("Nenhum arquivo encontrado para exportar.");
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const zipPath = path.join(OUTPUT_DIR, `bwipoart-migration-${stamp()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 1 } });

  const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") console.warn(err.message);
      else reject(err);
    });
    archive.on("error", reject);
  });

  archive.pipe(output);
  for (const file of files) {
    archive.file(file.abs, { name: file.rel });
  }
  await archive.finalize();
  await done;

  const size = fs.statSync(zipPath).size;
  console.log(`Arquivos: ${files.length}`);
  console.log(`Tamanho: ${formatBytes(size)} (${size} bytes)`);
  console.log(`Pacote: ${zipPath}`);
  if (missing.length > 0) {
    console.log(`Ausentes (não incluídos): ${missing.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
