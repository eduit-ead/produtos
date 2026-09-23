/**
 * Conexão PostgreSQL com cliente simulado. Não abre rede.
 */

const assert = require("node:assert/strict");
const {
  CONNECT_SQL,
  POOL_MAX,
  checkDatabase,
  closeDatabase,
  setPoolFactoryForTests,
  resetDatabaseForTests,
} = require("../src/db/postgres");

function mockPool(query) {
  return {
    query,
    end: async () => {
      this.ended = true;
    },
    on: () => {},
    ended: false,
  };
}

(async () => {
  const originalUrl = process.env.DATABASE_URL;
  const secretUrl = "postgres://bwipoart_user:senha-secreta@banco_banco:5432/bwipoart";

  try {
    delete process.env.DATABASE_URL;
    await resetDatabaseForTests();
    let created = 0;
    setPoolFactoryForTests(() => {
      created += 1;
      return mockPool(async () => {
        throw new Error("não deveria consultar");
      });
    });
    const missing = await checkDatabase();
    assert.deepEqual(missing, { configured: false, ok: false });
    assert.equal(created, 0, "sem DATABASE_URL o pool não é criado");

    process.env.DATABASE_URL = secretUrl;
    await resetDatabaseForTests();
    let seenSql = "";
    let pool;
    setPoolFactoryForTests((connectionString) => {
      assert.equal(connectionString, secretUrl);
      pool = mockPool(async (sql) => {
        seenSql = sql;
        return {
          rows: [{
            current_database: "bwipoart",
            current_user: "bwipoart_user",
            version: "PostgreSQL 16.0",
          }],
        };
      });
      return pool;
    });
    const ok = await checkDatabase();
    assert.equal(seenSql, CONNECT_SQL);
    assert.equal(ok.ok, true);
    assert.equal(ok.database, "bwipoart");
    assert.equal(ok.user, "bwipoart_user");
    assert.equal(ok.version, "PostgreSQL 16.0");
    assert.equal(JSON.stringify(ok).includes("senha-secreta"), false);
    assert.equal(JSON.stringify(ok).includes("banco_banco"), false);
    assert.equal(POOL_MAX, 5);

    await resetDatabaseForTests();
    setPoolFactoryForTests(() => mockPool(async () => {
      const err = new Error(`connect ${secretUrl}`);
      err.code = "ECONNREFUSED";
      throw err;
    }));
    const failed = await checkDatabase();
    assert.equal(failed.configured, true);
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "Não foi possível conectar ao banco.");
    assert.equal(JSON.stringify(failed).includes("senha-secreta"), false);
    assert.equal(JSON.stringify(failed).includes(secretUrl), false);

    let ended = false;
    await resetDatabaseForTests();
    setPoolFactoryForTests(() => ({
      query: async () => ({ rows: [{ current_database: "bwipoart", current_user: "u", version: "v" }] }),
      end: async () => {
        ended = true;
      },
      on: () => {},
    }));
    await checkDatabase();
    await closeDatabase();
    assert.equal(ended, true);

    console.log("Database connection OK: pool simulado, sem credenciais na resposta.");
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    await resetDatabaseForTests();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
