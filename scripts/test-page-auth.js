/**
 * Testa proteção server-side das páginas HTML.
 *
 * Apenas /login.html, recursos do login, /api/health e /api/auth/* são públicos.
 * Páginas protegidas redirecionam para /login.html com Cache-Control: no-store.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");

const PASSWORD = "senha-segura-123";
const SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars

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

function startServer(runtimeDir, authDisabled = false) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      APP_RUNTIME_DIR: runtimeDir,
      AI_CATALOG_DIR: path.join(runtimeDir, "output", "ai-catalog"),
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_DISABLED: authDisabled ? "true" : "false",
      APP_ACCESS_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: SECRET,
    };
    const child = spawn(process.execPath, ["src/template-editor/server.js"], {
      cwd: path.resolve(__dirname, ".."),
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
    }, 15000);
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

function assertNoStore(headers) {
  const cc = headers["cache-control"] || "";
  assert.ok(cc.includes("no-store"), `esperado Cache-Control no-store, obtido: ${cc}`);
}

(async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "page-auth-"));

  const server = await startServer(runtimeDir, false);
  let cookies = {};
  try {
    const home = await request(server.port, "GET", "/");
    assert.equal(home.status, 302, "/ sem login deve redirecionar");
    assert.ok(home.headers.location?.includes("/login.html"), `deve redirecionar para login: ${home.headers.location}`);
    assertNoStore(home.headers);

    const criar = await request(server.port, "GET", "/criar.html");
    assert.equal(criar.status, 302, "/criar.html sem login deve redirecionar");
    assertNoStore(criar.headers);

    const batch = await request(server.port, "GET", "/batch.html");
    assert.equal(batch.status, 302, "/batch.html sem login deve redirecionar");

    const biblioteca = await request(server.port, "GET", "/biblioteca.html");
    assert.equal(biblioteca.status, 302, "/biblioteca.html sem login deve redirecionar");

    const loginPage = await request(server.port, "GET", "/login.html");
    assert.equal(loginPage.status, 200, "/login.html deve ser público");

    const loginJs = await request(server.port, "GET", "/login.js");
    assert.equal(loginJs.status, 200, "login.js deve ser público");

    const wrong = await request(server.port, "POST", "/api/auth/login", JSON.stringify({ password: "errada" }), {
      "Content-Type": "application/json",
    });
    assert.equal(wrong.status, 401, "senha errada deve retornar 401");
    assertNoStore(wrong.headers);

    const right = await request(server.port, "POST", "/api/auth/login", JSON.stringify({ password: PASSWORD }), {
      "Content-Type": "application/json",
    });
    assert.equal(right.status, 200, "senha correta deve autenticar");
    assertNoStore(right.headers);
    cookies = getCookies(right.headers["set-cookie"]);
    assert.ok(cookies.produtos_session, "deve definir cookie de sessão");

    const homeAuth = await request(server.port, "GET", "/", null, { Cookie: cookieHeader(cookies) });
    assert.equal(homeAuth.status, 200, "/ deve acessar após login");
    assertNoStore(homeAuth.headers);

    const criarAuth = await request(server.port, "GET", "/criar.html", null, { Cookie: cookieHeader(cookies) });
    assert.equal(criarAuth.status, 200, "/criar.html deve acessar após login");
    assertNoStore(criarAuth.headers);

    const logout = await request(server.port, "POST", "/api/auth/logout", null, { Cookie: cookieHeader(cookies) });
    assert.equal(logout.status, 200, "logout deve retornar 200");
    assertNoStore(logout.headers);

    const cleared = getCookies(logout.headers["set-cookie"]);
    assert.ok(!cleared.produtos_session || cleared.produtos_session === "", "cookie deve ser limpo");

    const homeAfterLogout = await request(server.port, "GET", "/", null, { Cookie: cookieHeader(cleared) });
    assert.equal(homeAfterLogout.status, 302, "/ deve exigir login após logout");
  } finally {
    await stopServer(server.child);
  }

  const disabledServer = await startServer(runtimeDir, true);
  try {
    const homeDisabled = await request(disabledServer.port, "GET", "/");
    assert.equal(homeDisabled.status, 200, "com AUTH_DISABLED / deve ser público");

    const criarDisabled = await request(disabledServer.port, "GET", "/criar.html");
    assert.equal(criarDisabled.status, 200, "com AUTH_DISABLED /criar.html deve ser público");
  } finally {
    await stopServer(disabledServer.child);
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log("Page auth OK: páginas protegidas, login público, no-store e AUTH_DISABLED funcionam.");
})();
