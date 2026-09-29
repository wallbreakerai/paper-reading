import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTHORS_DETAIL_VERSION,
  STRUCTURE_VERSION,
  authorsDetailLooksStale,
  buildReadingStructure,
  ensureReadingStructure,
  extractAuthorsDetail,
  remapStructureIds,
  splitSentences,
  structureToOutline,
} from "./structure";

describe("splitSentences", () => {
  it("splits on .?! + capital", () => {
    assert.deepEqual(splitSentences("Hello world. How are you? Fine!"), [
      "Hello world.",
      "How are you?",
      "Fine!",
    ]);
  });

  it("keeps decimals intact", () => {
    const parts = splitSentences("We use 3.14 as pi. Next sentence.");
    assert.equal(parts.length, 2);
    assert.ok(parts[0]!.startsWith("We use 3.14"));
  });
});

describe("extractAuthorsDetail", () => {
  it("infers org from shared emails", () => {
    const html = `
    <html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Tri Dao</span>
      </span>
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Daniel Y. Fu</span>
      </span>
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Atri Rudra</span>
      </span>
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Christopher Ré</span>
        <span class="ltx_author_notes">
          <span class="ltx_contact ltx_role_affiliation">
            Affiliation:
            <span>{trid,danfu}@cs.stanford.edu</span>,
            <span>atri@buffalo.edu</span>,
            <span>chrismre@cs.stanford.edu</span>
          </span>
        </span>
      </span>
    </div></body></html>`;
    const detail = extractAuthorsDetail(html);
    const by = Object.fromEntries(detail.map((d) => [d.name, d.affiliation]));
    assert.equal(by["Tri Dao"], "Stanford University");
    assert.equal(by["Daniel Y. Fu"], "Stanford University");
    assert.equal(by["Atri Rudra"], "University at Buffalo");
    assert.equal(by["Christopher Ré"], "Stanford University");
  });

  it("keeps real institution text", () => {
    const html = `
    <html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Ada Lovelace</span>
        <span class="ltx_author_notes">
          <span class="ltx_affiliation">Department of Mathematics, University of London</span>
        </span>
      </span>
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Alan Turing</span>
        <span class="ltx_affiliation">University of Cambridge</span>
      </span>
    </div></body></html>`;
    const detail = extractAuthorsDetail(html);
    assert.equal(detail[0]!.name, "Ada Lovelace");
    assert.ok(detail[0]!.affiliation.includes("University of London"));
    assert.ok(!detail[0]!.affiliation.includes("Affiliation:"));
    assert.equal(detail[1]!.affiliation, "University of Cambridge");
  });
});

describe("authorsDetailLooksStale", () => {
  it("flags old authorsDetailVersion", () => {
    assert.equal(
      authorsDetailLooksStale([{ name: "A", affiliation: "MIT" }], {
        authorsDetailVersion: AUTHORS_DETAIL_VERSION - 1,
      }),
      true,
    );
  });
});

