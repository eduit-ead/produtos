const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("node:assert/strict");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);
const ASSETS_DIR = path.join(__dirname, "..", "data", "assets");
const uploadedAssets = [];

function uploadFile(port, filePath) {
  const boundary = "----Boundary" + Date.now();
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mime = filename.endsWith(".png")
    ? "image/png"
    : filename.endsWith(".jpg")
    ? "image/jpeg"
    : "image/svg+xml";

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/upload",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function assertJson(response) {
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.body}`);
  }
  return parsed;
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // Upload do asset demo existente
    const result = await uploadFile(port, "data/assets/demo-overlay.png");
    assert.equal(result.status, 200, `Upload PNG falhou: ${result.body}`);
    const data = assertJson(result);
    console.log("Upload PNG status:", result.status);
    console.log("Asset ID:", data.assetId);
    console.log("Original name:", data.originalName);
    console.log("MIME:", data.mimetype);
    console.log("Size:", data.size);

    assert.ok(data.assetId.endsWith(".png"), "PNG deve ter extensão .png");
    assert.equal(data.mimetype, "image/png", "MIME do PNG salvo");
    uploadedAssets.push(data.assetId);

    // SVG deve ser rasterizado para PNG
    const svgPath = path.join(__dirname, "..", "output", "template-test", "test-upload.svg");
    fs.mkdirSync(path.dirname(svgPath), { recursive: true });
    fs.writeFileSync(
      svgPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect width="100" height="100" fill="#00ff00"/>
</svg>`,
      "utf8"
    );

    const svgResult = await uploadFile(port, svgPath);
    assert.equal(svgResult.status, 200, `Upload SVG falhou: ${svgResult.body}`);
    const svgData = assertJson(svgResult);
    assert.ok(svgData.assetId.endsWith(".png"), "SVG deve ser rasterizado para PNG");
    assert.equal(svgData.mimetype, "image/png", "MIME do SVG rasterizado");
    uploadedAssets.push(svgData.assetId);
    console.log("SVG rasterizado para PNG:", svgData.assetId);

    // assetId gerado pelo servidor não deve conter path traversal
    if (data.assetId.includes("/") || data.assetId.includes("\\")) {
      assert.fail("Falha de segurança: assetId contém separador de path");
    }
    console.log("AssetId sanitizado: OK");

    // Limpar SVG temporário
    fs.unlinkSync(svgPath);
  } finally {
    server.close();
    for (const assetId of uploadedAssets) {
      const assetPath = path.join(ASSETS_DIR, assetId);
      if (fs.existsSync(assetPath)) {
        fs.unlinkSync(assetPath);
      }
    }
  }
})();
