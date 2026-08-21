from __future__ import annotations

from app.structure import (
    build_reading_structure,
    extract_authors_detail,
    ensure_reading_structure,
    split_sentences,
)


def test_split_sentences_basic():
    parts = split_sentences("Hello world. How are you? Fine!")
    assert parts == ["Hello world.", "How are you?", "Fine!"]


def test_extract_authors_infers_org_from_shared_emails():
    html = """
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
    </div></body></html>
    """
    detail = extract_authors_detail(html)
    by = {d["name"]: d["affiliation"] for d in detail}
    assert by["Tri Dao"] == "Stanford University"
    assert by["Daniel Y. Fu"] == "Stanford University"
    assert by["Atri Rudra"] == "University at Buffalo"
    assert by["Christopher Ré"] == "Stanford University"


def test_extract_authors_keeps_real_institution():
    html = """
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
    </div></body></html>
    """
    detail = extract_authors_detail(html)
    assert detail[0]["name"] == "Ada Lovelace"
    assert "University of London" in detail[0]["affiliation"]
    assert "Affiliation:" not in detail[0]["affiliation"]
    assert detail[1]["affiliation"] == "University of Cambridge"


def test_split_sentences_keeps_abbreviations_loosely():
    # Period inside number / short tokens should not over-split aggressively
    parts = split_sentences("We use 3.14 as pi. Next sentence.")
    assert len(parts) == 2
    assert parts[0].startswith("We use 3.14")


def test_build_reading_structure_sections_and_ids():
    html = """
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
    </article></body></html>
    """
    structure, events = build_reading_structure(html)
    assert structure["title"] == "Demo Paper"
    assert structure["version"] == 10
    assert len(structure["sections"]) >= 2
    ids = [s["id"] for s in structure["sections"]]
    assert len(ids) == len(set(ids))

    all_sentence_ids = [
        sent["id"] for sec in structure["sections"] for sent in sec["sentences"]
    ]
    assert len(all_sentence_ids) == len(set(all_sentence_ids))

    # Abstract section should include heading + two prose sentences
    abstract = next(
        s for s in structure["sections"] if any(
            x.get("kind") == "heading" and "Abstract" in x.get("text", "")
            for x in s["sentences"]
        )
    )
    prose = [x for x in abstract["sentences"] if x["kind"] == "prose"]
    assert len(prose) == 2
    assert "paraStart" not in prose[0]
    assert "paraStart" not in prose[1]
    # Single paragraph host → no spacer between its sentences
    kinds_abs = [x["kind"] for x in abstract["sentences"]]
    assert kinds_abs.count("spacer") == 0

    intro = next(
        s for s in structure["sections"] if any(
            "Introduction" in x.get("text", "") for x in s["sentences"]
        )
    )
    kinds = [x["kind"] for x in intro["sentences"]]
    assert "heading" in kinds
    assert "caption" in kinds
    assert "figure" in kinds
    assert events[-1]["type"] == "done"
    assert events[-1]["sections"] == len(structure["sections"])


def test_paragraph_hosts_insert_spacer_between_blocks():
    html = """
    <html><body><article>
      <h2>Sec</h2>
      <p>First paragraph only.</p>
      <p>Second paragraph starts. Continues here.</p>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    kinds = [s["kind"] for sec in structure["sections"] for s in sec["sentences"]]
    assert kinds[0] == "heading"
    assert "spacer" in kinds
    # spacer sits between the two paragraph hosts
    assert kinds.index("spacer") > kinds.index("prose")
    prose = [s for sec in structure["sections"] for s in sec["sentences"] if s["kind"]=="prose"]
    assert len(prose) >= 2
    assert not any(s.get("paraStart") for s in prose)

def test_ltx_para_does_not_swallow_table():
    """Regression: substring 'ltx_p' must not match class 'ltx_para'/'ltx_paragraph'."""
    html = """
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
    </div></body></html>
    """
    structure, _ = build_reading_structure(html)
    kinds = [s["kind"] for sec in structure["sections"] for s in sec["sentences"]]
    assert "table" in kinds
    assert "caption" in kinds
    prose = [
        s["text"]
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "prose"
    ]
    assert prose
    assert all("ModelsListOps" not in t.replace(" ", "") for t in prose)
    assert all("<table" not in (s.get("html") or "") for sec in structure["sections"] for s in sec["sentences"] if s["kind"] == "prose")
    table = next(
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "table"
    )
    assert "<table" in table["html"]

    html = """
    <html><body><article>
      <h2>Sec</h2>
      <p>Cost is <math class="ltx_Math"><mi>O</mi></math> and done.</p>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    prose = [
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "prose"
    ]
    assert prose
    assert prose[0]["embeds"]
    assert "⟦M0⟧" in prose[0]["text"]
    assert "<math" in prose[0]["embeds"][0]["html"]


