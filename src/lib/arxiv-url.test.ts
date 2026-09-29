import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UnsupportedUrlError,
  parseArxivUrl,
  parsePaperUrl,
  validatePaperUrl,
} from "./arxivUrl";

describe("parseArxivUrl", () => {
  it("parses abs urls", () => {
    const p = parseArxivUrl("https://arxiv.org/abs/2307.08691");
    assert.equal(p.arxivId, "2307.08691");
    assert.equal(
      p.ar5ivHtml,
      "https://ar5iv.labs.arxiv.org/html/2307.08691",
    );
  });

  it("strips version and pdf suffix", () => {
    const p = parseArxivUrl("https://arxiv.org/pdf/2307.08691v2.pdf");
    assert.equal(p.arxivId, "2307.08691");
    assert.equal(p.arxivIdRaw, "2307.08691v2");
  });

  it("parses ar5iv html urls", () => {
    const p = parseArxivUrl(
      "https://ar5iv.labs.arxiv.org/html/1706.03762",
    );
    assert.equal(p.arxivId, "1706.03762");
  });

  it("rejects empty", () => {
    assert.throws(() => parseArxivUrl(""), UnsupportedUrlError);
  });
});

describe("parsePaperUrl / validatePaperUrl", () => {
  it("maps to client shape", () => {
    const p = parsePaperUrl("arxiv.org/abs/2307.08691");
    assert.equal(p.arxivId, "2307.08691");
  });

  it("validate ok/fail", () => {
    assert.equal(validatePaperUrl("https://arxiv.org/abs/1").ok, false);
    assert.equal(
      validatePaperUrl("https://arxiv.org/abs/2307.08691").ok,
      true,
    );
  });
});
