from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

ProgressCb = Callable[[float, str], None]

_ASSET_ATTRS = (
    ("img", "src"),
    ("image", "href"),  # svg image
    ("source", "src"),
    ("video", "src"),
    ("audio", "src"),
    ("use", "href"),
    ("object", "data"),
)


def convert_graphics_objects(soup: BeautifulSoup) -> int:
    """Turn ar5iv <object type=image/… data=…> into <img src=…> (keep graphics).

    Returns number of objects converted. Non-image objects are left for callers
    to strip.
    """
    converted = 0
    for obj in list(soup.find_all("object")):
        if not isinstance(obj, Tag):
            continue
        data = (obj.get("data") or "").strip()
        typ = (obj.get("type") or "").lower()
        classes = " ".join(obj.get("class") or [])
        is_image = (
            typ.startswith("image/")
            or "ltx_graphics" in classes
            or bool(re.search(r"\.(svg|png|jpe?g|gif|webp)(?:\?|$)", data, re.I))
        )
        if not data or not is_image:
            continue
        img = soup.new_tag("img")
        img["src"] = data
        for attr in ("width", "height", "id", "alt", "class", "style"):
            if obj.get(attr):
                img[attr] = obj.get(attr)
        if not img.get("alt"):
            img["alt"] = "Refer to caption"
        cls = list(obj.get("class") or [])
        if "ltx_graphics" not in cls:
            cls.append("ltx_graphics")
        img["class"] = cls
        obj.replace_with(img)
        converted += 1
    return converted


def _safe_relpath(url_path: str) -> str:
    path = urlparse(url_path).path or url_path
    path = path.lstrip("/")
    path = re.sub(r"^html/[^/]+/", "", path)
    path = path.replace("\\", "/")
    parts = [p for p in path.split("/") if p and p not in {".", ".."}]
    # ar5iv paths often start with assets/; files already live under assets_dir
    if parts and parts[0] == "assets":
        parts = parts[1:]
    if not parts:
        digest = hashlib.sha1(url_path.encode("utf-8")).hexdigest()[:12]
        return f"misc/{digest}"
    return "/".join(parts)


