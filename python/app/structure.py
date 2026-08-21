from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html import escape, unescape
from typing import Any, Iterator

from bs4 import BeautifulSoup, NavigableString, Tag

from .parser import _clean_text, _heading_anchor, _heading_level

STRUCTURE_VERSION = 10

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_DECIMAL = re.compile(r"\d+\.\d+")
_EMAIL_RE = re.compile(
    r"[A-Z0-9._%+\-{}]+@[A-Z0-9.\-]+\.[A-Z]{2,}",
    re.IGNORECASE,
)
_AFF_LABEL_RE = re.compile(
    r"^(affiliation|email|e-?mail|contact)\s*:?\s*",
    re.IGNORECASE,
)

_STYLE_CLASSES = {
    "ltx_font_bold",
    "ltx_font_italic",
    "ltx_font_smallcaps",
    "ltx_font_typewriter",
    "ltx_font_slanted",
    "ltx_font_mathsf",
    "ltx_font_mathcaligraphic",
    "ltx_font_upright",
    "ltx_font_medium",
    "ltx_emph",
}
_STYLE_TAGS = {"strong", "b", "em", "i", "u", "mark", "code"}


def split_sentences(text: str) -> list[str]:
    """Split English prose on .?! followed by whitespace + capital/digit/quote."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return []
    protected: list[str] = []

    def _protect(m: re.Match[str]) -> str:
        protected.append(m.group(0))
        return f"⟦D{len(protected) - 1}⟧"

    masked = _DECIMAL.sub(_protect, text)
    parts = _SENTENCE_END.split(masked)
    out: list[str] = []
    for part in parts:
        s = part.strip()
        if not s:
            continue
        for i, val in enumerate(protected):
            s = s.replace(f"⟦D{i}⟧", val)
        out.append(s)
    return out


_GROUP_EMAIL_RE = re.compile(
    r"\{([^{}]+)\}@([A-Z0-9.\-]+\.[A-Z]{2,})",
    re.IGNORECASE,
)
# Bump when affiliation extraction heuristics change (forces meta refresh).
AUTHORS_DETAIL_VERSION = 2
_DOMAIN_ORGS = {
    "stanford.edu": "Stanford University",
    "berkeley.edu": "UC Berkeley",
    "mit.edu": "MIT",
    "cmu.edu": "Carnegie Mellon University",
    "washington.edu": "University of Washington",
    "illinois.edu": "University of Illinois",
    "buffalo.edu": "University at Buffalo",
    "nyu.edu": "New York University",
    "princeton.edu": "Princeton University",
    "harvard.edu": "Harvard University",
    "ox.ac.uk": "University of Oxford",
    "cam.ac.uk": "University of Cambridge",
    "tsinghua.edu.cn": "Tsinghua University",
    "pku.edu.cn": "Peking University",
    "google.com": "Google",
    "deepmind.com": "Google DeepMind",
    "openai.com": "OpenAI",
    "fb.com": "Meta",
    "meta.com": "Meta",
    "microsoft.com": "Microsoft",
    "apple.com": "Apple",
}


def _normalize_affiliation(text: str) -> str:
    t = (text or "").strip()
    t = _AFF_LABEL_RE.sub("", t).strip(" ,;|")
    return t


def _is_contact_only_affiliation(text: str) -> bool:
    """True when 'affiliation' is really just email / contact lines."""
    t = _normalize_affiliation(text)
    if not t:
        return True
    emails = _EMAIL_RE.findall(t)
    if not emails:
        return False
    remainder = _EMAIL_RE.sub(" ", t)
    remainder = re.sub(r"[\s,;|/&]+", "", remainder)
    if len(emails) >= 1 and len(remainder) <= 4:
        return True
    if len(emails) >= 2 and len(remainder) < 24:
        return True
    return False


def _expand_emails(text: str) -> list[str]:
    """Expand `{a,b}@domain.edu` and plain emails into individual addresses."""
    out: list[str] = []
    seen: set[str] = set()
    for m in _GROUP_EMAIL_RE.finditer(text or ""):
        domain = m.group(2)
        for local in re.split(r"\s*,\s*", m.group(1)):
            local = local.strip()
            if not local:
                continue
            email = f"{local}@{domain}".lower()
            if email not in seen:
                seen.add(email)
                out.append(email)
    stripped = _GROUP_EMAIL_RE.sub(" ", text or "")
    for m in _EMAIL_RE.finditer(stripped):
        email = m.group(0).lower()
        if "{" in email or "}" in email:
            continue
        if email not in seen:
            seen.add(email)
            out.append(email)
    return out


def _org_from_email(email: str) -> str:
    domain = (email.split("@")[-1] or "").lower()
    if domain in _DOMAIN_ORGS:
        return _DOMAIN_ORGS[domain]
    parts = domain.split(".")
    if len(parts) > 2:
        parent = ".".join(parts[-2:])
        if parent in _DOMAIN_ORGS:
            return _DOMAIN_ORGS[parent]
        if len(parts) >= 3:
            parent3 = ".".join(parts[-3:])
            if parent3 in _DOMAIN_ORGS:
                return _DOMAIN_ORGS[parent3]
    stem = parts[-2] if len(parts) >= 2 else domain
    return stem.replace("-", " ").title()


def _email_matches_author(name: str, email: str) -> bool:
    local = (email.split("@")[0] or "").lower()
    local = re.sub(r"[^a-z]", "", local)
    parts = re.findall(r"[a-z]+", (name or "").lower())
    if not local or not parts:
        return False
    last = parts[-1]
    first = parts[0]
    if last and last in local:
        return True
    if first and local.startswith(first):
        return True
    # trid / danfu: first (+chunk) + last initial/chunk
    if first and last:
        if local == first + last[0]:
            return True
        if local == first[:3] + last[:2]:
            return True
        if local == first[:4] + last[:2]:
            return True
    initials = "".join(p[0] for p in parts if p)
    if len(initials) >= 2 and initials in local:
        return True
    return False


def _creator_affiliation(creator: Tag) -> str:
    """Pick institution text; skip shared email dumps under author notes."""
    candidates: list[str] = []
    for el in creator.select(
        ".ltx_affiliation, .ltx_role_affiliation, .ltx_author_notes"
    ):
        raw = _clean_text(el)
        text = _normalize_affiliation(raw)
        if not text:
            continue
        if _is_contact_only_affiliation(raw):
            continue
        candidates.append(text)
    if not candidates:
        return ""
    candidates.sort(key=len)
    return candidates[0]


def _affiliations_from_shared_emails(
    authors_root: Tag, names: list[str]
) -> dict[str, str]:
    """Map author name → institution inferred from shared contact emails."""
    blob_parts: list[str] = []
    for el in authors_root.select(
        ".ltx_author_notes, .ltx_role_affiliation, .ltx_contact"
    ):
        blob_parts.append(_clean_text(el))
    blob = " ".join(blob_parts)
    emails = _expand_emails(blob)
    if not emails:
        return {}
    assigned: dict[str, str] = {}
    used: set[str] = set()
    for name in names:
        for email in emails:
            if email in used:
                continue
            if _email_matches_author(name, email):
                assigned[name] = _org_from_email(email)
                used.add(email)
                break
    return assigned


def extract_authors_detail(html: str) -> list[dict[str, str]]:
    """Return [{name, affiliation}, ...] from ar5iv author block."""
    soup = BeautifulSoup(html, "lxml")
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    authors_root = soup.select_one(".ltx_authors")
    creator_nodes = soup.select(".ltx_authors .ltx_creator")
    if not creator_nodes:
        for person in soup.select(".ltx_authors .ltx_personname"):
            name = _clean_text(person)
            if name and name not in seen:
                seen.add(name)
                out.append({"name": name, "affiliation": ""})
        return out
    for creator in creator_nodes:
        person = creator.select_one(".ltx_personname")
        name = _clean_text(person) if person else ""
        if not name or name in seen:
            continue
        seen.add(name)
        affiliation = _creator_affiliation(creator)
        if affiliation == name:
            affiliation = ""
        out.append({"name": name, "affiliation": affiliation})

    if authors_root is not None and out and all(not d["affiliation"] for d in out):
        inferred = _affiliations_from_shared_emails(
            authors_root, [d["name"] for d in out]
        )
        for d in out:
            if d["name"] in inferred:
                d["affiliation"] = inferred[d["name"]]
    return out


def authors_detail_looks_stale(detail: Any, meta: dict[str, Any] | None = None) -> bool:
    """True if stored authorsDetail needs re-extract (email blob as unit, etc.)."""
    if meta is not None:
        try:
            ver = int(meta.get("authorsDetailVersion") or 0)
        except (TypeError, ValueError):
            ver = 0
        if ver < AUTHORS_DETAIL_VERSION:
            return True
    if not isinstance(detail, list) or not detail:
        return True
    for item in detail:
        if not isinstance(item, dict):
            return True
        aff = str(item.get("affiliation") or "")
        if not aff:
            continue
        if aff.lower().lstrip().startswith("affiliation:"):
            return True
        if _is_contact_only_affiliation(aff):
            return True
    return False



def _class_set(el: Tag) -> set[str]:
    return set(el.get("class") or [])


def _is_heading(el: Tag) -> bool:
    name = (el.name or "").lower()
    classes = _class_set(el)
    if "ltx_runin" in classes or "ltx_title_theorem" in classes:
        return False
    if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        return True
    return "ltx_title" in classes and name not in {"span", "em", "strong"}


def _is_display_math(el: Tag) -> bool:
    classes = _class_set(el)
    if "ltx_equation" in classes or "ltx_equationgroup" in classes:
        return True
    if el.name in {"math"} and el.get("display") == "block":
        return True
    return False


def _is_caption(el: Tag) -> bool:
    classes = _class_set(el)
    return el.name in {"figcaption", "caption"} or "ltx_caption" in classes


def _is_figure_or_table(el: Tag) -> bool:
    """Top-level figures / data tables (not display-equation tables)."""
    if _is_display_math(el):
        return False
    name = (el.name or "").lower()
    classes = _class_set(el)
    if name == "figure" or "ltx_figure" in classes:
        return True
    if "ltx_float" in classes and "ltx_equation" not in classes:
        return True
    if "ltx_table" in classes and "ltx_equation" not in classes:
        return True
    if name == "table" and "ltx_tabular" in classes:
        return True
    return False


def _is_bibitem(el: Tag) -> bool:
    """One bibliography entry (ar5iv .ltx_bibitem)."""
    return "ltx_bibitem" in _class_set(el)


def _figure_html_without_caption(el: Tag) -> str:
    """Keep image/table body; captions are separate sentence units."""
    clone = BeautifulSoup(str(el), "lxml")
    root = clone.find(el.name) if el.name else clone.find(True)
    if root is None:
        return str(el)
    for cap in root.select("figcaption, .ltx_caption"):
        cap.decompose()
    # ar5iv SVG figures often use <object>; normalize to <img> for the reader.
    for obj in list(root.find_all("object")):
        if not isinstance(obj, Tag):
            continue
        data = (obj.get("data") or "").strip()
        if not data:
            obj.decompose()
            continue
        img = clone.new_tag("img")
        img["src"] = data
        for attr in ("width", "height", "id", "alt", "class", "style"):
            if obj.get(attr):
                img[attr] = obj.get(attr)
        if not img.get("alt"):
            img["alt"] = "Refer to caption"
        obj.replace_with(img)
    return str(root)


def _panel_kind_and_html(cell: Tag) -> tuple[str, str, str] | None:
    """Return (kind, text, html) for one flex cell; strip LaTeXML transform wrappers."""
    table = cell.find("table")
    img = cell.find("img")
    if img is None:
        # Pre-localize ar5iv may still use <object type="image/svg+xml">.
        obj = cell.find("object")
        if isinstance(obj, Tag) and (obj.get("data") or "").strip():
            img = obj
    if table is not None and img is None:
        text = _clean_text(table) or "[table]"
        return "table", text, str(table)
    if img is not None:
        if img.name == "object":
            # Normalize to img markup for the reader.
            src = (img.get("data") or "").strip()
            alt = (img.get("alt") or "").strip() or "Refer to caption"
            cls = " ".join(img.get("class") or []) or "ltx_graphics"
            html = f'<img class="{cls}" src="{src}" alt="{alt}"'
            for attr in ("width", "height", "id"):
                if img.get(attr):
                    html += f' {attr}="{img.get(attr)}"'
            html += "/>"
            return "figure", alt, html
        alt = (img.get("alt") or "").strip()
        text = alt or _clean_text(cell) or "[figure]"
        return "figure", text, str(img)
    text = _clean_text(cell)
    if not text:
        return None
    return "figure", text, str(cell)


def _flex_figure_panels(el: Tag) -> list[dict[str, str]]:
    """
    Split ar5iv multi-panel figures (table + plots, subfigures, …)
    into separate units. Empty if not a multi-panel flex figure.

    Each panel may include caption_text/caption_html from a figcaption inside
    that cell (so Table 5/6 side-by-side keep captions with their tables).
    """
    if not isinstance(el, Tag):
        return []
    flex = el.select_one(".ltx_flex_figure")
    if flex is None:
        return []
    panels: list[dict[str, str]] = []
    for cell in flex.find_all("div", recursive=False):
        if not isinstance(cell, Tag):
            continue
        classes = _class_set(cell)
        if "ltx_flex_break" in classes or "ltx_flex_cell" not in classes:
            continue
        cap_el = cell.select_one("figcaption, .ltx_caption")
        caption_text = ""
        caption_html = ""
        if isinstance(cap_el, Tag):
            caption_text = _clean_text(cap_el)
            caption_html = str(cap_el)

        # Parse media from a caption-stripped clone of the cell.
        stripped = BeautifulSoup(str(cell), "lxml")
        for cap in stripped.select("figcaption, .ltx_caption"):
            cap.decompose()
        node = stripped.find("div", class_=re.compile(r"ltx_flex_cell")) or stripped.find(
            True
        )
        if not isinstance(node, Tag):
            continue
        parsed = _panel_kind_and_html(node)
        if parsed is None:
            continue
        kind, text, html = parsed
        panel: dict[str, str] = {"kind": kind, "text": text, "html": html}
        if caption_text:
            panel["caption_text"] = caption_text
            panel["caption_html"] = caption_html
        panels.append(panel)
    return panels if len(panels) >= 2 else []


def _caption_label_key(text: str) -> tuple[str, str] | None:
    m = re.match(
        r"^\s*(Figure|Fig\.?|Table|Tab\.?)\s*(\d+)\b",
        text or "",
        flags=re.I,
    )
    if not m:
        return None
    kind = "table" if m.group(1).lower().startswith("tab") else "figure"
    return kind, m.group(2)


def _reorder_detached_captions(structure: dict[str, Any]) -> dict[str, Any]:
    """Zip equal-length media+caption runs (Table5,Table6,Cap5,Cap6 → paired)."""

    def reorder(sents: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        i = 0
        n = len(sents)
        while i < n:
            kind = sents[i].get("kind")
            if kind not in {"figure", "table"}:
                out.append(sents[i])
                i += 1
                continue
            medias: list[dict[str, Any]] = []
            while i < n and sents[i].get("kind") in {"figure", "table"}:
                medias.append(sents[i])
                i += 1
            caps: list[dict[str, Any]] = []
            while i < n and sents[i].get("kind") == "caption":
                caps.append(sents[i])
                i += 1
            if len(caps) >= 2 and len(caps) == len(medias):
                for media, cap in zip(medias, caps):
                    out.append(media)
                    out.append(cap)
            else:
                out.extend(medias)
                out.extend(caps)
        return out

    out = dict(structure)
    sections = []
    for sec in structure.get("sections") or []:
        if not isinstance(sec, dict):
            sections.append(sec)
            continue
        sents = sec.get("sentences")
        if not isinstance(sents, list):
            sections.append(sec)
            continue
        sections.append({**sec, "sentences": reorder(sents)})
    out["sections"] = sections
    return out


def _paragraph_hosts(article: Tag) -> list[Tag]:
    hosts: list[Tag] = []
    for el in article.find_all(True):
        if not isinstance(el, Tag):
            continue
        classes = _class_set(el)
        name = (el.name or "").lower()
        if _is_heading(el):
            continue
        # Exact class token — never substring-match "ltx_p" against "ltx_para".
        if name == "p" or "ltx_p" in classes:
            hosts.append(el)
            continue
        if _is_caption(el):
            hosts.append(el)
            continue
        if _is_display_math(el):
            hosts.append(el)
            continue
        if _is_figure_or_table(el):
            hosts.append(el)
            continue
        if _is_bibitem(el):
            hosts.append(el)
            continue
        if name == "blockquote" or "ltx_blockquote" in classes:
            hosts.append(el)
    # Tag.__eq__ compares markup content — never use Tags in a set for membership.
    host_ids = {id(el) for el in hosts}

    def _nested_under_other_host(el: Tag) -> bool:
        for parent in el.parents:
            if id(parent) not in host_ids:
                continue
            # Keep figcaption even when the parent figure is also a host.
            if _is_caption(el) and _is_figure_or_table(parent):
                return False
            return True
        return False

    return [el for el in hosts if not _nested_under_other_host(el)]


def _extract_html_fragment(el: Tag) -> str:
    return "".join(str(c) for c in el.contents).strip() or str(el)


def _sentence_html_from_text(text: str) -> str:
    return f'<span class="sent-text">{escape(text)}</span>'


def _is_style_node(el: Tag) -> bool:
    name = (el.name or "").lower()
    if name in _STYLE_TAGS:
        return True
    return bool(_class_set(el) & _STYLE_CLASSES)


def _plain_text_fast(node: Tag) -> str:
    """Lightweight text for style matching — avoids _clean_text's per-node reparse."""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


