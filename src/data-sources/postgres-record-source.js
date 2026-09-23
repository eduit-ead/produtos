/**
 * Leitura e exportação dos registros persistidos no PostgreSQL.
 * A exportação grava um arquivo novo. Não altera a planilha de origem.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { DataSource } = require("./base");
const repo = require("../db/collections-repository");

function outputValues(collection, metadata) {
  const out = collection.outputColumns || {};
  const timestamp = metadata?.timestamps?.whatsapp_at
    || metadata?.timestamps?.rendered_at
    || metadata?.timestamps?.generated_at
    || metadata?.updatedAt
    || null;
  return {
    [out.backgroundFilename]: metadata?.files?.fundo || null,
    [out.cardFilename]: metadata?.files?.card || null,
    [out.whatsappFilename]: metadata?.files?.whatsapp || null,
    [out.backgroundUrl]: metadata?.urls?.fundo || null,
    [out.cardUrl]: metadata?.urls?.card || null,
    [out.whatsappUrl]: metadata?.urls?.whatsapp || null,
    [out.productionStatus]: metadata?.status || null,
    [out.templateId]: metadata?.template_id || null,
    [out.updatedAt]: timestamp,
  };
}

class PostgresRecordSource extends DataSource {
  async listRecords(options = {}) {
    if (options.limit == null) return repo.listRecords(this.collection.id);
    return repo.listRecords(this.collection.id, options);
  }

  async getRecord(recordId) {
    return repo.getRecord(this.collection.id, recordId);
  }

  async getFields() {
    const records = await repo.listRecords(this.collection.id);
    const fields = new Set();
    for (const record of records) {
      for (const key of Object.keys(record.fields || {})) fields.add(key);
    }
    return [...fields].sort();
  }

  async getFilterOptions(field) {
    const records = await repo.listRecords(this.collection.id);
    const values = new Set();
    for (const record of records) {
      const value = record.fields?.[field];
      if (value) values.add(String(value));
    }
    return [...values].sort();
  }

  async _plan(recordsMetadata, { approvedOnly = false } = {}) {
    const records = await repo.listRecords(this.collection.id);
    const byId = new Map();
    for (const record of records) {
      byId.set(String(record.id), record);
      byId.set(String(record.slug), record);
    }
    const plan = { items: [], notFound: [], noChangeCount: 0, wouldChangeCount: 0, skippedCount: 0 };
    for (const metadata of recordsMetadata || []) {
      if (approvedOnly && metadata.status !== "aprovado") {
        plan.skippedCount += 1;
        continue;
      }
      const record = byId.get(String(metadata.id || metadata.slug || metadata.course_id || ""));
      if (!record) {
        plan.notFound.push({ recordId: metadata.id || metadata.course_id, slug: metadata.slug });
        continue;
      }
      const next = outputValues(this.collection, metadata);
      const changes = [];
      for (const [column, value] of Object.entries(next)) {
        if (!column || value == null || value === "") continue;
        const current = record.fields?.[column] ?? null;
        if (String(current ?? "") !== String(value)) {
          changes.push({ column, previous: current, next: value });
        }
      }
      if (changes.length === 0) plan.noChangeCount += 1;
      else plan.wouldChangeCount += 1;
      plan.items.push({ recordId: record.id, slug: record.slug, changes, next });
    }
    return plan;
  }

  async exportUpdatedCopy(recordsMetadata, outputPath) {
    const records = await repo.listRecords(this.collection.id);
    const plan = await this._plan(recordsMetadata, { approvedOnly: false });
    const nextById = new Map(plan.items.map((item) => [item.recordId, item.next]));
    const headers = [];
    const seen = new Set();
    function addHeader(name) {
      if (!name || seen.has(name)) return;
      seen.add(name);
      headers.push(name);
    }
    for (const record of records) {
      for (const key of Object.keys(record.fields || {})) addHeader(key);
    }
    for (const column of Object.values(this.collection.outputColumns || {})) addHeader(column);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(this.collection.source?.sheet || "Registros");
    sheet.addRow(headers);
    for (const record of records) {
      const next = nextById.get(record.id) || {};
      const row = { ...(record.fields || {}) };
      for (const [column, value] of Object.entries(next)) {
        if (value != null && value !== "") row[column] = value;
      }
      sheet.addRow(headers.map((header) => row[header] ?? ""));
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);
    return plan;
  }

  async syncApprovedRecords(recordsMetadata, { confirm = false } = {}) {
    const plan = await this._plan(recordsMetadata, { approvedOnly: true });
    if (!confirm) return { mode: "dry-run", plan };
    for (const item of plan.items) {
      if (item.changes.length === 0) continue;
      const patch = {};
      for (const change of item.changes) patch[change.column] = change.next;
      await repo.patchRecordFields(this.collection.id, item.recordId, patch);
    }
    return { mode: "sync", plan, backup: null };
  }
}

module.exports = { PostgresRecordSource };
