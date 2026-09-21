/**
 * Testa que server.js carrega o .env ANTES de importar configurações.
 *
 * Inicia o entrypoint real a partir de um diretório temporário que contém
 * um arquivo .env, garantindo que AUTH_DISABLED e APP_RUNTIME_DIR sejam
 * respeitados.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

function request(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(cwd, runtimeDir, envLines) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, ".env"), envLines.join("\n"), "utf8");

  const env = { ...process.env };
  for (const key of [
    "AUTH_DISABLED",
    "APP_RUNTIME_DIR",
    "APP_ACCESS_PASSWORD",
    "APP_SESSION_SECRET",
    "PORT",
    "HOST",
  ]) {
    delete env[key];
  }

  return new Promise((resolve, reject) => {
    const serverScript = path.resolve(__dirname, "..", "src", "template-editor", "server.js");
    const child = spawn(process.execPath, [serverScript], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    function onData(data) {
      output += data.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && child) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve({ child, port: parseInt(match[1], 10) });
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Servidor saiu com código ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout iniciando servidor. Output: ${output}`));
    }, 20000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.kill();
    child.on("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

function getCookies(setCookieHeader) {
  if (!setCookieHeader) return {};
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const cookies = {};
  for (const c of arr) {
    const [kv] = c.split(";");
    const [k, v] = kv.trim().split("=");
    if (k) cookies[k] = v;
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-"));

  // 1. AUTH_DISABLED=true com runtime temporário.
  const runtimeDisabled = path.join(baseDir, "runtime-disabled");
  const cwdDisabled = path.join(baseDir, "cwd-disabled");
  const envDisabled = [
    "AUTH_DISABLED=true",
    `APP_RUNTIME_DIR=${runtimeDisabled}`,
    "PORT=0",
    "HOST=127.0.0.1",
  ];

  const server1 = await startServer(cwdDisabled, runtimeDisabled, envDisabled);
  try {
    const status = await request(server1.port, "GET", "/api/auth/status");
    assert.equal(status.status, 200, `/api/auth/status deve retornar 200`);
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.enabled, false, "AUTH_DISABLED=true deve desativar auth");

    const home = await request(server1.port, "GET", "/");
    assert.equal(home.status, 200, "/ deve abrir sem login quando auth está desativada");

    const templates = await request(server1.port, "GET", "/api/templates");
    assert.equal(templates.status, 200, "templates devem carregar");
    const templateList = JSON.parse(templates.body);
    assert.ok(templateList.some((t) => t.id === "demo"), "demo deve aparecer");
    assert.ok(templateList.some((t) => t.id === "cruzeiro-graduacao-v1"), "cruzeiro-graduacao-v1 deve aparecer");

    const collections = await request(server1.port, "GET", "/api/collections");
    assert.equal(collections.status, 200, "coleções devem carregar");
    const collectionList = JSON.parse(collections.body);
    assert.ok(collectionList.some((c) => c.id === "graduacao-cruzeiro"), "graduacao-cruzeiro deve aparecer");

    assert.ok(fs.existsSync(path.join(runtimeDisabled, "data", "templates", "demo.json")), "runtime temporário deve conter demo.json");
  } finally {
    await stopServer(server1.child);
  }

  // 2. AUTH_DISABLED=false com senha configurada.
  const runtimeProtected = path.join(baseDir, "runtime-protected");
  const cwdProtected = path.join(baseDir, "cwd-protected");
  const password = "senha-de-teste-123";
  const secret = "0123456789abcdef0123456789abcdef";
  const envProtected = [
    "AUTH_DISABLED=false",
    `APP_ACCESS_PASSWORD=${password}`,
    `APP_SESSION_SECRET=${secret}`,
    `APP_RUNTIME_DIR=${runtimeProtected}`,
    "PORT=0",
    "HOST=127.0.0.1",
  ];

  const server2 = await startServer(cwdProtected, runtimeProtected, envProtected);
  try {
    const status = await request(server2.port, "GET", "/api/auth/status");
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.enabled, true, "AUTH_DISABLED=false deve ativar auth");

    const home = await request(server2.port, "GET", "/");
    assert.equal(home.status, 302, "/ sem login deve redirecionar");
    assert.ok(home.headers.location?.includes("/login.html"), `deve redirecionar para login: ${home.headers.location}`);

    const wrong = await request(server2.port, "POST", "/api/auth/login", JSON.stringify({ password: "errada" }), {
      "Content-Type": "application/json",
    });
    assert.equal(wrong.status, 401, "senha errada deve retornar 401");

    const right = await request(server2.port, "POST", "/api/auth/login", JSON.stringify({ password }), {
      "Content-Type": "application/json",
    });
    assert.equal(right.status, 200, "senha correta deve autenticar");
    const cookies = getCookies(right.headers["set-cookie"]);
    assert.ok(cookies.produtos_session, "deve definir cookie de sessão");

    const homeAuth = await request(server2.port, "GET", "/", null, { Cookie: cookieHeader(cookies) });
    assert.equal(homeAuth.status, 200, "/ deve abrir após login");
  } finally {
    await stopServer(server2.child);
  }

  fs.rmSync(baseDir, { recursive: true, force: true });
  console.log("Server entrypoint OK: .env carregado antes da configuração, auth e runtime respeitados.");
})();
