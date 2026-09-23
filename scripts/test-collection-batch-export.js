/**
 * Publicação em lote e exportação da coleção.
 * Banco e arquivos simulados. Não altera cursos.xlsx nem chama a OpenAI.
 */

process.env.AUTH_DISABLED = "false";
process.env.APP_SESSION_SECRET = "test-session-secret-32chars-minimum";
process.env.DATA_SOURCE = "postgres";
process.env.ALLOW_TEST_DATABASE = "1";
process.env.DATABASE_URL = "postgres://bwipoart_user:senha@localhost:5432/bwipoart_test";
delete process.env.PUBLIC_BASE_URL;

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_XLSX = path.join(ROOT, "input", "cursos.xlsx");
const FIXTURE = path.join(ROOT, "output", "test-short-desc.xlsx");

function parseJson(value) {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function createMemory() {
  const state = {
    databaseName: "bwipoart_test",
    collections: new Map(),
    records: new Map(),
    publications: new Map(),
    versions: [],
  };
  const key = (collectionId, itemId) => `${collectionId}\0${itemId}`;

  async function query(sql, params = []) {
    const repo = require("../src/db/collections-repository");
    const pub = require("../src/publications/service");
    const text = String(sql);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes("current_database()")) return { rows: [{ name: state.databaseName }] };
    if (text === repo.SQL.getCollection) {
      const row = state.collections.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (text === repo.SQL.insertCollection) {
      state.collections.set(params[0], {
        id: params[0], name: params[1], config: parseJson(params[2]),
        default_template_id: params[3], archived: params[4], created_at: params[5], updated_at: params[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text === repo.SQL.getRecord) {
      const wanted = String(params[1]);
      const rows = [...state.records.values()]
        .filter((row) => row.collection_id === params[0] && (row.item_id === wanted || row.slug === wanted || row.source_key === wanted))
        .sort((a, b) => (a.item_id === wanted ? 0 : 1) - (b.item_id === wanted ? 0 : 1));
      return { rows: rows.slice(0, 1) };
    }
    if (text === repo.SQL.listRecords) {
      const rows = [...state.records.values()]
        .filter((row) => row.collection_id === params[0])
        .sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
      return { rows };
    }
    if (text === repo.SQL.insertRecord) {
      state.records.set(key(params[0], params[1]), {
        collection_id: params[0], item_id: params[1], slug: params[2], source_key: params[3],
        title: params[4], fields: parseJson(params[5]), record: parseJson(params[6]),
        created_at: params[7], updated_at: params[8],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text === repo.SQL.updateRecord) {
      const row = state.records.get(key(params[0], params[1]));
      if (!row) return { rows: [], rowCount: 0 };
      row.slug = params[2];
      row.source_key = params[3];
      row.title = params[4];
      row.fields = parseJson(params[5]);
      row.record = parseJson(params[6]);
      row.updated_at = params[7];
      return { rows: [], rowCount: 1 };
    }
    if (text === pub.SQL.lockRecord) {
      const row = state.records.get(key(params[0], params[1]));
      return { rows: row ? [row] : [] };
    }
    if (text === pub.SQL.lockPublication || text === pub.SQL.selectCurrent) {
      const row = state.publications.get(key(params[0], params[1]));
      return { rows: row ? [row] : [] };
    }
    if (text === pub.SQL.insertPublication) {
      state.publications.set(key(params[0], params[1]), {
        collection_id: params[0], item_id: params[1], public_id: params[2], public_url: params[3],
        finished_piece_id: params[4], file_key: params[5], version: params[6],
        created_at: params[7], updated_at: params[8],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text === pub.SQL.updatePublication) {
      const row = state.publications.get(key(params[0], params[1]));
      if (!row || Number(row.version) !== Number(params[6])) return { rows: [], rowCount: 0 };
      row.finished_piece_id = params[2];
      row.file_key = params[3];
      row.version = params[4];
      row.updated_at = params[5];
      return { rows: [], rowCount: 1 };
    }
    if (text === pub.SQL.insertVersion) {
      state.versions.push({
        collection_id: params[0], item_id: params[1], version: params[2],
        finished_piece_id: params[3], file_key: params[4], created_at: params[5],
      });
      return { rows: [], rowCount: 1 };
    }
    const err = new Error(`SQL não simulada: ${text.slice(0, 140)}`);
    err.expose = true;
    throw err;
  }

  const client = { query, release() {} };
  return { state, pool: { query, connect: async () => client, end: async () => {}, on() {} } };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(port, method, urlPath, { body, cookie } = {}) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const headers = {};
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(payload.length);
  }
  if (cookie) headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

function piece(id, itemId, fileKey, collectionId = "lote-teste") {
  return { id, title: id, collectionId, itemId, fileKey, createdAt: "2026-01-01T00:00:00.000Z" };
}

(async () => {
  const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(SOURCE_XLSX)).digest("hex");
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Graduação");
  sheet.addRow(["course_id", "Curso", "slug", "descricao_curta", "Descrição"]);
  sheet.addRow(["9001", "Administração", "administracao", "Curta ADM\nlinha 2 — ção", "Descrição longa ADM"]);
  sheet.addRow(["9002", "Administração Pública", "administracao-publica", "Curta pública", "Outra descrição"]);
  sheet.addRow(["9003", "Editado", "editado", "Arquivo original", "x"]);
  await workbook.xlsx.writeFile(FIXTURE);

  const postgres = require("../src/db/postgres");
  await postgres.resetDatabaseForTests();
  const memory = createMemory();
  postgres.setPoolFactoryForTests(() => memory.pool);
  require("../src/db/collections-repository").resetDatabaseGuardForTests();

  const files = new Map();
  const publications = require("../src/publications/service");
  publications.setStorageForTests({
    async save(key, buffer) { files.set(key, Buffer.from(buffer)); return { key }; },
    async read(key) {
      if (key === "finished/falha.png") {
        const err = new Error("Arquivo não encontrado");
        err.expose = true;
        err.status = 400;
        throw err;
      }
      if (!files.has(key)) throw new Error("Arquivo não encontrado");
      return Buffer.from(files.get(key));
    },
    async delete(key) { files.delete(key); },
    async exists(key) { return key === "finished/falha.png" || files.has(key); },
  });

  const repo = require("../src/db/collections-repository");
  const batch = require("../src/publications/batch");
  const collectionExport = require("../src/publications/export-collection");
  const base = {
    source: { type: "xlsx", path: "output/test-short-desc.xlsx", sheet: "Graduação" },
    primaryKey: "course_id",
    displayField: "curso",
    searchFields: ["curso"],
    fieldMappings: { title: "curso", subtitle: "descricao_curta", slug: "slug" },
    filters: [],
    templateIds: ["cruzeiro-graduacao-v1"],
    defaultTemplateId: "cruzeiro-graduacao-v1",
    filenamePattern: "{{slug}}",
    outputColumns: {},
  };
  await repo.saveCollection({ ...base, id: "graduacao-cruzeiro", name: "Graduação" }, { onConflict: "replace" });
  await repo.saveCollection({ ...base, id: "lote-teste", name: "Lote" }, { onConflict: "replace" });

  const courses = [
    { id: "administracao", title: "Administração", courseId: "9001" },
    { id: "administracao-publica", title: "Administração Pública", courseId: "9002" },
    {
      id: "editado",
      title: "Nome editado no sistema",
      courseId: "9003",
      fields: {
        descricao_curta: "Texto já editado no sistema",
        subtitle: "Texto já editado no sistema",
        curso: "Nome editado no sistema",
      },
    },
    { id: "outro-admin", title: "Administração", courseId: "7777" },
  ];
  for (let i = 0; i < 124; i += 1) {
    courses.push({ id: `curso-${String(i).padStart(3, "0")}`, title: `Curso ${i}`, courseId: String(20000 + i) });
  }
  assert.equal(courses.length, 128);
  await repo.importRecords({ ...base, id: "graduacao-cruzeiro" }, courses.map((course) => ({
    id: course.id,
    slug: course.id,
    title: course.title,
    fields: {
      course_id: course.courseId,
      curso: course.fields?.curso || course.title,
      slug: course.id,
      ...(course.fields || {}),
    },
    prompt: "",
    sourceImage: "",
    sourceStatus: "",
  })), { onConflict: "skip" });

  await repo.importRecords({ ...base, id: "lote-teste" }, ["pronto", "publicado", "sem-peca", "escolha", "falha"].map((id) => ({
    id,
    slug: id,
    title: id,
    fields: { course_id: id, curso: id, slug: id },
    prompt: "",
    sourceImage: "",
    sourceStatus: "",
  })), { onConflict: "skip" });

  for (const name of ["pronto", "publicado-a", "publicado-b", "escolha-a", "escolha-b"]) {
    files.set(`finished/${name}.png`, Buffer.from(name));
  }
  const pieces = [
    piece("pronto", "pronto", "finished/pronto.png"),
    piece("publicado-a", "publicado", "finished/publicado-a.png"),
    piece("publicado-b", "publicado", "finished/publicado-b.png"),
    piece("escolha-a", "escolha", "finished/escolha-a.png"),
    piece("escolha-b", "escolha", "finished/escolha-b.png"),
    piece("falha", "falha", "finished/falha.png"),
    piece("rascunho", "pronto", "preview/rascunho.png"),
    piece("foto", "sem-peca", "candidates/foto.png"),
    piece("solta", "", "finished/solta.png"),
    piece("outra", "pronto", "finished/pronto.png", "outra-colecao"),
  ];
  const listPieces = async () => pieces;

  const first = await publications.publish(pieces[1], { baseUrl: "https://bwipo.example" });
  const publishedUrl = first.publication.publicUrl;
  assert.equal(publishedUrl, "https://bwipo.example/api/public/images/lote-teste/publicado");

  const plan = await batch.planCollectionPublish("lote-teste", { listPieces });
  assert.deepEqual(plan.ready.map((item) => item.itemId).sort(), ["falha", "pronto"]);
  assert.deepEqual(plan.published.map((item) => item.itemId), ["publicado"]);
  assert.equal(plan.published[0].pieces.length, 2);
  assert.deepEqual(plan.missing.map((item) => item.itemId), ["sem-peca"]);
  assert.deepEqual(plan.choices.map((item) => item.itemId), ["escolha"]);

  const run = await batch.publishCollection("lote-teste", {
    baseUrl: "https://bwipo.example",
    confirm: true,
    listPieces,
  });
  assert.equal(run.published, 1);
  assert.equal(run.alreadyPublished, 1);
  assert.equal(run.missing, 1);
  assert.equal(run.needsChoice, 1);
  assert.equal(run.errors.length, 1);
  assert.equal(run.errors[0].itemId, "falha");
  const pronto = await publications.currentPublication("lote-teste", "pronto");
  const publicado = await publications.currentPublication("lote-teste", "publicado");
  assert.equal(pronto.version, 1);
  assert.equal(publicado.publicUrl, publishedUrl);
  assert.equal(publicado.finishedPieceId, "publicado-a");
  assert.equal(await publications.currentPublication("lote-teste", "falha"), null);
  assert.equal(memory.state.versions.filter((row) => row.item_id === "publicado").length, 1);

  const again = await batch.publishCollection("lote-teste", { baseUrl: "https://bwipo.example", listPieces });
  assert.equal(again.published, 0);
  assert.equal(again.alreadyPublished, 2);
  assert.equal((await publications.currentPublication("lote-teste", "pronto")).version, 1);
  assert.equal((await publications.currentPublication("lote-teste", "publicado")).publicUrl, publishedUrl);

  await assert.rejects(
    () => batch.publishCollection("lote-teste", { baseUrl: "https://bwipo.example", replace: true, listPieces }),
    /confirmação explícita/
  );
  assert.equal((await publications.currentPublication("lote-teste", "publicado")).finishedPieceId, "publicado-a");

  const chosen = await batch.publishCollection("lote-teste", {
    baseUrl: "https://bwipo.example",
    choices: { escolha: "escolha-b" },
    listPieces,
  });
  assert.equal(chosen.published, 1);
  assert.equal((await publications.currentPublication("lote-teste", "escolha")).finishedPieceId, "escolha-b");

  const replaced = await batch.publishCollection("lote-teste", {
    baseUrl: "https://outro.example",
    replace: true,
    confirmReplace: true,
    choices: { publicado: "publicado-b" },
    listPieces,
  });
  assert.equal(replaced.replaced, 1);
  assert.equal(replaced.published, 0);
  const afterReplace = await publications.currentPublication("lote-teste", "publicado");
  assert.equal(afterReplace.publicUrl, publishedUrl);
  assert.equal(afterReplace.finishedPieceId, "publicado-b");
  assert.equal(afterReplace.version, 2);
  assert.equal((await publications.currentPublication("lote-teste", "escolha")).version, 1);

  const exported = await collectionExport.exportCollection("graduacao-cruzeiro", "xlsx");
  assert.equal(exported.total, 128);
  assert.equal(exported.report.filled, 2);
  assert.equal(exported.report.preserved, 1);
  const adm = await repo.getRecord("graduacao-cruzeiro", "administracao");
  const publica = await repo.getRecord("graduacao-cruzeiro", "administracao-publica");
  const edited = await repo.getRecord("graduacao-cruzeiro", "editado");
  const decoy = await repo.getRecord("graduacao-cruzeiro", "outro-admin");
  assert.equal(adm.fields.descricao_curta, "Curta ADM\nlinha 2 — ção");
  assert.equal(publica.fields.descricao_curta, "Curta pública");
  assert.equal(edited.fields.descricao_curta, "Texto já editado no sistema");
  assert.equal(edited.fields.curso, "Nome editado no sistema");
  assert.equal(decoy.fields.descricao_curta || "", "");
  assert.equal(adm.fields.course_id, "9001");

  const second = await collectionExport.exportCollection("graduacao-cruzeiro", "csv");
  assert.equal(second.total, 128);
  assert.equal(second.report.filled, 0);
  assert.equal(second.body[0], 0xEF);
  assert.equal(second.body[1], 0xBB);
  assert.equal(second.body[2], 0xBF);
  const csv = second.body.toString("utf8");
  assert.match(csv.split("\r\n")[0], /Descrição curta;.*URL da imagem;Status da imagem;Publicada em/);
  assert.match(csv, /"Curta ADM\nlinha 2 — ção"/);

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(exported.body);
  const out = readBack.getWorksheet("Coleção");
  assert.equal(out.rowCount, 129);
  const headers = out.getRow(1).values.slice(1);
  assert.ok(headers.includes("Descrição curta"));
  assert.ok(headers.includes("URL da imagem"));
  assert.equal(headers.includes("Descrição longa ADM"), false);
  const descIndex = headers.indexOf("Descrição curta") + 1;
  const values = [];
  out.eachRow((row, number) => { if (number > 1) values.push(row.getCell(descIndex).value); });
  assert.equal(values.filter((value) => value === "Curta ADM\nlinha 2 — ção").length, 1);
  assert.equal(values.includes("Descrição longa ADM"), false);
  assert.equal(values.filter((value) => value === "Texto já editado no sistema").length, 1);

  const { createRouter } = require("../src/template-editor/api");
  const { requireAuth } = require("../src/auth/middleware");
  const { cookieName, sessionSecret } = require("../src/auth/config");
  const cookie = require("cookie");
  const signature = require("cookie-signature");
  const session = cookie.serialize(cookieName, signature.sign(JSON.stringify({
    authenticated: true,
    expiresAt: Date.now() + 60_000,
  }), sessionSecret), { path: "/" });
  const app = express();
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
    requireAuth(req, res, next);
  });
  app.use("/api", createRouter());
  const server = await listen(app);
  const port = server.address().port;
  const previewDenied = await request(port, "GET", "/api/collections/graduacao-cruzeiro/publish-preview");
  const downloadDenied = await request(port, "POST", "/api/collections/graduacao-cruzeiro/download", { body: { format: "xlsx" } });
  assert.equal(previewDenied.status, 401);
  assert.equal(downloadDenied.status, 401);

  for (const format of ["xlsx", "csv"]) {
    const response = await request(port, "POST", "/api/collections/graduacao-cruzeiro/download", {
      body: { format },
      cookie: session,
    });
    assert.equal(response.status, 200, response.body.toString("utf8"));
    assert.match(response.headers["content-disposition"], new RegExp(`graduacao-cruzeiro-colecao\\.${format}`));
    if (format === "csv") {
      assert.match(response.headers["content-type"], /text\/csv/);
      assert.equal(response.body[0], 0xEF);
      const csv = response.body.toString("utf8");
      assert.match(csv.split("\r\n")[0], /Descrição curta;.*URL da imagem;Status da imagem;Publicada em/);
      assert.match(csv, /"Curta ADM\nlinha 2 — ção"/);
    } else {
      assert.match(response.headers["content-type"], /spreadsheetml/);
      const readBack = new ExcelJS.Workbook();
      await readBack.xlsx.load(response.body);
      const out = readBack.getWorksheet("Coleção");
      assert.equal(out.rowCount, 129);
      const headers = out.getRow(1).values.slice(1);
      assert.ok(headers.includes("Descrição curta"));
      assert.ok(headers.includes("URL da imagem"));
      const descIndex = headers.indexOf("Descrição curta") + 1;
      const values = [];
      out.eachRow((row, number) => { if (number > 1) values.push(row.getCell(descIndex).value); });
      assert.equal(values.filter((value) => value === "Curta ADM\nlinha 2 — ção").length, 1);
    }
  }
  server.close();

  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(SOURCE_XLSX)).digest("hex"), sourceHash);
  fs.unlinkSync(FIXTURE);
  console.log("collection batch export ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
