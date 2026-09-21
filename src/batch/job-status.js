/**
 * Atualização atômica de status de itens dentro de jobs em lote.
 * Atualiza o job, recalcula estatísticas e sincroniza metadata.json e manifest.json.
 */

const fs = require("fs");
const path = require("path");
const { readJob, writeJob } = require("./job");
const { readMetadata, writeMetadata, metadataPath } = require("./metadata");
const { courseFiles } = require("./naming");
const { createStorageProvider } = require("../storage");
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
  const terminalCount = stats.completed + stats.errors;
  const allDone = stats.total > 0 && terminalCount === stats.total;
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
  const cleanup = () => {
    if (locks.get(jobId) === next) locks.delete(jobId);
  };
  return next.then(
    (value) => { cleanup(); return value; },
    (err) => { cleanup(); throw err; }
  );
}

async function cardExists(catalogDir, slug, storageProvider = null) {
  const meta = readMetadata(catalogDir, slug);
  if (!meta) return false;
  try {
    const storage = storageProvider || createStorageProvider({ baseDir: catalogDir });
    return await storage.exists(meta.storage.keys.card);
  } catch {
    return false;
  }
}

function updateMetadataStatus(catalogDir, slug, status) {
  const metadata = readMetadata(catalogDir, slug);
  if (!metadata) throw new Error(`metadata.json não encontrado para ${slug}.`);

  metadata.status = status;
  metadata.timestamps = metadata.timestamps || {};
  if (status === "aprovado") {
    metadata.timestamps.approved_at = new Date().toISOString();
    metadata.timestamps.rejected_at = null;
  } else if (status === "rejeitado") {
    metadata.timestamps.rejected_at = new Date().toISOString();
    metadata.timestamps.approved_at = null;
  } else if (status === "pendente") {
    metadata.timestamps.approved_at = null;
    metadata.timestamps.rejected_at = null;
  }
  metadata.updatedAt = new Date().toISOString();
  writeMetadata(catalogDir, slug, metadata);
  return metadata;
}

function updateManifestFromMetadata(collectionId, metadata) {
  const manifest = ensureManifest(collectionId);
  const entry = getManifestEntry(manifest, metadata.slug) || {};
  const next = {
    ...entry,
    course_id: metadata.course_id,
    curso: metadata.curso,
    slug: metadata.slug,
    status: metadata.status,
    template_id: metadata.template_id,
    files: metadata.files,
    urls: metadata.urls,
    hashes: metadata.hashes,
    timestamps: metadata.timestamps,
    updatedAt: metadata.updatedAt,
  };
  if (metadata.status === "aprovado") {
    next.approvedAt = metadata.timestamps.approved_at;
    next.rejectedAt = null;
  } else if (metadata.status === "rejeitado") {
    next.rejectedAt = metadata.timestamps.rejected_at;
    next.approvedAt = null;
  }
  setManifestEntry(manifest, metadata.slug, next);
  saveManifest(collectionId, manifest);
  return next;
}

async function updateJobItemStatus(collectionId, jobId, slug, newStatus, recordLike = {}, storageProvider = null) {
  const catalogDir = catalogDirFor(collectionId);
  return withJobWriteLock(jobId, async () => {
    const job = readJob(catalogDir, jobId);
    if (!job) throw new Error("Lote não encontrado.");
    const item = job.courses.find((c) => c.slug === slug);
    if (!item) throw new Error("Item não encontrado no lote.");

    if (newStatus === "aprovado" && !(await cardExists(catalogDir, slug, storageProvider))) {
      throw new Error("Não é possível aprovar: card ainda não foi gerado.");
    }

    item.status = newStatus;
    item.updatedAt = new Date().toISOString();
    recalcJobStats(job);
    writeJob(catalogDir, job);

    const metadata = updateMetadataStatus(catalogDir, slug, newStatus);
    if (recordLike.curso) metadata.curso = recordLike.curso;
    if (recordLike.course_id) metadata.course_id = recordLike.course_id;
    writeMetadata(catalogDir, slug, metadata);

    const manifestEntry = updateManifestFromMetadata(collectionId, metadata);
    return { job, metadata, manifestEntry };
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

    const metadata = updateMetadataStatus(catalogDir, slug, "pendente");
    updateManifestFromMetadata(collectionId, metadata);
    return { job };
  });
}

module.exports = {
  recalcJobStats,
  withJobWriteLock,
  updateJobItemStatus,
  resetJobItemForRegeneration,
  cardExists,
};
