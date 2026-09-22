/**
 * Renderiza um template salvo pelo ID.
 *
 * Se o template usar rendererType="legacy-course-card", delega para o
 * renderizador oficial de cards de curso (src/render-card.js), preservando o
 * resultado pixel a pixel.
 *
 * Outros templates continuam usando renderTemplate genérico.
 */

const fs = require("fs");
const path = require("path");
const { RUNTIME } = require("../../config/runtime");
const { renderTemplate } = require("./index");
const { loadAssetBuffer } = require("./utils");
const { renderCourseCard, prepareBackgroundBuffer } = require("../../render-card");
const { renderDnaWorkVagasTemplate } = require("./dna-work-vagas");

async function renderSavedTemplate(templateId, values = {}, runtimeAssets = {}) {
  const filePath = path.join(RUNTIME.templatesDir, `${templateId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template "${templateId}" não encontrado.`);
  }

  const template = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (template.rendererType === "legacy-course-card") {
    const required = ["titulo", "modalidade", "formacao", "duracao", "imagemFundo"];
    for (const key of required) {
      if (values[key] === undefined || values[key] === null || String(values[key]).trim() === "") {
        throw new Error(`Variável obrigatória ausente: ${key}`);
      }
    }

    const bgBuffer = await loadAssetBuffer(values.imagemFundo, runtimeAssets);
    if (!bgBuffer) {
      throw new Error(`Imagem de fundo não encontrada: ${values.imagemFundo}`);
    }

    const prepared = await prepareBackgroundBuffer(bgBuffer);
    const course = {
      curso: values.titulo,
      modalidade: values.modalidade,
      formacao: values.formacao,
      duracao: values.duracao,
    };

    return renderCourseCard(prepared, course);
  }

  if (template.rendererType === "dna-work-vagas") {
    return renderDnaWorkVagasTemplate(values, runtimeAssets);
  }

  return renderTemplate(template, values, { runtimeAssets });
}

module.exports = { renderSavedTemplate };
