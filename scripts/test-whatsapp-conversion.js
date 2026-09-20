const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { convertCardToWhatsAppJpeg } = require("../src/whatsapp-image");

(async () => {
  // Cria um PNG 1080x1080 simples.
  const pngBuffer = await sharp({
    create: {
      width: 1080,
      height: 1080,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .png()
    .toBuffer();

  const jpegBuffer = await convertCardToWhatsAppJpeg(pngBuffer);
  assert.ok(Buffer.isBuffer(jpegBuffer));

  const meta = await sharp(jpegBuffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(jpegBuffer.length > 0);
  assert.ok(jpegBuffer.length < pngBuffer.length, "JPEG deve ser menor que PNG");

  await assert.rejects(
    () => convertCardToWhatsAppJpeg("não é buffer"),
    /Entrada deve ser um Buffer/
  );

  console.log("WhatsApp conversion OK");
})();
