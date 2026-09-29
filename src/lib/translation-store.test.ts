import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emptyTranslation,
  loadTranslationFile,
  mergeSectionTranslation,
  pendingSections,
} from "./translation-store";

describe("translation-store", () => {
  it("empty shape", () => {
    assert.deepEqual(emptyTranslation(), {
      version: 1,
      completedSections: [],
      sentences: {},
    });
  });

  it("treats legacy blocks as empty", () => {
    const tr = loadTranslationFile(
      JSON.stringify({ blocks: { a: { zh: "x" } } }),
    );
    assert.deepEqual(tr.sentences, {});
  });

  it("merges section and pending", () => {
    let tr = emptyTranslation();
    tr = mergeSectionTranslation(tr, "s1", { a: "甲", b: "乙" });
    assert.deepEqual(tr.completedSections, ["s1"]);
    assert.equal(tr.sentences!.a, "甲");
    const pending = pendingSections(
      {
        version: 1,
        title: "t",
        sections: [
          { id: "s1", level: 1, sentences: [] },
          { id: "s2", level: 1, sentences: [] },
        ],
      },
      tr,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, "s2");
  });
});
