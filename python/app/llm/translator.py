from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

from bs4 import BeautifulSoup, NavigableString, Tag

from .client import LlmClient

# Delimiter format avoids brittle JSON escaping from the model.
SYSTEM = (
    "你是学术论文英译中译者。请对用户给出的句子做忠实全文翻译："
    "保留原意与信息量，不要总结、不要省略、不要添加原文没有的内容。"
    "专有名词、变量名、⟦M0⟧ 这类公式/图表占位符必须原样保留"
    "（不要展开成 d d、F_{1}、\\times 等明文；不要改写占位符编号）。\n"
    "若原文含内联样式标签，译文必须在对应语义位置保留相同标签（可嵌套；"
    "标签内写中文；不要发明原文没有的标签）：\n"
    "  <b>加粗</b>  <i>斜体</i>  <em>强调</em>  <code>等宽</code>  "
    "<u>下划线</u>  <sc>小型大写</sc>\n"
    "严格按下面格式输出（不要 JSON、不要 Markdown 代码围栏）：\n"
    "<<<句子id>>>\n"
    "该句的中文译文\n"
    "<<<下一句id>>>\n"
    "该句的中文译文\n"
    "必须为每个输入 id 恰好输出一块；不得增删 id；译文里不要再写 <<< >>> 标记。"
)

_BLOCK_RE = re.compile(
    r"<<<\s*(?P<id>[^>\s]+)\s*>>>\s*\n(?P<zh>.*?)(?=\n<<<\s*[^>\s]+\s*>>>|\Z)",
    re.DOTALL,
)
_JSON_PAIR_RE = re.compile(
    r'"id"\s*:\s*"(?P<id>[^"]+)"\s*,\s*"zh"\s*:\s*"(?P<zh>(?:[^"\\]|\\.)*)"',
    re.DOTALL,
)

# Keep each LLM call small enough that models stay on-format.
MAX_SENTENCES_PER_BATCH = 8
MAX_CHARS_PER_BATCH = 2800

_STYLE_HINT_RE = re.compile(
    r"ltx_font_(?:bold|italic|slanted|smallcaps|typewriter)|ltx_emph|"
    r"<(?:b|strong|i|em|code|u|math)\b|ltx_Math",
    re.I,
)


def chunk_sentences(
    sentences: list[dict[str, Any]],
    *,
    max_sentences: int = MAX_SENTENCES_PER_BATCH,
    max_chars: int = MAX_CHARS_PER_BATCH,
) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    cur_chars = 0
    for s in sentences:
        text_len = len(sentence_source_for_translate(s))
        if cur and (
            len(cur) >= max_sentences or cur_chars + text_len > max_chars
        ):
            batches.append(cur)
            cur = []
            cur_chars = 0
        cur.append(s)
        cur_chars += text_len
    if cur:
        batches.append(cur)
    return batches or [[]]


def _class_set(el: Tag) -> set[str]:
    raw = el.get("class") or []
    if isinstance(raw, str):
        return {raw}
    return {str(c) for c in raw}


def _style_wrap_tag(el: Tag) -> str | None:
    name = (el.name or "").lower()
    classes = _class_set(el)
    if name in {"b", "strong"} or "ltx_font_bold" in classes:
        return "b"
    if "ltx_font_smallcaps" in classes:
        return "sc"
    if name in {"i"} or "ltx_font_italic" in classes or "ltx_font_slanted" in classes:
        return "i"
    if name in {"em"} or "ltx_emph" in classes:
        return "em"
    if name in {"code"} or "ltx_font_typewriter" in classes:
        return "code"
    if name == "u":
        return "u"
    return None


def html_to_translate_markup(html: str) -> str:
    """Flatten sentence HTML into plain text plus <b>/<i>/<em>/<code>/<u>/<sc>.

    Embeds become ⟦Mn⟧ tokens so the model can keep them aligned.
    """
    if not (html or "").strip():
        return ""
    soup = BeautifulSoup(f"<div id='_root'>{html}</div>", "lxml")
    root = soup.find(id="_root")
    if root is None:
        return re.sub(r"\s+", " ", BeautifulSoup(html, "lxml").get_text(" ")).strip()

    embed_i = 0

    def walk(node: Any) -> str:
        nonlocal embed_i
        if isinstance(node, NavigableString):
            return str(node)
        if not isinstance(node, Tag):
            return ""
        name = (node.name or "").lower()
        classes = _class_set(node)
        if name in {"annotation", "annotation-xml", "script", "style"}:
            return ""
        if "sent-embed" in classes:
            idx = node.get("data-embed")
            if idx is not None and str(idx).strip() != "":
                return f"⟦M{idx}⟧"
            return node.get_text(" ", strip=True)
        if name == "math" or "ltx_Math" in classes:
            token = f"⟦M{embed_i}⟧"
            embed_i += 1
            return token
        if name in {"img", "svg", "table", "figure"}:
            token = f"⟦M{embed_i}⟧"
            embed_i += 1
            return token

        inner = "".join(walk(child) for child in node.children)
        wrap = _style_wrap_tag(node)
        if wrap and inner:
            return f"<{wrap}>{inner}</{wrap}>"
        return inner

    text = "".join(walk(child) for child in root.children)
    return re.sub(r"[ \t\f\v]+", " ", text).replace("\n", " ").strip()


