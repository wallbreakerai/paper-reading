import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compactMathText,
  mathAliases,
  recoverZhEmbedTokens,
} from "./zh-embed-recover";

describe("zh-embed-recover", () => {
  it("compacts spaced MathML plain text", () => {
    assert.equal(compactMathText("C ^ c ​ ( 𝐫 )"), "C^c​(𝐫)");
    assert.equal(compactMathText("c i"), "ci");
  });

  it("recovers NeRF-style plain+tex duplication", () => {
    // Include U+200B like real MathML plain text / model output.
    const zw = "\u200b";
    const embeds = [
      {
        id: "m3",
        html:
          `<math alttext="\\hat{C}_{c}(\\mathbf{r})"><mi>C</mi><mo>^</mo><mi>c</mi><mo>${zw}</mo><mo>(</mo><mi>𝐫</mi><mo>)</mo></math>`,
      },
      {
        id: "m4",
        html: '<a href="#S4.E3">3</a>',
      },
      {
        id: "m5",
        html: '<math alttext="c_{i}"><mi>c</mi><mi>i</mi></math>',
      },
    ];
    const zh =
      `为此，我们首先将公式 3 中来自粗糙网络的 Alpha 合成颜色 C^c${zw}(𝐫)\\hat{C}_{c}(\\mathbf{r}) 重写为沿射线所有采样颜色 cic_{i} 的加权和：`;
    const out = recoverZhEmbedTokens(zh, embeds);
    assert.match(out, /⟦M3⟧/);
    assert.match(out, /⟦M5⟧/);
    assert.match(out, /⟦M4⟧/);
    assert.doesNotMatch(out, /\\hat\{C\}/);
    assert.doesNotMatch(out, /c_\{\s*i\s*\}/);
    assert.doesNotMatch(out, /cic_/);
    assert.doesNotMatch(out, /C\^c/);
  });

  it("builds compact aliases from spaced plain", () => {
    const aliases = mathAliases(
      '<math alttext="c_{i}"><mi>c</mi><mi>i</mi></math>',
    );
    assert.ok(aliases.includes("c_{i}"));
    assert.ok(aliases.includes("ci"));
  });
});
