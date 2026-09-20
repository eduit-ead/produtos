const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { renderTemplate } = require("../src/template-editor/renderer");

const templatePath = path.join(__dirname, "..", "data", "templates", "demo.json");
const outputPath = path.join(__dirname, "..", "output", "template-test", "demo-render.png");

(async () => {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));

  const buffer = await renderTemplate(template, {
    titulo: "Análise e Desenvolvimento de Sistemas para Aplicações Empresariais",
    subtitulo: "Tecnólogo | 4 semestres | EAD",
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);

  const meta = await require("sharp")(buffer).metadata();
  assert.equal(meta.width, template.canvas.width, "largura deve coincidir com canvas.width");
  assert.equal(meta.height, template.canvas.height, "altura deve coincidir com canvas.height");
  assert.ok(buffer.length > 0, "buffer não pode estar vazio");

  console.log(`PNG renderizado: ${outputPath}`);
  console.log(`Dimensões: ${meta.width}x${meta.height}`);
  console.log(`Tamanho: ${(buffer.length / 1024).toFixed(1)} KB`);
})();
