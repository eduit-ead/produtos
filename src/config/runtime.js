/**
 * Configuração de diretórios de runtime.
 *
 * APP_RUNTIME_DIR define o diretório base que sobrevive a restarts.
 * Em produção (Docker) geralmente aponta para um volume persistente.
 * Em desenvolvimento usa o diretório do projeto.
 */

const fs = require("fs");
const path = require("path");
const { ROOT } = require("../collections/schema");

const APP_RUNTIME_DIR = process.env.APP_RUNTIME_DIR
  ? (path.isAbsolute(process.env.APP_RUNTIME_DIR)
      ? path.resolve(process.env.APP_RUNTIME_DIR)
      : path.resolve(ROOT, process.env.APP_RUNTIME_DIR))
  : ROOT;

function runtimeSubdir(...parts) {
  return path.join(APP_RUNTIME_DIR, ...parts);
}

const RUNTIME = {
  root: APP_RUNTIME_DIR,
  collectionsDir: runtimeSubdir("data", "collections"),
  templatesDir: runtimeSubdir("data", "templates"),
  assetsDir: runtimeSubdir("data", "assets"),
  importsDir: runtimeSubdir("data", "imports"),
  catalogDir: runtimeSubdir("output", "ai-catalog"),
  exportsDir: runtimeSubdir("output", "exports"),
};

function ensureRuntimeDirs() {
  for (const dir of Object.values(RUNTIME)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFileIfMissing(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function copyDirContentsIfMissing(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirContentsIfMissing(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function seedDefaults() {
  if (APP_RUNTIME_DIR === ROOT) return;

  copyDirContentsIfMissing(path.join(ROOT, "data", "templates"), RUNTIME.templatesDir);
  copyDirContentsIfMissing(path.join(ROOT, "data", "assets"), RUNTIME.assetsDir);
  copyFileIfMissing(
    path.join(ROOT, "data", "collections", "graduacao-cruzeiro.json"),
    path.join(RUNTIME.collectionsDir, "graduacao-cruzeiro.json")
  );
}

module.exports = {
  APP_RUNTIME_DIR,
  RUNTIME,
  ensureRuntimeDirs,
  seedDefaults,
};
