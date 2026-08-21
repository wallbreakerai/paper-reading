from __future__ import annotations

import pytest

from app.arxiv_url import UnsupportedUrlError, parse_arxiv_url
from app.parser import concat_blocks_text


def test_parse_arxiv_abs():
    p = parse_arxiv_url("https://arxiv.org/abs/1706.03762")
    assert p.arxiv_id == "1706.03762"
    assert p.ar5iv_html.endswith("/html/1706.03762")


def test_parse_arxiv_pdf_version():
    p = parse_arxiv_url("https://arxiv.org/pdf/1706.03762v7.pdf")
    assert p.arxiv_id == "1706.03762"


def test_parse_ar5iv():
    p = parse_arxiv_url("https://ar5iv.labs.arxiv.org/html/1706.03762")
    assert p.arxiv_id == "1706.03762"


@pytest.mark.parametrize(
    "url",
    [
        "https://arxiv.org/pdf/2205.14135",
        "https://ar5iv.labs.arxiv.org/html/2205.14135",
        "https://arxiv.org/abs/2205.14135",
        "https://arxiv.org/pdf/2205.14135.pdf",
    ],
)
def test_parse_supported_forms(url: str):
    p = parse_arxiv_url(url)
    assert p.arxiv_id == "2205.14135"
    assert p.canonical_abs == "https://arxiv.org/abs/2205.14135"
    assert p.ar5iv_html == "https://ar5iv.labs.arxiv.org/html/2205.14135"


def test_reject_other_host():
    with pytest.raises(UnsupportedUrlError):
        parse_arxiv_url("https://example.com/paper")


def test_concat_truncate():
    blocks = [{"type": "paragraph", "text": "x" * 100} for _ in range(5)]
    out = concat_blocks_text("T", blocks, max_chars=50)
    assert len(out) <= 50
    assert out.endswith("…")
