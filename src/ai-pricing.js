/**
 * Configuração local versionada de preços da Image API da OpenAI.
 *
 * Valores usados para estimar custo quando a API não retorna preço diretamente.
 * Atualizar sempre que os preços oficiais mudarem.
 */

const PRICING = {
  "gpt-image-2.5-flare": {
    model: "gpt-image-2.5-flare",
    textInputUsdPerMillion: 5,
    imageInputUsdPerMillion: 8,
    imageOutputUsdPerMillion: 30,
    verifiedAt: "2026-09-19",
    source: "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
  },
};

function getPricing(model) {
  return PRICING[model] || null;
}

function estimateCost(model, usage) {
  const pricing = getPricing(model);
  if (!pricing || !usage) return null;

  const inputTextTokens = usage.input_tokens_details?.text_tokens || usage.input_tokens || 0;
  const outputImageTokens = usage.output_tokens_details?.image_tokens || usage.output_tokens || 0;

  const inputTextCost = (inputTextTokens * pricing.textInputUsdPerMillion) / 1_000_000;
  const outputImageCost = (outputImageTokens * pricing.imageOutputUsdPerMillion) / 1_000_000;

  return {
    model,
    inputTextTokens,
    outputImageTokens,
    inputTextCostUsd: inputTextCost,
    outputImageCostUsd: outputImageCost,
    totalCostUsd: inputTextCost + outputImageCost,
    pricing,
  };
}

module.exports = {
  PRICING,
  getPricing,
  estimateCost,
};
