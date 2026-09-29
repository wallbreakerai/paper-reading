import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getLlm, llmConfigured, settingsPublic } from "./settings";

describe("settings", () => {
  it("returns llm shape from env", () => {
    const llm = getLlm();
    assert.equal(typeof llm.apiBase, "string");
    assert.equal(typeof llm.apiKey, "string");
    assert.equal(typeof llm.model, "string");
    assert.equal(llm.source, "env");
    assert.equal(typeof llmConfigured(), "boolean");
  });

  it("settingsPublic masks key", () => {
    const pub = settingsPublic();
    assert.ok(typeof pub.libraryDir === "string");
    assert.equal(typeof pub.llm.configured, "boolean");
    assert.equal(typeof pub.llm.apiKeyMasked, "string");
  });
});
