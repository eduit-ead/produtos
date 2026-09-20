/**
 * Atualização atômica de status de itens dentro de jobs em lote.
 * Atualiza o job, recalcula estatísticas e sincroniza o manifesto genérico.
 */

const { readJob, writeJob } = require("./job");
const { catalogDirFor, ensureManifest, saveManifest, getManifestEntry, setManifestEntry } = require("../production/generic-production-service");

const locks = new Map();

function recalcJobStats(job) {
  const stats = {
    total: job.courses.length,
    completed: 0,
    errors: 0,
    approved: 0,
    rejected: 0,
    calls: 0,
    cost_usd: 0,
  };
  for (const item of job.courses) {
    if (["pronto_revisao", "aprovado", "rejeitado"].includes(item.status)) stats.completed++;
    if (item.status === "erro") stats.errors++;
    if (item.status === "aprovado") stats.approved++;
    if (item.status === "rejeitado") stats.rejected++;
    stats.calls += item.calls || 0;
    stats.cost_usd += item.cost_usd || 0;
  }
  job.stats = stats;
  if (!job.status) job.status = "criado";
  if (job.status === "executando") return;
  const allDone = stats.total > 0 && stats.total === stats.completed + stats.errors + stats.rejected;
  if (allDone && !["cancelado", "pausado"].includes(job.status)) {
    job.status = stats.errors > 0 ? "concluido_com_erros" : "concluido";
  }
}

function withJobWriteLock(jobId, fn) {
  const current = locks.get(jobId) || Promise.resolve();
  const next = current.then(
    () => fn(),
    () => fn()
  );
  locks.set(jobId, next);
  next.finally(() => {
    if (locks.get(jobId) === next) locks.delete(jobId);
  });
  return next;
}

function updateManifestStatus(collectionId, slug, status, recordLike = {}) {
  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, slug) || {};
  const next = {
    ...entry,
    ...recordLike,
    status,
    timestamps: {
      ...(entry.timestamps || {}),
      approved_at: status === "aprovado" ? new Date().toISOString() : (entry.timestamps?.approved_at || null),
      rejected_at: status === "rejeitado" ? new Date().toISOString() : (entry.timestamps?.rejected_at || null),
    },
    updatedAt: new Date().toISOString(),
  };
  if (status === "aprovado") {
    next.approvedAt = next.timestamps.approved_at;
    next.rejectedAt = null;
  } else if (status === "rejeitado") {
    next.rejectedAt = next.timestamps.rejected_at;
    next.approvedAt = null;
  }
  setManifestEntry(manifest, slug, next);
  saveManifest(collectionId, manifest);
  return next;
}

async function updateJobItemStatus(collectionId, jobId, slug, newStatus, recordLike = {}) {
  const catalogDir = catalogDirFor(collectionId);
  return withJobWriteLock(jobId, () => {
    const job = readJob(catalogDir, jobId);
    if (!job) throw new Error("Lote não encontrado.");
    const item = job.courses.find((c) => c.slug === slug);
    if (!item) throw new Error("Item não encontrado no lote.");

    item.status = newStatus;
    item.updatedAt = new Date().toISOString();
    recalcJobStats(job);
    writeJob(catalogDir, job);

    updateManifestStatus(collectionId, slug, newStatus, recordLike);
    return { job, manifestEntry: getManifestEntry(ensureManifest(collectionId), slug) };
  });
}

async function resetJobItemForRegeneration(collectionId, jobId, slug) {
  const catalogDir = catalogDirFor(collectionId);
  return withJobWriteLock(jobId, () => {
    const job = readJob(catalogDir, jobId);
    if (!job) throw new Error("Lote não encontrado.");
    const item = job.courses.find((c) => c.slug === slug);
    if (!item) throw new Error("Item não encontrado no lote.");

    item.status = "pendente";
    item.calls = 0;
    item.cost_usd = 0;
    item.error = null;
    item.updatedAt = new Date().toISOString();
    recalcJobStats(job);
    writeJob(catalogDir, job);

    updateManifestStatus(collectionId, slug, "pendente");
    return { job };
  });
}

module.exports = {
  recalcJobStats,
  withJobWriteLock,
  updateJobItemStatus,
  resetJobItemForRegeneration,
};
