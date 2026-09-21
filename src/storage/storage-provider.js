/**
 * Interface base de um provedor de armazenamento.
 *
 * Contrato:
 *   save(key, buffer, { contentType })
 *   exists(key)
 *   getPublicUrl(key)
 *   delete(key)
 *   healthCheck()
 */

class StorageProvider {
  async save(key, buffer, options = {}) {
    throw new Error("save() não implementado pelo provedor.");
  }

  async exists(key) {
    throw new Error("exists() não implementado pelo provedor.");
  }

  async getPublicUrl(key) {
    throw new Error("getPublicUrl() não implementado pelo provedor.");
  }

  async delete(key) {
    throw new Error("delete() não implementado pelo provedor.");
  }

  async healthCheck() {
    throw new Error("healthCheck() não implementado pelo provedor.");
  }

  resolveLocalPath(key) {
    throw new Error("resolveLocalPath() não implementado pelo provedor.");
  }
}

module.exports = {
  StorageProvider,
};
