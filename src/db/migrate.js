/**
 * Aplica migrations versionadas. Não é chamado na inicialização do servidor.
 */

const fs = require("fs");
const path = require("path");
const { query, withTransaction, sanitizeDbError } = require("./postgres");
const { expectedDatabaseFromEnv, exposeError } = require("./database-name");

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");
const VERSION_REGEX = /^[0-9]{3}_[a-z0-9_]+$/;

function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const version = name.replace(/\.sql$/, "");
      if (!VERSION_REGEX.test(version)) {
        throw exposeError(`Migration com nome inválido: ${name}`, 500);
      }
      return { version, file: path.join(dir, name), sql: fs.readFileSync(path.join(dir, name), "utf8") };
    });
}

async function assertConnectedDatabase() {
  const expected = expectedDatabaseFromEnv();
  let result;
  try {
    result = await query("SELECT current_database() AS name");
  } catch (err) {
    throw sanitizeDbError(err);
  }
  const current = result.rows?.[0]?.name;
  if (current !== expected) {
    throw exposeError("Operação recusada: o banco conectado não é o banco indicado em DATABASE_URL.", 503);
  }
  return current;
}

async function applyMigrations() {
  const database = await assertConnectedDatabase();
  const files = migrationFiles();
  const applied = [];
  const skipped = [];

  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const existing = await query("SELECT version FROM schema_migrations");
  const done = new Set((existing.rows || []).map((row) => row.version));

  for (const migration of files) {
    if (done.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    await withTransaction(async (client) => {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    });
    applied.push(migration.version);
  }

  return { database, applied, skipped };
}

module.exports = {
  MIGRATIONS_DIR,
  migrationFiles,
  assertConnectedDatabase,
  applyMigrations,
};
