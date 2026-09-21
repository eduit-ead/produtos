/**
 * Configuração de autenticação do editor de templates.
 *
 * Variáveis de ambiente:
 *   - AUTH_DISABLED="true"      desativa autenticação
 *   - APP_ACCESS_PASSWORD        senha de acesso
 *   - APP_SESSION_SECRET         segredo para assinar cookies
 *   - NODE_ENV=production        ativa validação estrita
 */

const authDisabled = process.env.AUTH_DISABLED === "true";
const accessPassword = process.env.APP_ACCESS_PASSWORD;
const sessionSecret = process.env.APP_SESSION_SECRET;
const isProduction = process.env.NODE_ENV === "production";

const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

function validateAuthConfig() {
  if (authDisabled) return;
  if (!isProduction) return;

  if (!accessPassword || accessPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `APP_ACCESS_PASSWORD ausente ou muito curto (mínimo ${MIN_PASSWORD_LENGTH} caracteres).`
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
  cookieName: "produtos_session",
};
