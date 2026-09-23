/**
 * Cursos da coleção graduacao-cruzeiro lidos do PostgreSQL.
 * Mantém o formato usado pela produção legada.
 */

const { getRecord, getCollection, listRecords } = require("./collections-repository");
const { exposeError } = require("./database-name");

const LEGACY_COLLECTION_ID = "graduacao-cruzeiro";

function field(record, ...names) {
  const fields = record?.fields || {};
  for (const name of names) {
    const direct = fields[name];
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(fields)) {
      if (key.toLowerCase() === target && value != null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }
  return "";
}

function toCourse(record) {
  return {
    course_id: field(record, "course_id") || record.id,
    slug: record.slug,
    curso: record.title || field(record, "curso", "Curso"),
    formacao: field(record, "formacao", "Formação"),
    modalidade: field(record, "modalidade", "Modalidade"),
    duracao: field(record, "duracao", "Duração"),
    descricao_curta: field(record, "descricao_curta"),
    prompt_imagem: record.prompt || field(record, "prompt_imagem"),
    image_url: record.sourceImage || field(record, "Image"),
    conteudo_status: record.sourceStatus || field(record, "conteudo_status"),
  };
}

async function requireLegacyCollection() {
  const collection = await getCollection(LEGACY_COLLECTION_ID);
  if (!collection) {
    throw exposeError("Coleção graduacao-cruzeiro não encontrada no PostgreSQL.", 404);
  }
  return collection;
}

async function loadCoursesFromPostgres() {
  await requireLegacyCollection();
  const records = await listRecords(LEGACY_COLLECTION_ID);
  return records.map(toCourse);
}

async function loadCourseFromPostgres(slug) {
  await requireLegacyCollection();
  const record = await getRecord(LEGACY_COLLECTION_ID, slug);
  return record ? toCourse(record) : null;
}

module.exports = {
  LEGACY_COLLECTION_ID,
  toCourse,
  loadCoursesFromPostgres,
  loadCourseFromPostgres,
};
