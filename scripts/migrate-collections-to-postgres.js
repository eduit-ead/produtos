/**
 * Importa coleções e registros dos arquivos para o PostgreSQL.
 * Não altera os arquivos de origem.
 *
 * Dry-run (não conecta no banco):
 *   node scripts/migrate-collections-to-postgres.js --dry-run
 *
 * Aplicar, sem sobrescrever linhas já existentes:
 *   node scripts/migrate-collections-to-postgres.js --database bwipoart
 *
 * Política explícita: --on-conflict=skip|newer|merge|replace
 */

require("dotenv").config();

const { scanFileCollections, publicReport, applyFileImport } = require("../src/db/import-collections");
const { expectedDatabaseFromEnv } = require("../src/db/database-name");
const { assertPolicy } = require("../src/db/record-merge");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const policyArg = process.argv.find((arg) => arg.startsWith("--on-conflict="));
  const onConflict = policyArg ? policyArg.slice("--on-conflict=".length) : "skip";
  assertPolicy(onConflict);

  const scan = await scanFileCollections();
  const report = publicReport(scan);
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "apply", onConflict, ...report }, null, 2));
  if (dryRun) return;

  const databaseArg = argument("--database");
  if (!databaseArg) {
    console.error("Informe --database bwipoart para gravar. Use --dry-run para apenas contar.");
    process.exit(1);
  }
  const expected = expectedDatabaseFromEnv();
  if (databaseArg !== expected) {
    console.error("O argumento --database não confere com o banco de DATABASE_URL.");
    process.exit(1);
  }

  const results = await applyFileImport(scan, { onConflict });
  const failed = results.filter((item) => item.status === "erro");
  console.log(JSON.stringify({ results }, null, 2));
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || "Falha na migração das coleções.");
  process.exit(1);
});