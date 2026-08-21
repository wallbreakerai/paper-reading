from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from .settings import get_library_dir

SEED_PARTITIONS = ("AIGC", "AI-Infra")
INTERRUPTED_STATUSES = frozenset(
    {"pending", "downloading", "parsing", "translating"}
)
ORDER_FILENAME = "_order.json"

_lock = Lock()
_SAFE_RE = re.compile(r"[^\w\-.]+", re.UNICODE)


@dataclass(frozen=True)
class PaperPaths:
    root: Path

    @property
    def meta(self) -> Path:
        return self.root / "meta.json"

    @property
    def source(self) -> Path:
        return self.root / "source.html"

    @property
    def blocks(self) -> Path:
        return self.root / "source_blocks.json"

    @property
    def reading_structure(self) -> Path:
        return self.root / "reading_structure.json"

    @property
    def translation(self) -> Path:
        return self.root / "translation.json"

    @property
    def article(self) -> Path:
        return self.root / "article.html"

    @property
    def assets(self) -> Path:
        return self.root / "assets"

    @property
    def notes(self) -> Path:
        return self.root / "notes.md"

    @property
    def qa_chat(self) -> Path:
        return self.root / "qa-chat.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def title_slug(title: str, max_len: int = 80) -> str:
    text = (title or "").strip()
    text = text.replace("/", "-")
    text = _SAFE_RE.sub("_", text)
    text = re.sub(r"_+", "_", text).strip("._-")
    if not text:
        text = "untitled"
    return text[:max_len]


def _order_path(root: Path | None = None) -> Path:
    return (root or get_library_dir()) / ORDER_FILENAME


def _read_order(root: Path, *, key: str = "partitions") -> list[str]:
    path = _order_path(root)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    names = data.get(key) if isinstance(data, dict) else data
    if not isinstance(names, list):
        return []
    return [str(n) for n in names if isinstance(n, str) and n.strip()]


