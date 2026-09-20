/**
 * Nomenclatura determinística de arquivos por curso no catálogo.
 */

function courseFiles(slug) {
  if (!slug || typeof slug !== "string") {
    throw new Error("Slug inválido para nomeação de arquivos.");
  }
  return {
    slug,
    fundo: `${slug}-fundo.png`,
    card: `${slug}-card.png`,
    whatsapp: `${slug}-whatsapp.jpg`,
  };
}

module.exports = {
  courseFiles,
};
