/**
 * Fonte das coleções e registros.
 * files é o padrão. DATABASE_URL sozinho não ativa o PostgreSQL.
 */

const { exposeError } = require("./database-name");

function getDataSourceMode() {
  const raw = String(process.env.DATA_SOURCE || "files").trim().toLowerCase();
  if (raw === "files" || raw === "postgres") return raw;
  throw exposeError("DATA_SOURCE deve ser files ou postgres.", 500);
}

function usesPostgres() {
  return getDataSourceMode() === "postgres";
}

function assertPostgresConfigured() {
  if (!usesPostgres()) return;
  const url = typeof process.env.DATABASE_URL === "string" ? process.env.DATABASE_URL.trim() : "";
  if (!url) throw exposeError("DATA_SOURCE=postgres exige DATABASE_URL.", 503);
}

module.exports = {
  getDataSourceMode,
  usesPostgres,
  assertPostgresConfigured,
};
