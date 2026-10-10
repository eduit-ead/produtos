/**
 * Keys de storage: legado de 2 segmentos e coleção genérica de 3 segmentos.
 * Não grava no catálogo real.
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LocalStorageProvider } = require("../src/storage/local-storage-provider");
const { createMetadata, storageKeysForCourse } = require("../src/batch/metadata");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "storage-keys-"));
const provider = new LocalStorageProvider(base);
const slug = "administracao-e-gestao-de-projetos-sociais";
const collectionId = "pos-graduacao-cruzeiro";

function expectThrow(key) {
  assert.throws(() => provider.resolveLocalPath(key), /rejeitada|inválida|fora do diretório|Slug inválido/);
}

async function main() {
  const legacyKey = "administracao/card";
  const legacyPath = provider.resolveLocalPath(legacyKey);
  assert.equal(
    legacyPath,
    path.resolve(base, "administracao", "administracao-card.png")
  );
  await provider.save(legacyKey, Buffer.from("grad"));
  assert.equal(fs.existsSync(legacyPath), true);

  const posCard = `${collectionId}/${slug}/card`;
  const posFundo = `${collectionId}/${slug}/fundo`;
  const posWhatsapp = `${collectionId}/${slug}/whatsapp`;
  assert.equal(
    provider.resolveLocalPath(posCard),
    path.resolve(base, collectionId, slug, `${slug}-card.png`)
  );
  assert.equal(
    provider.resolveLocalPath(posFundo),
    path.resolve(base, collectionId, slug, `${slug}-fundo.png`)
  );
  assert.equal(
    provider.resolveLocalPath(posWhatsapp),
    path.resolve(base, collectionId, slug, `${slug}-whatsapp.jpg`)
  );
  await provider.save(posCard, Buffer.from("card"));
  await provider.save(posFundo, Buffer.from("fundo"));
  await provider.save(posWhatsapp, Buffer.from("wa"));
  assert.equal(fs.existsSync(provider.resolveLocalPath(posCard)), true);
  assert.equal(fs.existsSync(provider.resolveLocalPath(posFundo)), true);
  assert.equal(fs.existsSync(provider.resolveLocalPath(posWhatsapp)), true);

  const encoded = Buffer.from(posCard, "utf8").toString("base64url");
  const url = await provider.getPublicUrl(posCard);
  assert.equal(url, `/api/files/${encoded}`);
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), posCard);

  expectThrow("../administracao/card");
  expectThrow(`${collectionId}/../${slug}/card`);
  expectThrow(`${collectionId}/${slug}/../card`);
  expectThrow(`${collectionId}\\${slug}/card`);
  expectThrow(`/${collectionId}/${slug}/card`);
  expectThrow(`${collectionId}/${slug}/outro`);

  const studioPath = provider.resolveLocalPath("studio/run-1/fundo");
  assert.equal(studioPath, path.resolve(base, "studio", "fundo"));
  const uploadPath = provider.resolveLocalPath("uploads/foto.png");
  assert.equal(uploadPath, path.resolve(base, "uploads", "foto.png"));

  const posMeta = createMetadata(
    { course_id: "pos-0002", slug, curso: "Administração" },
    { collectionId }
  );
  assert.deepEqual(posMeta.storage.keys, storageKeysForCourse(slug, collectionId));
  assert.equal(posMeta.storage.keys.fundo, `${collectionId}/${slug}/fundo`);
  assert.equal(posMeta.storage.keys.card, `${collectionId}/${slug}/card`);
  assert.equal(posMeta.storage.keys.whatsapp, `${collectionId}/${slug}/whatsapp`);

  const gradMeta = createMetadata(
    { course_id: "1", slug: "administracao", curso: "Administração" },
    { collectionId: "graduacao-cruzeiro" }
  );
  assert.equal(gradMeta.storage.keys.card, "administracao/card");
  assert.equal(gradMeta.storage.keys.fundo, "administracao/fundo");
  assert.equal(gradMeta.storage.keys.whatsapp, "administracao/whatsapp");

  const omitted = createMetadata({ course_id: "1", slug: "administracao", curso: "Administração" });
  assert.equal(omitted.storage.keys.card, "administracao/card");

  console.log("storage keys OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