def test_remap_structure_ids_preserves_old_ids():
    from app.structure import remap_structure_ids

    old = {
        "version": 1,
        "sections": [
            {
                "id": "sec-9",
                "sentences": [
                    {"id": "s-40", "kind": "heading", "text": "1 Intro", "html": "<h2>1 Intro</h2>"},
                    {"id": "s-41", "kind": "prose", "text": "Hello.", "html": "Hello."},
                ],
            }
        ],
    }
    new = {
        "version": 2,
        "sections": [
            {
                "id": "sec-1",
                "sentences": [
                    {"id": "s-1", "kind": "heading", "text": "1 Intro", "html": "<h2>1 Intro</h2>"},
                    {"id": "s-2", "kind": "figure", "text": "[figure]", "html": "<img>"},
                    {"id": "s-3", "kind": "prose", "text": "Hello.", "html": "Hello."},
                ],
            }
        ],
    }
    out = remap_structure_ids(old, new)
    sents = out["sections"][0]["sentences"]
    assert out["sections"][0]["id"] == "sec-9"
    assert sents[0]["id"] == "s-40"
    assert sents[2]["id"] == "s-41"
    assert sents[1]["kind"] == "figure"
    assert sents[1]["id"].startswith("s-")


def test_remap_does_not_duplicate_section_ids():
    from app.structure import remap_structure_ids

    old = {
        "version": 1,
        "sections": [
            {
                "id": "sec-40",
                "sentences": [
                    {"id": "s-1", "kind": "heading", "text": "Same Title", "html": "x"},
                ],
            }
        ],
    }
    new = {
        "version": 3,
        "sections": [
            {
                "id": "sec-1",
                "sentences": [
                    {"id": "s-1", "kind": "heading", "text": "Same Title", "html": "x"},
                    {"id": "s-2", "kind": "prose", "text": "A.", "html": "A."},
                ],
            },
            {
                "id": "sec-2",
                "sentences": [
                    {"id": "s-3", "kind": "heading", "text": "Same Title", "html": "x"},
                    {"id": "s-4", "kind": "prose", "text": "B.", "html": "B."},
                ],
            },
        ],
    }
    out = remap_structure_ids(old, new)
    ids = [s["id"] for s in out["sections"]]
    assert len(ids) == len(set(ids))
    assert "sec-40" in ids


