/**
 * Aponta o fontconfig do Sharp para as fontes Inter versionadas no repositório.
 * Precisa rodar antes do primeiro require("sharp").
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const FONTS_DIR = path.join(__dirname, "..", "..", "..", "assets", "fonts");

function confProvidesInter(confPath) {
  if (!confPath || !fs.existsSync(confPath)) return false;
  const text = fs.readFileSync(confPath, "utf8");
  const dirs = [...text.matchAll(/<dir\b[^>]*>([^<]+)<\/dir>/g)];
  return dirs.some((match) => {
    const raw = match[1].trim();
    const relative = /prefix="relative"/.test(match[0]);
    const dir = path.isAbsolute(raw) || !relative
      ? (path.isAbsolute(raw) ? raw : path.resolve(path.dirname(confPath), raw))
      : path.resolve(path.dirname(confPath), raw);
    return fs.existsSync(path.join(dir, "Inter-Black.ttf"));
  });
}

function ensurePosFontconfig() {
  if (confProvidesInter(process.env.FONTCONFIG_FILE)) return process.env.FONTCONFIG_FILE;
  if (!fs.existsSync(path.join(FONTS_DIR, "Inter-Black.ttf"))) {
    throw new Error(`Fonte Inter Black não encontrada em ${FONTS_DIR}.`);
  }
  const cacheDir = path.join(os.tmpdir(), "bwipoart-fontconfig");
  fs.mkdirSync(cacheDir, { recursive: true });
  const confPath = path.join(cacheDir, "fonts.conf");
  const xml = `<?xml version="1.0"?>
<fontconfig>
  <dir>${FONTS_DIR}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
  if (!fs.existsSync(confPath) || fs.readFileSync(confPath, "utf8") !== xml) {
    fs.writeFileSync(confPath, xml);
  }
  process.env.FONTCONFIG_FILE = confPath;
  return confPath;
}

module.exports = { ensurePosFontconfig, FONTS_DIR };
