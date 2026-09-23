/**
 * Cache local de imagens externas indicadas na planilha.
 * Normaliza URLs e realiza download com retry.
 */

const fs = require("fs");
const path = require("path");
const { RUNTIME } = require("./config/runtime");

const CACHE_DIR = RUNTIME.cacheDir;

const DOWNLOAD_TIMEOUT_MS = 60000;
const DOWNLOAD_RETRIES = 3;
const IMAGE_CONTENT_TYPES = [
  "image/",
  "application/octet-stream",
];

function cleanUrl(value = "") {
  let url = String(value || "").trim();
  if (!url) return "";

  // Caso o Excel tenha algo tipo:
  // [https://site.com/img.png](https://site.com/img.png)
  const markdownMatch = url.match(/\((https?:\/\/[^)]+)\)/);
  if (markdownMatch) {
    url = markdownMatch[1];
  }

  return url;
}

function getCacheFile(url) {
  const hash = Buffer.from(url).toString("base64url");
  return path.join(CACHE_DIR, `${hash}.cache.png`);
}

async function downloadImage(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cacheFile = getCacheFile(url);

  if (fs.existsSync(cacheFile)) {
    return {
      buffer: fs.readFileSync(cacheFile),
      finalUrl: url,
      fromCache: true,
    };
  }

  let lastError;
  let finalUrl = url;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          Referer: "https://www.google.com/",
        },
      });

      clearTimeout(timeoutId);

      finalUrl = response.url || url;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} - ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      const isImage = IMAGE_CONTENT_TYPES.some((prefix) =>
        contentType.toLowerCase().includes(prefix)
      );

      if (!isImage) {
        throw new Error(`Content-Type inválido (${contentType || "vazio"})`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      fs.writeFileSync(cacheFile, buffer);

      return {
        buffer,
        finalUrl,
        fromCache: false,
      };
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(`Download falhou após ${DOWNLOAD_RETRIES} tentativas: ${lastError.message}`);
}

async function getImageBuffer(url) {
  const cleaned = cleanUrl(url);
  if (!cleaned) {
    throw new Error("URL de imagem inválida.");
  }

  // Suporte a caminhos locais absolutos ou file://, útil para testes e assets internos.
  if (cleaned.startsWith("file://")) {
    const filePath = cleaned.slice(7);
    if (!fs.existsSync(filePath)) throw new Error(`Arquivo local não encontrado: ${filePath}`);
    return fs.readFileSync(filePath);
  }
  if (path.isAbsolute(cleaned)) {
    if (!fs.existsSync(cleaned)) throw new Error(`Arquivo local não encontrado: ${cleaned}`);
    return fs.readFileSync(cleaned);
  }

  const result = await downloadImage(cleaned);
  return result.buffer;
}

module.exports = {
  cleanUrl,
  getCacheFile,
  downloadImage,
  getImageBuffer,
  CACHE_DIR,
};