def test_bibliography_bibitems_become_reference_units():
    html = """
    <html><body><article>
      <section class="ltx_bibliography" id="bib">
        <h2 class="ltx_title ltx_title_bibliography">References</h2>
        <ul class="ltx_biblist">
          <li class="ltx_bibitem" id="bib.bib1">
            <span class="ltx_tag ltx_tag_bibitem">[1]</span>
            <span class="ltx_bibblock">Ada Lovelace. Notes. 1843.</span>
          </li>
          <li class="ltx_bibitem" id="bib.bib2">
            <span class="ltx_tag ltx_tag_bibitem">[2]</span>
            <span class="ltx_bibblock">Alan Turing. Computing. 1936.</span>
          </li>
        </ul>
      </section>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    refs = [
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "reference"
    ]
    assert len(refs) == 2
    assert refs[0]["text"].startswith("[1]")
    assert "Ada Lovelace" in refs[0]["text"]
    assert 'id="bib.bib1"' in refs[0]["html"]
    assert refs[1]["text"].startswith("[2]")
    assert any(
        s["kind"] == "heading" and "References" in s["text"]
        for sec in structure["sections"]
        for s in sec["sentences"]
    )


def test_v4_to_v5_injects_references_without_full_rebuild():
    from app.structure import ensure_reading_structure

    html = """
    <html><body><article>
      <h2 class="ltx_title">References</h2>
      <ul class="ltx_biblist">
        <li class="ltx_bibitem" id="bib.bib1">
          <span class="ltx_tag">[1]</span>
          <span class="ltx_bibblock">Only Ref. 2020.</span>
        </li>
      </ul>
    </article></body></html>
    """
    existing = {
        "version": 4,
        "title": "Demo",
        "sections": [
            {
                "id": "sec-9",
                "level": 2,
                "anchor": None,
                "sentences": [
                    {
                        "id": "s-40",
                        "kind": "heading",
                        "text": "References",
                        "html": "<h2>References</h2>",
                        "level": 2,
                    }
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure(html, existing)
    assert changed
    assert out["version"] == 10
    assert out["sections"][0]["id"] == "sec-9"
    refs = [s for s in out["sections"][0]["sentences"] if s["kind"] == "reference"]
    assert len(refs) == 1
    assert refs[0]["id"] != "s-40"
    assert "[1]" in refs[0]["text"]


def test_v5_to_v6_converts_parastart_to_spacer():
    from app.structure import ensure_reading_structure

    existing = {
        "version": 5,
        "title": "Demo",
        "sections": [
            {
                "id": "sec-1",
                "level": 2,
                "sentences": [
                    {"id": "s-1", "kind": "heading", "text": "Sec", "html": "<h2>Sec</h2>"},
                    {
                        "id": "s-2",
                        "kind": "prose",
                        "text": "A.",
                        "html": "A.",
                        "paraStart": True,
                    },
                    {
                        "id": "s-3",
                        "kind": "prose",
                        "text": "B.",
                        "html": "B.",
                        "paraStart": True,
                    },
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure("<html></html>", existing)
    assert changed
    assert out["version"] == 10
    kinds = [s["kind"] for s in out["sections"][0]["sentences"]]
    assert kinds == ["heading", "prose", "spacer", "prose"]
    assert all("paraStart" not in s for s in out["sections"][0]["sentences"])


def test_flex_figure_splits_table_and_image_panels():
    html = """
    <html><body><article>
      <h2>Sec</h2>
      <figure class="ltx_figure" id="S3.F2">
        <div class="ltx_flex_figure">
          <div class="ltx_flex_cell ltx_flex_size_1">
            <div class="ltx_inline-block ltx_figure_panel ltx_transformed_outer"
                 style="width:166pt;height:136pt;">
              <span class="ltx_transformed_inner"
                    style="transform:translate(100pt,-32pt) scale(1.9);">
                <table class="ltx_tabular">
                  <tr><th>Attention</th><th>Standard</th><th>FlashAttention</th></tr>
                  <tr><th>GFLOPs</th><td>66.6</td><td>75.2</td></tr>
                </table>
              </span>
            </div>
          </div>
          <div class="ltx_flex_break"></div>
          <div class="ltx_flex_cell ltx_flex_size_1">
            <div class="ltx_block ltx_figure_panel">
              <img class="ltx_graphics" src="assets/x2.png" width="230" alt="plots"/>
            </div>
          </div>
        </div>
        <figcaption class="ltx_caption">Figure 2: Left and right panels.</figcaption>
      </figure>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    kinds = [s["kind"] for sec in structure["sections"] for s in sec["sentences"]]
    assert kinds.count("table") == 1
    assert kinds.count("figure") == 1
    assert kinds.count("caption") == 1
    table = next(
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "table"
    )
    figure = next(
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "figure"
    )
    assert "<table" in table["html"]
    assert "transform" not in table["html"]
    assert "<img" in figure["html"]
    assert "<table" not in figure["html"]
    assert "Attention" in table["text"]


