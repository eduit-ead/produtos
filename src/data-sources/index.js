/**
 * Fábrica de DataSources.
 */

const { XlsxDataSource } = require("./xlsx-data-source");
const { CsvDataSource } = require("./csv-data-source");
const { JsonDataSource } = require("./json-data-source");
const { PostgresRecordSource } = require("./postgres-record-source");
const { usesPostgres } = require("../db/data-source-mode");

function getFileDataSource(collection) {
  const type = collection.source?.type;
  switch (type) {
    case "xlsx":
      return new XlsxDataSource(collection);
    case "csv":
      return new CsvDataSource(collection);
    case "json":
      return new JsonDataSource(collection);
    default:
      throw new Error(`Tipo de fonte não suportado: ${type}`);
  }
}

function getDataSource(collection) {
  if (usesPostgres()) return new PostgresRecordSource(collection);
  return getFileDataSource(collection);
}

module.exports = { getDataSource, getFileDataSource };
