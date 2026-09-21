/**
 * Rotas de download de ZIPs organizados por lote.
 *
 * POST /api/batches/:id/download
 */

const express = require("express");
const path = require("path");
const { createStorageProvider } = require("../storage");
const { getCatalogDir } = require("./metadata");
const { buildBatchZip, findJobCatalogDir } = require("./zip-download");

const router = express.Router();

function parseOptions(body = {}) {
  return {
    approvedOnly: body.approvedOnly !== false,
    includeCards: !!body.includeCards,
    includeWhatsApp: !!body.includeWhatsApp,
    includeBackgrounds: !!body.includeBackgrounds,
    includeMetadata: !!body.includeMetadata,
  };
}

router.post("/:id/download", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || /[\/\\]/.test(id)) {
      return res.status(400).json({ error: "ID de lote inválido." });
    }

    const options = parseOptions(req.body);
    const hasContent = options.includeCards || options.includeWhatsApp || options.includeBackgrounds || options.includeMetadata;
    if (!hasContent) {
      return res.status(400).json({ error: "Nenhum conteúdo selecionado para download." });
    }

    const catalogDir = findJobCatalogDir(getCatalogDir(), id);
    if (!catalogDir) {
      return res.status(404).json({ error: "Lote não encontrado." });
    }
    const storageProvider = createStorageProvider({ baseDir: catalogDir });
    const result = await buildBatchZip({ catalogDir, jobId: id, options, storageProvider });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("Content-Length", result.buffer.length);
    res.setHeader("X-Download-Report", encodeURIComponent(JSON.stringify(result.report)));
    res.end(result.buffer);
  } catch (err) {
    console.error("Erro ao gerar ZIP de lote:", err.message);
    if (res.headersSent) return;
    const status = err.message?.includes("não encontrado") ? 400 : 500;
    res.status(status).json({ error: err.message || "Erro interno ao gerar ZIP." });
  }
});

module.exports = router;