def test_flex_side_by_side_tables_keep_per_panel_captions():
    html = """
    <html><body><article>
      <h2>Sec</h2>
      <figure class="ltx_table" id="S4.T6">
        <div class="ltx_flex_figure ltx_flex_table">
          <div class="ltx_flex_cell ltx_flex_size_2">
            <figure class="ltx_figure ltx_figure_panel">
              <figcaption class="ltx_caption">Table 5: Long Document performance.</figcaption>
              <table class="ltx_tabular" id="S4.T6.2"><tr><td>MIMIC</td></tr></table>
            </figure>
          </div>
          <div class="ltx_flex_cell ltx_flex_size_2">
            <figure class="ltx_figure ltx_figure_panel">
              <figcaption class="ltx_caption">Table 6: Path-X results.</figcaption>
              <table class="ltx_tabular" id="S4.T6.fig1"><tr><td>Path-X</td></tr></table>
            </figure>
          </div>
        </div>
      </figure>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    units = [s for sec in structure["sections"] for s in sec["sentences"]]
    kinds = [u["kind"] for u in units]
    # table, caption, table, caption — not table, table, caption, caption
    assert kinds == ["heading", "table", "caption", "table", "caption"]
    assert "Table 5" in units[2]["text"]
    assert "Table 6" in units[4]["text"]
    assert "MIMIC" in units[1]["text"]
    assert "Path-X" in units[3]["text"]


def test_v8_to_v9_reorders_detached_captions():
    from app.structure import ensure_reading_structure

    existing = {
        "version": 8,
        "title": "Demo",
        "sections": [
            {
                "id": "sec-1",
                "level": 2,
                "sentences": [
                    {"id": "s-1", "kind": "table", "text": "A", "html": "<table></table>"},
                    {"id": "s-2", "kind": "table", "text": "B", "html": "<table></table>"},
                    {
                        "id": "s-3",
                        "kind": "caption",
                        "text": "Table 5: AAA",
                        "html": "<figcaption>Table 5: AAA</figcaption>",
                    },
                    {
                        "id": "s-4",
                        "kind": "caption",
                        "text": "Table 6: BBB",
                        "html": "<figcaption>Table 6: BBB</figcaption>",
                    },
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure("<html></html>", existing)
    assert changed
    assert out["version"] == 10
    kinds = [s["kind"] for s in out["sections"][0]["sentences"]]
    assert kinds == ["table", "caption", "table", "caption"]
    assert "Table 5" in out["sections"][0]["sentences"][1]["text"]
    assert "Table 6" in out["sections"][0]["sentences"][3]["text"]


def test_v6_to_v7_splits_composite_figure_units():
    from app.structure import ensure_reading_structure

    existing = {
        "version": 6,
        "title": "Demo",
        "sections": [
            {
                "id": "sec-1",
                "level": 2,
                "sentences": [
                    {
                        "id": "s-10",
                        "kind": "figure",
                        "text": "mixed",
                        "html": """
                        <figure class="ltx_figure" id="F1">
                          <div class="ltx_flex_figure">
                            <div class="ltx_flex_cell">
                              <table class="ltx_tabular"><tr><td>A</td></tr></table>
                            </div>
                            <div class="ltx_flex_cell">
                              <img src="assets/x.png" alt="plot"/>
                            </div>
                          </div>
                        </figure>
                        """,
                    }
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure("<html></html>", existing)
    assert changed
    assert out["version"] == 10
    kinds = [s["kind"] for s in out["sections"][0]["sentences"]]
    assert kinds == ["table", "figure"]
    assert out["sections"][0]["sentences"][0]["id"] == "s-10"
    assert out["sections"][0]["sentences"][1]["id"] != "s-10"


def test_intext_ltx_ref_preserved_as_embed_across_split():
    html = """
    <html><body><article>
      <h2>Sec</h2>
      <p>See <a class="ltx_ref" href="#S1.F1"><span>Fig.</span> 1</a> left. Next sentence here.</p>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    prose = [
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "prose"
    ]
    assert prose
    first = prose[0]
    assert first.get("embeds")
    assert "ltx_ref" in first["embeds"][0]["html"]
    assert "⟦M0⟧" in first["text"]
    assert "ltx_ref" in first["html"]


