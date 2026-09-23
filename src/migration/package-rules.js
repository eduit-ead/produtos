/**
 * Regras do pacote de migração.
 * Exportação e importação usam a mesma lista para não divergir.
 */

const ALLOWED_DIRS = [
  "data/templates",
  "data/assets",
  "data/collections",
  "data/imports",
  "output/ai-catalog",
  "output/final",
  "output/whatsapp",
  "output/exports",
];

const ALLOWED_FILES = ["input/cursos.xlsx"];

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi",
  ".ps1", ".sh", ".bash", ".vbs", ".jar",
  ".js", ".mjs", ".cjs",
  ".pem", ".key", ".p12", ".pfx", ".env",
]);

const BLOCKED_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

function toPosix(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function normalizeRelative(name) {
  const raw = toPosix(name).trim();
  if (!raw || raw.includes("\0")) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

function isBlockedRelative(rel) {
  const base = rel.split("/").pop().toLowerCase();
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (base.startsWith("~$")) return true;
  const dot = base.lastIndexOf(".");
  if (dot >= 0 && BLOCKED_EXTENSIONS.has(base.slice(dot))) return true;
  return false;
}

function isAllowedRelative(rel) {
  if (ALLOWED_FILES.includes(rel)) return true;
  return ALLOWED_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

function shouldSkipExportName(name) {
  const base = String(name || "");
  const lower = base.toLowerCase();
  if (!base || base === "." || base === "..") return true;
  if (lower === "node_modules" || lower === ".git") return true;
  if (lower === "thumbs.db" || lower === "desktop.ini") return true;
  if (lower.startsWith(".tmp-") || lower.startsWith("~$")) return true;
  return isBlockedRelative(base);
}

module.exports = {
  ALLOWED_DIRS,
  ALLOWED_FILES,
  normalizeRelative,
  isBlockedRelative,
  isAllowedRelative,
  shouldSkipExportName,
};
