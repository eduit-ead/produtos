/**
 * Executor de jobs em lote com suporte a coleções.
 *
 * Mantém estados, dry-run, retry, pause/resume/cancel, limites e
 * persistência atômica. Para cada coleção carrega um provider que
 * fornece mapa de itens, geração de fundo e renderização de card.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");

const { JobQueue } = require("./job-queue");
const { readJob, writeJob, generateJobId } = require("./job");
const {
  readMetadata,
  writeMetadata,
  createMetadata,
  updateMetadataUrls,
  sha256,
  getCatalogDir,
} = require("./metadata");
const { courseFiles } = require("./naming");
const { generateImage, DEFAULT_MODEL, DEFAULT_QUALITY, DEFAULT_SIZE } = require("../generate-ai-background");
const { renderCourseCard, prepareBackgroundBuffer } = require("../render-card");
const { convertCardToWhatsAppJpeg } = require("../whatsapp-image");
const { loadAllCourses } = require("../read-courses");
const { getImageBuffer } = require("../image-cache");
const {
  LEGACY_COLLECTION_ID,
  LEGACY_TEMPLATE_ID,
  catalogDirFor: catalogDirForCollection,
  loadCollectionAndRecords,
  resolveTemplateBindingsValues,
  applyProductionBackground,
  PRODUCTION_BACKGROUND_KEY,
} = require("../production/generic-production-service");
const { getDataSource } = require("../data-sources");
const { loadCollection } = require("../collections/manager");
const { renderTemplate } = require("../template-editor/renderer");

const MAX_ATTEMPTS = 3;

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /download falhou/i,
  /http 5/i,
  /rate limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
];

const BLOCKING_PATTERNS = [
  /openai_api_key/i,
  /api key/i,
  /billing/i,
  /quota/i,
  /insufficient_quota/i,
  /invalid_api_key/i,
  /unauthorized/i,
  /model/i,
];

function isTransientError(err) {
  return TRANSIENT_PATTERNS.some((p) => p.test(err?.message || ""));
}

function isBlockingError(err) {
  return BLOCKING_PATTERNS.some((p) => p.test(err?.message || ""));
}

function nowIso() {
  return new Date().toISOString();
}

async function createMockBackgroundBuffer() {
  return sharp({
    create: { width: 1080, height: 1080, channels: 3, background: { r: 11, g: 17, b: 32 } },
  })
    .png()
    .toBuffer();
}

function catalogDirFor(job) {
  const collectionId = job.collectionId || LEGACY_COLLECTION_ID;
  return catalogDirForCollection(collectionId);
}

function stepNameFromStatus(status) {
  switch (status) {
    case "pendente":
    case "erro":
    case "gerando_fundo":
      return "fundo";
    case "fundo_gerado":
    case "renderizando_card":
      return "card";
    case "gerando_whatsapp":
      return "whatsapp";
    case "pronto_revisao":
    case "aprovado":
    case "rejeitado":
    case "cancelado":
      return "done";
    default:
      return "fundo";
  }
}

// ============================================================
// Providers de coleção
// ============================================================

function createLegacyProvider() {
  return {
    async loadMap() {
      const courses = await loadAllCourses();
      const map = {};
      for (const c of courses) map[c.slug] = c;
      return map;
    },
    async generateBackground(job, item, course, metadata) {
      if (job.background_source === "original") {
        if (!course.image_url) throw new Error("Curso não possui imagem original.");
        return getImageBuffer(course.image_url);
      }
      if (job.dryRun) return createMockBackgroundBuffer();
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-bg-"));
      try {
        const record = await generateImage(
          {
            course_id: course.course_id,
            slug: course.slug,
            curso: course.curso,
            prompt: metadata.prompt || course.prompt_imagem,
          },
          { outputDir: tempDir }
        );
        metadata.model = record.modelo || job.model || DEFAULT_MODEL;
        metadata.quality = record.qualidade || job.quality || DEFAULT_QUALITY;
        metadata.size = record.tamanho || job.size || DEFAULT_SIZE;
        metadata.prompt = record.prompt || metadata.prompt;
        item.cost_usd = (item.cost_usd || 0) + (record.custo_estimado_usd?.totalCostUsd || 0);
        metadata.cost_usd = item.cost_usd;
        item.calls = (item.calls || 0) + 1;
        metadata.attempts = item.attempts || 0;
        return fs.readFileSync(record.caminho_arquivo);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    async renderCard(job, item, course, backgroundBuffer) {
      const prepared = await prepareBackgroundBuffer(backgroundBuffer);
      return renderCourseCard(prepared, {
        curso: course.curso,
        modalidade: course.modalidade,
        formacao: course.formacao,
        duracao: course.duracao,
      });
    },
  };
}

function createGenericProvider(collectionId) {
  const collection = loadCollection(collectionId);
  const source = getDataSource(collection);

  async function loadMap() {
    const { records } = await loadCollectionAndRecords(collectionId);
    const map = {};
    for (const r of records) map[r.slug] = r;
    return map;
  }

  async function generateBackground(job, item, record, metadata) {
    if (job.background_source === "original") {
      if (!record.sourceImage) throw new Error("Item não possui imagem original.");
      return getImageBuffer(record.sourceImage);
    }
    if (job.dryRun) return createMockBackgroundBuffer();
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-bg-"));
    try {
      const recordImage = await generateImage(
        {
          course_id: record.id,
          slug: record.slug,
          curso: record.title,
          prompt: metadata.prompt || record.prompt || record.title,
        },
        { outputDir: tempDir }
      );
      metadata.model = recordImage.modelo || job.model || DEFAULT_MODEL;
      metadata.quality = recordImage.qualidade || job.quality || DEFAULT_QUALITY;
      metadata.size = recordImage.tamanho || job.size || DEFAULT_SIZE;
      metadata.prompt = recordImage.prompt || metadata.prompt;
      item.cost_usd = (item.cost_usd || 0) + (recordImage.custo_estimado_usd?.totalCostUsd || 0);
      metadata.cost_usd = item.cost_usd;
      item.calls = (item.calls || 0) + 1;
      metadata.attempts = item.attempts || 0;
      return fs.readFileSync(recordImage.caminho_arquivo);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function renderCard(job, item, record, backgroundBuffer) {
    const templateId = job.template_id || collection.defaultTemplateId;
    if (templateId === LEGACY_TEMPLATE_ID) {
      throw new Error("Template Cruzeiro não pode ser usado fora da coleção padrão.");
    }

    const templatePath = path.join(ROOT, "data", "templates", `${templateId}.json`);
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const values = resolveTemplateBindingsValues(collection, record);

    for (const v of template.variables || []) {
      if (Object.hasOwn(values, v.key)) continue;
      if (v.defaultValue !== undefined) values[v.key] = v.defaultValue;
    }

    const missing = (template.variables || [])
      .filter((v) => v.required && (!values[v.key] || values[v.key] === ""))
      .map((v) => v.key);
    if (missing.length > 0) {
      throw new Error(`Variáveis obrigatórias sem binding: ${missing.join(", ")}`);
    }

    const applied = applyProductionBackground(template, values, collection);
    return renderTemplate(applied.template || template, applied.values, {
      runtimeAssets: { [PRODUCTION_BACKGROUND_KEY]: backgroundBuffer },
    });
  }

  return { loadMap, generateBackground, renderCard };
}

function getProvider(job) {
  const collectionId = job.collectionId || LEGACY_COLLECTION_ID;
  if (collectionId === LEGACY_COLLECTION_ID) {
    return createLegacyProvider();
  }
  return createGenericProvider(collectionId);
}

// ============================================================
// BatchExecutor
// ============================================================

class BatchExecutor {
  constructor({ catalogDir, storageProvider, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.catalogDir = catalogDir || getCatalogDir();
    this.storage = storageProvider;
    this.queue = new JobQueue();
    this.maxAttempts = maxAttempts;
    this._activeRuns = new Map();
  }

  _ensureStorage() {
    if (!this.storage) {
      throw new Error("StorageProvider não configurado no executor.");
    }
  }

  _refreshJob(jobId) {
    return readJob(this.catalogDir, jobId);
  }

  _updateStats(job) {
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
      if (item.status === "pronto_revisao" || item.status === "aprovado") stats.completed++;
      if (item.status === "erro") stats.errors++;
      if (item.status === "aprovado") stats.approved++;
      if (item.status === "rejeitado") stats.rejected++;
      stats.calls += item.calls || 0;
      stats.cost_usd += item.cost_usd || 0;
    }
    job.stats = stats;
  }

  _finalizeJob(job) {
    this._updateStats(job);
    if (job.status === "cancelado" || job.status === "bloqueado") return;
    const hasPending = job.courses.some((c) =>
      ["pendente", "gerando_fundo", "fundo_gerado", "renderizando_card", "gerando_whatsapp"].includes(c.status)
    );
    if (job.status === "pausado") {
      // mantém pausado
    } else if (job.stats.errors > 0) {
      job.status = "concluido_com_erros";
      job.completed_at = nowIso();
    } else if (!hasPending) {
      job.status = "concluido";
      job.completed_at = nowIso();
    } else {
      job.status = "pausado";
    }
  }

  async _withJobLock(jobId, fn) {
    return this.queue.run(jobId, fn);
  }

  async _setJobStatus(jobId, status) {
    return this._withJobLock(jobId, () => {
      const job = readJob(this.catalogDir, jobId);
      if (!job) throw new Error("Job não encontrado.");
      job.status = status;
      if (status === "executando" && !job.started_at) job.started_at = nowIso();
      writeJob(this.catalogDir, job);
      return job;
    });
  }

  async _withRetry(item, metadata, stepFn) {
    let attempts = (item.attempts || 0) + 1;
    while (attempts <= this.maxAttempts) {
      try {
        item.attempts = attempts;
        return await stepFn();
      } catch (err) {
        if (isTransientError(err) && attempts < this.maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempts++;
          continue;
        }
        item.status = "erro";
        item.error = err.message;
        metadata.status = "erro";
        metadata.error = err.message;
        metadata.attempts = attempts;
        throw err;
      }
    }
  }

  _checkLimits(job) {
    this._updateStats(job);
    if (job.max_calls != null && job.stats.calls >= job.max_calls) {
      job.status = "pausado";
      job.error = `Limite de chamadas atingido (${job.max_calls}).`;
      writeJob(this.catalogDir, job);
      return false;
    }
    if (job.max_cost_usd != null && job.stats.cost_usd >= job.max_cost_usd) {
      job.status = "pausado";
      job.error = `Limite de custo atingido (${job.max_cost_usd}).`;
      writeJob(this.catalogDir, job);
      return false;
    }
    return true;
  }

  async _generateBackground(job, item, course, metadata, provider) {
    if (job.background_source === "upload") {
      throw new Error("Fonte de fundo 'upload' não suportada em lote.");
    }

    const buffer = await this._withRetry(item, metadata, () =>
      provider.generateBackground(job, item, course, metadata)
    );

    if (!buffer) return false;

    await this.storage.save(metadata.storage.keys.fundo, buffer, { contentType: "image/png" });
    metadata.hashes.fundo = sha256(buffer);
    metadata.timestamps.generated_at = nowIso();
    metadata.status = "fundo_gerado";
    metadata.background_origin = job.background_source || "ia";
    item.status = "fundo_gerado";
    item.error = null;
    await updateMetadataUrls(metadata, this.storage);
    return true;
  }

  async _doCardStep(job, item, course, metadata, provider) {
    item.status = "renderizando_card";
    metadata.status = "renderizando_card";

    const fundoPath = this.storage.resolveLocalPath(metadata.storage.keys.fundo);
    const bgBuffer = fs.readFileSync(fundoPath);
    const cardBuffer = await provider.renderCard(job, item, course, bgBuffer);
    if (!Buffer.isBuffer(cardBuffer)) {
      throw new Error("Renderização do card não retornou um buffer válido.");
    }

    await this.storage.save(metadata.storage.keys.card, cardBuffer, { contentType: "image/png" });
    metadata.hashes.card = sha256(cardBuffer);
    metadata.timestamps.rendered_at = nowIso();
    metadata.status = "gerando_whatsapp";
    item.status = "gerando_whatsapp";
    item.error = null;
    await updateMetadataUrls(metadata, this.storage);
  }

  async _doWhatsappStep(job, item, metadata) {
    item.status = "gerando_whatsapp";
    metadata.status = "gerando_whatsapp";

    const cardPath = this.storage.resolveLocalPath(metadata.storage.keys.card);
    const cardBuffer = fs.readFileSync(cardPath);
    const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
    await this.storage.save(metadata.storage.keys.whatsapp, whatsappBuffer, { contentType: "image/jpeg" });
    metadata.hashes.whatsapp = sha256(whatsappBuffer);
    metadata.timestamps.whatsapp_at = nowIso();
    metadata.status = "pronto_revisao";
    item.status = "pronto_revisao";
    item.error = null;
    await updateMetadataUrls(metadata, this.storage);
  }

  async _persistItem(job, item, metadata) {
    return this._withJobLock(job.id, () => {
      const fresh = readJob(this.catalogDir, job.id);
      if (!fresh) throw new Error("Job não encontrado.");

      if (["pausado", "cancelado", "bloqueado"].includes(fresh.status)) {
        if (
          !["pronto_revisao", "aprovado", "rejeitado", "erro", "cancelado"].includes(item.status)
        ) {
          item.status = fresh.status === "pausado" ? item.status : "cancelado";
          metadata.status = item.status;
        }
        this._updateStats(fresh);
        writeMetadata(this.catalogDir, item.slug, metadata);
        writeJob(this.catalogDir, fresh);
        return { aborted: true, job: fresh };
      }

      const idx = fresh.courses.findIndex((c) => c.slug === item.slug);
      if (idx >= 0) fresh.courses[idx] = item;
      this._updateStats(fresh);
      writeMetadata(this.catalogDir, item.slug, metadata);
      writeJob(this.catalogDir, fresh);
      return { aborted: false, job: fresh };
    });
  }

  async _processOneStep(jobId, courseMap, provider) {
    const job = this._refreshJob(jobId);
    if (!job) throw new Error("Job não encontrado.");

    if (job.status === "criado" || job.status === "pausado") {
      await this._setJobStatus(jobId, "executando");
    }

    if (job.status !== "executando") {
      return { done: true, job };
    }

    const item = job.courses.find((c) =>
      !["pronto_revisao", "aprovado", "rejeitado", "cancelado", "erro"].includes(c.status)
    );
    if (!item) {
      return this._withJobLock(jobId, () => {
        const fresh = readJob(this.catalogDir, jobId);
        this._finalizeJob(fresh);
        writeJob(this.catalogDir, fresh);
        return { done: true, job: fresh };
      });
    }

    const course = courseMap[item.slug];
    if (!course) {
      item.status = "erro";
      item.error = "Item não encontrado na fonte de dados.";
      let metadata = readMetadata(this.catalogDir, item.slug);
      if (!metadata) {
        metadata = this._createMetadata({ id: item.course_id, slug: item.slug }, job, item);
      }
      metadata.status = "erro";
      metadata.error = item.error;
      await this._persistItem(job, item, metadata);
      return { done: false, job: this._refreshJob(jobId) };
    }

    let metadata = readMetadata(this.catalogDir, item.slug);
    if (!metadata) {
      metadata = this._createMetadata(course, job, item);
    }

    const step = stepNameFromStatus(item.status);

    try {
      if (step === "fundo") {
        if (!this._checkLimits(job)) {
          return { done: false, job: this._refreshJob(jobId) };
        }
        const proceed = await this._generateBackground(job, item, course, metadata, provider);
        if (!proceed) return { done: false, job: this._refreshJob(jobId) };
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      } else if (step === "card") {
        await this._doCardStep(job, item, course, metadata, provider);
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      } else if (step === "whatsapp") {
        await this._doWhatsappStep(job, item, metadata);
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      }
    } catch (err) {
      console.error(`Erro no processamento de ${item?.slug}:`, err.message);
      if (isBlockingError(err)) {
        return this._withJobLock(jobId, () => {
          const fresh = readJob(this.catalogDir, jobId);
          fresh.status = "bloqueado";
          fresh.error = err.message;
          const idx = fresh.courses.findIndex((c) => c.slug === item.slug);
          if (idx >= 0) fresh.courses[idx] = item;
          this._updateStats(fresh);
          writeJob(this.catalogDir, fresh);
          writeMetadata(this.catalogDir, item.slug, metadata);
          throw err;
        });
      }
      await this._persistItem(job, item, metadata);
    }

    return { done: false, job: this._refreshJob(jobId) };
  }

  _createMetadata(course, job, item) {
    const template_id = job.template_id || "cruzeiro-graduacao-v1";
    const title = course.curso || course.title || course.name || "";
    const prompt =
      (course.prompt_imagem || course.prompt || title || "").toString().slice(0, 4000);
    const recordLike = {
      course_id: course.course_id || course.id || item.slug,
      slug: item.slug,
      curso: title,
      prompt_imagem: prompt,
    };
    return createMetadata(recordLike, {
      template_id,
      model: job.model,
      quality: job.quality,
      size: job.size,
      background_origin: job.background_source || "ia",
    });
  }

  async _run(jobId) {
    if (this._activeRuns.has(jobId)) return this._activeRuns.get(jobId);

    const runPromise = (async () => {
      try {
        let job = this._refreshJob(jobId);
        if (!job) throw new Error("Job não encontrado.");
        this.catalogDir = catalogDirFor(job);
        this.storage = new (require("../storage/local-storage-provider").LocalStorageProvider)(this.catalogDir);
        const provider = getProvider(job);
        const courseMap = await provider.loadMap();

        let safety = 0;
        const maxSteps = 10000;
        while (safety < maxSteps) {
          safety++;
          const { done } = await this._processOneStep(jobId, courseMap, provider);
          if (done) break;
        }
        return this._refreshJob(jobId);
      } catch (err) {
        console.error(`Erro no executor do job ${jobId}:`, err.message);
        throw err;
      } finally {
        this._activeRuns.delete(jobId);
      }
    })();

    this._activeRuns.set(jobId, runPromise);
    return runPromise;
  }

  async start(jobId) {
    const job = await this._setJobStatus(jobId, "executando");
    this._run(jobId).catch((err) => console.error(err));
    return job;
  }

  async resume(jobId) {
    const job = await this._setJobStatus(jobId, "executando");
    this._run(jobId).catch((err) => console.error(err));
    return job;
  }

  async pause(jobId) {
    return this._withJobLock(jobId, () => {
      const job = readJob(this.catalogDir, jobId);
      if (!job) throw new Error("Job não encontrado.");
      if (job.status === "executando") {
        job.status = "pausado";
        writeJob(this.catalogDir, job);
      }
      return job;
    });
  }

  async cancel(jobId) {
    return this._withJobLock(jobId, () => {
      const job = readJob(this.catalogDir, jobId);
      if (!job) throw new Error("Job não encontrado.");
      job.status = "cancelado";
      for (const item of job.courses) {
        if (!["pronto_revisao", "aprovado", "rejeitado", "erro"].includes(item.status)) {
          item.status = "cancelado";
          const metadata = readMetadata(this.catalogDir, item.slug);
          if (metadata) {
            metadata.status = "cancelado";
            writeMetadata(this.catalogDir, item.slug, metadata);
          }
        }
      }
      this._updateStats(job);
      writeJob(this.catalogDir, job);
      return job;
    });
  }

  async retryErrors(jobId) {
    const job = await this._withJobLock(jobId, () => {
      const j = readJob(this.catalogDir, jobId);
      if (!j) throw new Error("Job não encontrado.");
      let reset = false;
      for (const item of j.courses) {
        if (item.status === "erro") {
          item.status = "pendente";
          item.error = null;
          item.attempts = 0;
          reset = true;
        }
      }
      if (reset) {
        j.status = "executando";
        j.error = null;
        writeJob(this.catalogDir, j);
      }
      return j;
    });
    this._run(jobId).catch((err) => console.error(err));
    return job;
  }

  async retryRejected(jobId) {
    const job = await this._withJobLock(jobId, () => {
      const j = readJob(this.catalogDir, jobId);
      if (!j) throw new Error("Job não encontrado.");
      let reset = false;
      for (const item of j.courses) {
        if (item.status === "rejeitado") {
          item.status = "pendente";
          item.error = null;
          item.attempts = 0;
          reset = true;
        }
      }
      if (reset) {
        j.status = "executando";
        j.error = null;
        writeJob(this.catalogDir, j);
      }
      return j;
    });
    this._run(jobId).catch((err) => console.error(err));
    return job;
  }

  static createJob(courses, options = {}) {
    const {
      collectionId = LEGACY_COLLECTION_ID,
      template_id = "cruzeiro-graduacao-v1",
      background_source = "ia",
      batch_size = 1,
      concurrency = 1,
      max_calls = null,
      max_cost_usd = null,
      model = DEFAULT_MODEL,
      quality = DEFAULT_QUALITY,
      size = DEFAULT_SIZE,
      dryRun = true,
    } = options;

    return {
      id: generateJobId(),
      collectionId,
      status: "criado",
      template_id,
      background_source,
      batch_size,
      concurrency,
      max_calls,
      max_cost_usd,
      model,
      quality,
      size,
      dryRun,
      courses: courses.map((c) => ({
        course_id: c.course_id || c.id,
        slug: c.slug,
        status: "pendente",
        error: null,
        attempts: 0,
        cost_usd: 0,
        calls: 0,
      })),
      stats: {
        total: courses.length,
        completed: 0,
        errors: 0,
        approved: 0,
        rejected: 0,
        calls: 0,
        cost_usd: 0,
      },
      created_at: nowIso(),
      started_at: null,
      completed_at: null,
      error: null,
    };
  }
}

module.exports = {
  BatchExecutor,
  isTransientError,
  isBlockingError,
  createMockBackgroundBuffer,
  stepNameFromStatus,
  LEGACY_COLLECTION_ID,
};
