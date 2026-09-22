/**
 * Teste do template DNA Work - Temos Vagas.
 */

require("dotenv").config();

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { renderSavedTemplate } = require("../src/template-editor/renderer/render-saved-template");

(async () => {
  // 1. Render completo com foto limpa
  const payload = {
    titulo_vaga: "Açougueiro",
    regime: "CLT",
    salario: "R$ 2800,00",
    beneficio: "Auxílio Transporte",
    local: "Jardim Cumbica Guarulhos",
    imagem_principal: "dna-work-person.jpg",
  };

  const buf = await renderSavedTemplate("dna-work-vagas", payload);
  const meta = await sharp(buf).metadata();
  assert.equal(meta.width, 1080, "largura deve ser 1080");
  assert.equal(meta.height, 1350, "altura deve ser 1350");
  assert.ok(buf.length > 100000, "PNG renderizado deve ter conteúdo");

  // 2. Preview sem dados preenchidos e sem foto (apenas fundo + fallbacks)
  const empty = await renderSavedTemplate("dna-work-vagas", {});
  const emptyMeta = await sharp(empty).metadata();
  assert.equal(emptyMeta.width, 1080);
  assert.equal(emptyMeta.height, 1350);
  assert.ok(empty.length > 50000);

  // 3. Sem imagem principal ainda deve produzir card válido
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

  // 4. Fallbacks
  const fallbackBuf = await renderSavedTemplate("dna-work-vagas", {
    titulo_vaga: "",
    regime: "",
    salario: "0",
    beneficio: "",
    local: "",
  });
  const fallbackMeta = await sharp(fallbackBuf).metadata();
  assert.equal(fallbackMeta.width, 1080);
  assert.equal(fallbackMeta.height, 1350);

  // 5. Textos longos não quebram dimensões
  const longText = await renderSavedTemplate("dna-work-vagas", {
    titulo_vaga: "Engenheiro de Software Sênior Especialista em Plataformas",
    regime: "CLT - Contrato Indeterminado",
    salario: "R$ 15.000,00 + Benefícios",
    beneficio: "Vale Refeição, Vale Transporte, Plano de Saúde, Gympass",
    local: "Jardim Cumbica Guarulhos - São Paulo - Brasil",
  });
  const longMeta = await sharp(longText).metadata();
  assert.equal(longMeta.width, 1080);
  assert.equal(longMeta.height, 1350);

  // 6. A imagem de referência preenchida NUNCA deve ser usada automaticamente como imagem_principal
  const fs = require("fs");
  assert.ok(!fs.existsSync("data/assets/dna-work-vagas-exemplo.jpg"), "flyer de referência não deve estar em assets");

  console.log("DNA Work - Temos Vagas OK");
})();
