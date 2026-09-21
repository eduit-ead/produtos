/**
 * Provedor de armazenamento S3 compatível.
 *
 * Suporta AWS S3, Cloudflare R2 e Supabase Storage via endpoint S3.
 * Nunca loga credenciais, buffers completos ou chaves inteiras em produção.
 */

const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const { StorageProvider } = require("./storage-provider");

const PATH_TRAVERSAL_RE = /(\.\.|^\/|\\|\0|\r|\n)/;

function sanitizeKey(key) {
  if (!key || typeof key !== "string") {
    throw new Error("Chave de armazenamento inválida.");
  }
  if (PATH_TRAVERSAL_RE.test(key)) {
    throw new Error("Chave de armazenamento rejeitada por segurança.");
  }
  return key.replace(/^\/+/, "").replace(/\/+/g, "/").trim();
}

function buildBucketKey(key, prefix) {
  const safePrefix = prefix ? String(prefix).replace(/^\/+/, "").replace(/\/+$/g, "") : "";
  return safePrefix ? `${safePrefix}/${key}` : key;
}

function sanitizeForLog(value, maxLen = 40) {
  if (typeof value !== "string") return "<non-string>";
  const v = value.trim();
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen - 3)}...`;
}

class S3StorageProvider extends StorageProvider {
  constructor({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    publicBaseUrl,
    prefix,
    client,
  } = {}) {
    super();

    if (!bucket) {
      throw new Error("Parâmetro 'bucket' é obrigatório para S3StorageProvider.");
    }

    this.bucket = String(bucket).trim();
    this.region = region || process.env.S3_REGION || "auto";
    this.prefix = prefix || process.env.S3_PREFIX || "";
    this.publicBaseUrl = publicBaseUrl || process.env.S3_PUBLIC_BASE_URL || "";
    this.endpoint = endpoint || process.env.S3_ENDPOINT || undefined;

    const credentials =
      accessKeyId && secretAccessKey
        ? { accessKeyId: String(accessKeyId), secretAccessKey: String(secretAccessKey) }
        : process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined;

    if (client) {
      this.client = client;
    } else {
      const config = {
        region: this.region,
        credentials,
      };
      if (this.endpoint) {
        config.endpoint = this.endpoint;
      }
      if (typeof forcePathStyle === "boolean") {
        config.forcePathStyle = forcePathStyle;
      } else if (process.env.S3_FORCE_PATH_STYLE === "true") {
        config.forcePathStyle = true;
      }
      this.client = new S3Client(config);
    }
  }

  _bucketKey(key) {
    const safe = sanitizeKey(key);
    return buildBucketKey(safe, this.prefix);
  }

  _contentTypeFromKey(key, providedContentType) {
    if (providedContentType) return providedContentType;
    const lower = key.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    return "application/octet-stream";
  }

  async save(key, buffer, { contentType } = {}) {
    const safeKey = sanitizeKey(key);
    const bucketKey = this._bucketKey(key);
    const finalContentType = this._contentTypeFromKey(safeKey, contentType);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: bucketKey,
          Body: buffer,
          ContentType: finalContentType,
        })
      );

      return {
        key: safeKey,
        size: buffer.length,
        contentType: finalContentType,
        url: this.getPublicUrl(safeKey),
      };
    } catch (err) {
      throw new Error(
        `Falha ao salvar objeto '${sanitizeForLog(bucketKey)}': ${err.message}`
      );
    }
  }

  async exists(key) {
    const bucketKey = this._bucketKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: bucketKey,
        })
      );
      return true;
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw new Error(
        `Falha ao verificar existência de '${sanitizeForLog(bucketKey)}': ${err.message}`
      );
    }
  }

  getPublicUrl(key) {
    const safeKey = sanitizeKey(key);
    const bucketKey = buildBucketKey(safeKey, this.prefix);

    if (this.publicBaseUrl) {
      const base = this.publicBaseUrl.replace(/\/+$/, "");
      return `${base}/${bucketKey}`;
    }

    return `/api/files/${Buffer.from(bucketKey, "utf8").toString("base64url")}`;
  }

  async delete(key) {
    const bucketKey = this._bucketKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: bucketKey,
        })
      );
    } catch (err) {
      throw new Error(
        `Falha ao remover '${sanitizeForLog(bucketKey)}': ${err.message}`
      );
    }
  }

  async healthCheck() {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket })
      );
      return {
        ok: true,
        provider: "s3",
        bucket: this.bucket,
        region: this.region,
      };
    } catch (headErr) {
      try {
        await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 })
        );
        return {
          ok: true,
          provider: "s3",
          bucket: this.bucket,
          region: this.region,
        };
      } catch (listErr) {
        return {
          ok: false,
          provider: "s3",
          bucket: this.bucket,
          region: this.region,
          error: listErr.message,
        };
      }
    }
  }
}

module.exports = {
  S3StorageProvider,
  sanitizeKey,
  buildBucketKey,
};
