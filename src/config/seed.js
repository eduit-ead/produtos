/**
 * Inicialização padrão do diretório de runtime.
 *
 * Garante que todos os diretórios de runtime existam e copia os defaults
 * do projeto quando APP_RUNTIME_DIR aponta para um volume externo.
 */

const fs = require("fs");
const path = require("path");
const { RUNTIME, ensureRuntimeDirs, seedDefaults, APP_RUNTIME_DIR } = require("./runtime");
const { ROOT } = require("../collections/schema");

const LEGACY_COLLECTIONS_DIR = path.join(ROOT, "data", "collections");

function ensureLegacyFallback() {
  // Se o diretório legado ainda existe e o runtime ainda não foi populado,
  // sincroniza a coleção padrão para o novo diretório, mantendo a compatibilidade.
  if (!fs.existsSync(LEGACY_COLLECTIONS_DIR)) return;
  if (RUNTIME.collectionsDir === LEGACY_COLLECTIONS_DIR) return;

  const legacyFiles = fs.readdirSync(LEGACY_COLLECTIONS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of legacyFiles) {
    const src = path.join(LEGACY_COLLECTIONS_DIR, file);
    const dest = path.join(RUNTIME.collectionsDir, file);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(RUNTIME.collectionsDir, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function seedRuntimeDefaults() {
  ensureRuntimeDirs();
  seedDefaults();
  ensureLegacyFallback();
}

module.exports = {
  seedRuntimeDefaults,
};
