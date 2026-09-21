const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const assert = require("node:assert/strict");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "batch-lifecycle-test-"));
process.env.AI_CATALOG_DIR = TEMP_DIR;
process.env.STORAGE_LOCAL_DIR = TEMP_DIR;

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
          resolve({ status: res.statusCode, body: buffer.toString() });
        });
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
    parsed = JSON.parse(response.body);
  } catch {
    assert.fail(`Resposta não é JSON válido: ${response.body}`);
  }
  return parsed;
}

async function pollJob(port, jobId, targetStatuses, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const poll = await request(port, "GET", `/api/batches/${jobId}`);
    const job = assertJson(poll);
    if (targetStatuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout aguardando status ${targetStatuses.join(",")} para ${jobId}`);
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const courses = [
      { course_id: "1", slug: "analise-e-desenvolvimento-de-sistemas" },
      { course_id: "2", slug: "administracao" },
    ];

    // 1. Criar job dry-run
    const create = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({ courses, dryRun: true, concurrency: 1, batch_size: 1 }),
      { "Content-Type": "application/json" }
    );
    assert.equal(create.status, 201, `Criar job falhou: ${create.body}`);
    const job = assertJson(create).job;
    assert.ok(job.id, "job deve ter id");
    assert.equal(job.status, "criado");
    assert.equal(job.dryRun, true);

    // 2. Iniciar e concluir
    const start = await request(port, "POST", `/api/batches/${job.id}/start`);
    assert.equal(start.status, 200, `Start falhou: ${start.body}`);
    let finished = await pollJob(port, job.id, ["concluido", "concluido_com_erros"]);
    assert.equal(finished.status, "concluido");

    // 3. Itens de simulação e arquivos existem
    const items = assertJson(await request(port, "GET", `/api/batches/${job.id}/items`));
    assert.equal(items.length, courses.length);
    for (const item of items) {
      assert.equal(item.status, "simulacao", `item ${item.slug} não ficou simulacao`);
      assert.equal(item.dryRun, true, `item ${item.slug} deve estar marcado como dryRun`);
      const base = path.join(TEMP_DIR, item.slug);
      assert.ok(fs.existsSync(path.join(base, `${item.slug}-fundo.png`)));
      assert.ok(fs.existsSync(path.join(base, `${item.slug}-card.png`)));
      assert.ok(fs.existsSync(path.join(base, `${item.slug}-whatsapp.jpg`)));
      assert.ok(fs.existsSync(path.join(base, "metadata.json")));
    }

    // 3b. Aprovação de simulação deve retornar 409
    const approveSim = await request(port, "POST", `/api/batches/${job.id}/items/${courses[0].slug}/approve`);
    assert.equal(approveSim.status, 409, "aprovação de simulação deve retornar 409");

    // 4. Testar pause e resume com job de 2 cursos
    const create2 = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({ courses, dryRun: true }),
      { "Content-Type": "application/json" }
    );
    const job2 = assertJson(create2).job;

    const start2 = await request(port, "POST", `/api/batches/${job2.id}/start`);
    assert.equal(start2.status, 200);
    const running = assertJson(start2).job;
    assert.equal(running.status, "executando");

    // Pausa imediata
    await new Promise((r) => setTimeout(r, 30));
    const pause = await request(port, "POST", `/api/batches/${job2.id}/pause`);
    assert.equal(pause.status, 200);
    const paused = assertJson(pause).job;
    assert.ok(["pausado", "concluido"].includes(paused.status), `pause resultou em ${paused.status}`);

    if (paused.status === "pausado") {
      // Resume e aguarda conclusão
      const resume = await request(port, "POST", `/api/batches/${job2.id}/resume`);
      assert.equal(resume.status, 200);
      const resumed = assertJson(resume).job;
      assert.equal(resumed.status, "executando");
      finished = await pollJob(port, job2.id, ["concluido", "concluido_com_erros"]);
      assert.equal(finished.status, "concluido");
    }

    // 5. Cancelar job em execução
    const create3 = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({ courses, dryRun: true }),
      { "Content-Type": "application/json" }
    );
    const job3 = assertJson(create3).job;
    const start3 = await request(port, "POST", `/api/batches/${job3.id}/start`);
    assert.equal(start3.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    const cancel = await request(port, "POST", `/api/batches/${job3.id}/cancel`);
    assert.equal(cancel.status, 200);
    const cancelled = assertJson(cancel).job;
    assert.ok(["cancelado", "concluido"].includes(cancelled.status));
    if (cancelled.status === "cancelado") {
      for (const item of cancelled.courses) {
        assert.ok(["cancelado", "pronto_revisao", "aprovado", "rejeitado", "erro", "simulacao", "ignorado"].includes(item.status));
      }
    }

    // 6. Retry errors: slug inexistente
    const create4 = await request(
      port,
      "POST",
      "/api/batches",
      JSON.stringify({ courses: [{ course_id: "x", slug: "nao-existe-slug-123" }], dryRun: true }),
      { "Content-Type": "application/json" }
    );
    const job4 = assertJson(create4).job;
    const start4 = await request(port, "POST", `/api/batches/${job4.id}/start`);
    assert.equal(start4.status, 200);
    finished = await pollJob(port, job4.id, ["concluido", "concluido_com_erros"]);
    assert.equal(finished.status, "concluido_com_erros");
    const items4 = assertJson(await request(port, "GET", `/api/batches/${job4.id}/items`));
    assert.equal(items4[0].status, "erro");

    const retry = await request(port, "POST", `/api/batches/${job4.id}/retry-errors`);
    assert.equal(retry.status, 200);
    const retried = await pollJob(port, job4.id, ["concluido", "concluido_com_erros"]);
    assert.equal(retried.status, "concluido_com_erros");
    assert.equal(retried.courses[0].status, "erro", "slug inexistente continua com erro após retry");

    console.log("Batch lifecycle OK: create, start dry-run, pause, resume, cancel, retry.");
  } finally {
    server.close();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
})();
