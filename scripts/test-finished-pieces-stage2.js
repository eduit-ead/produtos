/**
 * Teste da Etapa 2 do histórico de peças finalizadas.
 *
 * Valida integração com produção em lote (aprovação gera peça finalizada),
 * migração idempotente de manifestos e exclusão segura de peças sem apagar
 * assets compartilhados. Não faz chamadas reais à OpenAI.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "finished-test2-"));
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
const { createStorageProvider } = require("../src/storage");
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
    const catalogDir = process.env.AI_CATALOG_DIR;
    const collectionId = "test-colecao";
    const slug = "cozinheiro-teste";
    const storage = createStorageProvider({ baseDir: catalogDir });

    // Cria um card falso para o item aprovado em lote.
    // A chave segue o padrão do lote: "{slug}/card" relativo ao storage da coleção.
    const samplePng = fs.readFileSync(path.join(__dirname, "..", "output", "dna-work-cozinheira.png"));
    const cardKey = `${slug}/card`;
    const collectionStorage = createStorageProvider({ baseDir: path.join(catalogDir, collectionId) });
    await collectionStorage.save(cardKey, samplePng, { contentType: "image/png" });

    // Cria manifesto com approvedVisual
    const manifestDir = path.join(catalogDir, collectionId);
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      courses: {
        [slug]: {
          course_id: "rec-1",
          curso: "Cozinheiro Teste Lote",
          status: "aprovado",
          approvedAt: new Date().toISOString(),
          approvedVisual: {
            collectionId,
            slug,
            source: "batch",
            jobId: "job-1",
            runId: "run-1",
            templateId: "dna-work-vagas",
            backgroundKey: `${slug}/fundo`,
            cardKey,
            whatsappKey: `${slug}/whatsapp`,
            approvedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      },
    };
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // 1. Migração deve criar peça finalizada a partir do manifesto
    const migrateRes = await request(port, "POST", "/api/finished-pieces/migrate");
    assert.equal(migrateRes.status, 200, "migração deve funcionar");
    assert.equal(migrateRes.body.created, 1, "uma peça migrada");

    // 2. Migração idempotente
    const migrate2 = await request(port, "POST", "/api/finished-pieces/migrate");
    assert.equal(migrate2.body.created, 0, "não duplicar peças");

    // 3. Listagem mostra peça migrada
    const listRes = await request(port, "GET", "/api/finished-pieces?source=migration");
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.total, 1);
    const piece = listRes.body.items[0];
    assert.equal(piece.source, "migration");
    assert.equal(piece.templateId, "dna-work-vagas");
    assert.equal(piece.collectionId, collectionId);
    assert.equal(piece.itemId, slug);
    assert.ok(piece.url, "URL pública");

    // 4. Arquivo copiado para finished/{id}/card.png está acessível
    const fileRes = await request(port, "GET", `/api/files/${encodeKey(piece.fileKey)}`);
    assert.equal(fileRes.status, 200);
    assert.ok(fileRes.body.length > 100000, "PNG copiado tem conteúdo");

    // 5. Excluir peça finalizada não apaga manifesto nem card original do lote
    const delRes = await request(port, "DELETE", `/api/finished-pieces/${encodeURIComponent(piece.id)}`);
    assert.equal(delRes.status, 200);

    const indexPath = path.join(catalogDir, "finished", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.ok(!index.pieces.some((p) => p.id === piece.id), "peça removida do índice");

    assert.ok(fs.existsSync(path.join(manifestDir, "manifest.json")), "manifesto original preservado");
    const originalCardExists = await collectionStorage.exists(cardKey);
    assert.ok(originalCardExists, "card original do lote preservado");

    console.log("Etapa 2 — Histórico de peças finalizadas (lote e migração): OK");
  } finally {
    server.close();
  }
})();
