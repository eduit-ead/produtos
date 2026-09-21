#!/usr/bin/env node
"use strict";

/**
 * Importa fundos gerados pelo piloto de IA para o fluxo oficial de produção.
 *
 * Uso:
 *   node scripts/import-ai-pilot.js
 *   node scripts/import-ai-pilot.js --map slug:arquivo.png [--map outro:file.png]
 *   node scripts/import-ai-pilot.js --name "Nome do lote"
 *
 * Regras:
 * - Não chama OpenAI.
 * - Não altera input/cursos.xlsx, output/final, output/whatsapp nem output/ai-pilot.
 * - Não sobrescreve versões existentes com hash diferente.
 * - É idempotente: reexecutar não duplica o lote nem reimporta fundos idênticos.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const sharp = require("sharp");

const { RUNTIME } = require("../src/config/runtime");
const CATALOG_DIR = RUNTIME.catalogDir;
process.env.AI_CATALOG_DIR = CATALOG_DIR;

const { loadAllCourses } = require("../src/read-courses");
const { createStorageProvider } = require("../src/storage");
const genericProduction = require("../src/production/generic-production-service");
const courseService = require("../src/course-production-service");
const { renderCourseCard, prepareBackgroundBuffer } = require("../src/render-card");
const { convertCardToWhatsAppJpeg } = require("../src/whatsapp-image");
const {
  createMetadata,
  readMetadata,
  writeMetadata,
  sha256,
  updateMetadataUrls,
} = require("../src/batch/metadata");
const { courseFiles } = require("../src/batch/naming");
const { BatchExecutor } = require("../src/batch/executor");
const { writeJob, listJobs } = require("../src/batch/job");
const { recalcJobStats } = require("../src/batch/job-status");

const ROOT = path.resolve(__dirname, "..");
const PILOT_DIR = path.join(ROOT, "output", "ai-pilot");
const COLLECTION_ID = "graduacao-cruzeiro";
const TEMPLATE_ID = "cruzeiro-graduacao-v1";
const JOB_NAME = "Piloto oficial — fundos IA existentes";

const DEFAULT_IMPORTS = [
  { slug: "ciberseguranca", file: "ciberseguranca-fundo-ia.png" },
  { slug: "gestao-publica", file: "gestao-publica-fundo-ia.png" },
  { slug: "nutricao", file: "nutricao-fundo-ia.png" },
];

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const imports = [];
  let name = JOB_NAME;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--map" && i + 1 < argv.length) {
      const parts = argv[i + 1].split(":");
      if (parts.length === 2 && parts[0] && parts[1]) {
        imports.push({ slug: parts[0], file: parts[1] });
      }
      i++;
    } else if (arg === "--name" && i + 1 < argv.length) {
      name = argv[i + 1];
      i++;
    }
  }
  return { imports: imports.length ? imports : DEFAULT_IMPORTS, name };
}

function assertGitStatusClean() {
  const result = spawnSync("git", ["status", "--short"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git status falhou: ${result.stderr || result.stdout}`);
  }

  const ownFile = path.basename(__filename);
  const testFile = "test-" + ownFile;
  const allowedUntracked = new Set([ownFile, testFile]);

  const lines = (result.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      if (l.endsWith(".zip")) return false;
      const fileName = path.basename(l.replace(/^\?\?\s+/, ""));
      if (l.startsWith("?? ") && allowedUntracked.has(fileName)) return false;
      return true;
    });

  if (lines.length > 0) {
    throw new Error(
      `Há arquivos fonte modificados/não rastreados por outra tarefa. Resolva antes de importar:\n${lines.join("\n")}`
    );
  }
  console.log("git status limpo (script atual e arquivos .zip não rastreados ignorados).");
}

async function assertPilotFilesExist(imports) {
  for (const imp of imports) {
    const filePath = path.join(PILOT_DIR, imp.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Fundo piloto não encontrado: ${filePath}`);
    }
    const meta = await sharp(filePath).metadata();
    if (meta.format !== "png") {
      throw new Error(`Fundo piloto deve ser PNG: ${imp.file}`);
    }
    if (meta.width !== 1024 || meta.height !== 1024) {
      console.warn(
        `  Atenção: ${imp.file} é ${meta.width}x${meta.height} (esperado 1024x1024). O card será renderizado em 1080x1080.`
      );
    }
  }
  console.log(`${imports.length} fundos piloto encontrados e validados.`);
}

function assertCoursesFound(allCourses, imports) {
  const missing = [];
  for (const imp of imports) {
    const course = allCourses.find((c) => c.slug === imp.slug);
    if (!course) {
      missing.push(imp.slug);
      continue;
    }
    const required = ["course_id", "slug", "curso", "modalidade", "formacao", "duracao", "prompt_imagem"];
    for (const key of required) {
      if (!course[key]) {
        throw new Error(`Curso ${imp.slug} está sem o campo obrigatório: ${key}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Cursos não encontrados na base: ${missing.join(", ")}`);
  }
  console.log(`${imports.length} cursos encontrados na coleção ${COLLECTION_ID}.`);
}

function updateGenericManifest(course, files, stage) {
  const manifest = genericProduction.ensureManifest(COLLECTION_ID);
  const existing = genericProduction.getManifestEntry(manifest, course.slug) || {};
  const update = {
    course_id: course.course_id,
    curso: course.curso,
    selectedBackground: "pilot",
    model: "gpt-image-2.5-flare",
    quality: "medium",
    size: "1024x1024",
    costUsd: 0,
    error: null,
  };
  if (stage === "fundo") {
    update.status = existing.status === "aprovado" ? "aprovado" : "gerado";
    update.backgroundPath = `${course.slug}/${files.fundo}`;
    update.uploadedAt = nowIso();
  } else if (stage === "card") {
    update.status = existing.status === "aprovado" ? "aprovado" : "gerado";
    update.cardPath = `${course.slug}/${files.card}`;
    update.renderedAt = nowIso();
  }
  genericProduction.setManifestEntry(manifest, course.slug, update);
  genericProduction.saveManifest(COLLECTION_ID, manifest);
}

function courseServiceGetEntry(manifest, slug) {
  return manifest.courses[slug] || null;
}

function courseServiceResolveStatus(manifest, slug) {
  const entry = courseServiceGetEntry(manifest, slug);
  if (entry?.status === "aprovado") return "aprovado";
  if (entry?.status === "rejeitado") return "rejeitado";
  if (entry?.status === "erro") return "erro";
  if (entry?.status === "gerando") return "gerando";
  const hasBg = fs.existsSync(path.join(CATALOG_DIR, slug, `${slug}-fundo.png`));
  const hasCard = fs.existsSync(path.join(CATALOG_DIR, slug, `${slug}-card.png`));
  if (hasCard || hasBg) return "gerado";
  return "pendente";
}

function courseServiceSetEntry(manifest, slug, partial) {
  const existing = courseServiceGetEntry(manifest, slug) || {};
  manifest.courses[slug] = {
    course_id: partial.course_id ?? existing.course_id,
    slug,
    curso: partial.curso ?? existing.curso,
    status: partial.status ?? existing.status ?? courseServiceResolveStatus(manifest, slug),
    prompt: partial.prompt ?? existing.prompt,
    backgroundPath: partial.backgroundPath ?? existing.backgroundPath,
    cardPath: partial.cardPath ?? existing.cardPath,
    selectedBackground: partial.selectedBackground ?? existing.selectedBackground,
    model: partial.model ?? existing.model,
    quality: partial.quality ?? existing.quality,
    size: partial.size ?? existing.size,
    costUsd: partial.costUsd ?? existing.costUsd ?? 0,
    usage: partial.usage ?? existing.usage,
    dryRun: partial.dryRun ?? existing.dryRun,
    attempts: partial.attempts ?? existing.attempts ?? 0,
    error: partial.error ?? existing.error,
    generatedAt: partial.generatedAt ?? existing.generatedAt,
    uploadedAt: partial.uploadedAt ?? existing.uploadedAt,
    renderedAt: partial.renderedAt ?? existing.renderedAt,
    approvedAt: partial.approvedAt ?? existing.approvedAt,
    rejectedAt: partial.rejectedAt ?? existing.rejectedAt,
    updatedAt: new Date().toISOString(),
  };
}

function updateCourseServiceManifest(course, files, stage) {
  const manifest = courseService.loadManifest();
  const existing = courseServiceGetEntry(manifest, course.slug) || {};
  const update = {
    course_id: course.course_id,
    curso: course.curso,
    selectedBackground: "pilot",
    error: null,
  };
  if (stage === "fundo") {
    update.status = courseServiceResolveStatus(manifest, course.slug) === "aprovado" ? "aprovado" : "gerado";
    update.backgroundPath = `${course.slug}/${files.fundo}`;
    update.uploadedAt = nowIso();
  } else if (stage === "card") {
    update.status = courseServiceResolveStatus(manifest, course.slug) === "aprovado" ? "aprovado" : "gerado";
    update.cardPath = `${course.slug}/${files.card}`;
    update.renderedAt = nowIso();
  }
  courseServiceSetEntry(manifest, course.slug, update);
  courseService.saveManifest(manifest);
}

async function importBackground(course, imp, storage) {
  const sourcePath = path.join(PILOT_DIR, imp.file);
  const sourceBuffer = fs.readFileSync(sourcePath);
  const sourceHash = sha256(sourceBuffer);
  const files = courseFiles(course.slug);
  const fundoKey = `${course.slug}/fundo`;

  let action = "imported";
  if (await storage.exists(fundoKey)) {
    const existingBuffer = await storage.read(fundoKey);
    const existingHash = sha256(existingBuffer);
    if (existingHash === sourceHash) {
      action = "kept";
      console.log(`  ${course.slug}: fundo já existe com mesmo hash`);
    } else {
      throw new Error(
        `${course.slug}: fundo existe com hash diferente; não sobrescrevendo (source ${sourceHash.slice(0, 16)} vs existing ${existingHash.slice(0, 16)})`
      );
    }
  }

  if (action === "imported") {
    await storage.save(fundoKey, sourceBuffer, { contentType: "image/png" });
    console.log(`  ${course.slug}: fundo importado (${sourceBuffer.length} bytes, hash ${sourceHash.slice(0, 16)})`);
  }

  updateGenericManifest(course, files, "fundo");
  updateCourseServiceManifest(course, files, "fundo");

  return { action, sourceHash, sourceBuffer, files };
}

async function renderCard(course, files, storage) {
  // Renderiza pelo adaptador oficial (delega ao renderer legado src/render-card.js).
  const renderResult = await genericProduction.renderItem(COLLECTION_ID, course.slug, {
    templateId: TEMPLATE_ID,
  });

  const cardKey = `${course.slug}/card`;
  if (!(await storage.exists(cardKey))) {
    throw new Error(`${course.slug}: card não foi gerado em ${renderResult.cardPath}`);
  }
  const cardBuffer = await storage.read(cardKey);
  const cardHash = sha256(cardBuffer);
  const cardMeta = await sharp(cardBuffer).metadata();
  if (cardMeta.format !== "png" || cardMeta.width !== 1080 || cardMeta.height !== 1080) {
    throw new Error(
      `${course.slug}: card com dimensões/formato inesperado: ${cardMeta.width}x${cardMeta.height} ${cardMeta.format}`
    );
  }

  updateGenericManifest(course, files, "card");
  console.log(`  ${course.slug}: card renderizado (${cardBuffer.length} bytes, hash ${cardHash.slice(0, 16)})`);
  return { cardBuffer, cardHash, cardMeta };
}

async function generateWhatsApp(course, files, storage, cardBuffer) {
  const whatsappBuffer = await convertCardToWhatsAppJpeg(cardBuffer);
  const whatsappKey = `${course.slug}/whatsapp`;
  await storage.save(whatsappKey, whatsappBuffer, { contentType: "image/jpeg" });
  const whatsappHash = sha256(whatsappBuffer);
  const waMeta = await sharp(whatsappBuffer).metadata();
  if (waMeta.format !== "jpeg" || waMeta.width !== 1080 || waMeta.height !== 1080) {
    throw new Error(
      `${course.slug}: WhatsApp com dimensões/formato inesperado: ${waMeta.width}x${waMeta.height} ${waMeta.format}`
    );
  }
  console.log(`  ${course.slug}: WhatsApp gerado (${whatsappBuffer.length} bytes, hash ${whatsappHash.slice(0, 16)})`);
  return { whatsappBuffer, whatsappHash, waMeta };
}

async function processCourse(imp, allCourses, storage) {
  const course = allCourses.find((c) => c.slug === imp.slug);
  console.log(`\nProcessando ${course.slug} (${course.curso})...`);

  const { sourceHash, files } = await importBackground(course, imp, storage);

  let metadata = readMetadata(CATALOG_DIR, course.slug);
  if (!metadata) {
    metadata = createMetadata(course, {
      template_id: TEMPLATE_ID,
      model: "gpt-image-2.5-flare",
      quality: "medium",
      size: "1024x1024",
      background_origin: "pilot",
    });
  }
  metadata.background_origin = "pilot";
  metadata.prompt = course.prompt_imagem;
  metadata.hashes.fundo = sourceHash;
  metadata.timestamps.generated_at = metadata.timestamps.generated_at || nowIso();

  const { cardBuffer, cardHash } = await renderCard(course, files, storage);
  metadata.hashes.card = cardHash;
  metadata.timestamps.rendered_at = nowIso();

  const { whatsappHash } = await generateWhatsApp(course, files, storage, cardBuffer);
  metadata.hashes.whatsapp = whatsappHash;
  metadata.timestamps.whatsapp_at = nowIso();

  metadata.status = "pronto_revisao";
  metadata.updatedAt = nowIso();
  metadata.error = null;
  await updateMetadataUrls(metadata, storage);

  // Mantém o manifesto genérico consistente com o metadata final.
  const finalManifest = genericProduction.ensureManifest(COLLECTION_ID);
  genericProduction.setManifestEntry(finalManifest, course.slug, {
    course_id: course.course_id,
    curso: course.curso,
    status: "pronto_revisao",
    backgroundPath: `${course.slug}/${files.fundo}`,
    cardPath: `${course.slug}/${files.card}`,
    selectedBackground: "pilot",
    model: metadata.model,
    quality: metadata.quality,
    size: metadata.size,
    costUsd: 0,
    uploadedAt: metadata.timestamps.generated_at,
    renderedAt: metadata.timestamps.rendered_at,
    error: null,
  });
  genericProduction.saveManifest(COLLECTION_ID, finalManifest);

  writeMetadata(CATALOG_DIR, course.slug, metadata);

  return {
    slug: course.slug,
    curso: course.curso,
    sourceHash,
    cardHash,
    whatsappHash,
    fundoSize: (await storage.read(`${course.slug}/fundo`)).length,
    cardSize: cardBuffer.length,
    whatsappSize: (await storage.read(`${course.slug}/whatsapp`)).length,
  };
}

function findExistingJob(name) {
  const jobs = listJobs(CATALOG_DIR);
  return jobs.find((j) => j.name === name) || null;
}

function createCompletedJob(imports, allCourses, name) {
  const coursesForJob = imports.map((imp) => {
    const course = allCourses.find((c) => c.slug === imp.slug);
    return {
      course_id: course.course_id,
      slug: course.slug,
      status: "pronto_revisao",
      error: null,
      attempts: 0,
      cost_usd: 0,
      calls: 0,
      updatedAt: nowIso(),
    };
  });

  const job = BatchExecutor.createJob(coursesForJob, {
    collectionId: COLLECTION_ID,
    template_id: TEMPLATE_ID,
    background_source: "pilot",
    dryRun: false,
    batch_size: 1,
    concurrency: 1,
  });
  job.name = name;
  job.status = "concluido";
  job.started_at = nowIso();
  job.completed_at = nowIso();
  job.courses = coursesForJob;
  recalcJobStats(job);
  return job;
}

async function validateResults(imports, allCourses, storage, jobName) {
  console.log("\n=== Validação ===");

  // 1. Fundos existem e hash não mudou.
  for (const imp of imports) {
    const course = allCourses.find((c) => c.slug === imp.slug);
    const sourceBuffer = fs.readFileSync(path.join(PILOT_DIR, imp.file));
    const sourceHash = sha256(sourceBuffer);
    const fundoBuffer = await storage.read(`${course.slug}/fundo`);
    assert.equal(
      sha256(fundoBuffer),
      sourceHash,
      `hash do fundo importado mudou para ${course.slug}`
    );
    console.log(`  ✓ fundo ${course.slug}: hash consistente`);
  }

  // 2. Cursos encontrados.
  assert.equal(
    imports.length,
    imports.filter((imp) => allCourses.some((c) => c.slug === imp.slug)).length,
    "todos os cursos devem ter sido encontrados"
  );
  console.log(`  ✓ ${imports.length} cursos encontrados na base`);

  // 3. Cards e WhatsApp existem, dimensões e formatos corretos.
  for (const imp of imports) {
    const course = allCourses.find((c) => c.slug === imp.slug);
    const cardKey = `${course.slug}/card`;
    const waKey = `${course.slug}/whatsapp`;
    assert.ok(await storage.exists(cardKey), `card deve existir para ${course.slug}`);
    assert.ok(await storage.exists(waKey), `whatsapp deve existir para ${course.slug}`);

    const cardMeta = await sharp(await storage.read(cardKey)).metadata();
    assert.equal(cardMeta.format, "png", `card ${course.slug} deve ser PNG`);
    assert.equal(cardMeta.width, 1080, `card ${course.slug} deve ter 1080px de largura`);
    assert.equal(cardMeta.height, 1080, `card ${course.slug} deve ter 1080px de altura`);

    const waMeta = await sharp(await storage.read(waKey)).metadata();
    assert.equal(waMeta.format, "jpeg", `whatsapp ${course.slug} deve ser JPEG`);
    assert.equal(waMeta.width, 1080, `whatsapp ${course.slug} deve ter 1080px de largura`);
    assert.equal(waMeta.height, 1080, `whatsapp ${course.slug} deve ter 1080px de altura`);

    console.log(`  ✓ ${course.slug}: card PNG 1080x1080 e WhatsApp JPEG 1080x1080`);
  }

  // 4. Renderer oficial utilizado: metadata indica template oficial e card existe.
  for (const imp of imports) {
    const course = allCourses.find((c) => c.slug === imp.slug);
    const metadata = readMetadata(CATALOG_DIR, course.slug);
    assert.ok(metadata, `metadata deve existir para ${course.slug}`);
    assert.equal(metadata.template_id, TEMPLATE_ID, `template oficial deve ser usado para ${course.slug}`);
    assert.equal(metadata.status, "pronto_revisao", `status deve ser pronto_revisao para ${course.slug}`);
    assert.ok(metadata.hashes.card, `hash do card deve estar registrado para ${course.slug}`);
    assert.ok(metadata.hashes.whatsapp, `hash do whatsapp deve estar registrado para ${course.slug}`);
  }
  console.log(`  ✓ renderer oficial ${TEMPLATE_ID} registrado no metadata`);

  // 5. Lote aparece na API e está pronto para revisão.
  const jobs = listJobs(CATALOG_DIR);
  const job = jobs.find((j) => j.name === jobName);
  assert.ok(job, `lote "${jobName}" deve existir`);
  assert.equal(job.status, "concluido", "lote deve estar concluído");
  assert.equal(job.stats.total, imports.length, "lote deve conter todos os itens");
  assert.equal(job.stats.completed, imports.length, "todos os itens devem estar concluídos");
  assert.equal(job.stats.errors, 0, "lote não deve ter erros");
  for (const item of job.courses) {
    assert.equal(item.status, "pronto_revisao", `item ${item.slug} deve estar pronto_revisao`);
  }
  console.log(`  ✓ lote ${job.id} pronto para revisão (${job.stats.completed}/${job.stats.total})`);

  return job;
}

async function main() {
  const { imports, name } = parseArgs(process.argv.slice(2));

  console.log("=== Importação de fundos piloto para o fluxo oficial ===");
  console.log(`Diretório de catálogo: ${CATALOG_DIR}`);
  console.log(`Diretório do piloto: ${PILOT_DIR}`);
  console.log(`Itens: ${imports.map((i) => `${i.slug}=${i.file}`).join(", ")}`);

  assertGitStatusClean();
  await assertPilotFilesExist(imports);
  const allCourses = await loadAllCourses();
  assertCoursesFound(allCourses, imports);

  const storage = createStorageProvider({ baseDir: CATALOG_DIR });
  const existingJob = findExistingJob(name);
  if (existingJob && existingJob.status === "concluido") {
    console.log(`\nLote "${name}" já existe (${existingJob.id}) e está concluído. Validando sem reimportar.`);
    const job = await validateResults(imports, allCourses, storage, name);
    printSummary(imports, allCourses, job);
    return;
  }

  const results = [];
  for (const imp of imports) {
    results.push(await processCourse(imp, allCourses, storage));
  }

  const job = createCompletedJob(imports, allCourses, name);
  writeJob(CATALOG_DIR, job);

  const validatedJob = await validateResults(imports, allCourses, storage, name);
  printSummary(imports, allCourses, validatedJob);
}

function printSummary(imports, allCourses, job) {
  console.log("\n=== Resumo ===");
  console.log(`Lote criado: ${job.id}`);
  console.log(`Nome: ${job.name}`);
  console.log(`Status: ${job.status}`);
  console.log(`Itens: ${job.stats.total} total, ${job.stats.completed} concluídos, ${job.stats.errors} erros`);
  console.log("\nCursos importados:");
  for (const imp of imports) {
    const course = allCourses.find((c) => c.slug === imp.slug);
    const metadata = readMetadata(CATALOG_DIR, course.slug);
    console.log(`  - ${course.curso} (${course.slug})`);
    console.log(`    fundo:   ${metadata.urls.fundo || "—"} (hash ${metadata.hashes.fundo.slice(0, 16)})`);
    console.log(`    card:    ${metadata.urls.card || "—"} (hash ${metadata.hashes.card.slice(0, 16)})`);
    console.log(`    whatsapp:${metadata.urls.whatsapp || "—"} (hash ${metadata.hashes.whatsapp.slice(0, 16)})`);
  }
  console.log("\nURLs de revisão (quando servidor estiver rodando):");
  console.log(`  http://localhost:3000/batch.html?job=${encodeURIComponent(job.id)}&collection=${COLLECTION_ID}`);
}

main().catch((err) => {
  console.error("\nXXX Importação falhou:", err.message);
  console.error(err.stack);
  process.exit(1);
});
