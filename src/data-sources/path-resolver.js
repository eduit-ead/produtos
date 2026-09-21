/**
 * Resolve caminhos de fontes de dados contra o diretório de runtime configurável.
 */

const fs = require("fs");
const path = require("path");
const { RUNTIME } = require("../config/runtime");

function isSafeRuntimePath(p) {
  if (!p || typeof p !== "string") return false;
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(RUNTIME.root, p);
  return resolved.startsWith(RUNTIME.root + path.sep) || resolved === RUNTIME.root;
}

function resolveDataSourcePath(p) {
  if (!p) throw new Error("Caminho da fonte não informado.");
  if (!isSafeRuntimePath(p)) {
    throw new Error("Caminho da fonte inválido ou fora do diretório de runtime.");
  }
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(RUNTIME.root, p);
  if (!fs.existsSync(resolved)) throw new Error("Arquivo não encontrado.");
  return resolved;
}

module.exports = {
  isSafeRuntimePath,
  resolveDataSourcePath,
};
