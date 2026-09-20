const fs = require("fs");
const sharp = require("sharp");

const dir = "data/assets";
fs.mkdirSync(dir, { recursive: true });

(async () => {
  await sharp({
    create: { width: 1080, height: 1080, channels: 3, background: "#2563eb" },
  })
    .jpeg({ quality: 90 })
    .toFile(`${dir}/demo-bg.jpg`);

  const overlaySvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#g)"/>
</svg>`;

  await sharp({
    create: { width: 1080, height: 1080, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: Buffer.from(overlaySvg), left: 0, top: 0 }])
    .png()
    .toFile(`${dir}/demo-overlay.png`);

  console.log("Assets criados em", dir);
})();
