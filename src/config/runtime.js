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
  ? path.resolve(process.env.APP_RUNTIME_DIR)
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

function copyIfMissing(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

function seedDefaults() {
  if (APP_RUNTIME_DIR === ROOT) return;

  const defaults = [
    [path.join(ROOT, "data", "templates"), RUNTIME.templatesDir],
    [path.join(ROOT, "data", "assets"), RUNTIME.assetsDir],
    [path.join(ROOT, "data", "collections", "graduacao-cruzeiro.json"), path.join(RUNTIME.collectionsDir, "graduacao-cruzeiro.json")],
  ];
  for (const [src, dest] of defaults) {
    if (fs.existsSync(src)) copyIfMissing(src, dest);
  }
}

module.exports = {
  APP_RUNTIME_DIR,
  RUNTIME,
  ensureRuntimeDirs,
  seedDefaults,
};
