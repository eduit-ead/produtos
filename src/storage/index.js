/**
 * Factory de provedores de armazenamento.
 *
 * STORAGE_PROVIDER=local (padrão) → LocalStorageProvider
 * STORAGE_PROVIDER=s3           → S3StorageProvider
 */

const { LocalStorageProvider } = require("./local-storage-provider");
const { S3StorageProvider } = require("./s3-storage-provider");

function createStorageProvider(options = {}) {
  const provider = (process.env.STORAGE_PROVIDER || "local").toLowerCase();

  if (provider === "s3") {
    return new S3StorageProvider({
      endpoint: options.endpoint || process.env.S3_ENDPOINT,
      region: options.region || process.env.S3_REGION,
      bucket: options.bucket || process.env.S3_BUCKET,
      accessKeyId: options.accessKeyId || process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: options.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: options.forcePathStyle,
      publicBaseUrl: options.publicBaseUrl || process.env.S3_PUBLIC_BASE_URL,
      prefix: options.prefix || process.env.S3_PREFIX,
      client: options.client,
    });
  }

  if (provider === "local") {
    return new LocalStorageProvider(options.baseDir);
  }

  throw new Error(`Provedor de armazenamento não suportado: ${provider}`);
}

module.exports = {
  createStorageProvider,
  LocalStorageProvider,
  S3StorageProvider,
};
