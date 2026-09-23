/**
 * Servidor do editor de templates, catálogo de imagens e produção em lote.
 *
 * Comando:
 *   npm run template:editor
 */

// Carrega variáveis de ambiente ANTES de qualquer módulo que leia process.env.
require("dotenv").config();

const path = require("path");
const express = require("express");
const { seedRuntimeDefaults } = require("../config/seed");
const { validateAuthConfig, authDisabled } = require("../auth/config");
const authRoutes = require("../auth/routes");
const { requireAuth, isAuthenticated } = require("../auth/middleware");
const { createRouter } = require("./api");
const { createMigrationRouter } = require("../migration/routes");
const { createDatabaseRouter } = require("../db/routes");
const { closeDatabase } = require("../db/postgres");

// Garante diretórios de runtime e copia defaults quando em volume externo.
seedRuntimeDefaults();

// Em produção, recusa iniciar se autentação não estiver configurada.
validateAuthConfig();

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

function setNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

function isProtectedPage(pagePath) {
  if (pagePath === "/") return true;
  if (!pagePath.endsWith(".html")) return false;
  return path.basename(pagePath) !== "login.html";
}

function protectPages(req, res, next) {
  if (authDisabled) return next();
  if (!isProtectedPage(req.path)) return next();

  if (!isAuthenticated(req)) {
    setNoStoreHeaders(res);
    return res.redirect("/login.html");
  }

  setNoStoreHeaders(res);
  next();
}

// Necessário para req.secure funcionar atrás de proxies/reverse-proxies.
app.set("trust proxy", true);

// Rotas públicas de autenticação (sem cache).
app.use("/api/auth", (req, res, next) => {
  setNoStoreHeaders(res);
  next();
});
app.use("/api/auth", authRoutes);

// Protege a API, exceto health e auth.
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/auth/")) {
    return next();
  }
  requireAuth(req, res, next);
});

app.use("/api/admin/migration", createMigrationRouter());
app.use("/api/admin/database", createDatabaseRouter());
app.use("/api", createRouter());

// Protege páginas HTML antes de servir estáticos.
app.use(protectPages);
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html") && path.basename(filePath) !== "login.html") {
        setNoStoreHeaders(res);
      }
    },
  })
);

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address?.port || PORT;
  console.log(`Produção Visual rodando em http://${HOST}:${actualPort}`);
});

function shutdown() {
  server.close(() => {
    closeDatabase().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
