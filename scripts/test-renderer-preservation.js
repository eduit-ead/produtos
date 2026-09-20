const assert = require("assert");
const sharp = require("sharp");
const { wrapText, fitText } = require("../src/template-editor/renderer/utils");
const { renderTextLayer } = require("../src/template-editor/renderer/text-layer");

const longTitle =
  "Análise e Desenvolvimento de Sistemas para Aplicações Empresariais";

// wrapText must preserve every word and explicit line breaks.
const wrapped = wrapText(longTitle, 20);
assert.strictEqual(
  wrapped.join(" ").replace(/\s+/g, " ").trim(),
  longTitle,
  "wrapText should not discard words"
);
assert.deepStrictEqual(
  wrapText("one\ntwo three\nfour", 10),
  ["one", "two three", "four"],
  "wrapText should support explicit line breaks"
);

// fitText in shrink (non-truncating) mode must keep all content.
const fitted = fitText(longTitle, 16, 200, 1000, 1.2, 1, { truncate: false });
const joined = fitted.join(" ");
assert(joined.includes("Análise"), "fitText should preserve the start of the text");
assert(joined.includes("Empresariais"), "fitText should preserve the end of the text");
assert(!joined.includes("…"), "fitText should not add ellipsis when truncation is disabled");

// Render a long title in a tiny layer with autoFit shrink. Even when it cannot
// fit at minFontSize, all content must remain visible (SVG expands, no clip).
(async () => {
  const layer = {
    type: "text",
    name: "Título preservado",
    x: 0,
    y: 0,
    width: 200,
    height: 10,
    rotation: 0,
    opacity: 1,
    visible: true,
    zIndex: 1,
    properties: {
      text: longTitle,
      fontFamily: "Arial",
      fontSize: 48,
      fontWeight: 400,
      fill: "#000000",
      align: "left",
      verticalAlign: "top",
      lineHeight: 1.2,
      letterSpacing: 0,
      autoFit: true,
      minFontSize: 8,
      padding: 0,
      maxLines: 1,
      overflow: "shrink",
    },
  };

  const buffer = await renderTextLayer(layer, {});
  const meta = await sharp(buffer).metadata();

  assert.strictEqual(meta.width, layer.width, "rendered width should match layer width");
  assert(
    meta.height > layer.height,
    "rendered height should expand to keep all content visible"
  );

  console.log("All renderer preservation tests passed");
})();