describe("buildReadingStructure", () => {
  it("builds sections, ids, prose, figure/caption", () => {
    const html = `
    <html><body><article>
      <h1 class="ltx_title ltx_title_document">Demo Paper</h1>
      <div class="ltx_authors"><span class="ltx_personname">Ada Lovelace</span></div>
      <h2 class="ltx_title ltx_title_abstract" id="abstract">Abstract</h2>
      <div class="ltx_abstract">
        <p>First claim. Second claim.</p>
      </div>
      <section id="S1" class="ltx_section">
        <h2 class="ltx_title ltx_title_section">1 Introduction</h2>
        <div class="ltx_para"><p>Alpha beta. Gamma delta?</p></div>
        <figure class="ltx_figure">
          <figcaption class="ltx_caption">Figure 1: A cat.</figcaption>
        </figure>
      </section>
    </article></body></html>`;
    const { structure, events } = buildReadingStructure(html);
    assert.equal(structure.title, "Demo Paper");
    assert.equal(structure.version, STRUCTURE_VERSION);
    assert.ok(structure.sections.length >= 2);
    const ids = structure.sections.map((s) => s.id);
    assert.equal(ids.length, new Set(ids).size);

    const allSentenceIds = structure.sections.flatMap((sec) =>
      sec.sentences.map((s) => s.id),
    );
    assert.equal(allSentenceIds.length, new Set(allSentenceIds).size);

    const abstract = structure.sections.find((s) =>
      s.sentences.some(
        (x) => x.kind === "heading" && (x.text || "").includes("Abstract"),
      ),
    )!;
    const prose = abstract.sentences.filter((x) => x.kind === "prose");
    assert.equal(prose.length, 2);
    assert.ok(!prose.some((p) => p.paraStart));
    assert.equal(
      abstract.sentences.filter((x) => x.kind === "spacer").length,
      0,
    );

    const intro = structure.sections.find((s) =>
      s.sentences.some((x) => (x.text || "").includes("Introduction")),
    )!;
    const kinds = intro.sentences.map((x) => x.kind);
    assert.ok(kinds.includes("heading"));
    assert.ok(kinds.includes("caption"));
    assert.ok(kinds.includes("figure"));
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.ok(done && done.type === "done");
    assert.equal(done.sections, structure.sections.length);

    const outline = structureToOutline(structure);
    assert.ok(outline.some((o) => o.text.includes("Abstract")));
  });

  it("does not treat ltx_para as ltx_p host", () => {
    const html = `
    <html><body><div class="ltx_document">
      <section class="ltx_paragraph">
        <div class="ltx_para">
          <p class="ltx_p">Intro sentence before the table.</p>
        </div>
        <figure class="ltx_table" id="T1">
          <figcaption class="ltx_caption">Table 1: Scores.</figcaption>
          <table class="ltx_tabular">
            <tr><td>Models</td><td>ListOps</td><td>Text</td></tr>
            <tr><td>Transformer</td><td>36.0</td><td>63.6</td></tr>
          </table>
        </figure>
      </section>
    </div></body></html>`;
    const { structure } = buildReadingStructure(html);
    const kinds = structure.sections.flatMap((sec) =>
      sec.sentences.map((s) => s.kind),
    );
    assert.ok(kinds.includes("table"));
    assert.ok(kinds.includes("caption"));
    const prose = structure.sections.flatMap((sec) =>
      sec.sentences.filter((s) => s.kind === "prose").map((s) => s.text),
    );
    assert.ok(prose.length);
    assert.ok(
      prose.every((t) => !t.replace(/\s+/g, "").includes("ModelsListOps")),
    );
    assert.ok(
      structure.sections
        .flatMap((sec) => sec.sentences)
        .filter((s) => s.kind === "prose")
        .every((s) => !(s.html || "").includes("<table")),
    );
  });

  it("embeds inline math as ⟦Mn⟧", () => {
    const html = `
    <html><body><article>
      <h2>Sec</h2>
      <p>Cost is <math class="ltx_Math"><mi>O</mi></math> and done.</p>
    </article></body></html>`;
    const { structure } = buildReadingStructure(html);
    const prose = structure.sections
      .flatMap((sec) => sec.sentences)
      .filter((s) => s.kind === "prose");
    assert.ok(prose.length);
    assert.ok(prose[0]!.embeds?.length);
    assert.ok(prose[0]!.text.includes("⟦M0⟧"));
    assert.ok(prose[0]!.embeds![0]!.html.includes("<math"));
    assert.equal(prose[0]!.embeds![0]!.id, "m0");
  });

  it("inserts spacer between paragraph hosts", () => {
    const html = `
    <html><body><article>
      <h2>Sec</h2>
      <p>First paragraph only.</p>
      <p>Second paragraph starts. Continues here.</p>
    </article></body></html>`;
    const { structure } = buildReadingStructure(html);
    const kinds = structure.sections.flatMap((sec) =>
      sec.sentences.map((s) => s.kind),
    );
    assert.equal(kinds[0], "heading");
    assert.ok(kinds.includes("spacer"));
    assert.ok(kinds.indexOf("spacer") > kinds.indexOf("prose"));
  });
});

