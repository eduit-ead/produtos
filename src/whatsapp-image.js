/**
 * Conversão compartilhada de card PNG para imagem WhatsApp JPEG.
 */

const sharp = require("sharp");

async function convertCardToWhatsAppJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Entrada deve ser um Buffer.");
  }
  return sharp(buffer)
    .jpeg({
      quality: 88,
      mozjpeg: true,
    })
    .toBuffer();
}

module.exports = {
  convertCardToWhatsAppJpeg,
};
