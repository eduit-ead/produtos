const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const assert = require("node:assert/strict");

const INPUT_FILE = path.join(__dirname, "..", "input", "cursos.xlsx");

// Isola testes em diretório temporário.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ai-catalog-test-"));
process.env.AI_CATALOG_DIR = TEMP_DIR;

const express = require("express");
const { createRouter } = require("../src/template-editor/api");

const app = express();
app.use("/api", createRouter());
const server = http.createServer(app);

const MANIFEST_FILE = path.join(TEMP_DIR, "manifest.json");

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

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

(async () => {
  const inputHashBefore = hashFile(INPUT_FILE);

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
    assert.ok(courses[0].current_background_url, "curso deve ter current_background_url da coluna Image");

    // 3. Buscar curso por slug.
    const slug = "analise-e-desenvolvimento-de-sistemas";
    const detail = await request(port, "GET", `/api/courses/${slug}`);
    assert.equal(detail.status, 200, `Detalhe falhou: ${detail.body}`);
    const course = assertJson(detail);
    assert.equal(course.slug, slug);
    assert.ok(course.curso, "curso deve ter nome");
    assert.ok(course.prompt_imagem, "deve ter prompt_imagem");
    assert.ok(course.current_background_url, "deve ter current_background_url da planilha");

    // 4. Slug inválido deve retornar 400.
    const invalid = await request(port, "GET", "/api/courses/invalid-slug!");
    assert.equal(invalid.status, 400, "slug inválido deve retornar 400");

    // 5. Slug inexistente deve retornar 404.
    const missing = await request(port, "GET", "/api/courses/nao-existe-123");
    assert.equal(missing.status, 404, "slug inexistente deve retornar 404");

    // 6. Aprovação sem card renderizado deve falhar.
    const approveBeforeRender = await request(port, "POST", `/api/courses/${slug}/approve`);
    assert.equal(approveBeforeRender.status, 400, "aprovar sem card deve falhar");

    // 7. Gerar fundo em dry-run sem chamar OpenAI, com prompt customizado.
    const customPrompt = "Prompt de teste para dry-run";
    const generate = await request(
      port,
      "POST",
      `/api/courses/${slug}/generate`,
      JSON.stringify({ dryRun: true, prompt: customPrompt }),
      { "Content-Type": "application/json" }
    );
    assert.equal(generate.status, 200, `Geração dry-run falhou: ${generate.body}`);
    const genRecord = assertJson(generate).record;
    assert.ok(genRecord, "deve retornar registro");
    assert.equal(genRecord.dryRun, true, "deve ser dry-run");
    assert.equal(genRecord.model, "mock", "modelo mock em dry-run");
    assert.equal(genRecord.prompt, customPrompt, "prompt customizado deve ser usado");
    assert.ok(fs.existsSync(path.join(TEMP_DIR, slug, `${slug}-fundo-ia.png`)), "fundo IA deve existir");

    // 8. Renderizar card com fundo mock.
    const render = await request(port, "POST", `/api/courses/${slug}/render`, "", {});
    assert.equal(render.status, 200, `Render falhou: ${render.body}`);
    const renderResult = assertJson(render);
    assert.ok(renderResult.cardPath, "deve retornar cardPath");
    assert.ok(fs.existsSync(path.join(TEMP_DIR, slug, `${slug}-card-ia.png`)), "card IA deve existir");

    // 9. Aprovar curso com card renderizado.
    const approve = await request(port, "POST", `/api/courses/${slug}/approve`);
    assert.equal(approve.status, 200, `Aprovar falhou: ${approve.body}`);
    assert.equal(assertJson(approve).record.status, "aprovado");

    // 10. Rejeitar curso.
    const reject = await request(port, "POST", `/api/courses/${slug}/reject`);
    assert.equal(reject.status, 200, `Rejeitar falhou: ${reject.body}`);
    assert.equal(assertJson(reject).record.status, "rejeitado");

    // 11. Upload de fundo em JPEG normalizado para PNG.
    const jpgPath = path.join(__dirname, "..", "assets", "logo-cruzeiro-branco.png");
    // Usa PNG existente como arquivo de teste, mas simula extensão jpg no body não é trivial
    // com http.request. Usa o próprio arquivo com o MIME correto.
    const uploadBoundary = `----FormBoundary${crypto.randomBytes(8).toString("hex")}`;
    const fileBuffer = fs.readFileSync(jpgPath);
    const uploadBody = Buffer.concat([
      Buffer.from(`--${uploadBoundary}\r\nContent-Disposition: form-data; name="file"; filename="test-bg.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${uploadBoundary}--\r\n`),
    ]);
    const upload = await request(
      port,
      "POST",
      `/api/courses/${slug}/upload`,
      uploadBody,
      { "Content-Type": `multipart/form-data; boundary=${uploadBoundary}` }
    );
    assert.equal(upload.status, 200, `Upload falhou: ${upload.body}`);
    const uploadResult = assertJson(upload);
    assert.ok(uploadResult.path.endsWith("-fundo-upload.png"), "upload deve ser salvo como PNG");

    // 12. Manifesto criado/atualizado atomicamente.
    assert.ok(fs.existsSync(MANIFEST_FILE), "manifest.json deve existir");
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    assert.ok(manifest.courses, "manifest deve ter courses");
    assert.ok(manifest.courses[slug], "manifest deve conter o curso processado");
    assert.equal(manifest.courses[slug].selectedBackground, "upload", "upload deve ser selecionado");

    // 13. Geração real sem OPENAI_API_KEY deve retornar erro claro.
    delete process.env.OPENAI_API_KEY;
    const realGenerate = await request(
      port,
      "POST",
      `/api/courses/${slug}/generate`,
      JSON.stringify({ dryRun: false }),
      { "Content-Type": "application/json" }
    );
    assert.equal(realGenerate.status, 400, "geração real sem chave deve retornar 400");
    assert.ok(assertJson(realGenerate).error.includes("OPENAI_API_KEY"), "erro deve mencionar OPENAI_API_KEY");

    console.log("Course API OK: 128 cursos, busca, dry-run, prompt customizado, render, manifest, upload e status verificados.");
  } finally {
    server.close();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    const inputHashAfter = hashFile(INPUT_FILE);
    assert.equal(inputHashAfter, inputHashBefore, "input/cursos.xlsx foi modificado pelo teste");
  }
})();
