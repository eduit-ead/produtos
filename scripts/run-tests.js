const { spawnSync } = require("child_process");
const path = require("path");

const tests = [
  "test-template-render.js",
  "test-save-reload.js",
  "test-template-api.js",
  "test-upload.js",
  "test-studio-bindings.js",
  "test-course-api.js",
  "test-naming.js",
  "test-local-storage.js",
  "test-whatsapp-conversion.js",
  "test-xlsx-sync.js",
  "test-batch-lifecycle.js",
  "test-generic-collections.js",
  "test-stabilization.js",
];

let failed = false;

for (const test of tests) {
  const testPath = path.join(__dirname, test);
  console.log(`\n==> Executando ${test}`);
  const result = spawnSync(process.execPath, [testPath], {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  });
  if (result.status !== 0) {
    console.error(`\nXXX Teste falhou: ${test}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nXXX Um ou mais testes falharam.");
  process.exit(1);
} else {
  console.log("\n=== Todos os testes passaram.");
}
