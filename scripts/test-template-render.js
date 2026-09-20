const fs = require("fs");
const path = require("path");
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
  console.log(`PNG renderizado: ${outputPath}`);
  console.log(`Dimensões: ${meta.width}x${meta.height}`);
  console.log(`Tamanho: ${(buffer.length / 1024).toFixed(1)} KB`);
})();
