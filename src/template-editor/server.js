/**
 * Servidor do editor de templates, catálogo de imagens e produção em lote.
 *
 * Comando:
 *   npm run template:editor
 */

const path = require("path");
const express = require("express");
const { seedRuntimeDefaults } = require("../config/seed");
const { validateAuthConfig } = require("../auth/config");
const authRoutes = require("../auth/routes");
const { requireAuth } = require("../auth/middleware");
const { createRouter } = require("./api");

// Garante diretórios de runtime e copia defaults quando em volume externo.
seedRuntimeDefaults();

// Em produção, recusa iniciar se autentação não estiver configurada.
validateAuthConfig();

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

// Necessário para req.secure funcionar atrás de proxies/reverse-proxies.
app.set("trust proxy", true);

// Rotas públicas de autenticação.
app.use("/api/auth", authRoutes);

// Protege a API, exceto health e auth.
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/auth/")) {
    return next();
  }
  requireAuth(req, res, next);
});

app.use("/api", createRouter());
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address?.port || PORT;
  console.log(`Produção Visual rodando em http://${HOST}:${actualPort}`);
});
