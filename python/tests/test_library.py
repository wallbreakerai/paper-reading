from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import library


@pytest.fixture()
def lib_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(library, "get_library_dir", lambda: root)
    return root


def test_seed_and_duplicate(lib_root: Path):
    library.ensure_library_seeded()
    names = {p["name"] for p in library.list_partitions()}
    assert "AIGC" in names
    assert "AI-Infra" in names

    slug, paths, _ = library.create_paper_stub(
        "AIGC",
        arxiv_id="1706.03762",
        source_url="https://ar5iv.labs.arxiv.org/html/1706.03762",
        job_id="j1",
    )
    assert slug == "1706.03762"
    assert paths.meta.is_file()

    with pytest.raises(ValueError, match="已在本分区"):
        library.create_paper_stub(
            "AIGC",
            arxiv_id="1706.03762",
            source_url="https://ar5iv.labs.arxiv.org/html/1706.03762",
            job_id="j2",
        )


def test_title_duplicate_and_interrupt(lib_root: Path):
    library.ensure_library_seeded()
    slug, paths, meta = library.create_paper_stub(
        "AIGC",
        arxiv_id="1234.56789",
        source_url="https://ar5iv.labs.arxiv.org/html/1234.56789",
        job_id="j3",
    )
    meta["title"] = "Hello World Paper"
    meta["status"] = "downloading"
    library.write_meta(paths, meta)

    assert library.find_duplicate("AIGC", title="Hello World Paper") == slug

    # Listing must NOT kill in-flight imports (that was the pdf import bug).
    listed = library.list_papers("AIGC")
    assert listed[0]["status"] == "downloading"

    n = library.mark_interrupted_in_partition("AIGC")
    assert n == 1
    meta2 = json.loads(paths.meta.read_text(encoding="utf-8"))
    assert meta2["status"] == "interrupted"

    # Startup cleanup covers leftover jobs across partitions.
    meta2["status"] = "pending"
    library.write_meta(paths, meta2)
    assert library.mark_orphaned_jobs_interrupted() == 1


def test_title_slug():
    assert "Attention" in library.title_slug("Attention Is All You Need!")


def test_partition_order(lib_root: Path):
    library.ensure_library_seeded()
    names = [p["name"] for p in library.list_partitions()]
    assert names == ["AIGC", "AI-Infra"]

    library.create_partition("Vision")
    names = [p["name"] for p in library.list_partitions()]
    assert names == ["AIGC", "AI-Infra", "Vision"]

    reordered = library.reorder_partitions(["Vision", "AIGC", "AI-Infra"])
    assert [p["name"] for p in reordered] == ["Vision", "AIGC", "AI-Infra"]
    assert [p["name"] for p in library.list_partitions()] == [
        "Vision",
        "AIGC",
        "AI-Infra",
    ]

    library.rename_partition("Vision", "CV")
    assert [p["name"] for p in library.list_partitions()] == [
        "CV",
        "AIGC",
        "AI-Infra",
    ]

    library.delete_partition("AIGC")
    assert [p["name"] for p in library.list_partitions()] == ["CV", "AI-Infra"]

    order_file = lib_root / "_order.json"
    assert order_file.is_file()
    data = json.loads(order_file.read_text(encoding="utf-8"))
    assert data["partitions"] == ["CV", "AI-Infra"]


def test_reorder_rejects_partial(lib_root: Path):
    library.ensure_library_seeded()
    with pytest.raises(ValueError, match="全部现有分区"):
        library.reorder_partitions(["AIGC"])


def test_paper_order(lib_root: Path):
    library.ensure_library_seeded()
    s1, _, _ = library.create_paper_stub(
        "AIGC",
        arxiv_id="1111.11111",
        source_url="https://ar5iv.labs.arxiv.org/html/1111.11111",
        job_id="a",
    )
    s2, _, _ = library.create_paper_stub(
        "AIGC",
        arxiv_id="2222.22222",
        source_url="https://ar5iv.labs.arxiv.org/html/2222.22222",
        job_id="b",
    )
    assert [p["slug"] for p in library.list_papers("AIGC")] == [s1, s2]

    reordered = library.reorder_papers("AIGC", [s2, s1])
    assert [p["slug"] for p in reordered] == [s2, s1]

    library.rename_paper_dir("AIGC", s2, "FlashAttention")
    assert [p["slug"] for p in library.list_papers("AIGC")] == [
        "FlashAttention",
        s1,
    ]

    library.delete_paper("AIGC", s1)
    assert [p["slug"] for p in library.list_papers("AIGC")] == ["FlashAttention"]


def test_read_write_notes(lib_root: Path):
    library.ensure_library_seeded()
    slug, paths, _ = library.create_paper_stub(
        "AIGC",
        arxiv_id="3333.33333",
        source_url="https://ar5iv.labs.arxiv.org/html/3333.33333",
        job_id="n1",
    )
    assert paths.notes.is_file()
    assert library.read_notes("AIGC", slug) == ""

    saved = library.write_notes("AIGC", slug, "要点：tiling")
    assert saved.endswith("\n")
    assert library.read_notes("AIGC", slug) == "要点：tiling\n"
    assert paths.notes.read_text(encoding="utf-8") == "要点：tiling\n"
