/**
 * Aplica as migrations no banco indicado por DATABASE_URL.
 * Uso: node scripts/apply-db-migrations.js --database bwipoart
 * Não roda na inicialização do servidor.
 */

require("dotenv").config();

const { applyMigrations } = require("../src/db/migrate");
const { expectedDatabaseFromEnv } = require("../src/db/database-name");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const databaseArg = argument("--database");
  if (!databaseArg) {
    console.error("Informe --database bwipoart.");
    process.exit(1);
  }
  const expected = expectedDatabaseFromEnv();
  if (databaseArg !== expected) {
    console.error("O argumento --database não confere com o banco de DATABASE_URL.");
    process.exit(1);
  }
  const result = await applyMigrations();
  console.log(JSON.stringify({
    database: result.database,
    applied: result.applied,
    skipped: result.skipped,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || "Falha ao aplicar migrations.");
  process.exit(1);
});
