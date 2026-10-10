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
const { RUNTIME } = require("../config/runtime");

const KNOWN_ASSET_TYPES = new Set(["fundo", "card", "whatsapp"]);
const RESERVED_KEY_ROOTS = new Set(["studio", "uploads"]);

function rejectUnsafeSegment(segment) {
  if (
    !segment
    || segment.includes("..")
    || segment.includes("\\")
    || segment.includes("/")
    || segment.includes("\0")
    || segment.startsWith("/")
    || /^[A-Za-z]:/.test(segment)
  ) {
    throw new Error("Chave fora do diretório de armazenamento.");
  }
}

class LocalStorageProvider extends StorageProvider {
  constructor(baseDir) {
    super();
    this.baseDir = path.resolve(
      baseDir ||
        process.env.STORAGE_LOCAL_DIR ||
        process.env.AI_CATALOG_DIR ||
        RUNTIME.catalogDir
    );
  }

  _assertInside(filePath) {
    const resolved = path.resolve(filePath);
    const baseResolved = path.resolve(this.baseDir);
    if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
      throw new Error("Chave fora do diretório de armazenamento.");
    }
    return resolved;
  }

  _keyToFilePath(key) {
    if (!key || typeof key !== "string" || key.includes("\\") || key.includes("\0")) {
      throw new Error("Chave de armazenamento inválida.");
    }
    const parts = key.split("/");
    if (parts.some((part) => !part || part.includes(".."))) {
      throw new Error("Chave fora do diretório de armazenamento.");
    }
    if (parts.length === 3 && !RESERVED_KEY_ROOTS.has(parts[0])) {
      if (!KNOWN_ASSET_TYPES.has(parts[2])) {
        throw new Error("Chave fora do diretório de armazenamento.");
      }
      const [collectionId, slug, type] = parts;
      rejectUnsafeSegment(collectionId);
      rejectUnsafeSegment(slug);
      rejectUnsafeSegment(type);
      const filename = courseFiles(slug)[type];
      return this._assertInside(path.join(this.baseDir, collectionId, slug, filename));
    }
    if (parts.length >= 2) {
      const [slug, type, ...rest] = parts;
      const names = courseFiles(slug);
      const filename = names[type] || rest.join("/") || type;
      return this._assertInside(path.join(this.baseDir, slug, filename));
    }
    return this._assertInside(path.join(this.baseDir, key));
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

  async read(key) {
    const filePath = this._keyToFilePath(key);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo não encontrado: ${key}`);
    }
    return fs.readFileSync(filePath);
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
