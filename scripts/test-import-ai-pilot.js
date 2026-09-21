#!/usr/bin/env node
"use strict";

/**
 * Teste de regressão da importação de fundos piloto.
 *
 * Assume que scripts/import-ai-pilot.js já foi executado no catálogo real.
 * Inicia o servidor local, localiza o lote "Piloto oficial — fundos IA existentes"
 * e valida que a tela de revisão pode exibir fundo, card e WhatsApp.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PILOT_DIR = path.join(ROOT, "output", "ai-pilot");
const JOB_NAME = "Piloto oficial — fundos IA existentes";
const COLLECTION_ID = "graduacao-cruzeiro";
const EXPECTED_SLUGS = ["ciberseguranca", "gestao-publica", "nutricao"];

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function request(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertJson(response) {
  let parsed;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.body.toString("utf8")}`);
  }
  return parsed;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_DISABLED: "true",
    };
    delete env.APP_RUNTIME_DIR; // usa o padrão (ROOT)

    const child = spawn(process.execPath, [path.join(ROOT, "src", "template-editor", "server.js")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    function onData(data) {
      output += data.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && child) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve({ child, port: parseInt(match[1], 10) });
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Servidor saiu com código ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout iniciando servidor. Output: ${output}`));
    }, 20000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.kill();
    child.on("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

(async () => {
  // Pré-validação: arquivos de origem existem e são os esperados.
  for (const slug of EXPECTED_SLUGS) {
    const file = `${slug}-fundo-ia.png`;
    assert.ok(fs.existsSync(path.join(PILOT_DIR, file)), `fundo piloto deve existir: ${file}`);
  }

  const server = await startServer();
  try {
    // 1. Lote aparece na API.
    const batchesRes = await request(server.port, "GET", "/api/batches");
    assert.equal(batchesRes.status, 200, "/api/batches deve retornar 200");
    const jobs = assertJson(batchesRes);
    const job = jobs.find((j) => j.name === JOB_NAME);
    assert.ok(job, `lote "${JOB_NAME}" deve aparecer em /api/batches`);
    assert.equal(job.status, "concluido", "lote deve estar concluído");
    assert.equal(job.collectionId || job.collection_id, COLLECTION_ID, "lote deve pertencer à coleção legada");

    // 2. Itens do lote estão prontos para revisão e têm arquivos.
    const itemsRes = await request(server.port, "GET", `/api/batches/${encodeURIComponent(job.id)}/items`);
    assert.equal(itemsRes.status, 200, "/api/batches/:id/items deve retornar 200");
    const items = assertJson(itemsRes);
    assert.equal(items.length, EXPECTED_SLUGS.length, `lote deve ter ${EXPECTED_SLUGS.length} itens`);

    for (const slug of EXPECTED_SLUGS) {
      const item = items.find((i) => i.slug === slug);
      assert.ok(item, `item ${slug} deve existir no lote`);
      assert.equal(item.status, "pronto_revisao", `item ${slug} deve estar pronto_revisao`);
      assert.ok(item.hasBackground, `item ${slug} deve ter fundo`);
      assert.ok(item.hasCard, `item ${slug} deve ter card`);
      assert.ok(item.hasWhatsApp, `item ${slug} deve ter whatsapp`);
    }

    // 3. Imagens são servidas pela API e hash do fundo bate com o piloto.
    for (const slug of EXPECTED_SLUGS) {
      const fundoUrl = `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(`${slug}-fundo.png`)}`;
      const cardUrl = `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(`${slug}-card.png`)}`;
      const waUrl = `/api/catalog/${encodeURIComponent(slug)}/${encodeURIComponent(`${slug}-whatsapp.jpg`)}`;

      const fundoRes = await request(server.port, "GET", fundoUrl);
      assert.equal(fundoRes.status, 200, `fundo de ${slug} deve ser servido`);
      assert.equal(fundoRes.headers["content-type"], "image/png", `fundo de ${slug} deve ser PNG`);
      const sourceHash = hashFile(path.join(PILOT_DIR, `${slug}-fundo-ia.png`));
      const servedHash = crypto.createHash("sha256").update(fundoRes.body).digest("hex");
      assert.equal(servedHash, sourceHash, `hash do fundo servido de ${slug} deve ser idêntico ao piloto`);

      const cardRes = await request(server.port, "GET", cardUrl);
      assert.equal(cardRes.status, 200, `card de ${slug} deve ser servido`);
      assert.equal(cardRes.headers["content-type"], "image/png", `card de ${slug} deve ser PNG`);

      const waRes = await request(server.port, "GET", waUrl);
      assert.equal(waRes.status, 200, `whatsapp de ${slug} deve ser servido`);
      assert.equal(waRes.headers["content-type"], "image/jpeg", `whatsapp de ${slug} deve ser JPEG`);
    }

    console.log("Import AI pilot API OK: lote visível, itens prontos para revisão e imagens servidas corretamente.");
  } finally {
    await stopServer(server.child);
  }
})();
