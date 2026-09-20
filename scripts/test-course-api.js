const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("node:assert/strict");
const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

const INPUT_FILE = path.join(__dirname, "..", "input", "cursos.xlsx");
const MANIFEST_FILE = path.join(__dirname, "..", "output", "ai-catalog", "manifest.json");

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

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Planilha existe e é somente leitura.
    const stats = fs.statSync(INPUT_FILE);
    assert.ok(stats.isFile(), "input/cursos.xlsx deve existir");

    // 2. Listar cursos deve retornar 128 entradas.
    const list = await request(port, "GET", "/api/courses");
    assert.equal(list.status, 200, `Listagem falhou: ${list.body}`);
    const courses = assertJson(list);
    assert.equal(courses.length, 128, `esperava 128 cursos, encontrou ${courses.length}`);

    // 3. Buscar curso por slug.
    const slug = "analise-e-desenvolvimento-de-sistemas";
    const detail = await request(port, "GET", `/api/courses/${slug}`);
    assert.equal(detail.status, 200, `Detalhe falhou: ${detail.body}`);
    const course = assertJson(detail);
    assert.equal(course.slug, slug);
    assert.ok(course.curso, "curso deve ter nome");
    assert.ok(course.prompt_imagem, "deve ter prompt_imagem");

    // 4. Slug inválido deve retornar 400.
    const invalid = await request(port, "GET", "/api/courses/invalid-slug!");
    assert.equal(invalid.status, 400, "slug inválido deve retornar 400");

    // 5. Slug inexistente deve retornar 404.
    const missing = await request(port, "GET", "/api/courses/nao-existe-123");
    assert.equal(missing.status, 404, "slug inexistente deve retornar 404");

    // 6. Gerar fundo em dry-run sem chamar OpenAI.
    const generate = await request(
      port,
      "POST",
      `/api/courses/${slug}/generate`,
      JSON.stringify({ dryRun: true }),
      { "Content-Type": "application/json" }
    );
    assert.equal(generate.status, 200, `Geração dry-run falhou: ${generate.body}`);
    const genRecord = assertJson(generate);
    assert.ok(genRecord.record, "deve retornar registro");
    assert.equal(genRecord.record.dryRun, true, "deve ser dry-run");
    assert.equal(genRecord.record.model, "mock", "modelo mock em dry-run");

    // 7. Renderizar card com fundo mock.
    const render = await request(port, "POST", `/api/courses/${slug}/render`, "", {});
    assert.equal(render.status, 200, `Render falhou: ${render.body}`);
    const renderResult = assertJson(render);
    assert.ok(renderResult.cardPath, "deve retornar cardPath");
    assert.ok(fs.existsSync(path.join(__dirname, "..", "output", "ai-catalog", slug, `${slug}-card-ia.png`)), "card IA deve existir");

    // 8. Manifesto criado/atualizado atomicamente.
    assert.ok(fs.existsSync(MANIFEST_FILE), "manifest.json deve existir");
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    assert.ok(manifest.courses, "manifest deve ter courses");
    assert.ok(manifest.courses[slug], "manifest deve conter o curso processado");

    // 9. Aprovar e rejeitar.
    const approve = await request(port, "POST", `/api/courses/${slug}/approve`);
    assert.equal(approve.status, 200, `Aprovar falhou: ${approve.body}`);
    assert.equal(assertJson(approve).record.status, "aprovado");

    const reject = await request(port, "POST", `/api/courses/${slug}/reject`);
    assert.equal(reject.status, 200, `Rejeitar falhou: ${reject.body}`);
    assert.equal(assertJson(reject).record.status, "rejeitado");

    console.log("Course API OK: 128 cursos, busca, dry-run, render, manifest e status verificados.");
  } finally {
    server.close();
  }
})();
