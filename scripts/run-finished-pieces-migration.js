/**
 * Migra peças finalizadas a partir dos manifestos de lote existentes.
 * Idempotente: pode ser executado várias vezes sem duplicar registros.
 */

process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "local";

const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();

const finishedPiecesService = require("../src/finished-pieces");

(async () => {
  const result = await finishedPiecesService.migrate();
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
