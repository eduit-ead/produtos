/**
 * Política de conflito entre a base em arquivo e o PostgreSQL.
 * skip: não altera linha existente.
 * newer: atualiza só se a origem tiver data mais recente.
 * merge: atualiza chaves recebidas e preserva as demais.
 * replace: substitui o documento de campos. Só com política explícita.
 */

const POLICIES = new Set(["skip", "newer", "merge", "replace"]);

function assertPolicy(policy) {
  if (!POLICIES.has(policy)) {
    const err = new Error("Política de conflito inválida. Use skip, newer, merge ou replace.");
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return policy;
}

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function sourceUpdatedAt(record) {
  const fields = record?.fields || {};
  return record?.updatedAt || fields.updatedAt || fields.imagem_atualizada_em || null;
}

function resolveConflict(existing, incoming, policy) {
  assertPolicy(policy);
  if (!existing) return "insert";
  if (policy === "skip") return "skip";
  if (policy === "replace" || policy === "merge") return "update";
  const sourceTime = toTime(sourceUpdatedAt(incoming));
  const currentTime = toTime(existing.updated_at || existing.updatedAt);
  if (sourceTime == null || currentTime == null) return "skip";
  return sourceTime > currentTime ? "update" : "skip";
}

function mergeFields(existingFields, incomingFields, policy) {
  const current = existingFields && typeof existingFields === "object" ? existingFields : {};
  const incoming = incomingFields && typeof incomingFields === "object" ? incomingFields : {};
  if (policy === "replace") return { ...incoming };
  return { ...current, ...incoming };
}

function recordIdentity(collection, record) {
  const itemId = String(record?.id || record?.slug || "").trim();
  const slug = String(record?.slug || itemId).trim();
  const primaryKey = collection?.primaryKey;
  const rawKey = primaryKey ? record?.fields?.[primaryKey] : "";
  const sourceKey = String(rawKey || "").trim() || null;
  return { itemId, slug, sourceKey };
}

module.exports = {
  POLICIES,
  assertPolicy,
  sourceUpdatedAt,
  resolveConflict,
  mergeFields,
  recordIdentity,
};