def _write_order(root: Path, names: list[str], *, key: str = "partitions") -> None:
    path = _order_path(root)
    path.write_text(
        json.dumps({key: names}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _paper_dirs(base: Path) -> list[Path]:
    if not base.is_dir():
        return []
    return [
        p
        for p in base.iterdir()
        if p.is_dir()
        and not p.name.startswith(".")
        and not p.name.startswith("_")
        and (p / "meta.json").is_file()
    ]


def _sync_paper_order(base: Path) -> list[str]:
    existing = {p.name for p in _paper_dirs(base)}
    order = [n for n in _read_order(base, key="papers") if n in existing]
    extras = sorted(existing - set(order), key=lambda x: x.lower())
    merged = order + extras
    if merged != _read_order(base, key="papers"):
        _write_order(base, merged, key="papers")
    return merged


def _partition_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return [
        p
        for p in root.iterdir()
        if p.is_dir() and not p.name.startswith(".") and not p.name.startswith("_")
    ]


def _sync_order(root: Path) -> list[str]:
    existing = {p.name for p in _partition_dirs(root)}
    order = [n for n in _read_order(root) if n in existing]
    extras = sorted(existing - set(order), key=lambda x: x.lower())
    merged = order + extras
    if merged != _read_order(root):
        _write_order(root, merged)
    return merged


def ensure_library_seeded() -> Path:
    root = get_library_dir()
    with _lock:
        children = _partition_dirs(root)
        if not children:
            for name in SEED_PARTITIONS:
                (root / name).mkdir(parents=True, exist_ok=True)
            _write_order(root, list(SEED_PARTITIONS))
        else:
            _sync_order(root)
    return root


def list_partitions() -> list[dict]:
    root = ensure_library_seeded()
    with _lock:
        order = _sync_order(root)
    items = []
    for name in order:
        p = root / name
        if not p.is_dir():
            continue
        papers = [c for c in p.iterdir() if c.is_dir() and (c / "meta.json").is_file()]
        items.append({"name": p.name, "paperCount": len(papers)})
    return items


def reorder_partitions(names: list[str]) -> list[dict]:
    root = ensure_library_seeded()
    with _lock:
        existing = {p.name for p in _partition_dirs(root)}
        cleaned = [n.strip() for n in names if isinstance(n, str) and n.strip()]
        if not cleaned:
            raise ValueError("顺序列表不能为空")
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("顺序列表含重复分区名")
        if set(cleaned) != existing:
            raise ValueError("顺序列表必须包含且仅包含全部现有分区")
        _write_order(root, cleaned)
    return list_partitions()


def _partition_dir(name: str) -> Path:
    root = ensure_library_seeded()
    safe = name.strip()
    if not safe or "/" in safe or "\\" in safe or safe in {".", ".."}:
        raise ValueError("无效的分区名")
    if safe.startswith("_"):
        raise ValueError("分区名不能以下划线开头")
    return root / safe


def create_partition(name: str) -> dict:
    path = _partition_dir(name)
    root = path.parent
    with _lock:
        if path.exists():
            raise ValueError("分区已存在")
        path.mkdir(parents=True, exist_ok=False)
        order = _sync_order(root)
        if path.name not in order:
            order.append(path.name)
            _write_order(root, order)
    return {"name": path.name, "paperCount": 0}


def rename_partition(old: str, new: str) -> dict:
    src = _partition_dir(old)
    dst = _partition_dir(new)
    root = src.parent
    with _lock:
        if not src.is_dir():
            raise FileNotFoundError("分区不存在")
        if dst.exists():
            raise ValueError("目标分区名已存在")
        src.rename(dst)
        order = [dst.name if n == old else n for n in _read_order(root)]
        existing = {p.name for p in _partition_dirs(root)}
        order = [n for n in order if n in existing]
        if dst.name not in order:
            order.append(dst.name)
        extras = sorted(existing - set(order), key=lambda x: x.lower())
        _write_order(root, order + extras)
        papers = [c for c in dst.iterdir() if c.is_dir() and (c / "meta.json").is_file()]
    return {"name": dst.name, "paperCount": len(papers)}


def delete_partition(name: str) -> None:
    path = _partition_dir(name)
    root = path.parent
    with _lock:
        if not path.is_dir():
            raise FileNotFoundError("分区不存在")
        shutil.rmtree(path)
        order = [n for n in _read_order(root) if n != name]
        _write_order(root, order)


def read_meta(paths: PaperPaths) -> dict:
    return json.loads(paths.meta.read_text(encoding="utf-8"))


def write_meta(paths: PaperPaths, meta: dict) -> None:
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.meta.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def paper_paths(partition: str, slug: str) -> PaperPaths:
    base = _partition_dir(partition)
    root = base / slug
    if ".." in slug or "/" in slug or "\\" in slug:
        raise ValueError("无效的论文目录名")
    return PaperPaths(root=root)


def read_notes(partition: str, slug: str) -> str:
    paths = paper_paths(partition, slug)
    if not paths.root.is_dir():
        raise FileNotFoundError("论文不存在")
    if not paths.notes.is_file():
        return ""
    return paths.notes.read_text(encoding="utf-8")


def write_notes(partition: str, slug: str, content: str) -> str:
    paths = paper_paths(partition, slug)
    if not paths.root.is_dir():
        raise FileNotFoundError("论文不存在")
    text = content if isinstance(content, str) else ""
    # Keep a trailing newline for nicer diffs in editors.
    if text and not text.endswith("\n"):
        text = text + "\n"
    paths.notes.write_text(text, encoding="utf-8")
    return text


def mark_interrupted_in_partition(partition: str) -> int:
    """Mark in-flight papers as interrupted. Returns count updated."""
    base = _partition_dir(partition)
    if not base.is_dir():
        raise FileNotFoundError("分区不存在")
    updated = 0
    with _lock:
        for child in base.iterdir():
            if not child.is_dir():
                continue
            meta_path = child / "meta.json"
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            status = meta.get("status")
            if status not in INTERRUPTED_STATUSES:
                continue
            # Prefer partial when some section translations already exist
            new_status = "interrupted"
            tr_path = child / "translation.json"
            if status == "translating" and tr_path.is_file():
                try:
                    from .translation_store import load_translation_file

                    tr = load_translation_file(tr_path.read_text(encoding="utf-8"))
                    if tr.get("completedSections"):
                        new_status = "partial"
                except OSError:
                    pass
            meta["status"] = new_status
            meta["error"] = meta.get("error") or (
                None if new_status == "partial" else "进程中断，请删除后重新添加"
            )
            meta["updatedAt"] = utc_now()
            meta_path.write_text(
                json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            updated += 1
    return updated


def mark_orphaned_jobs_interrupted() -> int:
    """On process start, mark leftover in-flight papers across all partitions."""
    root = ensure_library_seeded()
    total = 0
    for part in _partition_dirs(root):
        total += mark_interrupted_in_partition(part.name)
    return total


def list_papers(partition: str) -> list[dict]:
    base = _partition_dir(partition)
    if not base.is_dir():
        raise FileNotFoundError("分区不存在")
    with _lock:
        order = _sync_paper_order(base)
    items = []
    for slug in order:
        child = base / slug
        meta_path = child / "meta.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append(
            {
                "slug": child.name,
                "title": meta.get("title") or child.name,
                "arxivId": meta.get("arxivId"),
                "sourceUrl": meta.get("sourceUrl"),
                "status": meta.get("status"),
                "error": meta.get("error"),
                "jobId": meta.get("jobId"),
                "updatedAt": meta.get("updatedAt"),
                "createdAt": meta.get("createdAt"),
            }
        )
    return items


def reorder_papers(partition: str, slugs: list[str]) -> list[dict]:
    base = _partition_dir(partition)
    if not base.is_dir():
        raise FileNotFoundError("分区不存在")
    with _lock:
        existing = {p.name for p in _paper_dirs(base)}
        cleaned = [s.strip() for s in slugs if isinstance(s, str) and s.strip()]
        if not cleaned:
            raise ValueError("顺序列表不能为空")
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("顺序列表含重复论文")
        if set(cleaned) != existing:
            raise ValueError("顺序列表必须包含且仅包含全部现有论文")
        _write_order(base, cleaned, key="papers")
    return list_papers(partition)


def find_duplicate(
    partition: str,
    *,
    arxiv_id: str | None = None,
    source_url: str | None = None,
    title: str | None = None,
    exclude_slug: str | None = None,
) -> str | None:
    """Return existing slug if duplicate found."""
    base = _partition_dir(partition)
    if not base.is_dir():
        return None
    title_norm = (title or "").strip().lower()
    title_as_slug = title_slug(title) if title else ""
    for child in base.iterdir():
        if not child.is_dir() or child.name == exclude_slug:
            continue
        meta_path = child / "meta.json"
        if not meta_path.is_file():
            if title_as_slug and child.name == title_as_slug:
                return child.name
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if arxiv_id and meta.get("arxivId") == arxiv_id:
            return child.name
        if source_url and meta.get("sourceUrl") == source_url:
            return child.name
        existing_title = (meta.get("title") or "").strip().lower()
        if title_norm and existing_title and existing_title == title_norm:
            return child.name
        if title_as_slug and (
            child.name == title_as_slug or meta.get("slug") == title_as_slug
        ):
            return child.name
    return None


def create_paper_stub(
    partition: str,
    *,
    arxiv_id: str,
    source_url: str,
    job_id: str,
) -> tuple[str, PaperPaths, dict]:
    dup = find_duplicate(partition, arxiv_id=arxiv_id, source_url=source_url)
    if dup:
        raise ValueError(f"该论文已在本分区：{dup}")
    base = _partition_dir(partition)
    if not base.is_dir():
        raise FileNotFoundError("分区不存在")
    slug = arxiv_id.replace("/", "_")
    root = base / slug
    with _lock:
        if root.exists():
            raise ValueError(f"该论文已在本分区：{slug}")
        root.mkdir(parents=True, exist_ok=False)
        paths = PaperPaths(root=root)
        meta = {
            "arxivId": arxiv_id,
            "sourceUrl": source_url,
            "title": arxiv_id,
            "slug": slug,
            "status": "pending",
            "pipeline": "full_translate_v1",
            "jobId": job_id,
            "error": None,
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
        }
        write_meta(paths, meta)
        paths.notes.write_text("", encoding="utf-8")
        order = _sync_paper_order(base)
        if slug not in order:
            order.append(slug)
            _write_order(base, order, key="papers")
    return slug, paths, meta


def rename_paper_dir(partition: str, old_slug: str, new_slug: str) -> PaperPaths:
    base = _partition_dir(partition)
    src = base / old_slug
    dst = base / new_slug
    with _lock:
        if not src.is_dir():
            raise FileNotFoundError("论文目录不存在")
        if dst.exists():
            raise ValueError("目标目录已存在")
        src.rename(dst)
        order = [new_slug if n == old_slug else n for n in _read_order(base, key="papers")]
        existing = {p.name for p in _paper_dirs(base)}
        order = [n for n in order if n in existing]
        if new_slug not in order:
            order.append(new_slug)
        extras = sorted(existing - set(order), key=lambda x: x.lower())
        _write_order(base, order + extras, key="papers")
    return PaperPaths(root=dst)


def allocate_title_slug(partition: str, title: str, exclude_slug: str | None = None) -> str:
    base = title_slug(title)
    candidate = base
    n = 2
    while True:
        existing = (_partition_dir(partition) / candidate)
        if not existing.exists() or existing.name == exclude_slug:
            return candidate
        candidate = f"{base}-{n}"
        n += 1


def delete_paper(partition: str, slug: str) -> None:
    paths = paper_paths(partition, slug)
    base = paths.root.parent
    with _lock:
        if not paths.root.is_dir():
            raise FileNotFoundError("论文不存在")
        shutil.rmtree(paths.root)
        order = [n for n in _read_order(base, key="papers") if n != slug]
        _write_order(base, order, key="papers")


def load_paper(partition: str, slug: str) -> dict:
    from .structure import (
        STRUCTURE_VERSION,
        authors_detail_looks_stale,
        ensure_reading_structure,
        extract_authors_detail,
    )
    from .translation_store import load_translation_file, paper_payload

    paths = paper_paths(partition, slug)
    if not paths.meta.is_file():
        raise FileNotFoundError("论文不存在")
    meta = read_meta(paths)
    structure = None
    if paths.reading_structure.is_file():
        try:
            structure = json.loads(paths.reading_structure.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            structure = None
    translation = load_translation_file(
        paths.translation.read_text(encoding="utf-8")
        if paths.translation.is_file()
        else None
    )

    has_article = paths.article.is_file() or paths.source.is_file()
    ver = int(structure.get("version") or 1) if structure else 0
    need_author_refresh = authors_detail_looks_stale(
        meta.get("authorsDetail"), meta
    )
    need_html = need_author_refresh or (
        structure is not None and 4 <= ver < STRUCTURE_VERSION
    )

    article_html = ""
    if need_html:
        if paths.article.is_file():
            article_html = paths.article.read_text(encoding="utf-8")
        elif paths.source.is_file():
            try:
                from .localize import localize_ar5iv_html

                source_url = meta.get("sourceUrl") or ""
                article_html = localize_ar5iv_html(
                    paths.source.read_text(encoding="utf-8"),
                    page_url=source_url,
                    assets_dir=paths.assets,
                )
                paths.article.write_text(article_html, encoding="utf-8")
            except Exception:
                article_html = ""

    # Cheap upgrades only — never full-rebuild on GET (that can take minutes and
    # leaves the reader stuck on「加载中」). Missing structure is built via SSE parse.
    if article_html and structure is not None and 4 <= ver < STRUCTURE_VERSION:
        try:
            structure, changed = ensure_reading_structure(article_html, structure)
            if changed:
                paths.reading_structure.write_text(
                    json.dumps(structure, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
        except Exception:
            pass

    # Refresh authorsDetail when missing or stale (e.g. email dump as affiliation).
    if article_html and need_author_refresh:
        try:
            from .structure import AUTHORS_DETAIL_VERSION

            detail = extract_authors_detail(article_html)
            if detail:
                meta["authorsDetail"] = detail
                meta["authorsDetailVersion"] = AUTHORS_DETAIL_VERSION
                if not meta.get("authors"):
                    meta["authors"] = [d["name"] for d in detail]
                write_meta(paths, meta)
        except Exception:
            pass

    return paper_payload(
        slug=paths.root.name,
        meta=meta,
        structure=structure,
        translation=translation,
        has_article=has_article,
    )


def resolve_paper_asset(partition: str, slug: str, rel: str) -> Path:
    paths = paper_paths(partition, slug)
    if ".." in rel or rel.startswith(("/", "\\")):
        raise ValueError("无效的资源路径")
    rel = rel.replace("\\", "/").lstrip("/")
    assets_root = paths.assets.resolve()
    candidates: list[str] = [rel]
    if rel.startswith("assets/"):
        candidates.append(rel[len("assets/") :])
    else:
        candidates.append(f"assets/{rel}")
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        target = (assets_root / candidate).resolve()
        try:
            target.relative_to(assets_root)
        except ValueError as exc:
            raise ValueError("无效的资源路径") from exc
        if target.is_file():
            return target
    raise FileNotFoundError("资源不存在")
