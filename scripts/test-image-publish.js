/**
 * Publicação de imagem com URL permanente.
 * Cliente PostgreSQL e armazenamento simulados. Não altera o volume real.
 */

process.env.AUTH_DISABLED = "false";
process.env.DATA_SOURCE = "postgres";
process.env.ALLOW_TEST_DATABASE = "1";
process.env.DATABASE_URL = "postgres://bwipoart_user:senha@localhost:5432/bwipoart_test";
delete process.env.PUBLIC_BASE_URL;

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(__dirname, "..");

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
    snapshots: [],
    failPublicationUpdate: false,
  };
  const key = (collectionId, itemId) => `${collectionId}\0${itemId}`;

  function snapshot() {
    return {
      collections: [...state.collections.entries()],
      records: [...state.records.entries()],
      publications: [...state.publications.entries()],
      versions: state.versions.map((row) => ({ ...row })),
    };
  }

  function restore(saved) {
    state.collections = new Map(saved.collections);
    state.records = new Map(saved.records);
    state.publications = new Map(saved.publications);
    state.versions = saved.versions;
  }

  async function query(sql, params = []) {
    const repo = require("../src/db/collections-repository");
    const pub = require("../src/publications/service");
    const text = String(sql);
    if (text === "BEGIN") {
      state.snapshots.push(snapshot());
      return { rows: [] };
    }
    if (text === "COMMIT") {
      state.snapshots.pop();
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      const saved = state.snapshots.pop();
      if (saved) restore(saved);
      return { rows: [] };
    }
    if (text.includes("current_database()")) return { rows: [{ name: state.databaseName }] };
    if (text.includes("CREATE TABLE")) return { rows: [] };
    if (text === "SELECT version FROM schema_migrations") return { rows: [] };
    if (text === repo.SQL.getCollection) {
      const row = state.collections.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (text === repo.SQL.insertCollection) {
      state.collections.set(params[0], {
        id: params[0],
        name: params[1],
        config: parseJson(params[2]),
        default_template_id: params[3],
        archived: params[4],
        created_at: params[5],
        updated_at: params[6],
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
    if (text === repo.SQL.insertRecord) {
      state.records.set(key(params[0], params[1]), {
        collection_id: params[0],
        item_id: params[1],
        slug: params[2],
        source_key: params[3],
        title: params[4],
        fields: parseJson(params[5]),
        record: parseJson(params[6]),
        created_at: params[7],
        updated_at: params[8],
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
    if (text === repo.SQL.listRecords) {
      const rows = [...state.records.values()]
        .filter((row) => row.collection_id === params[0])
        .sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
      return { rows };
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
        collection_id: params[0],
        item_id: params[1],
        public_id: params[2],
        public_url: params[3],
        finished_piece_id: params[4],
        file_key: params[5],
        version: params[6],
        created_at: params[7],
        updated_at: params[8],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text === pub.SQL.updatePublication) {
      if (state.failPublicationUpdate) {
        state.failPublicationUpdate = false;
        const err = new Error("falha simulada");
        err.expose = true;
        err.status = 500;
        throw err;
      }
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
        collection_id: params[0],
        item_id: params[1],
        version: params[2],
        finished_piece_id: params[3],
        file_key: params[4],
        created_at: params[5],
      });
      return { rows: [], rowCount: 1 };
    }
    const err = new Error(`SQL não simulada: ${text.slice(0, 120)}`);
    err.expose = true;
    throw err;
  }

  const client = { query, release() {} };
  return {
    state,
    pool: { query, connect: async () => client, end: async () => {}, on() {} },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const postgres = require("../src/db/postgres");
  await postgres.resetDatabaseForTests();
  const memory = createMemory();
  postgres.setPoolFactoryForTests(() => memory.pool);
  require("../src/db/collections-repository").resetDatabaseGuardForTests();

  const files = new Map();
  const publications = require("../src/publications/service");
  publications.setStorageForTests({
    async save(key, buffer) {
      files.set(key, Buffer.from(buffer));
      return { key };
    },
    async read(key) {
      if (!files.has(key)) throw new Error("Arquivo não encontrado");
      return Buffer.from(files.get(key));
    },
    async delete(key) {
      files.delete(key);
    },
    async exists(key) {
      return files.has(key);
    },
  });

  const repo = require("../src/db/collections-repository");
  const collection = {
    id: "graduacao-cruzeiro",
    name: "Graduação Cruzeiro do Sul",
    source: { type: "xlsx", path: "input/cursos.xlsx", sheet: "Graduação" },
    primaryKey: "course_id",
    displayField: "curso",
    searchFields: ["curso"],
    fieldMappings: { title: "curso", slug: "slug" },
    filters: [],
    templateIds: ["cruzeiro-graduacao-v1"],
    defaultTemplateId: "cruzeiro-graduacao-v1",
    filenamePattern: "{{slug}}",
    outputColumns: {
      backgroundFilename: "imagem_fundo_arquivo",
      cardFilename: "imagem_card_arquivo",
      whatsappFilename: "imagem_whatsapp_arquivo",
      backgroundUrl: "imagem_fundo_url",
      cardUrl: "imagem_card_url",
      whatsappUrl: "imagem_whatsapp_url",
      productionStatus: "imagem_producao_status",
      templateId: "imagem_template_id",
      updatedAt: "imagem_atualizada_em",
    },
  };
  await repo.saveCollection(collection, { onConflict: "replace" });
  await repo.importRecords(collection, [{
    id: "direito",
    slug: "direito",
    title: "Direito",
    fields: { course_id: "10", curso: "Direito", modalidade: "EAD", slug: "direito" },
    prompt: "",
    sourceImage: "",
    sourceStatus: "",
  }], { onConflict: "skip" });

  const originalA = Buffer.from("png-peca-a");
  const originalB = Buffer.from("png-peca-b");
  files.set("finished/fp-a.png", Buffer.from(originalA));
  files.set("finished/fp-b.png", Buffer.from(originalB));
  const pieceA = {
    id: "fp-a",
    title: "Card Direito A",
    collectionId: "graduacao-cruzeiro",
    itemId: "direito",
    fileKey: "finished/fp-a.png",
  };
  const pieceB = { ...pieceA, id: "fp-b", title: "Card Direito B", fileKey: "finished/fp-b.png" };

  const unlinked = await publications.preview({ id: "fp-x", title: "Solta", fileKey: "finished/fp-a.png" });
  assert.equal(unlinked.ok, false);
  assert.equal(unlinked.code, "missing-link");

  const created = await publications.publish(pieceA, { baseUrl: "https://bwipo.example" });
  assert.equal(created.action, "created");
  const publicUrl = created.publication.publicUrl;
  assert.equal(publicUrl, "https://bwipo.example/api/public/images/graduacao-cruzeiro/direito");
  assert.equal(created.publication.version, 1);
  assert.equal(files.get("finished/fp-a.png").equals(originalA), true);

  let record = await repo.getRecord("graduacao-cruzeiro", "direito");
  assert.equal(record.fields.imagem_url, publicUrl);
  assert.equal(record.fields.imagem_status, "publicada");
  assert.ok(record.fields.imagem_publicada_em);
  assert.equal(record.fields.curso, "Direito");
  assert.equal(record.fields.modalidade, "EAD");
  assert.equal(record.id, "direito");

  const replaced = await publications.publish(pieceB, { baseUrl: "https://outro.example" });
  assert.equal(replaced.action, "replaced");
  assert.equal(replaced.publication.publicUrl, publicUrl);
  assert.equal(replaced.publication.version, 2);
  assert.equal(replaced.publication.finishedPieceId, "fp-b");
  assert.equal(files.get("finished/fp-a.png").equals(originalA), true);
  assert.equal(files.get("finished/fp-b.png").equals(originalB), true);
  assert.equal([...files.keys()].filter((key) => key.startsWith("published-images/")).length, 2);

  record = await repo.getRecord("graduacao-cruzeiro", "direito");
  assert.equal(record.fields.imagem_url, publicUrl);
  assert.equal(record.fields.curso, "Direito");

  const repeated = await publications.publish(pieceB, { baseUrl: "https://bwipo.example" });
  assert.equal(repeated.action, "unchanged");
  assert.equal(repeated.publication.version, 2);
  assert.equal(memory.state.versions.length, 2);
  assert.equal([...files.keys()].filter((key) => key.startsWith("published-images/")).length, 2);

  const beforeFail = files.get(replaced.publication.fileKey);
  memory.state.failPublicationUpdate = true;
  await assert.rejects(() => publications.publish(pieceA, { baseUrl: "https://bwipo.example" }), /falha simulada/);
  const still = await publications.loadPublishedImage("graduacao-cruzeiro", "direito");
  assert.ok(still.buffer.equals(originalB));
  assert.equal(files.get(replaced.publication.fileKey).equals(beforeFail), true);
  assert.equal(files.get("finished/fp-a.png").equals(originalA), true);
  assert.equal(memory.state.versions.length, 2);

  const image = await publications.loadPublishedImage("graduacao-cruzeiro", "direito");
  assert.equal(image.contentType, "image/png");
  assert.equal(image.buffer.equals(originalB), true);
  assert.equal(await publications.loadPublishedImage("../secret", "direito"), null);
  assert.equal(await publications.loadPublishedImage("graduacao-cruzeiro", "outro-curso"), null);

  const { PostgresRecordSource } = require("../src/data-sources/postgres-record-source");
  const exportPath = path.join(ROOT, "output", ".publish-test.xlsx");
  await new PostgresRecordSource(collection).exportUpdatedCopy([], exportPath);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(exportPath);
  const sheet = book.worksheets[0];
  const headers = [];
  sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value)));
  const urlIndex = headers.indexOf("imagem_url") + 1;
  const cursoIndex = headers.indexOf("curso") + 1;
  assert.ok(urlIndex > 0);
  assert.ok(cursoIndex > 0);
  assert.equal(sheet.getRow(2).getCell(urlIndex).value, publicUrl);
  assert.equal(sheet.getRow(2).getCell(cursoIndex).value, "Direito");
  fs.rmSync(exportPath, { force: true });

  const { requireAuth } = require("../src/auth/middleware");
  const app = express();
  app.get("/api/public/images/:collectionId/:itemId", publications.sendPublishedImage);
  app.use("/api", (req, res, next) => requireAuth(req, res, next));
  app.post("/api/finished-pieces/:id/publish", (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  const port = server.address().port;
  try {
    const denied = await request(port, "POST", "/api/finished-pieces/fp-a/publish", { accept: "application/json" });
    assert.equal(denied.status, 401);
    const published = await request(port, "GET", "/api/public/images/graduacao-cruzeiro/direito");
    assert.equal(published.status, 200);
    assert.equal(published.headers["content-type"], "image/png");
    assert.match(published.headers["cache-control"], /no-cache/);
    assert.match(published.headers["cache-control"], /must-revalidate/);
    assert.equal(published.body.equals(originalB), true);
    const cached = await request(port, "GET", "/api/public/images/graduacao-cruzeiro/direito", {
      "if-none-match": published.headers.etag,
    });
    assert.equal(cached.status, 304);
    const hidden = await request(port, "GET", "/api/public/images/graduacao-cruzeiro/finished");
    assert.equal(hidden.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const migration = fs.readFileSync(path.join(ROOT, "migrations", "002_published_images.sql"), "utf8");
  assert.match(migration, /PRIMARY KEY \(collection_id, item_id\)/);
  assert.match(migration, /REFERENCES collection_records/);
  assert.equal(migration.toLowerCase().includes("bytea"), false);
  const versions = require("../src/db/migrate").migrationFiles().map((file) => file.version);
  assert.ok(versions.includes("002_published_images"));
  const serverSource = fs.readFileSync(path.join(ROOT, "src", "template-editor", "server.js"), "utf8");
  assert.ok(serverSource.indexOf("sendPublishedImage") < serverSource.indexOf("requireAuth(req, res, next)"));
  assert.equal(serverSource.includes("applyMigrations"), false);

  publications.setStorageForTests(null);
  await postgres.resetDatabaseForTests();
  console.log("image publish ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
