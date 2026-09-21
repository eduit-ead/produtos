/**
 * Coleta informações não-sensíveis sobre o estado do sistema.
 */

const fs = require("fs");
const { APP_RUNTIME_DIR } = require("../config/runtime");
const { createStorageProvider } = require("../storage");
const { getCatalogDir } = require("../batch/metadata");

function isOpenAIConfigured() {
  const key = process.env.OPENAI_API_KEY;
  return typeof key === "string" && key.trim().length > 0 && !key.startsWith("sk-...");
}

function getStorageProvider() {
  const provider = process.env.STORAGE_PROVIDER || "local";
  return ["local", "s3", "supabase"].includes(provider) ? provider : "local";
}

function isAuthActive() {
  const password = process.env.APP_ACCESS_PASSWORD;
  return typeof password === "string" && password.trim().length > 0 && process.env.AUTH_DISABLED !== "true";
}

function isRuntimeDirAvailable() {
  try {
    const stat = fs.statSync(APP_RUNTIME_DIR);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function getSystemStatus() {
  const openaiConfigured = isOpenAIConfigured();
  const storageProvider = getStorageProvider();
  const authActive = isAuthActive();
  const runtimeDirAvailable = isRuntimeDirAvailable();

  const storage = createStorageProvider({ baseDir: getCatalogDir() });
  const storageHealth = await storage.healthCheck().catch((err) => ({
    ok: false,
    provider: storageProvider,
    error: err.message,
  }));

  return {
    ok: storageHealth.ok && runtimeDirAvailable,
    openaiConfigured,
    storageProvider,
    storageHealthy: storageHealth.ok,
    authActive,
    runtimeDirAvailable,
    runtimeDir: APP_RUNTIME_DIR,
  };
}

module.exports = {
  getSystemStatus,
};
