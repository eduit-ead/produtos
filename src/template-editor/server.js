/**
 * Servidor local do editor de templates.
 *
 * Comando:
 *   npm run template:editor
 */

const path = require("path");
const express = require("express");
const { createRouter } = require("./api");

const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_DIR = path.join(ROOT, "output");
const PORT = process.env.PORT || 3000;

const app = express();

app.use("/api", createRouter());
app.use(express.static(PUBLIC_DIR));
app.use("/output", express.static(OUTPUT_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Editor de templates rodando em http://127.0.0.1:${PORT}`);
});
