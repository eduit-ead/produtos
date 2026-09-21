/**
 * Middleware de autenticação baseado em cookie assinado.
 */

const cookie = require("cookie");
const signature = require("cookie-signature");
const { authDisabled, sessionSecret, cookieName } = require("./config");

// Rate limit simples em memória para tentativas de login.
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000; // 5 minutos
const MAX_ATTEMPTS = 10;

function getClientIp(req) {
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/**
 * Verifica e atualiza o rate limit para um IP.
 * Retorna { allowed: true, remaining } ou { allowed: false, retryAfter }.
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record) {
    attempts.set(ip, {
      count: 1,
      resetAt: now + WINDOW_MS,
      blockedUntil: 0,
    });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  if (record.blockedUntil > now) {
    return {
      allowed: false,
      retryAfter: Math.ceil((record.blockedUntil - now) / 1000),
    };
  }

  if (record.resetAt <= now) {
    attempts.set(ip, {
      count: 1,
      resetAt: now + WINDOW_MS,
      blockedUntil: 0,
    });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    record.blockedUntil = now + WINDOW_MS;
    return {
      allowed: false,
      retryAfter: Math.ceil(WINDOW_MS / 1000),
    };
  }

  return { allowed: true, remaining: Math.max(0, MAX_ATTEMPTS - record.count) };
}

function readSessionCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;

  const parsed = cookie.parse(raw);
  const signed = parsed[cookieName];
  if (!signed) return null;

  const unsigned = signature.unsign(signed, sessionSecret);
  if (unsigned === false) return null;

  try {
    return JSON.parse(unsigned);
  } catch {
    return null;
  }
}

function isAuthenticated(req) {
  if (authDisabled) return true;
  const session = readSessionCookie(req);
  return !!(
    session &&
    session.authenticated === true &&
    session.expiresAt > Date.now()
  );
}

function requireAuth(req, res, next) {
  if (authDisabled) return next();
  if (isAuthenticated(req)) return next();

  const wantsJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes("application/json")) ||
    req.path.startsWith("/api/");

  if (wantsJson) {
    return res.status(401).json({ error: "Não autenticado." });
  }

  // Para navegação, deixa o frontend redirecionar para a tela de login.
  return res
    .status(401)
    .send('Não autenticado. <a href="/login.html">Fazer login</a>');
}

module.exports = {
  requireAuth,
  isAuthenticated,
  checkRateLimit,
  readSessionCookie,
};
