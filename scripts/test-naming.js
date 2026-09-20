const assert = require("node:assert/strict");
const { courseFiles } = require("../src/batch/naming");

assert.deepEqual(courseFiles("analise-e-desenvolvimento-de-sistemas"), {
  slug: "analise-e-desenvolvimento-de-sistemas",
  fundo: "analise-e-desenvolvimento-de-sistemas-fundo.png",
  card: "analise-e-desenvolvimento-de-sistemas-card.png",
  whatsapp: "analise-e-desenvolvimento-de-sistemas-whatsapp.jpg",
});

assert.throws(() => courseFiles(""), /inválido/);
assert.throws(() => courseFiles(null), /inválido/);

console.log("Naming OK");
