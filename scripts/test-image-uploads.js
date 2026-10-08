/**
 * Uploads manuais: PNG, JPEG, WebP, conteúdo inválido, SVG, acentos e duplicata.
 * Usa um diretório temporário. Não grava no catálogo real.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");
const sharp = require("sharp");
const { LocalStorageProvider } = require("../src/storage/local-storage-provider");
const {
  setUploadStorageForTests,
  createUploadRouter,
  sendUploadedImage,
  slugifyUploadName,
} = require("../src/uploads/image-uploads");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bwipoart-uploads-"));
setUploadStorageForTests(new LocalStorageProvider(tempDir));

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function postImage(base, { filename, mime, buffer, name }) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  if (name) form.append("name", name);
  const res = await fetch(`${base}/api/uploads/images`, { method: "POST", body: form });
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  assert.strictEqual(slugifyUploadName("Administração Pública"), "administracao-publica");
  assert.strictEqual(slugifyUploadName("../../etc/passwd"), "etc-passwd");

  const png = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#1144aa" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#aa4411" } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 12, height: 24, channels: 3, background: "#22aa66" } }).webp().toBuffer();

  const app = express();
  app.use("/api", createUploadRouter());
  app.get("/api/public/uploads/:id", sendUploadedImage);
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const pngRes = await postImage(base, {
    filename: "imagem-final.png",
    mime: "image/png",
    buffer: png,
    name: "banner pos administração",
  });
  assert.strictEqual(pngRes.status, 201, JSON.stringify(pngRes.body));
  assert.strictEqual(pngRes.body.id, "banner-pos-administracao");
  assert.strictEqual(pngRes.body.originalName, "imagem-final.png");
  assert.strictEqual(pngRes.body.format, "png");
  assert.strictEqual(pngRes.body.width, 32);
  assert.strictEqual(pngRes.body.height, 16);
  assert.strictEqual(pngRes.body.publicUrl, "/api/public/uploads/banner-pos-administracao");

  const jpegRes = await postImage(base, { filename: "foto.jpeg", mime: "image/jpeg", buffer: jpeg, name: "foto jpeg" });
  assert.strictEqual(jpegRes.status, 201, JSON.stringify(jpegRes.body));
  assert.strictEqual(jpegRes.body.format, "jpeg");

  const webpRes = await postImage(base, { filename: "arte.webp", mime: "image/webp", buffer: webp, name: "arte webp" });
  assert.strictEqual(webpRes.status, 201, JSON.stringify(webpRes.body));
  assert.strictEqual(webpRes.body.format, "webp");

  const fake = await postImage(base, {
    filename: "falso.png",
    mime: "image/png",
    buffer: Buffer.from("<html><script>alert(1)</script></html>"),
    name: "falso",
  });
  assert.strictEqual(fake.status, 400);

  const svg = await postImage(base, {
    filename: "icone.svg",
    mime: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
    name: "icone",
  });
  assert.strictEqual(svg.status, 400);

  const svgAsPng = await postImage(base, {
    filename: "icone.png",
    mime: "image/png",
    buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>"),
    name: "svg disfarçado",
  });
  assert.strictEqual(svgAsPng.status, 400);

  const duplicate = await postImage(base, {
    filename: "outro.png",
    mime: "image/png",
    buffer: png,
    name: "banner pos administração",
  });
  assert.strictEqual(duplicate.status, 409);

  const opened = await fetch(`${base}${pngRes.body.publicUrl}`);
  assert.strictEqual(opened.status, 200);
  assert.strictEqual(opened.headers.get("content-type"), "image/png");
  const openedBytes = Buffer.from(await opened.arrayBuffer());
  assert.strictEqual(openedBytes.equals(png), true);

  const webpOpened = await fetch(`${base}${webpRes.body.publicUrl}`);
  assert.strictEqual(webpOpened.headers.get("content-type"), "image/webp");

  await new Promise((resolve) => server.close(resolve));

  const restarted = express();
  restarted.use("/api", createUploadRouter());
  restarted.get("/api/public/uploads/:id", sendUploadedImage);
  const server2 = await listen(restarted);
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const listed = await fetch(`${base2}/api/uploads/images`).then((res) => res.json());
  assert.ok(listed.items.some((item) => item.id === "banner-pos-administracao"));
  const again = await fetch(`${base2}${pngRes.body.publicUrl}`);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.headers.get("content-type"), "image/png");
  await new Promise((resolve) => server2.close(resolve));

  console.log("image uploads OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
