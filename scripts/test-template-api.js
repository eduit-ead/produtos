const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("node:assert/strict");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());

const server = http.createServer(app);

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
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

function assertJson(response) {
  let parsed;
  try {
    parsed = JSON.parse(response.buffer.toString());
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.buffer.toString()}`);
  }
  return parsed;
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Listar templates
    const list = await request(port, "GET", "/api/templates");
    const templates = assertJson(list);
    console.log("Templates:", templates.map((t) => t.id).join(", "));

    // 2. Carregar demo
    const load = await request(port, "GET", "/api/templates/demo");
    assert.equal(load.status, 200, `GET demo falhou: ${load.buffer.toString()}`);
    const template = assertJson(load);
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
    assert.equal(render.status, 200, `Render falhou: ${render.buffer.toString()}`);
    const meta = await require("sharp")(render.buffer).metadata();
    console.log("Render PNG:", `${meta.width}x${meta.height}`, `${(render.buffer.length / 1024).toFixed(1)} KB`);

    // 4. Salvar cópia do renderizado
    const outDir = path.join(__dirname, "..", "output", "template-test");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "api-render.png"), render.buffer);

    // 5. Validar posições e ordem (zIndex) após recarregar
    const reloaded = assertJson(await request(port, "GET", "/api/templates/demo"));
    const zIndexes = reloaded.layers.map((l) => l.zIndex);
    console.log("zIndexes:", zIndexes.join(", "));

    // 6. Render direto sem variáveis (defaults)
    const defaultRender = await request(port, "POST", "/api/render/demo", JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    assert.equal(defaultRender.status, 200, `Default render falhou: ${defaultRender.buffer.toString()}`);
    fs.writeFileSync(path.join(outDir, "api-render-defaults.png"), defaultRender.buffer);
    console.log("Default render OK:", `${(defaultRender.buffer.length / 1024).toFixed(1)} KB`);

    // 7. Render in-memory: POST /api/render com template JSON
    const inMemoryTemplate = {
      schemaVersion: 1,
      id: "in-memory-test",
      name: "In Memory Test",
      canvas: { width: 200, height: 200, background: "#ffffff" },
      variables: [],
      assets: [],
      layers: [
        {
          id: "bg",
          type: "background",
          name: "Fundo",
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          rotation: 0,
          opacity: 1,
          visible: true,
          zIndex: 0,
          locked: false,
          properties: { color: "#ff0000", assetId: null },
        },
      ],
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };
    const inMemoryRender = await request(
      port,
      "POST",
      "/api/render",
      JSON.stringify({ template: inMemoryTemplate, values: {} }),
      { "Content-Type": "application/json" }
    );
    assert.equal(inMemoryRender.status, 200, `Render in-memory falhou: ${inMemoryRender.buffer.toString()}`);
    const inMemoryMeta = await require("sharp")(inMemoryRender.buffer).metadata();
    assert.equal(inMemoryMeta.width, 200);
    assert.equal(inMemoryMeta.height, 200);
    console.log("Render in-memory OK:", `${inMemoryMeta.width}x${inMemoryMeta.height}`);
  } finally {
    server.close();
  }
})();
