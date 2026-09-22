/**
 * Teste da Etapa 1 do histórico de peças finalizadas.
 *
 * Valida: salvamento individual, listagem, download, duplicação, exclusão,
 * persistência após leitura direta do disco e imutabilidade após alteração
 * do template. Não faz chamadas reais à OpenAI.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "finished-test-"));
process.env.APP_RUNTIME_DIR = runtimeDir;
process.env.AI_CATALOG_DIR = path.join(runtimeDir, "output", "ai-catalog");
process.env.STORAGE_LOCAL_DIR = process.env.AI_CATALOG_DIR;
process.env.OPENAI_API_KEY = "";
process.env.STORAGE_PROVIDER = "local";
process.env.AUTH_DISABLED = "true";

const { seedRuntimeDefaults } = require("../src/config/seed");
seedRuntimeDefaults();

const express = require("express");
const { createRouter } = require("../src/template-editor/api");
const finishedPiecesService = require("../src/finished-pieces");

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

function jsonRequest(port, method, urlPath, body) {
  return request(port, method, urlPath, body, { "Content-Type": "application/json" });
}

function encodeKey(key) {
  return Buffer.from(key, "utf8").toString("base64url");
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const values = {
      titulo_vaga: "Cozinheiro Teste",
      regime: "CLT",
      salario: "A combinar",
      beneficio: "A combinar",
      local: "Barra Funda",
      imagem_principal: "dna-work-photo-mud0orps-e9f40aca.png",
    };

    // 1. Salvar peça finalizada
    const saveRes = await jsonRequest(port, "POST", "/api/finished-pieces", JSON.stringify({
      templateId: "dna-work-vagas",
      values,
    }));
    assert.equal(saveRes.status, 200, `salvamento falhou: ${JSON.stringify(saveRes.body)}`);
    const piece = saveRes.body.piece;
    assert.ok(piece.id, "peça deve ter id");
    assert.equal(piece.templateId, "dna-work-vagas", "templateId correto");
    assert.equal(piece.source, "criar", "origem criar");
    assert.equal(piece.title, "Cozinheiro Teste", "título derivado");
    assert.ok(piece.fileKey, "fileKey definido");
    assert.equal(piece.dimensions.width, 1080, "largura 1080");
    assert.equal(piece.dimensions.height, 1350, "altura 1350");

    // 2. Arquivo final deve existir e ser servido
    const fileRes = await request(port, "GET", `/api/files/${encodeKey(piece.fileKey)}`);
    assert.equal(fileRes.status, 200, "arquivo final deve ser servido");
    assert.ok(fileRes.body.length > 100000, "PNG final tem conteúdo");

    // 3. Listar peças finalizadas
    const listRes = await request(port, "GET", "/api/finished-pieces?page=1&limit=10");
    assert.equal(listRes.status, 200, "listagem deve funcionar");
    assert.equal(listRes.body.total, 1, "uma peça no histórico");
    assert.equal(listRes.body.items[0].id, piece.id, "peça listada");
    assert.ok(listRes.body.items[0].url, "URL pública da peça");

    // 4. Persistência: recarregar índice diretamente do disco
    const indexPath = path.join(runtimeDir, "output", "ai-catalog", "finished", "index.json");
    assert.ok(fs.existsSync(indexPath), "índice persistido em disco");
    const indexOnDisk = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.ok(indexOnDisk.pieces.some((p) => p.id === piece.id), "peça no índice do disco");

    // 5. Duplicar peça
    const dupRes = await request(port, "POST", `/api/finished-pieces/${encodeURIComponent(piece.id)}/duplicate`);
    assert.equal(dupRes.status, 200, "duplicação deve funcionar");
    assert.equal(dupRes.body.templateId, "dna-work-vagas", "templateId para duplicação");
    assert.equal(dupRes.body.values.titulo_vaga, "Cozinheiro Teste", "valores preservados");

    // 6. Excluir peça
    const delRes = await request(port, "DELETE", `/api/finished-pieces/${encodeURIComponent(piece.id)}`);
    assert.equal(delRes.status, 200, "exclusão deve funcionar");
    const listAfter = await request(port, "GET", "/api/finished-pieces?page=1&limit=10");
    assert.equal(listAfter.body.total, 0, "histórico vazio após exclusão");

    // 7. Arquivo final foi removido, mas asset compartilhado permanece
    const fileAfter = await request(port, "GET", `/api/files/${encodeKey(piece.fileKey)}`);
    assert.equal(fileAfter.status, 404, "arquivo final removido");
    const assetPath = path.join(runtimeDir, "data", "assets", "dna-work-photo-mud0orps-e9f40aca.png");
    assert.ok(fs.existsSync(assetPath), "asset compartilhado preservado");

    // 8. Alterar template não altera peça já salva (simulado: salvar, alterar e verificar registro)
    const save2 = await jsonRequest(port, "POST", "/api/finished-pieces", JSON.stringify({
      templateId: "dna-work-vagas",
      values: { ...values, titulo_vaga: "Cozinheiro Imutável" },
    }));
    assert.equal(save2.status, 200);
    const piece2 = save2.body.piece;
    const templateFile = path.join(runtimeDir, "data", "templates", "dna-work-vagas.json");
    const originalTemplate = JSON.parse(fs.readFileSync(templateFile, "utf8"));
    originalTemplate.name = "DNA Work - Alterado";
    fs.writeFileSync(templateFile, JSON.stringify(originalTemplate), "utf8");
    const get2 = await request(port, "GET", `/api/finished-pieces/${encodeURIComponent(piece2.id)}`);
    assert.equal(get2.status, 200);
    assert.equal(get2.body.templateName, "DNA Work - Temos Vagas", "registro preserva nome do template no momento da finalização");

    console.log("Etapa 1 — Histórico de peças finalizadas: OK");
  } finally {
    server.close();
  }
})();
