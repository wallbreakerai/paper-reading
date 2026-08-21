from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from html import unescape

from bs4 import BeautifulSoup, NavigableString, Tag


@dataclass
class Block:
    id: str
    type: str  # title | heading | paragraph | author | other
    level: int
    text: str
    anchor: str | None = None


def _clean_text(node: Tag | NavigableString) -> str:
    if isinstance(node, NavigableString):
        return unescape(str(node))
    # Clone-ish: remove MathML annotations that leak TeX source like \times
    clone = BeautifulSoup(str(node), "lxml")
    root = clone.body or clone
    for bad in root.select(
        "annotation, annotation-xml, .ltx_nop, .ltx_ERROR, script, style"
    ):
        bad.decompose()
    text = root.get_text(" ", strip=True)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    # Drop leftover TeX commands that occasionally survive
    text = re.sub(r"\\[a-zA-Z]+\b", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _heading_level(el: Tag) -> int:
    classes = " ".join(el.get("class") or [])
    mapping = (
        ("ltx_title_part", 1),
        ("ltx_title_chapter", 1),
        ("ltx_title_section", 2),
        ("ltx_title_subsection", 3),
        ("ltx_title_subsubsection", 4),
        ("ltx_title_paragraph", 5),
        ("ltx_title_subparagraph", 6),
        ("ltx_title_abstract", 2),
    )
    for token, level in mapping:
        if token in classes:
            return level
    name = (el.name or "").lower()
    if len(name) == 2 and name[0] == "h" and name[1].isdigit():
        return int(name[1])
    return 2


def _heading_anchor(el: Tag) -> str | None:
    if el.get("id"):
        return str(el.get("id"))
    classes = " ".join(el.get("class") or [])
    if "ltx_title_abstract" in classes:
        parent = el.find_parent(class_="ltx_abstract")
        if isinstance(parent, Tag):
            if not parent.get("id"):
                parent["id"] = "abstract"
            return str(parent.get("id"))
        return "abstract"
    for parent in el.parents:
        if not isinstance(parent, Tag):
            continue
        if parent.name == "article":
            break
        pid = parent.get("id")
        if not pid:
            continue
        pclasses = " ".join(parent.get("class") or [])
        if parent.name == "section" or any(
            tok in pclasses
            for tok in (
                "ltx_section",
                "ltx_subsection",
                "ltx_subsubsection",
                "ltx_paragraph",
                "ltx_abstract",
            )
        ):
            return str(pid)
    return None


def parse_ar5iv_html(html: str) -> tuple[str, list[Block], list[str]]:
    """Return title, outline/LLM blocks, and author names."""
    soup = BeautifulSoup(html, "lxml")
    title = ""
    title_el = soup.find("h1", class_=re.compile(r"title", re.I))
    if not title_el:
        title_el = soup.find("title")
    if title_el:
        title = _clean_text(title_el)
        title = re.sub(r"^\s*Title:\s*", "", title, flags=re.I)

    authors: list[str] = []
    for person in soup.select(".ltx_authors .ltx_personname, .ltx_creator .ltx_personname"):
        name = _clean_text(person)
        if name and name not in authors:
            authors.append(name)
    if not authors:
        authors_el = soup.select_one(".ltx_authors")
        if authors_el:
            raw = _clean_text(authors_el)
            parts = re.split(r"\s{2,}|;|\band\b", raw)
            authors = [p.strip() for p in parts if len(p.strip()) > 1][:12]

    article = soup.find("article") or soup.find(
        "div", class_=re.compile(r"ltx_page_main", re.I)
    ) or soup.body
    if article is None:
        return title or "Untitled", [], authors

    blocks: list[Block] = []
    idx = 0

    def add(
        block_type: str,
        level: int,
        text: str,
        *,
        anchor: str | None = None,
    ) -> None:
        nonlocal idx
        text = text.strip()
        if not text:
            return
        idx += 1
        blocks.append(
            Block(
                id=f"b{idx}",
                type=block_type,
                level=level,
                text=text,
                anchor=anchor,
            )
        )

    if title:
        add("title", 1, title)
    if authors:
        add("author", 0, " · ".join(authors))

    candidates = article.find_all(["h1", "h2", "h3", "h4", "h5", "h6"], recursive=True)
    seen: set[str] = set()
    for el in candidates:
        if not isinstance(el, Tag):
            continue
        classes = " ".join(el.get("class") or [])
        # Skip theorem/lemma run-in titles from outline noise
        if "ltx_runin" in classes or "ltx_title_theorem" in classes:
            continue
        if "ltx_title" not in classes and el.name.lower() not in {
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
        }:
            continue
        level = _heading_level(el)
        text = _clean_text(el)
        if title and text == title:
            continue
        key = f"h:{text}"
        if key in seen:
            continue
        seen.add(key)
        add("heading", level, text, anchor=_heading_anchor(el))

    if not blocks and title:
        add("title", 1, title)

    return title or (blocks[0].text if blocks else "Untitled"), blocks, authors


def blocks_to_jsonable(blocks: list[Block]) -> list[dict]:
    return [asdict(b) for b in blocks]


def concat_blocks_text(title: str, blocks: list[dict] | list[Block], max_chars: int) -> str:
    parts: list[str] = []
    if title:
        parts.append(f"Title: {title}")
    for b in blocks:
        if isinstance(b, Block):
            text = b.text
            btype = b.type
        else:
            text = str(b.get("text") or "")
            btype = str(b.get("type") or "")
        if not text:
            continue
        if btype == "heading":
            parts.append(f"\n## {text}\n")
        elif btype in {"title", "author"}:
            if btype == "author":
                parts.append(f"Authors: {text}")
            continue
        else:
            parts.append(text)
    joined = "\n\n".join(parts).strip()
    if len(joined) <= max_chars:
        return joined
    return joined[: max_chars - 1] + "…"
