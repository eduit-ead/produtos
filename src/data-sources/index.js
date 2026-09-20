/**
 * Fábrica de DataSources.
 */

const { XlsxDataSource } = require("./xlsx-data-source");
const { CsvDataSource } = require("./csv-data-source");
const { JsonDataSource } = require("./json-data-source");

function getDataSource(collection) {
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

module.exports = { getDataSource };
