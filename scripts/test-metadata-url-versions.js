/**
 * URLs de produção levam ?v=<hash>. A key e o arquivo não mudam.
 * Uploads e getPublicUrl permanecem sem versão.
 */

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "url-versions-"));
process.env.AI_CATALOG_DIR = path.join(tempDir, "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.AUTH_DISABLED = "true";

const { LocalStorageProvider } = require("../src/storage/local-storage-provider");
const { sha256, updateMetadataUrls } = require("../src/batch/metadata");
const { createRouter } = require("../src/template-editor/api");

const slug = "administracao-e-gestao-de-projetos-sociais";
const collectionId = "pos-graduacao-cruzeiro";
const key = `${collectionId}/${slug}/fundo`;

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        cache: res.headers["cache-control"],
        body: Buffer.concat(chunks),
      }));
    }).on("error", reject);
  });
}

function reviewAssetUrlSource() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "template-editor", "public", "batch.js"),
    "utf8"
  );
  const match = source.match(/function reviewAssetUrl\(item, type\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  return new Function(`${match[0]}; return reviewAssetUrl;`)();
}

async function main() {
  const storage = new LocalStorageProvider(process.env.AI_CATALOG_DIR);
  const bufferA = Buffer.from("fundo-a-versao");
  const bufferB = Buffer.from("fundo-b-versao");
  const hashA = sha256(bufferA);
  const hashB = sha256(bufferB);
  assert.notEqual(hashA, hashB);

  const metadata = {
    storage: { keys: { fundo: key, card: `${collectionId}/${slug}/card`, whatsapp: `${collectionId}/${slug}/whatsapp` } },
    hashes: { fundo: hashA, card: null, whatsapp: null },
    urls: {},
  };
  await updateMetadataUrls(metadata, storage);
  const urlA = metadata.urls.fundo;
  assert.equal(urlA, `${await storage.getPublicUrl(key)}?v=${hashA}`);
  assert.equal(metadata.urls.card, await storage.getPublicUrl(metadata.storage.keys.card));
  assert.equal(metadata.storage.keys.fundo, key);

  await storage.save(key, bufferA, { contentType: "image/png" });
  const app = express();
  app.use("/api", createRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const first = await request(port, urlA);
    assert.equal(first.status, 200);
    assert.equal(sha256(first.body), hashA);

    await storage.save(key, bufferB, { contentType: "image/png" });
    metadata.hashes.fundo = hashB;
    await updateMetadataUrls(metadata, storage);
    const urlB = metadata.urls.fundo;
    assert.notEqual(urlA, urlB);
    assert.ok(urlB.endsWith(`?v=${hashB}`));
    assert.equal(urlA.split("?")[0], urlB.split("?")[0]);

    const second = await request(port, urlB);
    assert.equal(second.status, 200);
    assert.equal(sha256(second.body), hashB);
    assert.notEqual(sha256(second.body), hashA);

    const stale = await request(port, urlA);
    assert.equal(sha256(stale.body), hashB);

    const gradKey = "jornalismo/card";
    const grad = {
      storage: { keys: { fundo: "jornalismo/fundo", card: gradKey, whatsapp: "jornalismo/whatsapp" } },
      hashes: { fundo: hashA, card: hashA, whatsapp: hashA },
      urls: {},
    };
    await updateMetadataUrls(grad, storage);
    assert.equal(grad.storage.keys.card, gradKey);
    assert.equal(grad.urls.card, `${await storage.getPublicUrl(gradKey)}?v=${hashA}`);

    const uploadUrl = await storage.getPublicUrl("uploads/foto.png");
    assert.equal(uploadUrl.includes("?v="), false);

    const reviewAssetUrl = reviewAssetUrlSource();
    global.getCatalogUrl = () => "/api/catalog/fallback";
    assert.equal(reviewAssetUrl({ slug, urls: { card: urlB } }, "card"), urlB);
    assert.equal(reviewAssetUrl({ slug, urls: { card: null } }, "card"), "/api/catalog/fallback");

    console.log(JSON.stringify({ urlA, urlB, hashA, hashB, cache: first.cache }, null, 2));
    console.log("metadata url versions ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
