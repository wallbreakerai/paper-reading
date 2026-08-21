from app.llm.translator import (
    chunk_sentences,
    html_to_translate_markup,
    parse_section_translation,
    sentence_source_for_translate,
)


def test_parse_delimiter_format():
    raw = """<<<s-1>>>
你好"世界"
<<<s-2>>>
第二句
"""
    out = parse_section_translation(raw, ["s-1", "s-2"])
    assert out == {"s-1": '你好"世界"', "s-2": "第二句"}


def test_parse_preserves_style_tags_in_zh():
    raw = """<<<s-1>>>
我们提出 <b>闪注意力</b>，一种 <i>IO 感知</i> 算法。
"""
    out = parse_section_translation(raw, ["s-1"])
    assert "<b>闪注意力</b>" in out["s-1"]
    assert "<i>IO 感知</i>" in out["s-1"]


def test_html_to_translate_markup_bold_italic_smallcaps():
    html = (
        '<span class="sent-text">We propose '
        '<span class="ltx_text ltx_font_smallcaps">FlashAttention</span>, an '
        '<span class="ltx_text ltx_font_italic">IO-aware</span> algorithm.</span>'
    )
    out = html_to_translate_markup(html)
    assert "<sc>FlashAttention</sc>" in out
    assert "<i>IO-aware</i>" in out
    assert "ltx_font" not in out


def test_html_to_translate_markup_keeps_embed_tokens():
    html = (
        '<span class="sent-text">See '
        '<span class="sent-embed" data-embed="0">x</span> and '
        '<span class="ltx_text ltx_font_bold">GPU</span>.</span>'
    )
    out = html_to_translate_markup(html)
    assert "⟦M0⟧" in out
    assert "<b>GPU</b>" in out


def test_html_to_translate_markup_math_becomes_embed_token():
    html = (
        'micro <math alttext="F_{1}" class="ltx_Math">'
        "<semantics><msub><mi>F</mi><mn>1</mn></msub>"
        '<annotation encoding="application/x-tex">F_{1}</annotation>'
        "</semantics></math> score"
    )
    out = html_to_translate_markup(html)
    assert "⟦M0⟧" in out
    assert "F_{1}" not in out
    assert "micro" in out


def test_sentence_source_for_translate_uses_markup_when_styled():
    sent = {
        "id": "s-1",
        "text": "We propose FlashAttention, an IO-aware algorithm.",
        "html": (
            '<span class="sent-text">We propose '
            '<span class="ltx_text ltx_font_smallcaps">FlashAttention</span>, an '
            '<span class="ltx_text ltx_font_italic">IO-aware</span> algorithm.</span>'
        ),
    }
    src = sentence_source_for_translate(sent)
    assert "<sc>FlashAttention</sc>" in src
    assert "<i>IO-aware</i>" in src


def test_sentence_source_plain_when_no_styles():
    sent = {
        "id": "s-1",
        "text": "Hello world. ⟦M0⟧",
        "html": '<span class="sent-text">Hello world. <span class="sent-embed" data-embed="0">x</span></span>',
    }
    # No font classes — prefer plain text (already has embed tokens).
    assert sentence_source_for_translate(sent) == "Hello world. ⟦M0⟧"


def test_parse_json_fallback():
    raw = '{"sentences":[{"id":"s-1","zh":"你好"},{"id":"s-2","zh":"世界"}]}'
    out = parse_section_translation(raw, ["s-1", "s-2"])
    assert out == {"s-1": "你好", "s-2": "世界"}


def test_parse_broken_json_regex_fallback():
    # Unescaped quote inside zh breaks json.loads; regex pair extract may still work
    # if the broken part is later — here we use valid escaped content via regex path
    raw = (
        'noise {"sentences":['
        '{"id":"s-1","zh":"第一句"},'
        '{"id":"s-2","zh":"第二句"}'
        "]} trailing"
    )
    out = parse_section_translation(raw, ["s-1", "s-2"])
    assert out["s-1"] == "第一句"
    assert out["s-2"] == "第二句"


def test_parse_rejects_mismatch():
    raw = "<<<s-1>>>\n只一句\n"
    try:
        parse_section_translation(raw, ["s-1", "s-2"])
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "不对齐" in str(exc)


def test_chunk_sentences():
    sents = [{"id": f"s-{i}", "text": "x" * 100} for i in range(20)]
    batches = chunk_sentences(sents, max_sentences=8, max_chars=500)
    assert all(len(b) <= 8 for b in batches)
    assert sum(len(b) for b in batches) == 20
