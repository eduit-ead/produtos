/**
 * Teste de S3StorageProvider com cliente S3 mockado.
 *
 * Não acessa rede externa.
 */

const assert = require("assert");
const {
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { S3StorageProvider } = require("../src/storage/s3-storage-provider");

function createMockClient(initialState = {}) {
  const objects = new Map(initialState.objects || []);
  let available = initialState.available !== false;
  const calls = [];

  function loggableInput(input) {
    const out = { ...input };
    if (out.Body !== undefined) {
      out.Body = `<Buffer:${out.Body.length}>`;
    }
    if (out.SecretAccessKey) {
      out.SecretAccessKey = "***";
    }
    return out;
  }

  return {
    _objects: objects,
    _available: available,
    _calls: calls,
    send: async (command) => {
      const cmdName = command.constructor.name;
      const input = loggableInput(command.input);
      calls.push({ cmdName, input });

      if (!available && cmdName !== "HeadBucketCommand" && cmdName !== "ListObjectsV2Command") {
        const err = new Error("Network unreachable (mock)");
        err.name = "ServiceUnavailable";
        throw err;
      }

      switch (cmdName) {
        case "PutObjectCommand": {
          objects.set(command.input.Key, { size: command.input.Body.length, contentType: command.input.ContentType });
          return { ETag: `"mock-etag-${Date.now()}"` };
        }

        case "HeadObjectCommand": {
          if (!objects.has(command.input.Key)) {
            const err = new Error("Not Found");
            err.name = "NotFound";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return objects.get(command.input.Key);
        }

        case "DeleteObjectCommand": {
          objects.delete(command.input.Key);
          return {};
        }

        case "HeadBucketCommand": {
          if (!available) {
            const err = new Error("Forbidden (mock)");
            err.name = "Forbidden";
            throw err;
          }
          return {};
        }

        case "ListObjectsV2Command": {
          if (!available) {
            const err = new Error("Service unavailable (mock)");
            err.name = "ServiceUnavailable";
            throw err;
          }
          return { Contents: objects.size > 0 ? [{ Key: Array.from(objects.keys())[0] }] : [] };
        }

        default:
          throw new Error(`Comando mock não implementado: ${cmdName}`);
      }
    },
  };
}

async function run() {
  const mockClient = createMockClient();
  const provider = new S3StorageProvider({
    client: mockClient,
    bucket: "produtos-bucket",
    region: "auto",
    endpoint: "https://s3.example.com",
    forcePathStyle: true,
    publicBaseUrl: "https://cdn.example.com",
    prefix: "catalog",
  });

  // save retorna key/URL
  const saveResult = await provider.save(
    "analise-e-desenvolvimento-de-sistemas/fundos",
    Buffer.from("fake-image"),
    { contentType: "image/jpeg" }
  );
  assert.strictEqual(saveResult.key, "analise-e-desenvolvimento-de-sistemas/fundos");
  assert.strictEqual(saveResult.contentType, "image/jpeg");
  assert.strictEqual(saveResult.size, 10);
  assert(saveResult.url.includes("cdn.example.com/catalog/analise-e-desenvolvimento-de-sistemas/fundos"));

  // exists funciona
  assert.strictEqual(
    await provider.exists("analise-e-desenvolvimento-de-sistemas/fundos"),
    true
  );
  assert.strictEqual(await provider.exists("curso-nao-existente/card"), false);

  // getPublicUrl não vaza credenciais
  const url = provider.getPublicUrl("marketing/whatsapp");
  assert(!url.includes("example-access-key"));
  assert(!url.includes("example-secret"));
  assert(url.startsWith("https://cdn.example.com/catalog/marketing/whatsapp"));

  // fallback de getPublicUrl sem publicBaseUrl
  const fallbackProvider = new S3StorageProvider({
    client: mockClient,
    bucket: "produtos-bucket",
    region: "auto",
    publicBaseUrl: "",
    prefix: "",
  });
  const fallbackUrl = fallbackProvider.getPublicUrl("engenharia/card");
  assert(fallbackUrl.startsWith("/api/files/"));

  // delete remove objeto
  await provider.delete("analise-e-desenvolvimento-de-sistemas/fundos");
  assert.strictEqual(
    await provider.exists("analise-e-desenvolvimento-de-sistemas/fundos"),
    false
  );

  // healthCheck reflete estado
  const healthy = await provider.healthCheck();
  assert.strictEqual(healthy.ok, true);
  assert.strictEqual(healthy.provider, "s3");
  assert.strictEqual(healthy.bucket, "produtos-bucket");

  const brokenClient = createMockClient({ available: false });
  const brokenProvider = new S3StorageProvider({
    client: brokenClient,
    bucket: "produtos-bucket",
    region: "auto",
  });
  const unhealthy = await brokenProvider.healthCheck();
  assert.strictEqual(unhealthy.ok, false);
  assert.strictEqual(unhealthy.provider, "s3");

  // path traversal rejeitado
  const malicious = [
    "../etc/passwd",
    "slug/../../../../etc/passwd",
    "/etc/passwd",
    "slug\\windows\\system32",
    "slug\0null",
  ];
  for (const bad of malicious) {
    let threw = false;
    try {
      await provider.save(bad, Buffer.from("x"));
    } catch (err) {
      threw = true;
      assert(err.message.includes("rejeitada") || err.message.includes("inválida"));
    }
    assert.strictEqual(threw, true, `deveria rejeitar: ${bad}`);
  }

  console.log("✓ test-s3-storage passou");
}

run().catch((err) => {
  console.error("✗ test-s3-storage falhou:", err);
  process.exit(1);
});
