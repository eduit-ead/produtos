/**
 * Verificação administrativa da conexão PostgreSQL.
 */

const express = require("express");
const { checkDatabase } = require("./postgres");

function createDatabaseRouter() {
  const router = express.Router();

  router.get("/status", async (req, res) => {
    const status = await checkDatabase();
    if (status.configured && !status.ok) {
      return res.status(503).json(status);
    }
    res.json(status);
  });

  return router;
}

module.exports = { createDatabaseRouter };
