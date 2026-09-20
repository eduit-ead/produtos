const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

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
        hostname: "localhost",
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

(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // Upload do asset demo existente
    const result = await uploadFile(port, "data/assets/demo-overlay.png");
    console.log("Upload status:", result.status);
    const data = JSON.parse(result.body);
    console.log("Asset ID:", data.assetId);
    console.log("Original name:", data.originalName);
    console.log("MIME:", data.mimetype);
    console.log("Size:", data.size);

    // Tentar path traversal
    const malicious = await uploadFile(port, "data/assets/demo-overlay.png");
    const maliciousData = JSON.parse(malicious.body);
    // assetId gerado pelo servidor não deve conter path traversal
    if (maliciousData.assetId.includes("/") || maliciousData.assetId.includes("\\")) {
      console.error("Falha de segurança: assetId contém separador de path");
      process.exit(1);
    }
    console.log("AssetId sanitizado: OK");
  } finally {
    server.close();
  }
})();
