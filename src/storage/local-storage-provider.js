/**
 * Provedor de armazenamento local.
 *
 * Chave esperada: "<slug>/<tipo>" onde tipo é fundo, card ou whatsapp.
 * O arquivo físico segue a nomenclatura de src/batch/naming.js.
 * URL pública: /api/files/<encodedKey>, com encodedKey em base64url.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { StorageProvider } = require("./storage-provider");
const { courseFiles } = require("../batch/naming");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BASE_DIR = path.join(ROOT, "output", "ai-catalog");

class LocalStorageProvider extends StorageProvider {
  constructor(baseDir) {
    super();
    this.baseDir = path.resolve(
      baseDir ||
        process.env.STORAGE_LOCAL_DIR ||
        process.env.AI_CATALOG_DIR ||
        DEFAULT_BASE_DIR
    );
  }

  _keyToFilePath(key) {
    if (!key || typeof key !== "string") {
      throw new Error("Chave de armazenamento inválida.");
    }
    const parts = key.split("/");
    if (parts.length >= 2) {
      const [slug, type, ...rest] = parts;
      const names = courseFiles(slug);
      const filename = names[type] || rest.join("/") || type;
      const filePath = path.join(this.baseDir, slug, filename);
      const resolved = path.resolve(filePath);
      const baseResolved = path.resolve(this.baseDir);
      if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
        throw new Error("Chave fora do diretório de armazenamento.");
      }
      return resolved;
    }
    const filePath = path.join(this.baseDir, key);
    const resolved = path.resolve(filePath);
    const baseResolved = path.resolve(this.baseDir);
    if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
      throw new Error("Chave fora do diretório de armazenamento.");
    }
    return resolved;
  }

  _contentTypeFromKey(key) {
    const lower = key.toLowerCase();
    if (lower.endsWith("/whatsapp") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    return "image/png";
  }

  async save(key, buffer, { contentType } = {}) {
    const filePath = this._keyToFilePath(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, filePath);
    return {
      key,
      size: buffer.length,
      contentType: contentType || this._contentTypeFromKey(key),
      path: filePath,
    };
  }

  async exists(key) {
    return fs.existsSync(this._keyToFilePath(key));
  }

  async getPublicUrl(key) {
    if (!key || typeof key !== "string") {
      throw new Error("Chave inválida.");
    }
    return `/api/files/${Buffer.from(key, "utf8").toString("base64url")}`;
  }

  async delete(key) {
    const filePath = this._keyToFilePath(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async healthCheck() {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      fs.accessSync(this.baseDir, fs.constants.W_OK);
      return {
        ok: true,
        provider: "local",
        baseDir: this.baseDir,
      };
    } catch (err) {
      return {
        ok: false,
        provider: "local",
        baseDir: this.baseDir,
        error: err.message,
      };
    }
  }

  resolveLocalPath(key) {
    return this._keyToFilePath(key);
  }
}

module.exports = {
  LocalStorageProvider,
};
