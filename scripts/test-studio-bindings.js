const assert = require("node:assert/strict");
const { applyVariableBindings, replaceVariables } = require("../src/template-editor/schema/template-schema");
const { renderTemplate } = require("../src/template-editor/renderer");

const baseTemplate = {
  schemaVersion: 1,
  id: "binding-test",
  name: "Binding Test",
  canvas: { width: 200, height: 200, background: "#ffffff" },
  variables: [
    {
      key: "imagemFundo",
      label: "Imagem de fundo",
      type: "image",
      defaultValue: "default-bg.png",
      required: false,
      binding: { layerId: "bg-image", property: "assetId" },
    },
    {
      key: "corTitulo",
      label: "Cor do título",
      type: "color",
      defaultValue: "#ff0000",
      required: false,
      binding: { layerId: "title", property: "fill" },
    },
    {
      key: "texto",
      label: "Texto",
      type: "string",
      defaultValue: "Olá",
      required: false,
    },
  ],
  assets: ["default-bg.png", "new-bg.png"],
  layers: [
    {
      id: "bg-image",
      type: "image",
      name: "Fundo",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      rotation: 0,
      opacity: 1,
      visible: true,
      zIndex: 0,
      locked: false,
      properties: { assetId: "default-bg.png", fit: "cover", position: "center" },
    },
    {
      id: "title",
      type: "text",
      name: "Título",
      x: 10,
      y: 80,
      width: 180,
      height: 40,
      rotation: 0,
      opacity: 1,
      visible: true,
      zIndex: 1,
      locked: false,
      properties: {
        text: "{{texto}}",
        fontFamily: "Arial",
        fontSize: 24,
        fontWeight: 400,
        fill: "#ff0000",
        align: "left",
        verticalAlign: "top",
        lineHeight: 1.2,
        letterSpacing: 0,
        autoFit: false,
        minFontSize: 8,
        padding: 0,
        maxLines: 1,
        overflow: "clip",
      },
    },
  ],
  metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
};

(async () => {
  // 1. Aplicar binding de imagem altera assetId sem mutar o original.
  const withImage = applyVariableBindings(baseTemplate, { imagemFundo: "new-bg.png" });
  assert.equal(withImage.layers[0].properties.assetId, "new-bg.png", "assetId deve ser atualizado pelo binding de imagem");
  assert.equal(baseTemplate.layers[0].properties.assetId, "default-bg.png", "template original não deve ser mutado");

  // 2. Aplicar binding de cor altera fill sem mutar o original.
  const withColor = applyVariableBindings(baseTemplate, { corTitulo: "#00ff00" });
  assert.equal(withColor.layers[1].properties.fill, "#00ff00", "fill deve ser atualizado pelo binding de cor");
  assert.equal(baseTemplate.layers[1].properties.fill, "#ff0000", "template original não deve ser mutado pelo binding de cor");

  // 3. Valor padrão é usado quando nenhum valor é fornecido.
  const defaults = applyVariableBindings(baseTemplate, {});
  assert.equal(defaults.layers[0].properties.assetId, "default-bg.png", "assetId padrão deve ser usado");
  assert.equal(defaults.layers[1].properties.fill, "#ff0000", "cor padrão deve ser usada");

  // 4. Placeholders continuam funcionando.
  const resolved = { texto: "Teste" };
  assert.equal(replaceVariables("{{texto}}", resolved), "Teste", "placeholder deve ser resolvido");
  assert.equal(replaceVariables("{{inexistente}}", resolved), "{{inexistente}}", "placeholder inexistente deve permanecer");

  // 5. Renderização em memória não quebra com bindings ausentes ou presentes.
  // Como não temos os assets reais, esperamos erro de asset não encontrado, não erro de validação.
  try {
    await renderTemplate(baseTemplate, {});
    assert.fail("deveria ter falhado por asset ausente");
  } catch (err) {
    assert.ok(err.message.includes("não encontrado"), "deve falhar por asset ausente, não por validação");
  }

  console.log("Studio bindings OK: image, color, placeholders e imutabilidade verificados.");
})();
