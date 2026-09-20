const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("node:assert/strict");

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "local-storage-test-"));
process.env.STORAGE_LOCAL_DIR = TEMP_DIR;

const { LocalStorageProvider } = require("../src/storage/local-storage-provider");

(async () => {
  const provider = new LocalStorageProvider();

  // healthCheck
  let health = await provider.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "local");

  // save
  const slug = "teste-slug";
  const key = `${slug}/fundo`;
  const buffer = Buffer.from("fake-png");
  const saved = await provider.save(key, buffer, { contentType: "image/png" });
  assert.equal(saved.key, key);
  assert.equal(saved.size, buffer.length);
  assert.ok(saved.path.endsWith("teste-slug-fundo.png"));

  // exists
  assert.ok(await provider.exists(key));

  // getPublicUrl
  const url = await provider.getPublicUrl(key);
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  assert.equal(url, `/api/files/${encoded}`);

  // delete
  await provider.delete(key);
  assert.ok(!(await provider.exists(key)));

  // Chave maliciosa deve ser rejeitada
  await assert.rejects(
    () => provider.save("../../../etc/passwd", Buffer.from("x"), {}),
    /fora/
  );

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log("LocalStorage OK");
})();