describe("remapStructureIds", () => {
  it("preserves matching fingerprints", () => {
    const old = {
      version: 1,
      title: "t",
      sections: [
        {
          id: "sec-9",
          level: 2,
          sentences: [
            {
              id: "s-40",
              kind: "heading",
              text: "1 Intro",
              html: "<h2>1 Intro</h2>",
            },
            { id: "s-41", kind: "prose", text: "Hello.", html: "Hello." },
          ],
        },
      ],
    };
    const neu = {
      version: 2,
      title: "t",
      sections: [
        {
          id: "sec-1",
          level: 2,
          sentences: [
            {
              id: "s-1",
              kind: "heading",
              text: "1 Intro",
              html: "<h2>1 Intro</h2>",
            },
            { id: "s-2", kind: "figure", text: "[figure]", html: "<img>" },
            { id: "s-3", kind: "prose", text: "Hello.", html: "Hello." },
          ],
        },
      ],
    };
    const out = remapStructureIds(old, neu);
    const sents = out.sections[0]!.sentences;
    assert.equal(out.sections[0]!.id, "sec-9");
    assert.equal(sents[0]!.id, "s-40");
    assert.equal(sents[2]!.id, "s-41");
    assert.equal(sents[1]!.kind, "figure");
    assert.ok(sents[1]!.id.startsWith("s-"));
  });
});

describe("ensureReadingStructure upgrades", () => {
  it("v5→v6 converts paraStart to spacer", () => {
    const existing = {
      version: 5,
      title: "Demo",
      sections: [
        {
          id: "sec-1",
          level: 2,
          sentences: [
            {
              id: "s-1",
              kind: "heading",
              text: "Sec",
              html: "<h2>Sec</h2>",
            },
            {
              id: "s-2",
              kind: "prose",
              text: "A.",
              html: "A.",
              paraStart: true,
            },
            {
              id: "s-3",
              kind: "prose",
              text: "B.",
              html: "B.",
              paraStart: true,
            },
          ],
        },
      ],
    };
    const { structure: out, changed } = ensureReadingStructure(
      "<html></html>",
      existing,
    );
    assert.equal(changed, true);
    assert.equal(out.version, STRUCTURE_VERSION);
    assert.deepEqual(
      out.sections[0]!.sentences.map((s) => s.kind),
      ["heading", "prose", "spacer", "prose"],
    );
  });

  it("v8→v9 reorders detached captions", () => {
    const existing = {
      version: 8,
      title: "Demo",
      sections: [
        {
          id: "sec-1",
          level: 2,
          sentences: [
            { id: "s-1", kind: "table", text: "A", html: "<table></table>" },
            { id: "s-2", kind: "table", text: "B", html: "<table></table>" },
            {
              id: "s-3",
              kind: "caption",
              text: "Table 5: AAA",
              html: "<figcaption>Table 5: AAA</figcaption>",
            },
            {
              id: "s-4",
              kind: "caption",
              text: "Table 6: BBB",
              html: "<figcaption>Table 6: BBB</figcaption>",
            },
          ],
        },
      ],
    };
    const { structure: out, changed } = ensureReadingStructure(
      "<html></html>",
      existing,
    );
    assert.equal(changed, true);
    assert.equal(out.version, STRUCTURE_VERSION);
    assert.deepEqual(
      out.sections[0]!.sentences.map((s) => s.kind),
      ["table", "caption", "table", "caption"],
    );
  });

  it("v9→v10 extracts caption embeds", () => {
    const existing = {
      version: 9,
      title: "T",
      sections: [
        {
          id: "sec-1",
          level: 1,
          anchor: "S1",
          sentences: [
            {
              id: "s-1",
              kind: "caption",
              text: "Table 5: micro F 1 score.",
              html:
                '<figcaption class="ltx_caption">Table 5: micro ' +
                '<math alttext="F_{1}" class="ltx_Math"><semantics>' +
                "<msub><mi>F</mi><mn>1</mn></msub></semantics></math>" +
                " score.</figcaption>",
            },
          ],
        },
      ],
    };
    const { structure: out, changed } = ensureReadingStructure(
      "<html></html>",
      existing,
    );
    assert.equal(changed, true);
    assert.equal(out.version, STRUCTURE_VERSION);
    const cap = out.sections[0]!.sentences[0]!;
    assert.ok(cap.text.includes("⟦M0⟧"));
    assert.ok(cap.embeds?.length);
  });
});
