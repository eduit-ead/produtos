/**
 * A revisão devolve metadata.urls e o frontend usa essas URLs.
 * Itens sem URL continuam no fallback /api/catalog.
 * Não grava no catálogo real.
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-urls-"));
process.env.AI_CATALOG_DIR = path.join(tempDir, "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.AUTH_DISABLED = "true";

const { writeJob } = require("../src/batch/job");
const { writeMetadata } = require("../src/batch/metadata");
const { courseFiles } = require("../src/batch/naming");
const { createRouter } = require("../src/template-editor/api");

const posSlug = "administracao-e-gestao-de-projetos-sociais";
const posCollection = "pos-graduacao-cruzeiro";
const gradSlug = "jornalismo";
const gradCollection = "graduacao-cruzeiro";

function filesUrl(key) {
  return `/api/files/${Buffer.from(key, "utf8").toString("base64url")}`;
}

function touchCourseFiles(catalogDir, slug) {
  const dir = path.join(catalogDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const names = courseFiles(slug);
  for (const type of ["fundo", "card", "whatsapp"]) {
    fs.writeFileSync(path.join(dir, names[type]), type);
  }
}

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    }).on("error", reject);
  });
}

function loadReviewAssetUrl() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "template-editor", "public", "batch.js"),
    "utf8"
  );
  const match = source.match(/function reviewAssetUrl\(item, type\) \{[\s\S]*?\n\}/);
  assert.ok(match, "reviewAssetUrl deve existir em batch.js");
  assert.match(source, /reviewAssetUrl\(item, "fundo"\)/);
  assert.match(source, /reviewAssetUrl\(item, "card"\)/);
  assert.match(source, /reviewAssetUrl\(item, "whatsapp"\)/);
  assert.match(source, /reviewAssetUrl\(item, assetType\)/);
  return new Function(`${match[0]}; return reviewAssetUrl;`)();
}

async function main() {
  const posUrls = {
    fundo: filesUrl(`${posCollection}/${posSlug}/fundo`),
    card: filesUrl(`${posCollection}/${posSlug}/card`),
    whatsapp: filesUrl(`${posCollection}/${posSlug}/whatsapp`),
  };
  const posCatalog = path.join(process.env.AI_CATALOG_DIR, posCollection);
  touchCourseFiles(posCatalog, posSlug);
  writeMetadata(posCatalog, posSlug, {
    slug: posSlug,
    curso: "Administração e Gestão de Projetos Sociais",
    files: courseFiles(posSlug),
    urls: posUrls,
    status: "pronto_revisao",
  });
  const posJob = {
    id: "job-pos-review",
    collectionId: posCollection,
    status: "concluido",
    courses: [{ course_id: "pos-1", slug: posSlug, status: "pronto_revisao" }],
    stats: {},
  };
  writeJob(posCatalog, posJob);

  const gradCatalog = process.env.AI_CATALOG_DIR;
  touchCourseFiles(gradCatalog, gradSlug);
  writeMetadata(gradCatalog, gradSlug, {
    slug: gradSlug,
    curso: "Jornalismo",
    files: courseFiles(gradSlug),
    status: "pronto_revisao",
  });
  const gradJob = {
    id: "job-grad-review",
    collectionId: gradCollection,
    status: "concluido",
    courses: [{ course_id: "grad-1", slug: gradSlug, status: "pronto_revisao" }],
    stats: {},
  };
  writeJob(gradCatalog, gradJob);

  const app = express();
  app.use("/api", createRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const pos = await request(port, "/api/batches/job-pos-review");
    assert.equal(pos.status, 200);
    const posItem = pos.body.courses.find((course) => course.slug === posSlug);
    assert.equal(posItem.hasBackground, true);
    assert.equal(posItem.hasCard, true);
    assert.equal(posItem.hasWhatsApp, true);
    assert.deepEqual(posItem.urls, posUrls);

    const grad = await request(port, "/api/batches/job-grad-review");
    assert.equal(grad.status, 200);
    const gradItem = grad.body.courses.find((course) => course.slug === gradSlug);
    assert.equal(gradItem.hasBackground, true);
    assert.equal(gradItem.hasCard, true);
    assert.equal(gradItem.hasWhatsApp, true);
    assert.deepEqual(gradItem.urls, { fundo: null, card: null, whatsapp: null });

    const reviewAssetUrl = loadReviewAssetUrl();
    const state = { collectionId: posCollection };
    function getCatalogUrl(slug, file) {
      if (state.collectionId && state.collectionId !== "graduacao-cruzeiro") {
        return `/api/catalog/${encodeURIComponent(state.collectionId)}/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
      }
      return `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
    }
    global.getCatalogUrl = getCatalogUrl;

    assert.equal(reviewAssetUrl(posItem, "fundo"), posUrls.fundo);
    assert.equal(reviewAssetUrl(posItem, "card"), posUrls.card);
    assert.equal(reviewAssetUrl(posItem, "whatsapp"), posUrls.whatsapp);
    assert.match(reviewAssetUrl(posItem, "card"), /^\/api\/files\//);

    state.collectionId = gradCollection;
    assert.equal(reviewAssetUrl(gradItem, "fundo"), `/api/catalog/${gradSlug}/${gradSlug}-fundo.png`);
    assert.equal(reviewAssetUrl(gradItem, "card"), `/api/catalog/${gradSlug}/${gradSlug}-card.png`);
    assert.equal(reviewAssetUrl(gradItem, "whatsapp"), `/api/catalog/${gradSlug}/${gradSlug}-whatsapp.jpg`);

    console.log(JSON.stringify({
      slug: posItem.slug,
      hasBackground: posItem.hasBackground,
      hasCard: posItem.hasCard,
      hasWhatsApp: posItem.hasWhatsApp,
      urls: posItem.urls,
    }, null, 2));
    console.log("batch review urls ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
