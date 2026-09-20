/**
 * Executor de jobs em lote.
 *
 * Implementa todos os estados de job e item, dry-run por padrão,
 * batch_size, concurrency=1, maxCalls, maxCostUsd, pause/resume/cancel,
 * retry de erros/rejeitados, persistência após cada passo, e bloqueio do
 * job em erros de API key/billing/modelo.
 *
 * A escrita no arquivo do job é serializada por JobQueue, permitindo que
 * pause/cancel/cancel sejam aplicados entre passos sem deadlock.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const sharp = require("sharp");

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
  const message = err?.message || "";
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

function isBlockingError(err) {
  const message = err?.message || "";
  return BLOCKING_PATTERNS.some((p) => p.test(message));
}

function nowIso() {
  return new Date().toISOString();
}

async function createMockBackgroundBuffer() {
  return sharp({
    create: {
      width: 1080,
      height: 1080,
      channels: 3,
      background: { r: 11, g: 17, b: 32 },
    },
  })
    .png()
    .toBuffer();
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

class BatchExecutor {
  constructor({ catalogDir, storageProvider, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.catalogDir = catalogDir || getCatalogDir();
    this.storage = storageProvider;
    this.queue = new JobQueue();
    this.maxAttempts = maxAttempts;
    this._activeRuns = new Map(); // jobId -> Promise
  }

  _ensureStorage() {
    if (!this.storage) {
      throw new Error("StorageProvider não configurado no executor.");
    }
  }

  _loadCourseMap() {
    return loadAllCourses().then((courses) => {
      const map = {};
      for (const c of courses) {
        map[c.slug] = c;
      }
      return map;
    });
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
      if (item.status === "pronto_revisao" || item.status === "aprovado") {
        stats.completed++;
      }
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
    if (job.status === "cancelado" || job.status === "bloqueado") {
      return;
    }
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

  async _generateBackground(job, item, course, metadata) {
    if (job.background_source === "original") {
      if (!course.image_url) {
        throw new Error("Curso não possui imagem original.");
      }
      return getImageBuffer(course.image_url);
    }

    if (job.background_source === "upload") {
      throw new Error("Fonte de fundo 'upload' não suportada em lote.");
    }

    if (job.dryRun) {
      return createMockBackgroundBuffer();
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada.");
    }

    // Verifica limites antes da chamada real. Se atingidos, pausa o job sem
    // marcar o item como erro, permitindo retomada posterior.
    this._updateStats(job);
    if (job.max_calls != null && job.stats.calls >= job.max_calls) {
      job.status = "pausado";
      job.error = `Limite de chamadas atingido (${job.max_calls}).`;
      writeJob(this.catalogDir, job);
      return null;
    }
    if (job.max_cost_usd != null && job.stats.cost_usd >= job.max_cost_usd) {
      job.status = "pausado";
      job.error = `Limite de custo atingido (${job.max_cost_usd}).`;
      writeJob(this.catalogDir, job);
      return null;
    }

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

      const generatedPath = record.caminho_arquivo;
      if (!fs.existsSync(generatedPath)) {
        throw new Error("Arquivo gerado não foi encontrado após a API.");
      }
      const buffer = fs.readFileSync(generatedPath);

      metadata.model = record.modelo || job.model || DEFAULT_MODEL;
      metadata.quality = record.qualidade || job.quality || DEFAULT_QUALITY;
      metadata.size = record.tamanho || job.size || DEFAULT_SIZE;
      metadata.prompt = record.prompt || metadata.prompt;
      const cost = record.custo_estimado_usd?.totalCostUsd || 0;
      item.cost_usd = (item.cost_usd || 0) + cost;
      metadata.cost_usd = item.cost_usd;
      item.calls = (item.calls || 0) + 1;
      metadata.attempts = item.attempts || 0;

      return buffer;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async _doFundoStep(job, item, course, metadata) {
    item.status = "gerando_fundo";
    metadata.status = "gerando_fundo";

    const bgBuffer = await this._withRetry(item, metadata, () =>
      this._generateBackground(job, item, course, metadata)
    );

    if (!bgBuffer) {
      // Limite atingido: o job já foi pausado; aborta este passo sem erro.
      return false;
    }

    await this.storage.save(metadata.storage.keys.fundo, bgBuffer, {
      contentType: "image/png",
    });
    metadata.hashes.fundo = sha256(bgBuffer);
    metadata.timestamps.generated_at = nowIso();
    metadata.status = "fundo_gerado";
    item.status = "fundo_gerado";
    item.error = null;
    await updateMetadataUrls(metadata, this.storage);
  }

  async _doCardStep(job, item, course, metadata) {
    item.status = "renderizando_card";
    metadata.status = "renderizando_card";

    const fundoPath = this.storage.resolveLocalPath
      ? this.storage.resolveLocalPath(metadata.storage.keys.fundo)
      : path.join(this.catalogDir, item.slug, courseFiles(item.slug).fundo);
    const bgBuffer = fs.readFileSync(fundoPath);

    const prepared = await prepareBackgroundBuffer(bgBuffer);
    const cardBuffer = await renderCourseCard(prepared, {
      curso: course.curso,
      modalidade: course.modalidade,
      formacao: course.formacao,
      duracao: course.duracao,
    });

    await this.storage.save(metadata.storage.keys.card, cardBuffer, {
      contentType: "image/png",
    });
    metadata.hashes.card = sha256(cardBuffer);
    metadata.timestamps.rendered_at = nowIso();
    metadata.status = "gerando_whatsapp";
    item.status = "gerando_whatsapp";
    item.error = null;
    await updateMetadataUrls(metadata, this.storage);
  }

  async _doWhatsappStep(job, item, course, metadata) {
    item.status = "gerando_whatsapp";
    metadata.status = "gerando_whatsapp";

    const cardPath = this.storage.resolveLocalPath
      ? this.storage.resolveLocalPath(metadata.storage.keys.card)
      : path.join(this.catalogDir, item.slug, courseFiles(item.slug).card);
    const cardBuffer = fs.readFileSync(cardPath);

    const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
    await this.storage.save(metadata.storage.keys.whatsapp, whatsappBuffer, {
      contentType: "image/jpeg",
    });
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

      // Se o job foi pausado/cancelado/bloqueado por outra operação, respeitamos.
      if (["pausado", "cancelado", "bloqueado"].includes(fresh.status)) {
        // Reverte o status do item para refletir a interrupção, se ainda estava em progresso.
        if (
          !["pronto_revisao", "aprovado", "rejeitado", "erro", "cancelado"].includes(item.status)
        ) {
          item.status = fresh.status === "pausado" ? item.status : "cancelado";
          metadata.status = item.status;
        }
        // Mesmo interrompido, persistimos o metadata atual.
        this._updateStats(fresh);
        writeMetadata(this.catalogDir, item.slug, metadata);
        writeJob(this.catalogDir, fresh);
        return { aborted: true, job: fresh };
      }

      // Atualiza o item no job fresco.
      const idx = fresh.courses.findIndex((c) => c.slug === item.slug);
      if (idx >= 0) {
        fresh.courses[idx] = item;
      }
      this._updateStats(fresh);
      writeMetadata(this.catalogDir, item.slug, metadata);
      writeJob(this.catalogDir, fresh);
      return { aborted: false, job: fresh };
    });
  }

  async _processOneStep(jobId, courseMap) {
    const job = this._refreshJob(jobId);
    if (!job) throw new Error("Job não encontrado.");

    // Transição para executando, se aplicável.
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
      return await this._withJobLock(jobId, () => {
        const fresh = readJob(this.catalogDir, jobId);
        this._finalizeJob(fresh);
        writeJob(this.catalogDir, fresh);
        return { done: true, job: fresh };
      });
    }

    const course = courseMap[item.slug];
    if (!course) {
      item.status = "erro";
      item.error = "Curso não encontrado na planilha.";
      await this._persistItem(job, item, readMetadata(this.catalogDir, item.slug) || createMetadata(item));
      return { done: false, job: this._refreshJob(jobId) };
    }

    let metadata = readMetadata(this.catalogDir, item.slug);
    if (!metadata) {
      metadata = createMetadata(course, {
        template_id: job.template_id,
        model: job.model,
        quality: job.quality,
        size: job.size,
        background_origin: job.background_source || "ia",
      });
    }

    const step = stepNameFromStatus(item.status);

    try {
      if (step === "fundo") {
        const proceed = await this._doFundoStep(job, item, course, metadata);
        if (proceed === false) {
          return { done: false, job: this._refreshJob(jobId) };
        }
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      } else if (step === "card") {
        await this._doCardStep(job, item, course, metadata);
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      } else if (step === "whatsapp") {
        await this._doWhatsappStep(job, item, course, metadata);
        const result = await this._persistItem(job, item, metadata);
        if (result.aborted) return { done: true, job: result.job };
      }
    } catch (err) {
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

      // Erros não transientes já foram marcados em item/metadata pelo _withRetry.
      await this._persistItem(job, item, metadata);
    }

    return { done: false, job: this._refreshJob(jobId) };
  }

  async _run(jobId) {
    if (this._activeRuns.has(jobId)) {
      return this._activeRuns.get(jobId);
    }

    const runPromise = (async () => {
      try {
        const courseMap = await this._loadCourseMap();
        let safety = 0;
        const maxSteps = 10000;
        while (safety < maxSteps) {
          safety++;
          const { done } = await this._processOneStep(jobId, courseMap);
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
        if (
          !["pronto_revisao", "aprovado", "rejeitado", "erro"].includes(item.status)
        ) {
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

    const job = {
      id: generateJobId(),
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
        course_id: c.course_id,
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

    return job;
  }
}

module.exports = {
  BatchExecutor,
  isTransientError,
  isBlockingError,
  createMockBackgroundBuffer,
  stepNameFromStatus,
};
