/**
 * Servidor local do editor de templates e do catálogo de imagens.
 *
 * Comando:
 *   npm run template:editor
 */

const path = require("path");
const express = require("express");
const { createRouter } = require("./api");

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

app.use("/api", createRouter());
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Editor de templates rodando em http://${HOST}:${PORT}`);
});
