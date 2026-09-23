/**
 * Persistência de coleções com cliente PostgreSQL simulado.
 * Não conecta no banco de produção e não chama a OpenAI.
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "output", ".pg-collection-test");

function expose(message) {
  const err = new Error(message);
  err.expose = true;
  return err;
}

function parseJson(value) {
  if (value == null) return value;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function createMemory(databaseName) {
  const state = {
    databaseName,
    migrations: new Set(),
    collections: new Map(),
    records: new Map(),
    schemaSql: 0,
    snapshots: [],
  };

  function key(collectionId, itemId) {
    return `${collectionId}\0${itemId}`;
  }

  function snapshot() {
    return {
      migrations: [...state.migrations],
      collections: [...state.collections.entries()],
      records: [...state.records.entries()],
    };
  }

  function restore(saved) {
    state.migrations = new Set(saved.migrations);
    state.collections = new Map(saved.collections);
    state.records = new Map(saved.records);
  }

  async function query(sql, params = []) {
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
    if (text.includes("current_database()")) {
      return { rows: [{ name: state.databaseName }] };
    }
    if (text.includes("CREATE TABLE")) {
      if (text.includes("collection_records")) state.schemaSql += 1;
      return { rows: [] };
    }
    if (text === "SELECT version FROM schema_migrations") {
      return { rows: [...state.migrations].map((version) => ({ version })) };
    }
    if (text === "INSERT INTO schema_migrations (version) VALUES ($1)") {
      state.migrations.add(params[0]);
      return { rows: [], rowCount: 1 };
    }

    const { SQL } = require("../src/db/collections-repository");
    if (text === SQL.listCollections) {
      return { rows: [...state.collections.values()] };
    }
    if (text === SQL.getCollection) {
      return { rows: state.collections.get(params[0]) ? [state.collections.get(params[0])] : [] };
    }
    if (text === SQL.insertCollection) {
      if (state.collections.has(params[0])) throw expose("coleção duplicada");
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
    if (text === SQL.updateCollection) {
      const row = state.collections.get(params[0]);
      if (!row) throw expose("coleção ausente");
      row.name = params[1];
      row.config = parseJson(params[2]);
      row.default_template_id = params[3];
      row.archived = params[4];
      row.updated_at = params[5];
      return { rows: [], rowCount: 1 };
    }
    if (text === SQL.deleteCollection) {
      state.collections.delete(params[0]);
      for (const recordKey of [...state.records.keys()]) {
        if (recordKey.startsWith(`${params[0]}\0`)) state.records.delete(recordKey);
      }
      return { rows: [], rowCount: 1 };
    }
    if (text === SQL.listRecords || text === SQL.listRecordsPage) {
      let rows = [...state.records.values()]
        .filter((row) => row.collection_id === params[0])
        .sort((a, b) => String(a.item_id).localeCompare(String(b.item_id)));
      if (text === SQL.listRecordsPage) {
        const limit = params[1];
        const offset = params[2];
        rows = rows.slice(offset, offset + limit);
      }
      return { rows };
    }
    if (text === SQL.countRecords) {
      const count = [...state.records.values()].filter((row) => row.collection_id === params[0]).length;
      return { rows: [{ count }] };
    }
    if (text === SQL.getRecord) {
      const wanted = String(params[1]);
      const rows = [...state.records.values()]
        .filter((row) => row.collection_id === params[0] && (row.item_id === wanted || row.slug === wanted || row.source_key === wanted))
        .sort((a, b) => {
          const rank = (row) => (row.item_id === wanted ? 0 : row.slug === wanted ? 1 : 2);
          return rank(a) - rank(b);
        });
      return { rows: rows.slice(0, 1) };
    }
    if (text === SQL.insertRecord) {
      if (!state.collections.has(params[0])) throw expose("coleção inexistente");
      const recordKey = key(params[0], params[1]);
      if (state.records.has(recordKey)) throw expose("registro duplicado");
      state.records.set(recordKey, {
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
    if (text === SQL.updateRecord) {
      const row = state.records.get(key(params[0], params[1]));
      if (!row) throw expose("registro ausente");
      row.slug = params[2];
      row.source_key = params[3];
      row.title = params[4];
      row.fields = parseJson(params[5]);
      row.record = parseJson(params[6]);
      row.updated_at = params[7];
      return { rows: [], rowCount: 1 };
    }
    throw expose(`SQL não simulada: ${text.slice(0, 80)}`);
  }

  const client = {
    query,
    release() {},
  };
  return {
    state,
    pool: {
      query,
      connect: async () => client,
      end: async () => {},
      on() {},
    },
  };
}

function outputColumns() {
  return {
    backgroundFilename: "imagem_fundo_arquivo",
    cardFilename: "imagem_card_arquivo",
    whatsappFilename: "imagem_whatsapp_arquivo",
    backgroundUrl: "imagem_fundo_url",
    cardUrl: "imagem_card_url",
    whatsappUrl: "imagem_whatsapp_url",
    productionStatus: "imagem_producao_status",
    templateId: "imagem_template_id",
    updatedAt: "imagem_atualizada_em",
  };
}

(async () => {
  const previous = {
    DATA_SOURCE: process.env.DATA_SOURCE,
    DATABASE_URL: process.env.DATABASE_URL,
    ALLOW_TEST_DATABASE: process.env.ALLOW_TEST_DATABASE,
  };
  const secret = "senha-secreta";
  let memory = null;

  async function bind(databaseName) {
    const postgres = require("../src/db/postgres");
    await postgres.resetDatabaseForTests();
    const repo = require("../src/db/collections-repository");
    repo.resetDatabaseGuardForTests();
    memory = createMemory(databaseName);
    postgres.setPoolFactoryForTests(() => memory.pool);
    return repo;
  }

  try {
    process.env.DATA_SOURCE = "files";
    process.env.DATABASE_URL = `postgres://bwipoart_user:${secret}@banco_banco:5432/bwipoart`;
    delete process.env.ALLOW_TEST_DATABASE;
    const postgres = require("../src/db/postgres");
    await postgres.resetDatabaseForTests();
    let pools = 0;
    postgres.setPoolFactoryForTests(() => {
      pools += 1;
      return memory ? memory.pool : { query: async () => ({ rows: [] }), connect: async () => { throw new Error("connect"); }, on() {}, end: async () => {} };
    });
    const store = require("../src/collections/store");
    const listed = await store.listCollections();
    assert.equal(pools, 0, "DATA_SOURCE=files não abre o PostgreSQL");
    assert.ok(listed.some((item) => item.id === "graduacao-cruzeiro"));
    assert.equal(JSON.stringify(listed).includes(secret), false);

    process.env.DATA_SOURCE = "postgres";
    delete process.env.DATABASE_URL;
    await assert.rejects(() => store.listCollections(), /DATABASE_URL/);

    process.env.DATABASE_URL = "postgres://bwipoart_user:senha@localhost:5432/otherdb";
    const { applyMigrations } = require("../src/db/migrate");
    await assert.rejects(() => applyMigrations(), /bwipoart/);

    process.env.ALLOW_TEST_DATABASE = "1";
    process.env.DATABASE_URL = "postgres://bwipoart_user:senha@localhost:5432/bwipoart_test";
    await bind("outro");
    await assert.rejects(() => applyMigrations(), /não é o banco/);
    assert.equal(memory.state.schemaSql, 0);

    await bind("bwipoart_test");
    const first = await applyMigrations();
    const second = await applyMigrations();
    assert.deepEqual(first.applied, ["001_collections_and_records", "002_published_images"]);
    assert.deepEqual(second.applied, []);
    assert.ok(second.skipped.includes("001_collections_and_records"));
    assert.ok(second.skipped.includes("002_published_images"));
    assert.equal(memory.state.schemaSql, 2);
    const migrationSql = fs.readFileSync(path.join(ROOT, "migrations", "001_collections_and_records.sql"), "utf8");
    assert.match(migrationSql, /JSONB/);
    assert.match(migrationSql, /REFERENCES collections/);
    assert.match(migrationSql, /item_id TEXT NOT NULL/);
    assert.equal(migrationSql.includes("senha"), false);

    const { resolveConflict, mergeFields } = require("../src/db/record-merge");
    assert.equal(resolveConflict({ updated_at: "2026-01-02T00:00:00.000Z" }, { updatedAt: "2026-01-01T00:00:00.000Z" }, "newer"), "skip");
    assert.equal(resolveConflict({ updated_at: "2026-01-01T00:00:00.000Z" }, { updatedAt: "2026-01-03T00:00:00.000Z" }, "newer"), "update");
    assert.deepEqual(mergeFields({ curso: "Direito", extra: "x" }, { curso: "Medicina" }, "merge"), {
      curso: "Medicina",
      extra: "x",
    });

    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados");
    sheet.addRow(["id", "nome", "modalidade", "extra"]);
    sheet.addRow(["a", "Direito", "EAD", "alfa"]);
    sheet.addRow(["a", "Duplicado", "EAD", "beta"]);
    sheet.addRow(["b", "Medicina", "Presencial", "gama"]);
    const sourcePath = path.join(FIXTURE_DIR, "base.xlsx");
    await workbook.xlsx.writeFile(sourcePath);
    const sourceStat = fs.statSync(sourcePath);

    const collection = {
      id: "base-teste",
      name: "Base teste",
      source: { type: "xlsx", path: "output/.pg-collection-test/base.xlsx", sheet: "Dados" },
      primaryKey: "id",
      displayField: "nome",
      searchFields: ["nome"],
      fieldMappings: { title: "nome", slug: "id" },
      filters: [],
      templateIds: ["demo"],
      defaultTemplateId: "demo",
      filenamePattern: "{{slug}}",
      outputColumns: outputColumns(),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const repo = require("../src/db/collections-repository");
    const { getFileDataSource } = require("../src/data-sources");
    const loaded = await getFileDataSource(collection).listRecords();
    assert.equal(loaded.length, 3);
    await repo.saveCollection(collection, { onConflict: "skip" });
    const imported = await repo.importRecords(collection, loaded, { onConflict: "skip" });
    assert.equal(imported.inserted, 2);
    assert.equal(imported.duplicates, 1);
    const again = await repo.importRecords(collection, loaded, { onConflict: "skip" });
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 2);
    assert.equal([...memory.state.records.keys()].filter((key) => key.startsWith("base-teste")).length, 2);

    const direito = await repo.getRecord("base-teste", "a");
    assert.equal(direito.id, "a");
    assert.equal(direito.fields.nome, "Direito");
    assert.equal(direito.fields.extra, "alfa");
    assert.equal(direito.fields.modalidade, "EAD");
    const patched = await repo.patchRecordFields("base-teste", "a", { observacao: "nova" });
    assert.equal(patched.fields.nome, "Direito");
    assert.equal(patched.fields.extra, "alfa");
    assert.equal(patched.fields.observacao, "nova");
    const skipped = await repo.importRecords(collection, loaded, { onConflict: "skip" });
    assert.equal(skipped.updated, 0);
    const afterSkip = await repo.getRecord("base-teste", "a");
    assert.equal(afterSkip.fields.observacao, "nova");
    const merged = await repo.importRecords(collection, loaded, { onConflict: "merge" });
    assert.equal(merged.updated, 2);
    const afterMerge = await repo.getRecord("base-teste", "a");
    assert.equal(afterMerge.fields.observacao, "nova");
    assert.equal(afterMerge.fields.nome, "Direito");

    const page = await repo.listRecords("base-teste", { limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].id, "b");

    const { PostgresRecordSource } = require("../src/data-sources/postgres-record-source");
    const exported = path.join(FIXTURE_DIR, "export.xlsx");
    const plan = await new PostgresRecordSource(collection).exportUpdatedCopy([
      { id: "a", slug: "a", status: "aprovado", files: { fundo: "a-fundo.png" } },
    ], exported);
    assert.ok(plan.wouldChangeCount >= 1);
    const exportedBook = new ExcelJS.Workbook();
    await exportedBook.xlsx.readFile(exported);
    const headers = [];
    exportedBook.getWorksheet("Dados").getRow(1).eachCell((cell) => headers.push(String(cell.value)));
    for (const header of ["nome", "modalidade", "extra", "observacao", "imagem_fundo_arquivo"]) {
      assert.ok(headers.includes(header), header);
    }
    assert.equal(fs.statSync(sourcePath).mtimeMs, sourceStat.mtimeMs);

    const courseCollection = {
      ...collection,
      id: "graduacao-cruzeiro",
      name: "Graduação Cruzeiro do Sul",
      primaryKey: "course_id",
      defaultTemplateId: "cruzeiro-graduacao-v1",
      templateIds: ["cruzeiro-graduacao-v1"],
      fieldMappings: { title: "curso", slug: "slug", prompt: "prompt_imagem" },
    };
    await repo.saveCollection(courseCollection, { onConflict: "replace" });
    await repo.importRecords(courseCollection, [{
      id: "direito",
      slug: "direito",
      title: "Direito",
      fields: {
        course_id: "10",
        slug: "direito",
        curso: "Direito",
        modalidade: "EAD",
        formacao: "Bacharelado",
        duracao: "4 anos",
        prompt_imagem: "sala de aula",
      },
      prompt: "sala de aula",
      sourceImage: "",
      sourceStatus: "pronto",
    }], { onConflict: "skip" });
    const { loadAllCourses, loadCourseBySlug } = require("../src/read-courses");
    const courses = await loadAllCourses();
    assert.equal(courses.length, 1);
    assert.equal(courses[0].slug, "direito");
    assert.equal(courses[0].course_id, "10");
    assert.equal(courses[0].curso, "Direito");
    assert.equal(courses[0].modalidade, "EAD");
    const one = await loadCourseBySlug("direito");
    assert.equal(one.formacao, "Bacharelado");

    const listedCollections = await repo.listCollections();
    assert.ok(listedCollections.some((item) => item.id === "graduacao-cruzeiro" && item.defaultTemplateId === "cruzeiro-graduacao-v1"));

    delete require.cache[require.resolve("../src/db/collections-repository")];
    delete require.cache[require.resolve("../src/db/course-records")];
    delete require.cache[require.resolve("../src/read-courses")];
    require("../src/db/collections-repository").resetDatabaseGuardForTests();
    const reloaded = require("../src/read-courses");
    const afterRestart = await reloaded.loadAllCourses();
    assert.equal(afterRestart.length, 1);
    assert.equal(afterRestart[0].course_id, "10");
    assert.equal(JSON.stringify(afterRestart).includes(secret), false);

    const { scanFileCollections, publicReport } = require("../src/db/import-collections");
    const scan = await scanFileCollections();
    const report = publicReport(scan);
    assert.equal(typeof report.collections, "number");
    assert.equal(typeof report.records, "number");
    assert.ok(Array.isArray(report.items));
    assert.equal(Object.hasOwn(report, "_private"), false);
    for (const item of report.items) {
      assert.deepEqual(Object.keys(item).sort(), ["duplicates", "error", "id", "name", "records"]);
    }
    const graduacao = report.items.find((item) => item.id === "graduacao-cruzeiro");
    if (graduacao && !graduacao.error) assert.ok(graduacao.records >= 0);

    const server = fs.readFileSync(path.join(ROOT, "src", "template-editor", "server.js"), "utf8");
    assert.equal(server.includes("applyMigrations"), false);
    console.log("collections postgres ok");
  } finally {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    if (previous.DATA_SOURCE == null) delete process.env.DATA_SOURCE;
    else process.env.DATA_SOURCE = previous.DATA_SOURCE;
    if (previous.DATABASE_URL == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.DATABASE_URL;
    if (previous.ALLOW_TEST_DATABASE == null) delete process.env.ALLOW_TEST_DATABASE;
    else process.env.ALLOW_TEST_DATABASE = previous.ALLOW_TEST_DATABASE;
    const postgres = require("../src/db/postgres");
    await postgres.resetDatabaseForTests();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
