const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("node:assert/strict");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

const DEMO_PATH = path.join(__dirname, "..", "data", "templates", "demo.json");
const TEMPLATES_DIR = path.join(__dirname, "..", "data", "templates");
const FIXTURE_ID = "test-save-reload-fixture";
const FIXTURE_PATH = path.join(TEMPLATES_DIR, `${FIXTURE_ID}.json`);

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertResponseJson(response) {
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.body}`);
  }
  return parsed;
}

(async () => {
  const originalDemo = fs.readFileSync(DEMO_PATH, "utf8");
  const fixture = JSON.parse(originalDemo);
  fixture.id = FIXTURE_ID;
  fixture.name = "Test Save/Reload Fixture";
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const load = assertResponseJson(await request(port, "GET", `/api/templates/${FIXTURE_ID}`));
    assert.equal(load.id, FIXTURE_ID, "Carregamento do fixture falhou");

    // Alterar posições e ordem
    load.layers[0].x = 10;
    load.layers[0].y = 10;
    load.layers[2].rotation = 5;
    load.layers[3].zIndex = 10;

    const save = await request(port, "POST", `/api/templates/${FIXTURE_ID}`, JSON.stringify(load), {
      "Content-Type": "application/json",
    });
    assert.equal(save.status, 200, `Save falhou: ${save.body}`);

    const reload = assertResponseJson(await request(port, "GET", `/api/templates/${FIXTURE_ID}`));

    assert.equal(reload.layers[0].x, 10, "x preservado");
    assert.equal(reload.layers[0].y, 10, "y preservado");
    assert.equal(reload.layers[2].rotation, 5, "rotation preservada");
    assert.equal(reload.layers[3].zIndex, 10, "zIndex preservado");
    assert.equal(reload.layers.length, load.layers.length, "número de camadas preservado");
    assert.equal(reload.schemaVersion, 1, "schemaVersion preservado");

    // Verificar que demo.json não foi modificado
    const currentDemo = fs.readFileSync(DEMO_PATH, "utf8");
    assert.equal(currentDemo, originalDemo, "demo.json foi alterado indevidamente");

    console.log("Save/reload OK: posições e zIndex preservados; demo.json intacto.");
  } finally {
    server.close();
    if (fs.existsSync(FIXTURE_PATH)) {
      fs.unlinkSync(FIXTURE_PATH);
    }
  }
})();
