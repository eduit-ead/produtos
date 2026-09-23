/**
 * Pool PostgreSQL opcional.
 * Sem DATABASE_URL a aplicação segue só com os arquivos locais.
 * A URL não entra em logs, erros ou respostas.
 */

const CONNECT_SQL = "SELECT current_database(), current_user, version()";
const POOL_MAX = 5;
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 10000;

let pool = null;
let poolFactory = createPgPool;

function isDatabaseConfigured() {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0;
}

function createPgPool(connectionString) {
  const { Pool } = require("pg");
  const created = new Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  created.on("error", (err) => {
    console.error("Erro no pool PostgreSQL.", err.code || "erro");
  });
  return created;
}

function getPool() {
  if (!isDatabaseConfigured()) return null;
  if (!pool) pool = poolFactory(process.env.DATABASE_URL.trim());
  return pool;
}

async function checkDatabase() {
  if (!isDatabaseConfigured()) {
    return { configured: false, ok: false };
  }
  try {
    const result = await getPool().query(CONNECT_SQL);
    const row = result.rows?.[0] || {};
    return {
      configured: true,
      ok: true,
      database: row.current_database || null,
      user: row.current_user || null,
      version: row.version || null,
    };
  } catch (err) {
    console.error("Falha na verificação do PostgreSQL.", err.code || "erro");
    return {
      configured: true,
      ok: false,
      error: "Não foi possível conectar ao banco.",
    };
  }
}

async function closeDatabase() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

function setPoolFactoryForTests(factory) {
  poolFactory = factory || createPgPool;
}

async function resetDatabaseForTests() {
  await closeDatabase();
  poolFactory = createPgPool;
}

function exposeError(message, status = 503) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function safeDbMessage(err) {
  const raw = String(err && err.message ? err.message : "");
  if (!raw || raw.includes("://") || raw.includes("@") || /password/i.test(raw)) return "";
  return raw.slice(0, 300);
}

function sanitizeDbError(err) {
  if (err && err.expose) return err;
  const code = err && err.code ? err.code : "erro";
  const safe = safeDbMessage(err);
  console.error("Falha PostgreSQL.", code, safe || "");
  const wrapped = exposeError("Não foi possível acessar o PostgreSQL.", 503);
  wrapped.code = code;
  return wrapped;
}

function requirePool() {
  const current = getPool();
  if (!current) throw exposeError("PostgreSQL não configurado.", 503);
  return current;
}

async function query(text, params) {
  try {
    return await requirePool().query(text, params);
  } catch (err) {
    throw sanitizeDbError(err);
  }
}

async function withTransaction(fn) {
  let client;
  try {
    client = await requirePool().connect();
  } catch (err) {
    throw sanitizeDbError(err);
  }
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // a conexão já pode ter caído
    }
    throw sanitizeDbError(err);
  } finally {
    client.release();
  }
}

module.exports = {
  CONNECT_SQL,
  POOL_MAX,
  isDatabaseConfigured,
  checkDatabase,
  closeDatabase,
  setPoolFactoryForTests,
  resetDatabaseForTests,
  query,
  withTransaction,
  sanitizeDbError,
};
