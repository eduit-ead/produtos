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

async function topRightMeanColor(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .extract({ left: 600, top: 100, width: 400, height: 400 })
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

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Prompt fixo inclui título e restrições
    const prompt = buildDnaWorkImagePrompt("Açougueiro");
    assert.ok(prompt.includes("Açougueiro"), "prompt deve conter o título da vaga");
    assert.ok(prompt.includes("EXATAMENTE UMA pessoa"), "prompt deve exigir uma pessoa");
    assert.ok(DNA_WORK_NEGATIVE_PROMPT.includes("logotipos"), "negative prompt deve citar logotipos");

    // 2. Render sem foto e com dados padrão: dimensões corretas e sem área preta
    const emptyPayload = JSON.stringify({ values: {} });
    const emptyBuf = await bufferRequest(port, "/api/render/dna-work-vagas", emptyPayload, { "Content-Type": "application/json" });
    const emptyMeta = await sharp(emptyBuf).metadata();
    assert.equal(emptyMeta.width, 1080, "largura deve ser 1080");
    assert.equal(emptyMeta.height, 1350, "altura deve ser 1350");
    assert.ok(emptyBuf.length > 50000, "PNG renderizado deve ter conteúdo");

    const emptyMean = await topRightMeanColor(emptyBuf);
    assert.ok(emptyMean.b > 15, "canto superior direito sem foto deve manter o fundo azul-marinho, não preto");

    // 3. Render com todos os campos e foto placeholder
    const withPhoto = await renderSavedTemplate("dna-work-vagas", {
      titulo_vaga: "Açougueiro",
      regime: "CLT",
      salario: "R$ 2800,00",
      beneficio: "Auxílio Transporte",
      local: "Jardim Cumbica Guarulhos",
      imagem_principal: "dna-work-person.jpg",
    });
    assert.equal((await sharp(withPhoto).metadata()).width, 1080);
    assert.equal((await sharp(withPhoto).metadata()).height, 1350);
    assert.ok(withPhoto.length > 100000);

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