def sentence_source_for_translate(sentence: dict[str, Any]) -> str:
    """Choose LLM source text: styled markup when HTML has emphasis/math, else plain."""
    plain = (sentence.get("text") or "").strip()
    html = sentence.get("html") or ""
    if not html:
        return plain
    has_style = bool(_STYLE_HINT_RE.search(html))
    has_math = "<math" in html.lower() or "ltx_Math" in html
    plain_has_tokens = "⟦M" in plain
    # Prefer markup when styles/math need conversion, or plain lacks embed tokens.
    if has_style or (has_math and not plain_has_tokens) or (
        "sent-embed" in html and not plain_has_tokens
    ):
        marked = html_to_translate_markup(html)
        if marked:
            return marked
    return plain


def _section_user_prompt(section_id: str, sentences: list[dict[str, Any]]) -> str:
    lines = [
        f"请翻译章节块 {section_id} 中的下列句子（严格一一对应，使用 <<<id>>> 格式；"
        "保留 <b>/<i>/<em>/<code>/<u>/<sc> 与 ⟦Mn⟧）：",
        "",
    ]
    for s in sentences:
        sid = s.get("id") or ""
        kind = s.get("kind") or "prose"
        text = sentence_source_for_translate(s)
        lines.append(f"[{kind}] {sid}:")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).strip()


def run_section_translate_stream(
    client: LlmClient,
    section_id: str,
    sentences: list[dict[str, Any]],
    *,
    should_abort: Any | None = None,
) -> Iterator[str]:
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": _section_user_prompt(section_id, sentences)},
    ]
    yield from client.chat_stream(
        messages, temperature=0.2, should_abort=should_abort
    )


def _unescape_json_str(s: str) -> str:
    try:
        return json.loads(f'"{s}"')
    except json.JSONDecodeError:
        return (
            s.replace(r"\"", '"')
            .replace(r"\n", "\n")
            .replace(r"\\", "\\")
        )


def parse_section_translation(
    raw: str,
    expected_ids: list[str],
) -> dict[str, str]:
    """Parse model output into id→zh; raise ValueError if not 1:1."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    out: dict[str, str] = {}

    # Preferred: <<<id>>> blocks
    for m in _BLOCK_RE.finditer(text):
        sid = m.group("id").strip()
        zh = m.group("zh").strip()
        if sid:
            out[sid] = zh

    # Fallback: JSON object
    if len(out) < len(expected_ids):
        try:
            match = re.search(r"\{[\s\S]*\}", text)
            if match:
                data = json.loads(match.group(0))
                items = data.get("sentences")
                if isinstance(items, list):
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        sid = str(item.get("id") or "").strip()
                        zh = item.get("zh")
                        if sid and sid not in out:
                            out[sid] = "" if zh is None else str(zh).strip()
        except json.JSONDecodeError:
            pass

    # Fallback: regex-extract JSON-like pairs (handles some broken JSON)
    if len(out) < len(expected_ids):
        for m in _JSON_PAIR_RE.finditer(text):
            sid = m.group("id").strip()
            if sid and sid not in out:
                out[sid] = _unescape_json_str(m.group("zh")).strip()

    missing = [i for i in expected_ids if i not in out]
    extra = [i for i in out if i not in expected_ids]
    if missing or extra:
        raise ValueError(
            f"句对不对齐：缺少 {missing[:5]}{'…' if len(missing) > 5 else ''}，"
            f"多余 {extra[:5]}{'…' if len(extra) > 5 else ''}"
        )
    return {i: out[i] for i in expected_ids}


def translate_sentences_with_retry(
    client: LlmClient,
    section_id: str,
    sentences: list[dict[str, Any]],
    *,
    on_preview: Any | None = None,
    should_abort: Any | None = None,
    max_attempts: int = 2,
) -> dict[str, str]:
    """Translate one batch; retry once on parse/align failure."""
    expected_ids = [s["id"] for s in sentences]
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        if should_abort and should_abort():
            from .client import TranslatePaused

            raise TranslatePaused()
        full: list[str] = []
        for token in run_section_translate_stream(
            client, section_id, sentences, should_abort=should_abort
        ):
            full.append(token)
            if on_preview:
                on_preview("".join(full))
        raw = "".join(full)
        try:
            return parse_section_translation(raw, expected_ids)
        except Exception as exc:  # noqa: BLE001
            from .client import TranslatePaused

            if isinstance(exc, TranslatePaused):
                raise
            last_err = exc
            if attempt + 1 >= max_attempts:
                break
    assert last_err is not None
    raise last_err
