import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { titleSlug } from "./library";
import { parseAr5ivHtml } from "./parser";

describe("parseAr5ivHtml title extraction", () => {
  it("extracts real title text (not [object Object])", () => {
    const html = `<!doctype html><html><body><article>
      <h1 class="ltx_title ltx_title_document">Hello World Paper</h1>
      <div class="ltx_authors"><span class="ltx_personname">Ada Lovelace</span></div>
      <h2 class="ltx_title ltx_title_section">Introduction</h2>
    </article></body></html>`;
    const { title, authors, blocks } = parseAr5ivHtml(html);
    assert.equal(title, "Hello World Paper");
    assert.deepEqual(authors, ["Ada Lovelace"]);
    assert.ok(blocks.some((b) => b.type === "heading" && b.text === "Introduction"));
    assert.notEqual(titleSlug(title), "object_Object");
    assert.equal(titleSlug(title), "Hello_World_Paper");
  });
});
