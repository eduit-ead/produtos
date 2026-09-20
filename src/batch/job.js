/**
 * Leitura e escrita atômica de arquivos de job em lote.
 *
 * Jobs ficam em output/ai-catalog/jobs/<jobId>.json.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function getJobsDir(catalogDir) {
  const dir = path.join(catalogDir, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobPath(catalogDir, jobId) {
  return path.join(getJobsDir(catalogDir), `${jobId}.json`);
}

function generateJobId() {
  return `job-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function readJob(catalogDir, jobId) {
  const file = jobPath(catalogDir, jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJobAtomic(catalogDir, job) {
  if (!job || !job.id) {
    throw new Error("Job sem ID não pode ser salvo.");
  }
  const file = jobPath(catalogDir, job.id);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}.json`);
  const content = JSON.stringify(job, null, 2);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      try {
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
        return;
      } catch {}
    }
    fs.writeFileSync(file, content, "utf8");
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function listJobs(catalogDir) {
  const dir = getJobsDir(catalogDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

module.exports = {
  getJobsDir,
  jobPath,
  generateJobId,
  readJob,
  writeJob: writeJobAtomic,
  listJobs,
};