def _collect_style_snippets(el: Tag) -> list[tuple[str, str]]:
    """Outermost styled spans: (plain_text, outer_html) for re-injection after split."""
    out: list[tuple[str, str]] = []
    for node in el.find_all(True):
        if not isinstance(node, Tag) or not _is_style_node(node):
            continue
        # Prefer outermost style wrappers within this host.
        nested = False
        for p in node.parents:
            if p is el:
                break
            if isinstance(p, Tag) and _is_style_node(p):
                nested = True
                break
        if nested:
            continue
        text = _plain_text_fast(node)
        if not text or len(text) < 2:
            continue
        # Skip wrappers that are mostly math/media — those are embeds already.
        if node.find("math") or node.find("img") or node.find("table"):
            continue
        out.append((text, str(node)))
    # Longer phrases first so overlaps wrap correctly.
    out.sort(key=lambda x: len(x[0]), reverse=True)
    return out


def _apply_style_snippets(part: str, html_out: str, styles: list[tuple[str, str]]) -> str:
    for text, node_html in styles:
        if text not in part:
            continue
        if node_html in html_out:
            continue
        esc = escape(text)
        idx = html_out.find(esc)
        if idx < 0:
            continue
        before = html_out[:idx]
        # Skip if this text is already inside an open style/emphasis tag.
        opens = list(
            re.finditer(
                r"<(span|strong|b|em|i|u|code|mark)\b([^>]*)>",
                before,
                flags=re.I,
            )
        )
        closes = list(
            re.finditer(r"</(span|strong|b|em|i|u|code|mark)>", before, flags=re.I)
        )
        depth = 0
        styled_depth = 0
        tokens = sorted(
            [(m.start(), "o", m) for m in opens] + [(m.start(), "c", m) for m in closes]
        )
        for _, kind, m in tokens:
            if kind == "o":
                depth += 1
                attrs = m.group(2) or ""
                tag = m.group(1).lower()
                if tag in _STYLE_TAGS or "ltx_font_" in attrs or "ltx_emph" in attrs:
                    styled_depth += 1
            else:
                depth = max(0, depth - 1)
                styled_depth = max(0, styled_depth - 1)
        if styled_depth > 0:
            continue
        html_out = html_out[:idx] + node_html + html_out[idx + len(esc) :]
    return html_out


