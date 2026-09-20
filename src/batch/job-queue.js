/**
 * Fila in-process para serializar operações de leitura/escrita
 * de um único job ou arquivo de manifesto.
 */

class JobQueue {
  constructor() {
    this.locks = new Map();
  }

  async run(jobId, fn) {
    const previous = this.locks.get(jobId) || Promise.resolve();
    const next = previous.then(async () => {
      return await fn();
    });
    this.locks.set(jobId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(jobId) === next) {
        this.locks.delete(jobId);
      }
    }
  }
}

module.exports = {
  JobQueue,
};
