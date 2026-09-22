/**
 * Teste do template DNA Work - Temos Vagas.
 */

require("dotenv").config();

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { renderSavedTemplate } = require("../src/template-editor/renderer/render-saved-template");

(async () => {
  const payload = {
    titulo_vaga: "Açougueiro",
    regime: "CLT",
    salario: "R$ 2800,00",
    beneficio: "Auxílio Transporte",
    local: "Jardim Cumbica Guarulhos",
    imagem_principal: "dna-work-vagas-exemplo.jpg",
  };

  const buf = await renderSavedTemplate("dna-work-vagas", payload);
  const meta = await sharp(buf).metadata();
  assert.equal(meta.width, 1080, "largura deve ser 1080");
  assert.equal(meta.height, 1350, "altura deve ser 1350");
  assert.ok(buf.length > 100000, "PNG renderizado deve ter conteúdo");

  // Sem imagem principal ainda deve produzir card válido
  const noImage = await renderSavedTemplate("dna-work-vagas", {
    titulo_vaga: "Gerente",
    regime: "PJ",
    salario: "",
    beneficio: "",
    local: "",
  });
  const noImageMeta = await sharp(noImage).metadata();
  assert.equal(noImageMeta.width, 1080);
  assert.equal(noImageMeta.height, 1350);
  assert.ok(noImage.length > 50000);

  // Fallbacks
  const fallbackPayload = {
    titulo_vaga: "",
    regime: "",
    salario: "0",
    beneficio: "",
    local: "",
  };
  const fallbackBuf = await renderSavedTemplate("dna-work-vagas", fallbackPayload);
  const fallbackMeta = await sharp(fallbackBuf).metadata();
  assert.equal(fallbackMeta.width, 1080);
  assert.equal(fallbackMeta.height, 1350);

  console.log("DNA Work - Temos Vagas OK");
})();
