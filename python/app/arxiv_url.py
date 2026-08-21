from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

_ARXIV_ID_RE = re.compile(
    r"(?P<id>(?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)",
    re.IGNORECASE,
)


class UnsupportedUrlError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedArxivUrl:
    arxiv_id: str  # without version preferred for folder
    arxiv_id_raw: str
    canonical_abs: str
    ar5iv_html: str


def _strip_version(arxiv_id: str) -> str:
    return re.sub(r"v\d+$", "", arxiv_id, flags=re.IGNORECASE)


def parse_arxiv_url(url: str) -> ParsedArxivUrl:
    text = (url or "").strip()
    if not text:
        raise UnsupportedUrlError("链接不能为空")

    if not re.match(r"^https?://", text, re.IGNORECASE):
        text = "https://" + text

    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    path = parsed.path or ""

    if host in {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}:
        m = re.search(
            r"/(abs|pdf|html|ps|e-print|ftp)/([^/?#]+)",
            path,
            re.IGNORECASE,
        )
        if not m:
            # bare id in path?
            m2 = _ARXIV_ID_RE.search(path)
            if not m2:
                raise UnsupportedUrlError("无法从 arxiv 链接解析论文 id")
            raw_id = m2.group("id")
        else:
            raw_id = m.group(2)
            if raw_id.lower().endswith(".pdf"):
                raw_id = raw_id[:-4]
    elif host in {"ar5iv.labs.arxiv.org", "ar5iv.org"}:
        m = re.search(r"/html/([^/?#]+)", path, re.IGNORECASE)
        if not m:
            raise UnsupportedUrlError("无法从 ar5iv 链接解析论文 id")
        raw_id = m.group(1)
    else:
        raise UnsupportedUrlError("暂未支持：目前仅支持 arxiv.org 或 ar5iv 链接")

    raw_id = raw_id.strip().strip("/")
    if not _ARXIV_ID_RE.fullmatch(raw_id):
        # allow path-style old ids already captured
        if not _ARXIV_ID_RE.search(raw_id):
            raise UnsupportedUrlError(f"无效的 arXiv id：{raw_id}")

    base_id = _strip_version(raw_id)
    return ParsedArxivUrl(
        arxiv_id=base_id,
        arxiv_id_raw=raw_id,
        canonical_abs=f"https://arxiv.org/abs/{base_id}",
        ar5iv_html=f"https://ar5iv.labs.arxiv.org/html/{base_id}",
    )
