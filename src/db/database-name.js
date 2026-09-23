/**
 * Garante que coleções e migrations usem só o banco bwipoart.
 * bwipoart_test só é aceito com ALLOW_TEST_DATABASE=1.
 */

const PRODUCTION_DATABASE = "bwipoart";
const TEST_DATABASE = "bwipoart_test";

function exposeError(message, status = 503) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function databaseNameFromUrl(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const name = decodeURIComponent(String(parsed.pathname || "").replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

function isAllowedDatabaseName(name) {
  if (name === PRODUCTION_DATABASE) return true;
  return name === TEST_DATABASE && process.env.ALLOW_TEST_DATABASE === "1";
}

function assertAllowedDatabaseName(name) {
  if (isAllowedDatabaseName(name)) return name;
  throw exposeError("Operação recusada: o banco conectado não é bwipoart.", 503);
}

function expectedDatabaseFromEnv() {
  const url = typeof process.env.DATABASE_URL === "string" ? process.env.DATABASE_URL.trim() : "";
  if (!url) throw exposeError("PostgreSQL não configurado.", 503);
  const name = databaseNameFromUrl(url);
  if (!name) throw exposeError("DATABASE_URL não informa o nome do banco.", 503);
  return assertAllowedDatabaseName(name);
}

module.exports = {
  PRODUCTION_DATABASE,
  TEST_DATABASE,
  exposeError,
  databaseNameFromUrl,
  isAllowedDatabaseName,
  assertAllowedDatabaseName,
  expectedDatabaseFromEnv,
};
