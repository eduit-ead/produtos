/**
 * Testes de autenticação e status do sistema.
 *
 * Valida login/logout, proteção de API e health público.
 */

const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const express = require("express");

function resetAuthModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`src${path.sep}auth`) || key.includes(`src${path.sep}template-editor${path.sep}system-status`)) {
      delete require.cache[key];
    }
  }
}

function buildApp(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAuthModules();

  const { validateAuthConfig } = require("../src/auth/config");
  validateAuthConfig();

  const authRoutes = require("../src/auth/routes");
  const { requireAuth } = require("../src/auth/middleware");
  const { createRouter } = require("../src/template-editor/api");

  const app = express();
  app.set("trust proxy", true);
  app.use("/api/auth", authRoutes);
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
    requireAuth(req, res, next);
  });
  app.use("/api", createRouter());
  return app;
}

function requestRaw(app, method, path, body, cookie = "") {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const headers = {};
      if (typeof body === "string") headers["Content-Type"] = "application/json";
      if (cookie) headers["Cookie"] = cookie;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            server.close(() => {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
              });
            });
          });
        }
      );
      req.on("error", (err) => server.close(() => reject(err)));
      if (body) req.write(body);
      req.end();
    });
  });
}

(async () => {
  // 1. Com autenticação desabilitada, a API fica aberta.
  const disabledApp = buildApp({ AUTH_DISABLED: "true" });
  const statusDisabled = await requestRaw(disabledApp, "GET", "/api/auth/status");
  assert.equal(statusDisabled.status, 200);
  assert.equal(JSON.parse(statusDisabled.body).enabled, false);

  const openRes = await requestRaw(disabledApp, "GET", "/api/collections");
  assert.equal(openRes.status, 200, "API deve estar aberta com AUTH_DISABLED=true");

  // 2. Health permanece público mesmo com auth ativa.
  const enabledApp = buildApp({
    AUTH_DISABLED: "false",
    APP_ACCESS_PASSWORD: "senha-forte-1234",
    APP_SESSION_SECRET: "segredo-de-no-minimo-32-caracteres-xxxx",
  });
  const health = await requestRaw(enabledApp, "GET", "/api/health");
  assert.equal(health.status, 200, "health deve ser público");
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.authActive, true);
  assert.ok(!healthBody.runtimeDir.includes("segredo"), "health não deve vazar segredos");

  // 3. API não autenticada retorna 401.
  const blocked = await requestRaw(enabledApp, "GET", "/api/collections");
  assert.equal(blocked.status, 401, "API deve exigir autenticação");

  // 4. Login com senha errada falha.
  const wrongLogin = await requestRaw(
    enabledApp,
    "POST",
    "/api/auth/login",
    JSON.stringify({ password: "errada" })
  );
  assert.equal(wrongLogin.status, 401);

  // 5. Login correto retorna cookie e permite acesso.
  const login = await requestRaw(
    enabledApp,
    "POST",
    "/api/auth/login",
    JSON.stringify({ password: "senha-forte-1234" })
  );
  assert.equal(login.status, 200);
  const setCookie = login.headers["set-cookie"];
  assert.ok(setCookie && setCookie.length > 0, "deve definir cookie de sessão");
  assert.ok(setCookie[0].includes("HttpOnly"), "cookie deve ser HttpOnly");

  const protectedOk = await requestRaw(enabledApp, "GET", "/api/collections", null, setCookie[0]);
  assert.equal(protectedOk.status, 200, "requisição autenticada deve passar");

  // 6. Logout invalida a sessão.
  const logout = await requestRaw(enabledApp, "POST", "/api/auth/logout", null, setCookie[0]);
  assert.equal(logout.status, 200);
  const clearedCookie = logout.headers["set-cookie"];
  assert.ok(clearedCookie && /Expires=Thu, 01 Jan 1970/.test(clearedCookie[0]), "cookie deve ser limpo");

  // Após logout o cookie é limpo; enviá-lo novamente (como o navegador faria) recusa.
  const afterLogout = await requestRaw(enabledApp, "GET", "/api/collections", null, clearedCookie[0]);
  assert.equal(afterLogout.status, 401, "após logout a API deve recusar");

  // 7. Em produção, configuração ausente levanta erro.
  assert.throws(
    () => {
      for (const k of ["APP_ACCESS_PASSWORD", "APP_SESSION_SECRET", "AUTH_DISABLED"]) delete process.env[k];
      process.env.NODE_ENV = "production";
      resetAuthModules();
      const { validateAuthConfig } = require("../src/auth/config");
      validateAuthConfig();
    },
    /APP_ACCESS_PASSWORD|APP_SESSION_SECRET/
  );

  console.log("Auth OK: status, login/logout, 401 e validação de produção.");
})();
