const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const { renderTemplate } = require("../src/template-editor/renderer");

const app = express();
app.use("/api", createRouter());

const server = http.createServer(app);

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buffer });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. Listar templates
    const list = await request(port, "GET", "/api/templates");
    const templates = JSON.parse(list.buffer.toString());
    console.log("Templates:", templates.map((t) => t.id).join(", "));

    // 2. Carregar demo
    const load = await request(port, "GET", "/api/templates/demo");
    const template = JSON.parse(load.buffer.toString());
    console.log("Demo carregado:", template.name, "camadas:", template.layers.length);

    // 3. Renderizar com variáveis longas
    const variables = {
      titulo:
        "Análise e Desenvolvimento de Sistemas para Aplicações Empresariais e Gestão de Projetos Digitais",
      subtitulo: "Tecnólogo | 4 semestres | EAD",
    };
    const render = await request(port, "POST", "/api/render/demo", JSON.stringify(variables), {
      "Content-Type": "application/json",
    });
    if (render.status !== 200) {
      console.error("Render failed:", render.buffer.toString());
      process.exit(1);
    }
    const meta = await require("sharp")(render.buffer).metadata();
    console.log("Render PNG:", `${meta.width}x${meta.height}`, `${(render.buffer.length / 1024).toFixed(1)} KB`);

    // 4. Salvar cópia do renderizado
    const outDir = path.join(__dirname, "..", "output", "template-test");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "api-render.png"), render.buffer);

    // 5. Validar posições e ordem (zIndex) após recarregar
    const reloaded = JSON.parse((await request(port, "GET", "/api/templates/demo")).buffer.toString());
    const zIndexes = reloaded.layers.map((l) => l.zIndex);
    console.log("zIndexes:", zIndexes.join(", "));

    // 6. Render direto sem variáveis (defaults)
    const defaultRender = await request(port, "POST", "/api/render/demo", JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    if (defaultRender.status !== 200) {
      console.error("Default render failed:", defaultRender.buffer.toString());
      process.exit(1);
    }
    fs.writeFileSync(path.join(outDir, "api-render-defaults.png"), defaultRender.buffer);
    console.log("Default render OK:", `${(defaultRender.buffer.length / 1024).toFixed(1)} KB`);
  } finally {
    server.close();
  }
})();
