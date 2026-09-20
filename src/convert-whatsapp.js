const fs = require("fs");
const path = require("path");
const { convertCardToWhatsAppJpeg } = require("./whatsapp-image");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "output", "final");
const OUTPUT_DIR = path.join(ROOT, "output", "whatsapp");

async function convertPngToJpeg(inputFile, outputFile) {
  const buffer = await convertCardToWhatsAppJpeg(fs.readFileSync(inputFile));
  fs.writeFileSync(outputFile, buffer);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function parseSlugArg(args) {
  const prefix = "--slug=";
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

async function convertSingle(slug) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const inputFile = path.join(SOURCE_DIR, `${slug}.png`);
  const outputFile = path.join(OUTPUT_DIR, `${slug}.jpg`);

  if (!fs.existsSync(inputFile)) {
    console.error(`PNG não encontrado: ${inputFile}`);
    process.exit(1);
  }

  const originalSize = fs.statSync(inputFile).size;

  await convertPngToJpeg(inputFile, outputFile);

  const optimizedSize = fs.statSync(outputFile).size;
  const reduction =
    originalSize > 0
      ? ((originalSize - optimizedSize) / originalSize) * 100
      : 0;

  console.log(
    `${slug}.jpg ✓ ${formatBytes(originalSize)} → ${formatBytes(optimizedSize)} ` +
      `(${reduction.toFixed(1)}% menor)`
  );
}

async function convertAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = fs
    .readdirSync(SOURCE_DIR)
    .filter((file) => file.endsWith(".png"))
    .sort();

  console.log(`PNG encontrados: ${files.length}`);
  console.log("");

  const results = [];
  let totalOriginal = 0;
  let totalOptimized = 0;
  let converted = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const slug = path.basename(file, ".png");
    const inputFile = path.join(SOURCE_DIR, file);
    const outputFile = path.join(OUTPUT_DIR, `${slug}.jpg`);

    const originalSize = fs.statSync(inputFile).size;

    try {
      await convertPngToJpeg(inputFile, outputFile);
      const optimizedSize = fs.statSync(outputFile).size;

      const reduction =
        originalSize > 0
          ? ((originalSize - optimizedSize) / originalSize) * 100
          : 0;

      totalOriginal += originalSize;
      totalOptimized += optimizedSize;
      converted++;

      results.push({
        arquivo: `${slug}.jpg`,
        tamanho_original_bytes: originalSize,
        tamanho_otimizado_bytes: optimizedSize,
        reducao_percentual: parseFloat(reduction.toFixed(2)),
      });

      console.log(
        `[${i + 1}/${files.length}] ${slug}.jpg ` +
          `✓ ${formatBytes(originalSize)} → ${formatBytes(optimizedSize)} ` +
          `(${reduction.toFixed(1)}% menor)`
      );
    } catch (error) {
      console.error(
        `[${i + 1}/${files.length}] ${slug}.jpg ✗ ${error.message}`
      );

      results.push({
        arquivo: `${slug}.jpg`,
        tamanho_original_bytes: originalSize,
        tamanho_otimizado_bytes: 0,
        reducao_percentual: 0,
        erro: error.message,
      });
    }
  }

  const sizes = results
    .filter((r) => r.tamanho_otimizado_bytes > 0)
    .map((r) => r.tamanho_otimizado_bytes);

  const maxJpg = sizes.length > 0 ? Math.max(...sizes) : 0;
  const minJpg = sizes.length > 0 ? Math.min(...sizes) : 0;
  const avgJpg =
    sizes.length > 0
      ? sizes.reduce((a, b) => a + b, 0) / sizes.length
      : 0;

  const totalReduction =
    totalOriginal > 0
      ? ((totalOriginal - totalOptimized) / totalOriginal) * 100
      : 0;

  const summary = {
    quantidade_convertida: converted,
    quantidade_total: files.length,
    tamanho_total_pngs_bytes: totalOriginal,
    tamanho_total_pngs_formatado: formatBytes(totalOriginal),
    tamanho_total_jpgs_bytes: totalOptimized,
    tamanho_total_jpgs_formatado: formatBytes(totalOptimized),
    reducao_percentual_total: parseFloat(totalReduction.toFixed(2)),
    maior_jpg_bytes: maxJpg,
    maior_jpg_formatado: formatBytes(maxJpg),
    menor_jpg_bytes: minJpg,
    menor_jpg_formatado: formatBytes(minJpg),
    media_tamanho_jpg_bytes: Math.round(avgJpg),
    media_tamanho_jpg_formatado: formatBytes(avgJpg),
  };

  const report = {
    gerado_em: new Date().toISOString(),
    resumo: summary,
    arquivos: results,
  };

  const reportPath = path.join(OUTPUT_DIR, "relatorio.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log("");
  console.log("================================");
  console.log("CONVERSÃO FINALIZADA");
  console.log("================================");
  console.log(`Convertidos: ${summary.quantidade_convertida}/${summary.quantidade_total}`);
  console.log(`Total PNGs: ${summary.tamanho_total_pngs_formatado}`);
  console.log(`Total JPGs: ${summary.tamanho_total_jpgs_formatado}`);
  console.log(`Redução total: ${summary.reducao_percentual_total}%`);
  console.log(`Maior JPG: ${summary.maior_jpg_formatado}`);
  console.log(`Menor JPG: ${summary.menor_jpg_formatado}`);
  console.log(`Média JPG: ${summary.media_tamanho_jpg_formatado}`);
  console.log("");
  console.log(`Relatório: ${reportPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const slug = parseSlugArg(args);

  if (slug) {
    await convertSingle(slug);
    return;
  }

  await convertAll();
}

main().catch((error) => {
  console.error("ERRO FATAL:", error);
  process.exit(1);
});