def _flatten_with_embeds(el: Tag) -> tuple[str, list[dict[str, str]], str]:
    embeds: list[dict[str, str]] = []
    html_parts: list[str] = []
    text_parts: list[str] = []

    def walk(node: Tag | NavigableString) -> None:
        if isinstance(node, NavigableString):
            raw = unescape(str(node))
            if raw.strip():
                text_parts.append(raw)
            html_parts.append(escape(raw))
            return
        if not isinstance(node, Tag):
            return
        name = (node.name or "").lower()
        classes = " ".join(node.get("class") or [])
        class_set = _class_set(node)
        if name in {"annotation", "annotation-xml", "script", "style"}:
            return
        if "ltx_ERROR" in class_set or "ltx_nop" in class_set:
            return
        if name == "math" or "ltx_Math" in class_set or "ltx_equation" in class_set:
            idx = len(embeds)
            embeds.append({"id": f"m{idx}", "html": str(node)})
            token = f"⟦M{idx}⟧"
            text_parts.append(token)
            html_parts.append(
                f'<span class="sent-embed" data-embed="{idx}">{node!s}</span>'
            )
            return
        # Keep in-text figure/table/cite links through sentence splitting.
        href = str(node.get("href") or "")
        if name == "a" and ("ltx_ref" in class_set or href.startswith("#")):
            idx = len(embeds)
            embeds.append({"id": f"m{idx}", "html": str(node)})
            token = f"⟦M{idx}⟧"
            text_parts.append(token)
            html_parts.append(
                f'<span class="sent-embed" data-embed="{idx}">{node!s}</span>'
            )
            return
        if name == "img" or _is_figure_or_table(node) or name == "table":
            idx = len(embeds)
            embeds.append({"id": f"m{idx}", "html": str(node)})
            token = f"⟦M{idx}⟧"
            text_parts.append(token)
            html_parts.append(
                f'<span class="sent-embed" data-embed="{idx}">{node!s}</span>'
            )
            return
        # Preserve bold/italic/smallcaps/etc. wrappers in HTML.
        if _is_style_node(node):
            attrs = ""
            cls = node.get("class")
            if cls:
                attrs += f' class="{" ".join(cls)}"'
            html_parts.append(f"<{name}{attrs}>")
            for child in node.children:
                walk(child)  # type: ignore[arg-type]
            html_parts.append(f"</{name}>")
            return
        for child in node.children:
            walk(child)  # type: ignore[arg-type]

    walk(el)
    text = re.sub(r"\s+", " ", "".join(text_parts)).strip()
    html = "".join(html_parts).strip() or _extract_html_fragment(el)
    return text, embeds, html


