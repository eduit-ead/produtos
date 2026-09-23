/**
 * Finalização das artes existentes, sem OpenAI e sem alterar aprovação.
 */

process.env.DATA_SOURCE = "postgres";
process.env.ALLOW_TEST_DATABASE = "1";
process.env.DATABASE_URL = "postgres://bwipoart_user:senha@localhost:5432/bwipoart_test";
process.env.AI_CATALOG_DIR = require("path").join(require("os").tmpdir(), "bwipo-finalize-existing");

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const COLLECTION = "graduacao-cruzeiro";

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function createMemory() {
  const records = new Map();
  const publications = new Map();
  const key = (collectionId, itemId) => `${collectionId}\0${itemId}`;
  async function query(sql, params = []) {
    const text = String(sql);
    const repo = require("../src/db/collections-repository");
    const pub = require("../src/publications/service");
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes("current_database()")) return { rows: [{ name: "bwipoart_test" }] };
    if (text === repo.SQL.insertCollection || text === repo.SQL.getCollection) {
      return { rows: text === repo.SQL.getCollection ? [] : [], rowCount: 1 };
    }
    if (text === repo.SQL.insertRecord) {
      records.set(key(params[0], params[1]), {
        collection_id: params[0], item_id: params[1], slug: params[2], source_key: params[3],
        title: params[4], fields: parseJson(params[5]), record: parseJson(params[6]),
        created_at: params[7], updated_at: params[8],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text === repo.SQL.listRecords) {
      return { rows: [...records.values()].filter((row) => row.collection_id === params[0]) };
    }
    if (text === repo.SQL.getRecord) {
      const wanted = String(params[1]);
      const rows = [...records.values()].filter((row) => row.collection_id === params[0] && (row.item_id === wanted || row.slug === wanted || row.source_key === wanted));
      return { rows: rows.slice(0, 1) };
    }
    if (text === pub.SQL.selectCurrent || text === pub.SQL.lockPublication) {
      const row = publications.get(key(params[0], params[1]));
      return { rows: row ? [row] : [] };
    }
    const err = new Error(`SQL não simulada: ${text.slice(0, 80)}`);
    throw err;
  }
  const client = { query, release() {} };
  return {
    records,
    publications,
    pool: { query, connect: async () => client, end: async () => {}, on() {} },
  };
}

(async () => {
  fs.rmSync(process.env.AI_CATALOG_DIR, { recursive: true, force: true });
  const postgres = require("../src/db/postgres");
  await postgres.resetDatabaseForTests();
  const memory = createMemory();
  postgres.setPoolFactoryForTests(() => memory.pool);
  require("../src/db/collections-repository").resetDatabaseGuardForTests();

  const repo = require("../src/db/collections-repository");
  const finished = require("../src/finished-pieces");
  const finalize = require("../src/production/finalize-existing");
  const batch = require("../src/publications/batch");

  const approval = { status: "aguardando_revisao", candidate: "candidates/foto.png" };
  const records = {
    jornalismo: { slug: "jornalismo", curso: "Jornalismo", image_url: "https://example.test/jornalismo.png", modalidade: "EAD", formacao: "Bacharelado", duracao: "4 anos" },
    administracao: { slug: "administracao", curso: "Administração", image_url: "https://example.test/adm.png", modalidade: "EAD", formacao: "Bacharelado", duracao: "4 anos" },
    "sem-fundo": { slug: "sem-fundo", curso: "Sem fundo", image_url: "", modalidade: "", formacao: "", duracao: "" },
    redes: { slug: "redes", curso: "Redes de Computadores", image_url: "https://example.test/redes.png", modalidade: "EAD", formacao: "Tecnólogo", duracao: "2 anos" },
  };
  const visuals = {
    jornalismo: { visualStatus: "original", currentBackgroundKey: null, candidateBackgroundKey: null },
    administracao: { visualStatus: "aguardando_revisao", currentBackgroundKey: null, candidateBackgroundKey: "studio/adm/fundo.png" },
    "sem-fundo": { visualStatus: "aguardando_revisao", currentBackgroundKey: null, candidateBackgroundKey: "studio/sem-fundo/foto.png" },
    redes: { visualStatus: "aprovado", currentBackgroundKey: "redes/fundo", candidateBackgroundKey: null },
  };
  const reads = [];
  let renders = 0;
  const deps = {
    getRecord: async (_collectionId, slug) => records[slug] || null,
    resolveVisual: async (_collectionId, slug) => visuals[slug],
    readOfficialBackground: async (_collectionId, slug, record) => {
      reads.push(slug);
      if (!record.image_url && !visuals[slug].currentBackgroundKey) throw new Error("sem fundo");
      return Buffer.from(`bg:${slug}`);
    },
    renderCard: async (_collectionId, slug) => {
      renders += 1;
      return Buffer.concat([PNG, Buffer.from(slug)]);
    },
  };

  await finished.createFromExistingArt({
    collectionId: COLLECTION,
    itemId: "redes",
    templateId: "cruzeiro-graduacao-v1",
    buffer: Buffer.concat([PNG, Buffer.from("redes-antiga")]),
    fingerprint: "ja-publicada",
    title: "Redes de Computadores",
  });

  const slugs = ["jornalismo", "administracao", "sem-fundo", "redes"];
  const preview = await finalize.planFinalizeExisting(COLLECTION, slugs, deps);
  assert.equal(preview.selected, 4);
  assert.deepEqual(preview.ready.map((item) => item.slug).sort(), ["administracao", "jornalismo"]);
  assert.equal(preview.blocked.length, 1);
  assert.equal(preview.blocked[0].slug, "sem-fundo");
  assert.match(preview.blocked[0].blocked, /fotografia candidata/);
  assert.equal(preview.alreadyFinished[0].slug, "redes");
  assert.match(preview.ready.find((item) => item.slug === "administracao").note, /somente à fotografia candidata/);

  const before = JSON.stringify(approval);
  const first = await finalize.finalizeExisting(COLLECTION, slugs, deps);
  assert.equal(first.finalized, 2);
  assert.equal(first.blocked, 1);
  assert.equal(first.errors.length, 0);
  assert.equal(renders, 2);
  assert.deepEqual(reads.sort(), ["administracao", "jornalismo"]);
  assert.equal(JSON.stringify(approval), before);

  const pieces = finished.listRaw();
  const jornalismo = pieces.find((piece) => piece.itemId === "jornalismo");
  const adm = pieces.find((piece) => piece.itemId === "administracao");
  assert.equal(jornalismo.collectionId, COLLECTION);
  assert.equal(adm.collectionId, COLLECTION);
  assert.equal(pieces.filter((piece) => piece.itemId === "redes").length, 1);
  assert.equal(pieces.some((piece) => piece.itemId === "sem-fundo"), false);
  const saved = fs.readFileSync(path.join(process.env.AI_CATALOG_DIR, jornalismo.fileKey));
  assert.equal(saved.subarray(0, 8).equals(PNG.subarray(0, 8)), true);
  assert.equal(saved.includes(Buffer.from("jornalismo")), true);

  const again = await finalize.finalizeExisting(COLLECTION, slugs, deps);
  assert.equal(again.finalized, 0);
  assert.equal(renders, 2);
  assert.equal(finished.listRaw().filter((piece) => piece.itemId === "jornalismo").length, 1);

  await repo.saveCollection({
    id: COLLECTION,
    name: "Graduação",
    source: { type: "json", path: "input/unused.json" },
    primaryKey: "course_id",
    displayField: "curso",
    searchFields: ["curso"],
    fieldMappings: { title: "curso", slug: "slug" },
    filters: [],
    templateIds: ["cruzeiro-graduacao-v1"],
    defaultTemplateId: "cruzeiro-graduacao-v1",
    filenamePattern: "{{slug}}",
    outputColumns: {},
  }, { onConflict: "replace" });
  await repo.importRecords({ id: COLLECTION, primaryKey: "course_id", fieldMappings: { slug: "slug" } }, [
    { id: "jornalismo", slug: "jornalismo", title: "Jornalismo", fields: { course_id: "1", slug: "jornalismo" }, prompt: "", sourceImage: "", sourceStatus: "" },
    { id: "redes", slug: "redes", title: "Redes de Computadores", fields: { course_id: "2", slug: "redes" }, prompt: "", sourceImage: "", sourceStatus: "" },
  ], { onConflict: "skip" });
  memory.publications.set(`${COLLECTION}\0redes`, {
    collection_id: COLLECTION,
    item_id: "redes",
    public_url: "https://bwipo.example/api/public/images/graduacao-cruzeiro/redes",
    finished_piece_id: pieces.find((piece) => piece.itemId === "redes").id,
    file_key: "published-images/v1-redes.png",
    version: 1,
  });

  const publishPlan = await batch.planCollectionPublish(COLLECTION, { listPieces: () => finished.listRaw() });
  assert.ok(publishPlan.ready.some((item) => item.itemId === "jornalismo"));
  assert.ok(publishPlan.published.some((item) => item.itemId === "redes"));
  assert.equal(publishPlan.published.find((item) => item.itemId === "redes").publicUrl, "https://bwipo.example/api/public/images/graduacao-cruzeiro/redes");

  fs.rmSync(process.env.AI_CATALOG_DIR, { recursive: true, force: true });
  console.log("finalize existing ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
