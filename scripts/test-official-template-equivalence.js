/**
 * Testa equivalência pixel a pixel entre renderCourseCard legado e o adaptador
 * do Estúdio para o template cruzeiro-graduacao-v1.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { renderCourseCard, prepareBackgroundBuffer } = require("../src/render-card");
const { convertCardToWhatsAppJpeg } = require("../src/whatsapp-image");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

(async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "official-tpl-"));
  process.env.APP_RUNTIME_DIR = runtimeDir;

  // Carrega módulos de configuração/runtime SOMENTE após definir APP_RUNTIME_DIR.
  const { seedRuntimeDefaults } = require("../src/config/seed");
  const { renderSavedTemplate } = require("../src/template-editor/renderer/render-saved-template");

  seedRuntimeDefaults();

  const bgPath = path.join(runtimeDir, "data", "assets", "demo-bg.jpg");
  assert.ok(fs.existsSync(bgPath), "demo-bg.jpg deve existir nos assets");
  const bgBuffer = fs.readFileSync(bgPath);

  const values = {
    titulo: "Análise e Desenvolvimento de Sistemas",
    modalidade: "Graduação",
    formacao: "Bacharelado",
    duracao: "4 semestres",
    imagemFundo: "demo-bg.jpg",
  };

  const prepared = await prepareBackgroundBuffer(bgBuffer);
  const directCard = await renderCourseCard(prepared, {
    curso: values.titulo,
    modalidade: values.modalidade,
    formacao: values.formacao,
    duracao: values.duracao,
  });

  const studioCard = await renderSavedTemplate("cruzeiro-graduacao-v1", values);

  const directMeta = await sharp(directCard).metadata();
  const studioMeta = await sharp(studioCard).metadata();
  assert.strictEqual(directMeta.width, 1080, "largura do card legado deve ser 1080");
  assert.strictEqual(directMeta.height, 1080, "altura do card legado deve ser 1080");
  assert.strictEqual(studioMeta.width, 1080, "largura do card adaptador deve ser 1080");
  assert.strictEqual(studioMeta.height, 1080, "altura do card adaptador deve ser 1080");

  assert.strictEqual(directCard.length, studioCard.length, "cards devem ter mesmo tamanho em bytes");
  assert.strictEqual(sha256(directCard), sha256(studioCard), "cards devem ser idênticos byte a byte");

  const directWhatsApp = await convertCardToWhatsAppJpeg(directCard);
  const studioPngForWa = await renderSavedTemplate("cruzeiro-graduacao-v1", values);
  const studioWhatsApp = await convertCardToWhatsAppJpeg(studioPngForWa);

  const directWaMeta = await sharp(directWhatsApp).metadata();
  const studioWaMeta = await sharp(studioWhatsApp).metadata();
  assert.strictEqual(directWaMeta.format, "jpeg", "WhatsApp legado deve ser JPEG");
  assert.strictEqual(studioWaMeta.format, "jpeg", "WhatsApp adaptador deve ser JPEG");
  assert.strictEqual(directWaMeta.width, studioWaMeta.width, "WhatsApp deve ter mesma largura");
  assert.strictEqual(directWaMeta.height, studioWaMeta.height, "WhatsApp deve ter mesma altura");
  assert.strictEqual(sha256(directWhatsApp), sha256(studioWhatsApp), "WhatsApp devem ser idênticos byte a byte");

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log("Official template equivalence OK: card e WhatsApp são idênticos entre legado e Estúdio.");
})();
