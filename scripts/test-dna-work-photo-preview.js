/**
 * Preview da fotografia candidata do DNA Work sem aprovar e sem Base64.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dna-work-preview-"));
process.env.APP_RUNTIME_DIR = runtimeDir;
process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.OPENAI_API_KEY = "";
process.env.STORAGE_PROVIDER = "local";
process.env.AUTH_DISABLED = "true";

const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();

const imageGen = require("../src/generate-ai-background");
const originalGenerateImage = imageGen.generateImage;
let openaiCalls = 0;
imageGen.generateImage = async (...args) => {
  openaiCalls += 1;
  return originalGenerateImage(...args);
};

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const { createStorageProvider } = require("../src/storage");
const { RUNTIME } = require("../src/config/runtime");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

const VALUES = {
  titulo_vaga: "Cozinheira",
  regime: "CLT",
  salario: "A combinar",
  beneficio: "Vale transporte",
  local: "Guarulhos",
};

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const type = String(res.headers["content-type"] || "");
          let parsed = buffer;
          if (type.includes("application/json") || type.includes("text/html") || type.startsWith("text/")) {
            const text = buffer.toString("utf8");
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers, buffer });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function photoAssets() {
  const dir = path.join(runtimeDir, "data", "assets");
  return fs.readdirSync(dir).filter((name) => name.startsWith("dna-work-photo-")).sort();
}

function studioRuns() {
  const dir = path.join(RUNTIME.catalogDir, "studio");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

async function meanColor(png, left, top, width, height) {
  const { data, info } = await sharp(png)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  return { r: r / n, g: g / n, b: b / n };
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const criarHtml = fs.readFileSync(path.join(__dirname, "../src/template-editor/public/criar.html"), "utf8");
    assert.equal(criarHtml.includes("editor.html"), false, "Criar imagem não deve apontar para o editor avançado");
    assert.equal(/editor avançado/i.test(criarHtml), false, "o link do editor avançado não deve aparecer em Criar imagem");
    const editorHtml = fs.readFileSync(path.join(__dirname, "../src/template-editor/public/editor.html"), "utf8");
    assert.match(editorHtml, /Editor Avançado/, "o editor avançado continua existindo");

    const assetsBefore = photoAssets();

    const officialGen = await request(port, "POST", "/api/studio/generate-photo", JSON.stringify({
      templateId: "dna-work-vagas",
      values: { titulo_vaga: "Cozinheira" },
      dryRun: true,
      size: "1024x1792",
    }), { "Content-Type": "application/json" });
    assert.equal(officialGen.status, 200, JSON.stringify(officialGen.body));
    const officialMetaPath = path.join(RUNTIME.catalogDir, "studio", officialGen.body.metadata.runId, "metadata.json");
    const officialMeta = JSON.parse(fs.readFileSync(officialMetaPath, "utf8"));
    officialMeta.dryRun = false;
    officialMeta.cost.dryRun = false;
    fs.writeFileSync(officialMetaPath, JSON.stringify(officialMeta, null, 2), "utf8");

    const approveRes = await request(port, "POST", "/api/studio/approve-background", JSON.stringify({
      runId: officialGen.body.metadata.runId,
      templateId: "dna-work-vagas",
      collectionId: null,
      itemId: null,
    }), { "Content-Type": "application/json" });
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes.body));
    assert.equal(approveRes.body.kind, "photo");
    const officialAsset = path.join(runtimeDir, "data", "assets", approveRes.body.assetId);
    const officialBytes = fs.readFileSync(officialAsset);
    const officialAssets = photoAssets();
    assert.equal(officialAssets.length, assetsBefore.length + 1);

    const officialRender = await request(port, "POST", "/api/render/dna-work-vagas", JSON.stringify({
      values: { ...VALUES, imagem_principal: approveRes.body.assetId },
    }), { "Content-Type": "application/json" });
    assert.equal(officialRender.status, 200);
    const officialHash = crypto.createHash("sha256").update(officialRender.buffer).digest("hex");

    const candidateGen = await request(port, "POST", "/api/studio/generate-photo", JSON.stringify({
      templateId: "dna-work-vagas",
      values: { titulo_vaga: "Cozinheira" },
      dryRun: true,
      size: "1024x1792",
    }), { "Content-Type": "application/json" });
    assert.equal(candidateGen.status, 200, JSON.stringify(candidateGen.body));
    const candidate = candidateGen.body.metadata;
    assert.equal(candidate.kind, "photo");
    assert.equal(candidate.dryRun, true, "candidata permanece não aprovada");
    assert.ok(candidate.storage?.key, "candidata deve ter arquivo no storage");
    assert.ok(candidate.urls?.foto, "candidata deve ter URL");

    const candidateFile = await request(port, "GET", candidate.urls.foto);
    assert.equal(candidateFile.status, 200, "URL da candidata deve responder antes da aprovação");
    assert.match(String(candidateFile.headers["content-type"] || ""), /image\//);

    const big = await sharp({
      create: {
        width: 1400,
        height: 2400,
        channels: 3,
        background: { r: 220, g: 30, b: 30 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(big.length > 2 * 1024 * 1024, `imagem de teste deveria passar de 2 MB, veio ${big.length}`);

    const storage = createStorageProvider({ baseDir: RUNTIME.catalogDir });
    await storage.save(candidate.storage.key, big, { contentType: "image/png" });

    const runsAfterGenerate = studioRuns();
    process.env.OPENAI_API_KEY = "sk-test-should-not-be-called";

    const previewBody = JSON.stringify({
      values: { ...VALUES, imagem_principal: candidate.storage.key },
      runtimeAssetRefs: { [candidate.storage.key]: candidate.storage.key },
    });
    assert.ok(previewBody.length < 8000, "o preview não deve transportar a imagem em Base64");
    assert.equal(previewBody.includes(big.toString("base64").slice(0, 80)), false);

    const preview = await request(port, "POST", "/api/render/dna-work-vagas", previewBody, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(previewBody),
    });
    assert.equal(preview.status, 200, `preview da candidata falhou: ${preview.buffer.toString("utf8").slice(0, 300)}`);
    const color = await meanColor(preview.buffer, 960, 280, 40, 40);
    assert.ok(color.r > 150 && color.r > color.g + 40 && color.r > color.b + 40, `região da foto deveria refletir a candidata (${color.r},${color.g},${color.b})`);

    const previewAgain = await request(port, "POST", "/api/render/dna-work-vagas", previewBody, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(previewBody),
    });
    assert.equal(previewAgain.status, 200);

    assert.deepEqual(studioRuns(), runsAfterGenerate, "o preview não pode gerar outra fotografia");
    assert.equal(openaiCalls, 0, "nenhuma chamada à OpenAI");
    assert.deepEqual(photoAssets(), officialAssets, "não aprovar não cria nova imagem oficial");
    assert.ok(officialBytes.equals(fs.readFileSync(officialAsset)), "não aprovar não altera a imagem oficial");

    const officialAgain = await request(port, "POST", "/api/render/dna-work-vagas", JSON.stringify({
      values: { ...VALUES, imagem_principal: approveRes.body.assetId },
    }), { "Content-Type": "application/json" });
    assert.equal(officialAgain.status, 200);
    assert.equal(crypto.createHash("sha256").update(officialAgain.buffer).digest("hex"), officialHash);

    const hugeBody = JSON.stringify({
      values: { ...VALUES, imagem_principal: candidate.storage.key },
      runtimeAssets: { [candidate.storage.key]: big.toString("base64") },
    });
    assert.ok(Buffer.byteLength(hugeBody) > 2 * 1024 * 1024);
    const rejected = await request(port, "POST", "/api/render/dna-work-vagas", hugeBody, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(hugeBody),
    });
    assert.equal(rejected.status, 413, "enviar a fotografia em Base64 continua acima do limite do preview");

    console.log("DNA Work photo preview OK");
  } finally {
    server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