def localize_ar5iv_html(
    html: str,
    *,
    page_url: str,
    assets_dir: Path,
    on_progress: ProgressCb | None = None,
) -> str:
    """Download images/assets and rewrite article HTML to local relative paths."""
    soup = BeautifulSoup(html, "lxml")
    # Preserve figure SVGs: ar5iv often uses <object type="image/svg+xml">.
    convert_graphics_objects(soup)
    for tag in soup.find_all(["script", "iframe", "embed"]):
        tag.decompose()
    for tag in list(soup.find_all("object")):
        tag.decompose()

    article = soup.find("article")
    if article is None:
        article = soup.find("div", class_=re.compile(r"ltx_page_main", re.I))
    if article is None:
        article = soup.body
    if article is None:
        raise ValueError("无法从 ar5iv HTML 提取正文")

    # Stable anchors for abstract / sections missing ids on headings.
    for abstract in article.select(".ltx_abstract"):
        if not abstract.get("id"):
            abstract["id"] = "abstract"
    for title_el in article.select(".ltx_title_abstract"):
        parent = title_el.find_parent(class_="ltx_abstract")
        if parent is not None and not parent.get("id"):
            parent["id"] = "abstract"

    # Ensure bibliography shows numeric labels matching in-text cites.
    for i, item in enumerate(article.select(".ltx_bibitem"), start=1):
        bid = str(item.get("id") or "")
        m = re.search(r"bib\.?bib(\d+)\s*$", bid, re.I)
        if not m:
            m = re.search(r"(\d+)\s*$", bid)
        num = m.group(1) if m else str(i)
        tag = item.select_one(".ltx_tag_bibitem, .ltx_tag.ltx_role_refnum, .ltx_tag")
        label = f"[{num}]"
        if tag is not None:
            tag.clear()
            tag.append(label)
        else:
            new_tag = soup.new_tag(
                "span",
                attrs={"class": "ltx_tag ltx_role_refnum ltx_tag_bibitem"},
            )
            new_tag.string = label
            item.insert(0, new_tag)

    # Enrich citation titles from bibliography for hover tooltips.
    bib_titles: dict[str, str] = {}
    for bib in soup.select(".ltx_bibliography [id], .ltx_biblist [id]"):
        bid = bib.get("id")
        if not bid:
            continue
        text = " ".join(bib.get_text(" ", strip=True).split())
        if text:
            bib_titles[bid] = text[:300]
    for a in article.select("a.ltx_ref[href^='#']"):
        href = a.get("href") or ""
        target = href[1:]
        if target in bib_titles and not (a.get("title") or "").strip():
            a["title"] = bib_titles[target]

    origin = f"{urlparse(page_url).scheme}://{urlparse(page_url).netloc}"
    base = page_url if page_url.endswith("/") else page_url.rsplit("/", 1)[0] + "/"

    to_fetch: list[tuple[Tag, str, str]] = []  # tag, attr, abs_url
    seen_urls: set[str] = set()

    def enqueue(tag: Tag, attr: str, raw: str | None) -> None:
        if not raw or raw.startswith("data:") or raw.startswith("#"):
            return
        abs_url = urljoin(base, raw)
        if abs_url.startswith("//"):
            abs_url = "https:" + abs_url
        if not abs_url.startswith("http"):
            # site-root path like /assets/...
            if raw.startswith("/"):
                abs_url = origin + raw
            else:
                return
        # only ar5iv / arxiv hosts
        host = (urlparse(abs_url).hostname or "").lower()
        if "arxiv.org" not in host and "ar5iv" not in host:
            return
        to_fetch.append((tag, attr, abs_url))
        seen_urls.add(abs_url)

    for name, attr in _ASSET_ATTRS:
        for tag in article.select(f"{name}[{attr}]"):
            enqueue(tag, attr, tag.get(attr))
        # xlink:href
        for tag in article.select(f"{name}[xlink\\:href]"):
            enqueue(tag, "xlink:href", tag.get("xlink:href"))

    # CSS background images in style attrs are rare; skip for MVP.

    assets_dir.mkdir(parents=True, exist_ok=True)
    url_to_rel: dict[str, str] = {}
    total = max(len(to_fetch), 1)

    with httpx.Client(follow_redirects=True, timeout=120.0) as client:
        for i, (tag, attr, abs_url) in enumerate(to_fetch):
            if abs_url in url_to_rel:
                tag[attr] = url_to_rel[abs_url]
                continue
            rel = _safe_relpath(abs_url)
            # preserve extension from URL
            parsed_path = urlparse(abs_url).path
            if "." not in Path(rel).name and "." in Path(parsed_path).name:
                rel = f"{rel}{Path(parsed_path).suffix}"
            dest = assets_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.is_file():
                if on_progress:
                    on_progress(
                        0.7 + 0.25 * (i / total),
                        f"下载资源 {i + 1}/{len(to_fetch)}",
                    )
                try:
                    resp = client.get(
                        abs_url,
                        headers={"User-Agent": "paper-reading/0.1"},
                    )
                    resp.raise_for_status()
                    dest.write_bytes(resp.content)
                except Exception:
                    # leave original remote URL if download fails
                    continue
            local_ref = f"assets/{rel}"
            url_to_rel[abs_url] = local_ref
            tag[attr] = local_ref

    # Remove remote stylesheets from fragment; reader uses local CSS.
    for link in article.select("link"):
        link.decompose()

    # Ensure IDs usable for in-page jumps.
    article_html = article.decode_contents() if isinstance(article, Tag) else str(article)
    wrapped = (
        f'<div class="ar5iv-article ltx_document" data-paper-root="1">'
        f"{article_html}"
        f"</div>"
    )
    if on_progress:
        on_progress(0.96, "资源本地化完成")
    return wrapped