def test_bold_styles_preserved_across_sentence_split():
    html = """
    <html><body><article>
      <h2>Sec</h2>
      <p><span class="ltx_text ltx_font_bold">GPU Memory Hierarchy.</span>
      The rest continues here with more words.</p>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    prose = [
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "prose"
    ]
    assert prose
    bold = next(s for s in prose if "GPU Memory Hierarchy" in s["text"])
    assert "ltx_font_bold" in bold["html"]


def test_paragraph_hosts_uses_identity_not_markup_equality():
    """BS4 Tag.__eq__ compares markup; set membership must use id() or nested
    filtering becomes catastrophically slow on real papers."""
    from app.structure import _paragraph_hosts
    from bs4 import BeautifulSoup

    # Two siblings with identical markup must both remain hosts.
    html = """
    <html><body><article>
      <p class="ltx_p">Same text.</p>
      <p class="ltx_p">Same text.</p>
    </article></body></html>
    """
    article = BeautifulSoup(html, "lxml").find("article")
    hosts = _paragraph_hosts(article)
    assert len(hosts) == 2
    assert id(hosts[0]) != id(hosts[1])


def test_v7_to_v8_reinjects_inline_styles():
    from app.structure import ensure_reading_structure

    html = """
    <html><body><article>
      <p><span class="ltx_text ltx_font_bold">GPU Memory Hierarchy.</span> More text.</p>
    </article></body></html>
    """
    existing = {
        "version": 7,
        "title": "Demo",
        "sections": [
            {
                "id": "sec-1",
                "level": 2,
                "sentences": [
                    {
                        "id": "s-1",
                        "kind": "prose",
                        "text": "GPU Memory Hierarchy.",
                        "html": '<span class="sent-text">GPU Memory Hierarchy.</span>',
                    }
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure(html, existing)
    assert changed
    assert out["version"] == 10
    assert "ltx_font_bold" in out["sections"][0]["sentences"][0]["html"]


def test_caption_extracts_math_embeds():
    html = """
    <html><body><article>
      <h2>Results</h2>
      <figcaption class="ltx_caption">
        Table 5: micro
        <math alttext="F_{1}" class="ltx_Math" display="inline">
          <semantics><msub><mi>F</mi><mn>1</mn></msub>
          <annotation encoding="application/x-tex">F_{1}</annotation>
          </semantics>
        </math>
        score.
      </figcaption>
    </article></body></html>
    """
    structure, _ = build_reading_structure(html)
    cap = next(
        s
        for sec in structure["sections"]
        for s in sec["sentences"]
        if s["kind"] == "caption"
    )
    assert "⟦M0⟧" in cap["text"]
    assert cap.get("embeds")
    assert "<math" in cap["embeds"][0]["html"]


def test_v9_to_v10_extracts_caption_embeds():
    existing = {
        "version": 9,
        "title": "T",
        "sections": [
            {
                "id": "sec-1",
                "level": 1,
                "anchor": "S1",
                "sentences": [
                    {
                        "id": "s-1",
                        "kind": "caption",
                        "text": "Table 5: micro F 1 score.",
                        "html": (
                            '<figcaption class="ltx_caption">Table 5: micro '
                            '<math alttext="F_{1}" class="ltx_Math"><semantics>'
                            "<msub><mi>F</mi><mn>1</mn></msub></semantics></math>"
                            " score.</figcaption>"
                        ),
                    }
                ],
            }
        ],
    }
    out, changed = ensure_reading_structure("<html></html>", existing)
    assert changed
    assert out["version"] == 10
    cap = out["sections"][0]["sentences"][0]
    assert "⟦M0⟧" in cap["text"]
    assert cap.get("embeds")
