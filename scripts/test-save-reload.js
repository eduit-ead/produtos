const fs = require("fs");
const http = require("http");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

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
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
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
    const load = JSON.parse((await request(port, "GET", "/api/templates/demo")).body);

    // Alterar posições e ordem
    load.layers[0].x = 10;
    load.layers[0].y = 10;
    load.layers[2].rotation = 5;
    load.layers[3].zIndex = 10;

    const save = await request(port, "POST", "/api/templates/demo", JSON.stringify(load), {
      "Content-Type": "application/json",
    });
    if (save.status !== 200) {
      console.error("Save failed:", save.body);
      process.exit(1);
    }

    const reload = JSON.parse((await request(port, "GET", "/api/templates/demo")).body);

    const assertions = [
      reload.layers[0].x === 10,
      reload.layers[0].y === 10,
      reload.layers[2].rotation === 5,
      reload.layers[3].zIndex === 10,
      reload.layers.length === load.layers.length,
      reload.schemaVersion === 1,
    ];

    if (assertions.every(Boolean)) {
      console.log("Save/reload OK: posições e zIndex preservados.");
    } else {
      console.error("Save/reload assertions failed:", assertions);
      process.exit(1);
    }

    // Restaurar valores originais para não poluir o demo
    const original = JSON.parse(fs.readFileSync("data/templates/demo.json", "utf8"));
    await request(port, "POST", "/api/templates/demo", JSON.stringify(original), {
      "Content-Type": "application/json",
    });
    console.log("Template demo restaurado.");
  } finally {
    server.close();
  }
})();
