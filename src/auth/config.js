/**
 * Configuração de autenticação do editor de templates.
 *
 * Variáveis de ambiente:
 *   - AUTH_DISABLED="true"       desativa autenticação
 *   - APP_ACCESS_PASSWORD        senha de acesso principal
 *   - APP_MKT_ACCESS_PASSWORD    senha de acesso adicional, opcional
 *   - APP_SESSION_SECRET         segredo para assinar cookies
 *   - NODE_ENV=production        ativa validação estrita
 */

const crypto = require("crypto");

const authDisabled = process.env.AUTH_DISABLED === "true";
const accessPassword = process.env.APP_ACCESS_PASSWORD;
const mktAccessPassword = process.env.APP_MKT_ACCESS_PASSWORD;
const sessionSecret = process.env.APP_SESSION_SECRET;
const isProduction = process.env.NODE_ENV === "production";

const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

function isConfiguredSecret(value) {
  return typeof value === "string" && value.length > 0;
}

function secretsEqual(input, expected) {
  const left = crypto.createHash("sha256").update(typeof input === "string" ? input : "", "utf8").digest();
  const right = crypto.createHash("sha256").update(isConfiguredSecret(expected) ? expected : "\0", "utf8").digest();
  const same = crypto.timingSafeEqual(left, right);
  return isConfiguredSecret(expected) && same;
}

function passwordAccepted(input) {
  const primary = secretsEqual(input, accessPassword);
  const secondary = secretsEqual(input, mktAccessPassword);
  return primary || secondary;
}

function validateAuthConfig() {
  if (authDisabled) return;
  if (!isProduction) return;

  if (!accessPassword || accessPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `APP_ACCESS_PASSWORD ausente ou muito curto (mínimo ${MIN_PASSWORD_LENGTH} caracteres).`
    );
  }

  if (isConfiguredSecret(mktAccessPassword) && mktAccessPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `APP_MKT_ACCESS_PASSWORD muito curto (mínimo ${MIN_PASSWORD_LENGTH} caracteres).`
    );
  }

  if (!sessionSecret || sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `APP_SESSION_SECRET ausente ou muito curto (mínimo ${MIN_SECRET_LENGTH} caracteres).`
    );
  }
}

module.exports = {
  authDisabled,
  accessPassword,
  sessionSecret,
  isProduction,
  validateAuthConfig,
  passwordAccepted,
  cookieName: "produtos_session",
};
