/**
 * Teste do template DNA Work - Temos Vagas.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dna-work-test-"));
process.env.APP_RUNTIME_DIR = runtimeDir;
process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.OPENAI_API_KEY = "";
process.env.STORAGE_PROVIDER = "local";
process.env.AUTH_DISABLED = "true";

const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();

const {
  buildDnaWorkImagePrompt,
  DNA_WORK_NEGATIVE_PROMPT,
  generateStudioPhoto,
  approveStudioPhoto,
} = require("../src/template-editor/ai-background");
const { renderSavedTemplate } = require("../src/template-editor/renderer/render-saved-template");

const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          let parsed;
          try {
            parsed = JSON.parse(buffer.toString("utf8"));
          } catch {
            parsed = buffer;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function bufferRequest(port, urlPath, body, headers = {}) {
  return request(port, "POST", urlPath, body, headers).then((res) => {
    if (res.status !== 200) {
      throw new Error(`Render failed ${res.status}: ${res.body?.toString?.() || ""}`);
    }
    return res.body;
  });
}

async function topRightMeanColor(pngBuffer, top = 100, left = 600, width = 400, height = 400) {
  const { data, info } = await sharp(pngBuffer)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}

async function boxMeanColor(pngBuffer, x, y, width, height) {
  return topRightMeanColor(pngBuffer, y, x, width, height);
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const APPROVED_COZINHEIRA_PHOTO = "dna-work-photo-mud0orps-e9f40aca.png";

    // 1. Prompt com campos de geração
    const prompt = buildDnaWorkImagePrompt("Cozinheiro", "Masculino", "cozinha profissional com equipamentos", "sorrindo levemente");
    assert.ok(prompt.includes("Cozinheiro"), "prompt deve conter o título da vaga");
    assert.ok(prompt.includes("Masculino"), "prompt deve conter o sexo");
    assert.ok(prompt.includes("cozinha profissional"), "prompt deve conter o ambiente");
    assert.ok(prompt.includes("sorrindo levemente"), "prompt deve conter a descrição adicional");
    assert.ok(prompt.includes("EXATAMENTE UMA pessoa"), "prompt deve exigir uma pessoa");
    assert.ok(prompt.includes("70%"), "prompt deve exigir ~70% de altura");
    assert.ok(DNA_WORK_NEGATIVE_PROMPT.includes("logotipos"), "negative prompt deve citar logotipos");

    const indPrompt = buildDnaWorkImagePrompt("Recepcionista", "Indiferente", "", "");
    assert.ok(indPrompt.includes("não impor aparência masculina ou feminina"), "Indiferente não deve impor gênero");

    // 2. Render sem foto e com dados padrão: dimensões corretas e sem área preta
    const emptyPayload = JSON.stringify({ values: {} });
    const emptyBuf = await bufferRequest(port, "/api/render/dna-work-vagas", emptyPayload, { "Content-Type": "application/json" });
    const emptyMeta = await sharp(emptyBuf).metadata();
    assert.equal(emptyMeta.width, 1080, "largura deve ser 1080");
    assert.equal(emptyMeta.height, 1350, "altura deve ser 1350");
    assert.ok(emptyBuf.length > 50000, "PNG renderizado deve ter conteúdo");

    const emptyMean = await topRightMeanColor(emptyBuf);
    assert.ok(emptyMean.b > 15, "canto superior direito sem foto deve manter o fundo azul-marinho, não preto");

    // 3. Render com Cozinheiro e foto aprovada da cozinheira
    const cozinheiroPayload = JSON.stringify({
      values: {
        titulo_vaga: "Cozinheiro",
        regime: "CLT",
        salario: "A combinar",
        beneficio: "A combinar",
        local: "Barra Funda",
        imagem_principal: APPROVED_COZINHEIRA_PHOTO,
      },
    });
    const cozinheiroBuf = await bufferRequest(port, "/api/render/dna-work-vagas", cozinheiroPayload, { "Content-Type": "application/json" });
    fs.writeFileSync(path.join(__dirname, "..", "output", "dna-work-cozinheira.png"), cozinheiroBuf);
    const cozinheiroMeta = await sharp(cozinheiroBuf).metadata();
    assert.equal(cozinheiroMeta.width, 1080, "largura do card Cozinheiro deve ser 1080");
    assert.equal(cozinheiroMeta.height, 1350, "altura do card Cozinheiro deve ser 1350");
    assert.ok(cozinheiroBuf.length > 100000, "card Cozinheiro deve ter conteúdo");

    // A foto deve aparecer na região superior direita (próximo ao rosto esperado)
    const faceMean = await topRightMeanColor(cozinheiroBuf, 200, 760, 200, 260);
    assert.ok(faceMean.r > 50 || faceMean.g > 40 || faceMean.b > 40, "região do rosto deve conter cores da fotografia");

    // Não deve existir uma linha/faixa preta na transição superior da foto (top fade)
    const topMean = await topRightMeanColor(cozinheiroBuf, 0, 760, 200, 60);
    assert.ok(topMean.b > 10 || topMean.r > 10 || topMean.g > 10, "borda superior da foto não deve ser preta");

    // Valores dos 4 blocos centralizados nos centros dos ícones
    const centers = [158, 403, 667, 917];
    const { data: centerData, info: centerInfo } = await sharp(cozinheiroBuf).raw().toBuffer({ resolveWithObject: true });
    const rowStride = centerInfo.width * centerInfo.channels;
    for (const cx of centers) {
      const idx = (1015 * rowStride) + cx * centerInfo.channels;
      const [r, g, b] = [centerData[idx], centerData[idx + 1], centerData[idx + 2]];
      assert.ok(r > 200 && g > 200 && b > 200, `centro do texto do bloco em x=${cx} deve ser branco (${r},${g},${b})`);
    }

    // CTA inferior: apenas "Envie seu currículo", centralizado verticalmente
    function countWhitePixels(bufData, w, channels, x0, y0, wBox, hBox) {
      let count = 0;
      for (let y = y0; y < y0 + hBox; y++) {
        for (let x = x0; x < x0 + wBox; x++) {
          const i = (y * w + x) * channels;
          if (bufData[i] > 230 && bufData[i + 1] > 230 && bufData[i + 2] > 230) count++;
        }
      }
      return count;
    }
    const ctaWhiteMain = countWhitePixels(centerData, centerInfo.width, centerInfo.channels, 530, 1184, 340, 40);
    assert.ok(ctaWhiteMain > 1500, "texto 'Envie seu currículo' deve estar visível no CTA");
    const ctaWhiteBelow = countWhitePixels(centerData, centerInfo.width, centerInfo.channels, 530, 1225, 340, 40);
    assert.ok(ctaWhiteBelow < 100, "frase secundária 'E venha crescer com a gente!' deve ter sido removida do CTA");

    // 4. Geração de fotografia por IA (dry-run, sem chamada real)
    const genRes = await request(port, "POST", "/api/studio/generate-photo", JSON.stringify({
      templateId: "dna-work-vagas",
      values: { titulo_vaga: "Açougueiro" },
      visual: {},
      dryRun: true,
      size: "1024x1792",
    }), { "Content-Type": "application/json" });
    assert.equal(genRes.status, 200, `geração de fotografia falhou: ${JSON.stringify(genRes.body)}`);
    assert.equal(genRes.body.metadata.kind, "photo", "metadata.kind deve ser photo");
    assert.equal(genRes.body.metadata.dryRun, true, "dry-run deve ser true");
    assert.ok(genRes.body.metadata.urls?.foto, "deve haver URL da foto");
    assert.ok(genRes.body.metadata.prompt?.includes("Açougueiro"), "prompt deve conter título");

    // Transforma dry-run em registro fictício de produção para testar aprovação sem OpenAI real.
    const metaPath = path.join(runtimeDir, "output", "ai-catalog", "studio", genRes.body.metadata.runId, "metadata.json");
    const photoMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    photoMeta.dryRun = false;
    photoMeta.cost.dryRun = false;
    fs.writeFileSync(metaPath, JSON.stringify(photoMeta, null, 2), "utf8");

    // 5. Aprovação da fotografia retorna assetId
    const approveRes = await request(port, "POST", "/api/studio/approve-background", JSON.stringify({
      runId: genRes.body.metadata.runId,
      templateId: "dna-work-vagas",
      collectionId: null,
      itemId: null,
    }), { "Content-Type": "application/json" });
    assert.equal(approveRes.status, 200, `aprovação falhou: ${JSON.stringify(approveRes.body)}`);
    assert.equal(approveRes.body.kind, "photo", "aprovação deve retornar kind photo");
    assert.ok(approveRes.body.assetId, "deve retornar assetId");

    // 6. Render com a foto aprovada
    const approvedBuf = await bufferRequest(port, "/api/render/dna-work-vagas", JSON.stringify({
      values: {
        titulo_vaga: "Açougueiro",
        regime: "CLT",
        salario: "R$ 2800,00",
        beneficio: "Auxílio Transporte",
        local: "Jardim Cumbica Guarulhos",
        imagem_principal: approveRes.body.assetId,
      },
    }), { "Content-Type": "application/json" });
    const approvedMeta = await sharp(approvedBuf).metadata();
    assert.equal(approvedMeta.width, 1080);
    assert.equal(approvedMeta.height, 1350);
    assert.ok(approvedBuf.length > 50000, "render aprovado deve ter conteúdo");

    // 7. A imagem de referência preenchida NUNCA deve estar em assets
    assert.ok(!fs.existsSync(path.join(runtimeDir, "data", "assets", "dna-work-vagas-exemplo.jpg")), "flyer de referência não deve estar em assets");

    // 8. Textos longos não alteram dimensões
    const longBuf = await renderSavedTemplate("dna-work-vagas", {
      titulo_vaga: "Engenheiro de Software Sênior Especialista em Plataformas",
      regime: "CLT - Contrato Indeterminado",
      salario: "R$ 15.000,00 + Benefícios",
      beneficio: "Vale Refeição, Vale Transporte, Plano de Saúde, Gympass",
      local: "Jardim Cumbica Guarulhos - São Paulo - Brasil",
    });
    const longMeta = await sharp(longBuf).metadata();
    assert.equal(longMeta.width, 1080);
    assert.equal(longMeta.height, 1350);

    console.log("DNA Work - Temos Vagas OK");
  } finally {
    server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
})();
