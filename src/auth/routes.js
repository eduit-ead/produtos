/**
 * Rotas públicas de autenticação: /api/auth/*
 */

const express = require("express");
const cookie = require("cookie");
const signature = require("cookie-signature");
const {
  authDisabled,
  accessPassword,
  sessionSecret,
  isProduction,
  cookieName,
} = require("./config");
const { checkRateLimit, isAuthenticated } = require("./middleware");

const router = express.Router();

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60; // 24h

function buildSessionCookie(req, value) {
  const signed = signature.sign(JSON.stringify(value), sessionSecret);
  const secure = isProduction && req.secure === true;

  return cookie.serialize(cookieName, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}

function clearSessionCookie() {
  return cookie.serialize(cookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    expires: new Date(0),
    path: "/",
  });
}

// POST /api/auth/login
router.post("/login", express.json(), (req, res) => {
  if (authDisabled) {
    return res.json({ ok: true, disabled: true });
  }

  const ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown";
  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({
      error: "Muitas tentativas. Tente novamente mais tarde.",
      retryAfter: limit.retryAfter,
    });
  }

  const { password } = req.body || {};
  if (password !== accessPassword) {
    return res.status(401).json({ error: "Senha incorreta." });
  }

  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const session = { authenticated: true, expiresAt };
  res.setHeader("Set-Cookie", buildSessionCookie(req, session));
  return res.json({ ok: true });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", (req, res) => {
  if (authDisabled) {
    return res.json({ authenticated: true, disabled: true });
  }
  if (isAuthenticated(req)) {
    return res.json({ authenticated: true });
  }
  return res.status(401).json({ error: "Não autenticado." });
});

// GET /api/auth/status (público)
router.get("/status", (req, res) => {
  res.json({ enabled: !authDisabled });
});

module.exports = router;