@dataclass
class _OpenSection:
    id: str
    level: int
    anchor: str | None
    sentences: list[dict[str, Any]]


def build_reading_structure(
    html: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Build reading_structure dict and progress events:
      {type: progress, current, total, message}
      {type: done, sections, sentences}
    """
    events: list[dict[str, Any]] = []
    soup = BeautifulSoup(html, "lxml")
    article = (
        soup.find("article")
        or soup.find("div", class_=re.compile(r"ltx_page_main", re.I))
        or soup.body
    )
    title = "Untitled"
    title_el = soup.find("h1", class_=re.compile(r"title", re.I)) or soup.find("title")
    if title_el:
        title = re.sub(r"^\s*Title:\s*", "", _clean_text(title_el), flags=re.I) or title

    if article is None:
        structure = {"version": 1, "title": title, "sections": []}
        events.append({"type": "done", "sections": 0, "sentences": 0})
        return structure, events

    content_host_ids = {id(el) for el in _paragraph_hosts(article)}
    ordered: list[tuple[str, Tag]] = []
    seen: set[int] = set()
    for el in article.descendants:
        if not isinstance(el, Tag):
            continue
        key = id(el)
        if key in seen:
            continue
        if _is_heading(el):
            seen.add(key)
            classes = " ".join(el.get("class") or [])
            text = _clean_text(el)
            if "ltx_title_document" in classes or (
                title and text == title and el.name == "h1"
            ):
                ordered.append(("doc_title", el))
            else:
                ordered.append(("heading", el))
            continue
        if key in content_host_ids:
            if any(_is_heading(p) for p in el.parents if isinstance(p, Tag)):
                continue
            seen.add(key)
            if _is_caption(el):
                ordered.append(("caption", el))
            elif _is_display_math(el):
                ordered.append(("equation", el))
            elif _is_figure_or_table(el):
                kind = "table" if (
                    "ltx_table" in " ".join(el.get("class") or [])
                    or ((el.name or "").lower() == "table")
                ) and "ltx_figure" not in " ".join(el.get("class") or []) else "figure"
                ordered.append((kind, el))
            elif _is_bibitem(el):
                ordered.append(("reference", el))
            else:
                ordered.append(("prose", el))

    total = max(len(ordered), 1)
    sections: list[_OpenSection] = []
    current: _OpenSection | None = None
    sent_i = 0
    sec_i = 0
    consumed_caption_ids: set[int] = set()

    def ensure_section(level: int = 0, anchor: str | None = None) -> _OpenSection:
        nonlocal current, sec_i
        if current is None:
            sec_i += 1
            current = _OpenSection(
                id=f"sec-{sec_i}",
                level=level,
                anchor=anchor,
                sentences=[],
            )
            sections.append(current)
        return current

    def new_section(level: int, anchor: str | None) -> _OpenSection:
        nonlocal current, sec_i
        sec_i += 1
        current = _OpenSection(
            id=f"sec-{sec_i}",
            level=level,
            anchor=anchor,
            sentences=[],
        )
        sections.append(current)
        return current

    def add_sentence(
        sec: _OpenSection,
        *,
        kind: str,
        text: str,
        html: str,
        level: int | None = None,
        embeds: list[dict[str, str]] | None = None,
        para_start: bool = False,
    ) -> None:
        nonlocal sent_i
        text = (text or "").strip()
        if kind == "prose" and not text:
            return
        # Paragraph gap is its own unit (not CSS margin on the next prose).
        if para_start and kind == "prose" and sec.sentences:
            last_kind = sec.sentences[-1].get("kind")
            if last_kind not in {"heading", "spacer", "author"}:
                sent_i += 1
                sec.sentences.append(
                    {
                        "id": f"s-{sent_i}",
                        "kind": "spacer",
                        "text": "",
                        "html": '<div class="para-spacer" aria-hidden="true"></div>',
                    }
                )
        sent_i += 1
        if kind == "spacer":
            sec.sentences.append(
                {
                    "id": f"s-{sent_i}",
                    "kind": "spacer",
                    "text": "",
                    "html": html
                    or '<div class="para-spacer" aria-hidden="true"></div>',
                }
            )
            return
        item: dict[str, Any] = {
            "id": f"s-{sent_i}",
            "kind": kind,
            "text": text or html,
            "html": html or _sentence_html_from_text(text),
        }
        if level is not None:
            item["level"] = level
        if embeds:
            item["embeds"] = embeds
        sec.sentences.append(item)

    authors_el = soup.select_one(".ltx_authors")

    for idx, (kind, el) in enumerate(ordered):
        events.append(
            {
                "type": "progress",
                "current": idx + 1,
                "total": total,
                "message": f"解析结构 {idx + 1}/{total}",
            }
        )
        if kind == "doc_title":
            sec = new_section(level=1, anchor=_heading_anchor(el) or "title")
            text = _clean_text(el)
            add_sentence(
                sec,
                kind="heading",
                text=text,
                html=str(el),
                level=1,
            )
            if authors_el:
                atext = _clean_text(authors_el)
                if atext:
                    add_sentence(
                        sec,
                        kind="author",
                        text=atext,
                        html=str(authors_el),
                    )
                for person in authors_el.select(".ltx_personname"):
                    pname = _clean_text(person)
                    if pname and pname != atext:
                        add_sentence(
                            sec,
                            kind="author",
                            text=pname,
                            html=str(person),
                        )
            continue

        if kind == "heading":
            level = _heading_level(el)
            anchor = _heading_anchor(el)
            text = _clean_text(el)
            if not text:
                continue
            sec = new_section(level=level, anchor=anchor)
            add_sentence(
                sec,
                kind="heading",
                text=text,
                html=str(el),
                level=level,
            )
            continue

        sec = ensure_section()
        if kind == "caption":
            if id(el) in consumed_caption_ids:
                continue
            text, embeds, _frag = _flatten_with_embeds(el)
            if text:
                add_sentence(
                    sec,
                    kind="caption",
                    text=text,
                    html=str(el),
                    embeds=embeds or None,
                )
            continue
        if kind == "equation":
            add_sentence(
                sec,
                kind="equation",
                text=_clean_text(el) or "[equation]",
                html=str(el),
            )
            continue
        if kind in {"figure", "table"}:
            panels = _flex_figure_panels(el)
            if panels:
                # Captions inside flex cells are emitted with their panel.
                for cap in el.select("figcaption, .ltx_caption"):
                    if any(
                        isinstance(p, Tag) and "ltx_flex_cell" in _class_set(p)
                        for p in cap.parents
                    ):
                        consumed_caption_ids.add(id(cap))
                for panel in panels:
                    add_sentence(
                        sec,
                        kind=panel["kind"],
                        text=panel["text"],
                        html=panel["html"],
                    )
                    cap_text = (panel.get("caption_text") or "").strip()
                    if cap_text:
                        cap_html = panel.get("caption_html") or ""
                        cap_embeds: list[dict[str, str]] | None = None
                        flat_text = cap_text
                        if cap_html and "<math" in cap_html.lower():
                            cap_soup = BeautifulSoup(cap_html, "lxml")
                            cap_root = (
                                cap_soup.find("figcaption")
                                or cap_soup.find(class_="ltx_caption")
                                or cap_soup.find(True)
                            )
                            if isinstance(cap_root, Tag):
                                flat_text, cap_embeds, _ = _flatten_with_embeds(
                                    cap_root
                                )
                                flat_text = flat_text or cap_text
                        add_sentence(
                            sec,
                            kind="caption",
                            text=flat_text,
                            html=cap_html,
                            embeds=cap_embeds or None,
                        )
                continue
            html = _figure_html_without_caption(el)
            add_sentence(
                sec,
                kind=kind,
                text=_clean_text(BeautifulSoup(html, "lxml")) or f"[{kind}]",
                html=html,
            )
            continue
        if kind == "reference":
            text = _clean_text(el)
            if text:
                add_sentence(sec, kind="reference", text=text, html=str(el))
            continue

        text, embeds, frag_html = _flatten_with_embeds(el)
        styles = _collect_style_snippets(el)
        parts = split_sentences(text)
        if not parts and text:
            parts = [text]
        if len(parts) <= 1:
            if text:
                html_out = frag_html or _sentence_html_from_text(text)
                if "ltx_font_" not in html_out and "ltx_emph" not in html_out:
                    html_out = _apply_style_snippets(
                        text, html_out if "<" in html_out else _sentence_html_from_text(text), styles
                    )
                add_sentence(
                    sec,
                    kind="prose",
                    text=text,
                    html=html_out,
                    embeds=embeds or None,
                    para_start=True,
                )
        else:
            for i, part in enumerate(parts):
                used: list[dict[str, str]] = []
                for emb in embeds:
                    token = f"⟦M{emb['id'][1:]}⟧"
                    if token in part:
                        used.append(emb)
                html_out = _sentence_html_from_text(part)
                html_out = _apply_style_snippets(part, html_out, styles)
                for emb in used:
                    token = f"⟦M{emb['id'][1:]}⟧"
                    html_out = html_out.replace(
                        escape(token),
                        f'<span class="sent-embed">{emb["html"]}</span>',
                    )
                add_sentence(
                    sec,
                    kind="prose",
                    text=part,
                    html=html_out,
                    embeds=used or None,
                    para_start=(i == 0),
                )

    sections = [s for s in sections if s.sentences]
    structure = {
        "version": STRUCTURE_VERSION,
        "title": title,
        "sections": [
            {
                "id": s.id,
                "level": s.level,
                "anchor": s.anchor,
                "sentences": s.sentences,
            }
            for s in sections
        ],
    }
    n_sent = sum(len(s.sentences) for s in sections)
    events.append({"type": "done", "sections": len(sections), "sentences": n_sent})
    return structure, events


def iter_structure_progress(html: str) -> Iterator[dict[str, Any]]:
    structure, events = build_reading_structure(html)
    for ev in events:
        if ev["type"] == "done":
            yield {**ev, "structure": structure}
        else:
            yield ev


def structure_to_outline(structure: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sec in structure.get("sections") or []:
        for sent in sec.get("sentences") or []:
            if sent.get("kind") != "heading":
                continue
            out.append(
                {
                    "id": sent["id"],
                    "sectionId": sec["id"],
                    "type": "heading",
                    "level": sent.get("level") or sec.get("level") or 2,
                    "text": sent.get("text") or "",
                    "anchor": sec.get("anchor"),
                }
            )
            break
    return out



def _sentence_fingerprint(sent: dict[str, Any]) -> tuple[str, str]:
    return (str(sent.get("kind") or ""), (sent.get("text") or "")[:240])


def _section_fingerprint(sec: dict[str, Any]) -> str:
    for sent in sec.get("sentences") or []:
        if sent.get("kind") == "heading":
            return (sent.get("text") or "").strip()
    return str(sec.get("anchor") or sec.get("id") or "")


def _next_sentence_num(structure: dict[str, Any]) -> int:
    n = 0
    for sec in structure.get("sections") or []:
        for sent in sec.get("sentences") or []:
            sid = str(sent.get("id") or "")
            if sid.startswith("s-"):
                try:
                    n = max(n, int(sid[2:]))
                except ValueError:
                    pass
    return n + 1


def _next_section_num(structure: dict[str, Any]) -> int:
    n = 0
    for sec in structure.get("sections") or []:
        sid = str(sec.get("id") or "")
        if sid.startswith("sec-"):
            try:
                n = max(n, int(sid[4:]))
            except ValueError:
                pass
    return n + 1


def _ensure_unique_ids(structure: dict[str, Any]) -> dict[str, Any]:
    """Force unique section/sentence ids (repair collisions from remaps)."""
    used_sec: set[str] = set()
    used_sent: set[str] = set()
    next_sec = _next_section_num(structure)
    next_sent = _next_sentence_num(structure)
    for sec in structure.get("sections") or []:
        sid = str(sec.get("id") or "")
        if not sid or sid in used_sec:
            sid = f"sec-{next_sec}"
            next_sec += 1
            sec["id"] = sid
        used_sec.add(sid)
        for sent in sec.get("sentences") or []:
            tid = str(sent.get("id") or "")
            if not tid or tid in used_sent:
                tid = f"s-{next_sent}"
                next_sent += 1
                sent["id"] = tid
            used_sent.add(tid)
    return structure


def remap_structure_ids(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Reuse old sentence/section ids where fingerprints match (preserve translations)."""
    from copy import deepcopy

    out = deepcopy(new)
    old_sent_queues: dict[tuple[str, str], list[str]] = {}
    for sec in old.get("sections") or []:
        for sent in sec.get("sentences") or []:
            fp = _sentence_fingerprint(sent)
            old_sent_queues.setdefault(fp, []).append(str(sent.get("id") or ""))

    # Queue per fingerprint so two new sections never share one old id.
    old_sec_queues: dict[str, list[str]] = {}
    for sec in old.get("sections") or []:
        sfp = _section_fingerprint(sec)
        if sfp:
            old_sec_queues.setdefault(sfp, []).append(str(sec.get("id") or ""))

    next_n = _next_sentence_num(old)
    next_sec = _next_section_num(old)
    for sec in out.get("sections") or []:
        sfp = _section_fingerprint(sec)
        queue = old_sec_queues.get(sfp) if sfp else None
        if queue:
            sec["id"] = queue.pop(0)
        else:
            sec["id"] = f"sec-{next_sec}"
            next_sec += 1
        for sent in sec.get("sentences") or []:
            fp = _sentence_fingerprint(sent)
            sq = old_sent_queues.get(fp) or []
            if sq:
                sent["id"] = sq.pop(0)
            else:
                sent["id"] = f"s-{next_n}"
                next_n += 1
    out["version"] = STRUCTURE_VERSION
    return _ensure_unique_ids(out)


def _next_sentence_index(structure: dict[str, Any]) -> int:
    max_n = 0
    for sec in structure.get("sections") or []:
        for sent in sec.get("sentences") or []:
            sid = str(sent.get("id") or "")
            if sid.startswith("s-"):
                try:
                    max_n = max(max_n, int(sid[2:]))
                except ValueError:
                    pass
    return max_n + 1


def _inject_bibliography_references(
    html: str, structure: dict[str, Any]
) -> dict[str, Any]:
    """Attach ar5iv .ltx_bibitem entries under the References heading (v5)."""
    out = json.loads(json.dumps(structure))
    soup = BeautifulSoup(html, "lxml")
    items = soup.select(".ltx_bibitem")
    if not items:
        out["version"] = STRUCTURE_VERSION
        return out

    ref_sec: dict[str, Any] | None = None
    for sec in out.get("sections") or []:
        for sent in sec.get("sentences") or []:
            if sent.get("kind") != "heading":
                continue
            title = (sent.get("text") or "").strip().lower()
            if "reference" in title or "bibliograph" in title:
                ref_sec = sec
                break
        if ref_sec is not None:
            break

    if ref_sec is None:
        heading = soup.select_one(
            ".ltx_title_bibliography, .ltx_bibliography .ltx_title"
        )
        heading_text = _clean_text(heading) if heading else "References"
        heading_html = str(heading) if heading else f"<h2>{escape(heading_text)}</h2>"
        next_sec = 1
        for sec in out.get("sections") or []:
            sid = str(sec.get("id") or "")
            if sid.startswith("sec-"):
                try:
                    next_sec = max(next_sec, int(sid[4:]) + 1)
                except ValueError:
                    pass
        n = _next_sentence_index(out)
        ref_sec = {
            "id": f"sec-{next_sec}",
            "level": 2,
            "anchor": "bib",
            "sentences": [
                {
                    "id": f"s-{n}",
                    "kind": "heading",
                    "text": heading_text,
                    "html": heading_html,
                    "level": 2,
                }
            ],
        }
        out.setdefault("sections", []).append(ref_sec)

    ref_sec["sentences"] = [
        s for s in (ref_sec.get("sentences") or []) if s.get("kind") != "reference"
    ]
    n = _next_sentence_index(out)
    for el in items:
        text = _clean_text(el)
        if not text:
            continue
        ref_sec["sentences"].append(
            {
                "id": f"s-{n}",
                "kind": "reference",
                "text": text,
                "html": str(el),
            }
        )
        n += 1
    out["version"] = max(int(out.get("version") or 1), 5)
    return out


def _convert_parastart_to_spacers(structure: dict[str, Any]) -> dict[str, Any]:
    """Replace paraStart CSS gaps with explicit spacer sentence units (v6)."""
    out = json.loads(json.dumps(structure))
    n = _next_sentence_index(out)
    for sec in out.get("sections") or []:
        rebuilt: list[dict[str, Any]] = []
        for sent in sec.get("sentences") or []:
            if sent.get("paraStart") and sent.get("kind") == "prose":
                if rebuilt and rebuilt[-1].get("kind") not in {
                    "heading",
                    "spacer",
                    "author",
                }:
                    rebuilt.append(
                        {
                            "id": f"s-{n}",
                            "kind": "spacer",
                            "text": "",
                            "html": '<div class="para-spacer" aria-hidden="true"></div>',
                        }
                    )
                    n += 1
                sent = {k: v for k, v in sent.items() if k != "paraStart"}
            rebuilt.append(sent)
        sec["sentences"] = rebuilt
    out["version"] = max(int(out.get("version") or 1), 6)
    return out


def _split_composite_figure_units(structure: dict[str, Any]) -> dict[str, Any]:
    """Split figure/table units that embed both a table and an image (v7)."""
    out = json.loads(json.dumps(structure))
    n = _next_sentence_index(out)
    for sec in out.get("sections") or []:
        rebuilt: list[dict[str, Any]] = []
        for sent in sec.get("sentences") or []:
            kind = sent.get("kind")
            html = sent.get("html") or ""
            if kind not in {"figure", "table"} or (
                "<table" not in html.lower() or "<img" not in html.lower()
            ):
                rebuilt.append(sent)
                continue
            soup = BeautifulSoup(html, "lxml")
            root = soup.find("figure") or soup.find("div") or soup.find(True)
            panels = _flex_figure_panels(root) if isinstance(root, Tag) else []
            if len(panels) < 2:
                # Fallback: peel table + first image even without flex wrapper.
                table = soup.find("table")
                img = soup.find("img")
                panels = []
                if table is not None:
                    panels.append(
                        {
                            "kind": "table",
                            "text": _clean_text(table) or "[table]",
                            "html": str(table),
                        }
                    )
                if img is not None:
                    panels.append(
                        {
                            "kind": "figure",
                            "text": (img.get("alt") or "").strip() or "[figure]",
                            "html": str(img),
                        }
                    )
            if len(panels) < 2:
                rebuilt.append(sent)
                continue
            for i, panel in enumerate(panels):
                if i == 0:
                    rebuilt.append(
                        {
                            **sent,
                            "kind": panel["kind"],
                            "text": panel["text"],
                            "html": panel["html"],
                        }
                    )
                else:
                    rebuilt.append(
                        {
                            "id": f"s-{n}",
                            "kind": panel["kind"],
                            "text": panel["text"],
                            "html": panel["html"],
                        }
                    )
                    n += 1
        sec["sentences"] = rebuilt
    out["version"] = max(int(out.get("version") or 1), 7)
    return out


def _reinject_inline_styles(html: str, structure: dict[str, Any]) -> dict[str, Any]:
    """Restore bold/italic/etc. snippets into plain prose units (v8)."""
    out = json.loads(json.dumps(structure))
    soup = BeautifulSoup(html, "lxml")
    article = (
        soup.find("article")
        or soup.find("div", class_=re.compile(r"ltx_page_main", re.I))
        or soup.body
    )
    if article is None:
        out["version"] = max(int(out.get("version") or 1), 8)
        return out

    snippets: list[tuple[str, str]] = []
    seen: set[str] = set()
    for node in article.find_all(True):
        if not isinstance(node, Tag) or not _is_style_node(node):
            continue
        nested = False
        for p in node.parents:
            if p is article:
                break
            if isinstance(p, Tag) and _is_style_node(p):
                nested = True
                break
        if nested:
            continue
        if node.find("math") or node.find("img") or node.find("table"):
            continue
        text = _plain_text_fast(node)
        if not text or len(text) < 2 or text in seen:
            continue
        # Skip huge wrappers (near whole paragraphs).
        if len(text) > 180:
            continue
        seen.add(text)
        snippets.append((text, str(node)))
    snippets.sort(key=lambda x: len(x[0]), reverse=True)

    for sec in out.get("sections") or []:
        for sent in sec.get("sentences") or []:
            if sent.get("kind") != "prose":
                continue
            text = sent.get("text") or ""
            if not text:
                continue
            html_out = sent.get("html") or ""
            if not html_out or html_out == text:
                html_out = _sentence_html_from_text(text)
            cand = [s for s in snippets if s[0] in text]
            if not cand:
                continue
            sent["html"] = _apply_style_snippets(text, html_out, cand)

    out["version"] = max(int(out.get("version") or 1), 8)
    return out


def _extract_caption_embeds(structure: dict[str, Any]) -> dict[str, Any]:
    """Pull inline math (etc.) out of caption HTML into embeds + ⟦Mn⟧ text (v10)."""
    out = json.loads(json.dumps(structure))
    for sec in out.get("sections") or []:
        for sent in sec.get("sentences") or []:
            if sent.get("kind") != "caption":
                continue
            html = sent.get("html") or ""
            if "<math" not in html.lower() and "ltx_Math" not in html:
                continue
            if sent.get("embeds") and "⟦M" in (sent.get("text") or ""):
                continue
            soup = BeautifulSoup(html, "lxml")
            root = (
                soup.find("figcaption")
                or soup.find(class_="ltx_caption")
                or soup.find(True)
            )
            if not isinstance(root, Tag):
                continue
            text, embeds, _frag = _flatten_with_embeds(root)
            if not embeds:
                continue
            sent["embeds"] = embeds
            if text:
                sent["text"] = text
    out["version"] = max(int(out.get("version") or 1), 10)
    return out


def ensure_reading_structure(
    html: str, existing: dict[str, Any] | None
) -> tuple[dict[str, Any], bool]:
    """Build or upgrade structure to STRUCTURE_VERSION. Returns (structure, changed)."""
    ver = int(existing.get("version") or 1) if existing else 0
    if existing and ver >= STRUCTURE_VERSION:
        # Still repair accidental duplicate ids from older remaps.
        before = json.dumps(
            [(s.get("id"), [x.get("id") for x in s.get("sentences") or []]) for s in (existing.get("sections") or [])],
            ensure_ascii=False,
        )
        fixed = _ensure_unique_ids(existing)
        after = json.dumps(
            [(s.get("id"), [x.get("id") for x in s.get("sentences") or []]) for s in (fixed.get("sections") or [])],
            ensure_ascii=False,
        )
        return fixed, before != after
    # v4+: cheap upgrades — avoid full rebuild on large HTML.
    if existing and ver >= 4:
        out = existing
        if ver < 5:
            out = _inject_bibliography_references(html, out)
        if ver < 6:
            out = _convert_parastart_to_spacers(out)
        if ver < 7:
            out = _split_composite_figure_units(out)
        if ver < 8:
            out = _reinject_inline_styles(html, out)
        if ver < 9:
            out = _reorder_detached_captions(out)
        if ver < 10:
            out = _extract_caption_embeds(out)
        out["version"] = STRUCTURE_VERSION
        return _ensure_unique_ids(out), True
    fresh, _ = build_reading_structure(html)
    if not existing:
        return _ensure_unique_ids(fresh), True
    return remap_structure_ids(existing, fresh), True

