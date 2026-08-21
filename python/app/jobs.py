from __future__ import annotations

import json
import time
import traceback
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from threading import Condition, Lock, Thread
from typing import Any

from . import library
from .ar5iv import fetch_ar5iv_html
from .arxiv_url import parse_arxiv_url
from .localize import localize_ar5iv_html
from .parser import blocks_to_jsonable, parse_ar5iv_html
from .settings import get_llm, llm_configured
from .translation_store import (
    load_translation_file,
    merge_section_translation,
    pending_sections,
)


@dataclass
class Job:
    id: str
    partition: str
    slug: str
    phase: str = "queued"  # queued|download|parse|ready|failed
    status: str = "queued"  # queued|running|completed|failed
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    paper_slug: str | None = None  # may change after rename


_lock = Lock()
_cv = Condition(_lock)
_jobs: dict[str, Job] = {}
_queue: list[str] = []
_worker_started = False


def _ensure_worker() -> None:
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True
        Thread(target=_worker_loop, name="import-worker", daemon=True).start()


def _worker_loop() -> None:
    while True:
        with _cv:
            while not _queue:
                _cv.wait()
            job_id = _queue.pop(0)
            job = _jobs[job_id]
            job.status = "running"
            job.phase = "download"
            job.message = "开始下载"
        try:
            _run_import(job)
        except Exception as exc:  # noqa: BLE001
            _fail(job, str(exc), traceback.format_exc())


def _update(job: Job, **kwargs: Any) -> None:
    with _lock:
        for k, v in kwargs.items():
            setattr(job, k, v)


def _fail(job: Job, message: str, detail: str | None = None) -> None:
    paths = library.paper_paths(job.partition, job.paper_slug or job.slug)
    if paths.meta.is_file():
        meta = library.read_meta(paths)
        meta["status"] = "failed"
        meta["error"] = message
        meta["updatedAt"] = library.utc_now()
        library.write_meta(paths, meta)
    _update(
        job,
        status="failed",
        phase="failed",
        error=message,
        message=message,
        progress=1.0,
    )
    if detail:
        job.message = message


def _run_import(job: Job) -> None:
    paths = library.paper_paths(job.partition, job.slug)
    meta = library.read_meta(paths)
    source_url = meta["sourceUrl"]
    arxiv_id = meta["arxivId"]

    def on_prog(p: float, msg: str) -> None:
        _update(job, phase="download", progress=p * 0.7, message=msg)
        meta_local = library.read_meta(paths)
        meta_local["status"] = "downloading"
        meta_local["updatedAt"] = library.utc_now()
        library.write_meta(paths, meta_local)

    meta["status"] = "downloading"
    meta["updatedAt"] = library.utc_now()
    library.write_meta(paths, meta)

    html = fetch_ar5iv_html(source_url, on_progress=on_prog)
    paths.source.write_text(html, encoding="utf-8")

    _update(job, phase="parse", progress=0.72, message="本地化资源…")

    def on_asset(p: float, msg: str) -> None:
        _update(job, phase="parse", progress=p, message=msg)

    article_html = localize_ar5iv_html(
        html,
        page_url=source_url,
        assets_dir=paths.assets,
        on_progress=on_asset,
    )
    paths.article.write_text(article_html, encoding="utf-8")

    _update(job, phase="parse", progress=0.97, message="解析正文…")
    title, blocks, authors = parse_ar5iv_html(html)

    # title duplicate check before rename
    dup = library.find_duplicate(
        job.partition,
        title=title,
        exclude_slug=job.slug,
    )
    if dup:
        library.delete_paper(job.partition, job.slug)
        raise ValueError(f"同标题论文已存在：{dup}")

    paths.blocks.write_text(
        json.dumps(blocks_to_jsonable(blocks), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    new_slug = library.allocate_title_slug(job.partition, title, exclude_slug=job.slug)
    if new_slug != job.slug:
        try:
            paths = library.rename_paper_dir(job.partition, job.slug, new_slug)
        except ValueError:
            new_slug = job.slug
            paths = library.paper_paths(job.partition, new_slug)

    meta = library.read_meta(paths)
    meta["title"] = title
    meta["authors"] = authors
    try:
        from .structure import extract_authors_detail

        detail = extract_authors_detail(article_html)
        if detail:
            meta["authorsDetail"] = detail
            meta["authorsDetailVersion"] = 2
            meta["authors"] = [d["name"] for d in detail]
    except Exception:
        pass
    meta["slug"] = paths.root.name
    meta["status"] = "ready_source"
    meta["error"] = None
    meta["updatedAt"] = library.utc_now()
    library.write_meta(paths, meta)

    _update(
        job,
        status="completed",
        phase="ready",
        progress=1.0,
        message="原文就绪",
        paper_slug=paths.root.name,
        slug=paths.root.name,
        error=None,
    )


def enqueue_import(partition: str, url: str) -> dict:
    parsed = parse_arxiv_url(url)
    job_id = uuid.uuid4().hex
    slug, _paths, _meta = library.create_paper_stub(
        partition,
        arxiv_id=parsed.arxiv_id,
        source_url=parsed.ar5iv_html,
        job_id=job_id,
    )
    job = Job(id=job_id, partition=partition, slug=slug, paper_slug=slug)
    with _cv:
        _jobs[job_id] = job
        _queue.append(job_id)
        _cv.notify()
    _ensure_worker()
    return {"jobId": job_id, "paperSlug": slug, "arxivId": parsed.arxiv_id}


def get_job(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        return {
            "id": job.id,
            "partition": job.partition,
            "slug": job.paper_slug or job.slug,
            "phase": job.phase,
            "status": job.status,
            "progress": job.progress,
            "message": job.message,
            "error": job.error,
        }


# --- reading structure + full translation streaming ---

@dataclass
class TranslateStream:
    preview: str = ""
    phase: str = "idle"  # parsing|translating|done
    done: bool = False
    error: str | None = None
    cancelled: bool = False
    events: list = field(default_factory=list)
    event_cv: Condition = field(default_factory=Condition)


_translate_lock = Lock()
_translate_streams: dict[str, TranslateStream] = {}


def _paper_key(partition: str, slug: str) -> str:
    return f"{partition}::{slug}"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _push_event(stream: TranslateStream, event: dict) -> None:
    with stream.event_cv:
        if event.get("type") == "preview":
            stream.preview = str(event.get("text") or "")
            stream.event_cv.notify_all()
            return
        stream.events.append(event)
        stream.event_cv.notify_all()


def stream_translate(partition: str, slug: str) -> Iterator[str]:
    """SSE: parse progress, section preview, section_done, done/error."""
    paths = library.paper_paths(partition, slug)
    if not paths.meta.is_file():
        yield _sse({"type": "error", "message": "论文不存在"})
        return

    meta = library.read_meta(paths)
    if meta.get("status") in {"pending", "downloading"}:
        yield _sse({"type": "error", "message": "原文尚未就绪"})
        return

    if meta.get("status") == "completed" and paths.reading_structure.is_file():
        translation = load_translation_file(
            paths.translation.read_text(encoding="utf-8")
            if paths.translation.is_file()
            else None
        )
        structure = json.loads(paths.reading_structure.read_text(encoding="utf-8"))
        yield _sse(
            {
                "type": "snapshot",
                "readingStructure": structure,
                "translation": translation,
                "status": "completed",
            }
        )
        yield _sse({"type": "done", "status": "completed"})
        return

    key = _paper_key(partition, slug)
    stale: TranslateStream | None = None
    with _translate_lock:
        existing = _translate_streams.get(key)
        if (
            existing
            and not existing.done
            and existing.error is None
            and not existing.cancelled
        ):
            stream = existing
            replay = list(existing.events)
            preview0 = existing.preview
        else:
            if existing and not existing.done:
                # Cancelled/errored worker still winding down — wait, then restart.
                existing.cancelled = True
                with existing.event_cv:
                    existing.event_cv.notify_all()
                stale = existing
            stream = None
            replay = []
            preview0 = ""

    if stale is not None:
        _wait_stream_done(stale, timeout=60.0)
        with _translate_lock:
            if _translate_streams.get(key) is stale:
                _translate_streams.pop(key, None)

    if stream is None:
        with _translate_lock:
            existing = _translate_streams.get(key)
            if (
                existing
                and not existing.done
                and existing.error is None
                and not existing.cancelled
            ):
                stream = existing
                replay = list(existing.events)
                preview0 = existing.preview
            else:
                stream = TranslateStream()
                _translate_streams[key] = stream
                Thread(
                    target=_run_translate_thread,
                    args=(partition, slug, stream),
                    daemon=True,
                ).start()
                replay = []
                preview0 = ""

    for ev in replay:
        yield _sse(ev)
    if preview0:
        yield _sse({"type": "preview", "text": preview0})

    idx = len(replay)
    last_preview = preview0
    while True:
        with stream.event_cv:
            while (
                idx >= len(stream.events)
                and stream.preview == last_preview
                and not stream.done
                and stream.error is None
            ):
                stream.event_cv.wait(timeout=0.2)
            batch = stream.events[idx:]
            idx = len(stream.events)
            preview = stream.preview
            done = stream.done
            err = stream.error
        if preview != last_preview:
            yield _sse({"type": "preview", "text": preview})
            last_preview = preview
        for ev in batch:
            yield _sse(ev)
        if err:
            yield _sse({"type": "error", "message": err})
            return
        if done:
            return


def _run_translate_thread(partition: str, slug: str, stream: TranslateStream) -> None:
    from .llm.client import LlmClient, TranslatePaused
    # structure helpers imported where need_parse is evaluated


    paths = library.paper_paths(partition, slug)

    def _aborted() -> bool:
        return stream.cancelled

    try:
        if not paths.article.is_file():
            raise RuntimeError("缺少 article.html，无法解析结构")

        # --- parsing ---
        existing_structure = None
        if paths.reading_structure.is_file():
            try:
                existing_structure = json.loads(
                    paths.reading_structure.read_text(encoding="utf-8")
                )
            except json.JSONDecodeError:
                existing_structure = None

        from .structure import (
            STRUCTURE_VERSION,
            build_reading_structure,
            ensure_reading_structure,
        )

        need_parse = existing_structure is None or int(
            (existing_structure or {}).get("version") or 1
        ) < STRUCTURE_VERSION
        if need_parse:
            meta = library.read_meta(paths)
            meta["status"] = "parsing"
            meta["error"] = None
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
            stream.phase = "parsing"
            _push_event(stream, {"type": "phase", "phase": "parsing"})

            if _aborted():
                raise TranslatePaused()

            html = paths.article.read_text(encoding="utf-8")
            if existing_structure is None:
                structure, events = build_reading_structure(html)
                for ev in events:
                    if _aborted():
                        raise TranslatePaused()
                    if ev["type"] == "progress":
                        _push_event(
                            stream,
                            {
                                "type": "parse_progress",
                                "current": ev["current"],
                                "total": ev["total"],
                                "message": ev["message"],
                            },
                        )
            else:
                _push_event(
                    stream,
                    {
                        "type": "parse_progress",
                        "current": 1,
                        "total": 1,
                        "message": "升级阅读结构（补全公式/图/表）…",
                    },
                )
                structure, _changed = ensure_reading_structure(html, existing_structure)
            paths.reading_structure.write_text(
                json.dumps(structure, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            _push_event(
                stream,
                {
                    "type": "structure_ready",
                    "readingStructure": structure,
                    "sections": len(structure.get("sections") or []),
                },
            )
        else:
            structure = existing_structure
            _push_event(
                stream,
                {
                    "type": "structure_ready",
                    "readingStructure": structure,
                    "sections": len(structure.get("sections") or []),
                },
            )

        if _aborted():
            raise TranslatePaused()

        translation = load_translation_file(
            paths.translation.read_text(encoding="utf-8")
            if paths.translation.is_file()
            else None
        )
        pending = pending_sections(structure, translation)
        if not pending:
            meta = library.read_meta(paths)
            meta["status"] = "completed"
            meta["error"] = None
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
            _push_event(
                stream,
                {
                    "type": "snapshot",
                    "readingStructure": structure,
                    "translation": translation,
                    "status": "completed",
                },
            )
            _push_event(stream, {"type": "done", "status": "completed"})
            stream.done = True
            return

        if not llm_configured():
            meta = library.read_meta(paths)
            meta["status"] = "translate_failed"
            meta["error"] = "请先在设置中配置 LLM"
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
            raise RuntimeError("请先在设置中配置 LLM")

        meta = library.read_meta(paths)
        meta["status"] = "translating"
        meta["error"] = None
        meta["updatedAt"] = library.utc_now()
        library.write_meta(paths, meta)
        stream.phase = "translating"
        _push_event(stream, {"type": "phase", "phase": "translating"})

        llm = get_llm()
        client = LlmClient(llm["apiBase"], llm["apiKey"], llm["model"])
        total = len(structure.get("sections") or [])
        done_n = len(translation.get("completedSections") or [])

        for section in pending:
            if _aborted():
                raise TranslatePaused()
            sec_id = section["id"]
            sentences = [
                s
                for s in (section.get("sentences") or [])
                if s.get("kind") != "author"
            ]
            # Skip lone document-title heading (shown in hero)
            if sentences and sentences[0].get("kind") == "heading":
                t0 = (sentences[0].get("text") or "").strip()
                meta_title = (library.read_meta(paths).get("title") or "").strip()
                if t0 and meta_title and t0 == meta_title:
                    sentences = sentences[1:]
            expected_ids = [s["id"] for s in sentences]
            media_kinds = {"equation", "figure", "table", "reference", "spacer"}
            media_map = {
                s["id"]: ""
                for s in sentences
                if s.get("kind") in media_kinds
            }
            llm_sentences = [
                s for s in sentences if s.get("kind") not in media_kinds
            ]
            if not expected_ids:
                translation = merge_section_translation(translation, sec_id, {})
                paths.translation.write_text(
                    json.dumps(translation, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                done_n += 1
                _push_event(
                    stream,
                    {
                        "type": "section_done",
                        "sectionId": sec_id,
                        "sentences": {},
                        "index": done_n,
                        "total": total,
                    },
                )
                continue
            if not llm_sentences:
                translation = merge_section_translation(
                    translation, sec_id, media_map
                )
                paths.translation.write_text(
                    json.dumps(translation, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                done_n += 1
                _push_event(
                    stream,
                    {
                        "type": "section_done",
                        "sectionId": sec_id,
                        "sentences": media_map,
                        "index": done_n,
                        "total": total,
                    },
                )
                continue
            _push_event(
                stream,
                {
                    "type": "section_start",
                    "sectionId": sec_id,
                    "index": done_n + 1,
                    "total": total,
                    "message": f"翻译章节块 {done_n + 1}/{total}",
                },
            )

            # Equations/captions still go through model; chunk large sections.
            from .llm.translator import (
                chunk_sentences,
                translate_sentences_with_retry,
            )

            mapping: dict[str, str] = dict(media_map)
            batches = chunk_sentences(llm_sentences)
            for bi, batch in enumerate(batches):
                if _aborted():
                    raise TranslatePaused()
                if not batch:
                    continue

                # No token-level preview SSE — flooding the browser with growing
                # JSON payloads freezes the UI (buttons become unresponsive).
                part = translate_sentences_with_retry(
                    client,
                    f"{sec_id}#{bi + 1}" if len(batches) > 1 else sec_id,
                    batch,
                    on_preview=None,
                    should_abort=_aborted,
                )
                mapping.update(part)

            if _aborted():
                # Drop in-flight section mapping — resume will redo this block.
                raise TranslatePaused()

            # Ensure every expected id present (empty ok for skipped empties)
            for sid in expected_ids:
                mapping.setdefault(sid, "")

            translation = merge_section_translation(translation, sec_id, mapping)
            paths.translation.write_text(
                json.dumps(translation, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            done_n += 1
            _push_event(
                stream,
                {
                    "type": "section_done",
                    "sectionId": sec_id,
                    "sentences": mapping,
                    "index": done_n,
                    "total": total,
                },
            )

        meta = library.read_meta(paths)
        meta["status"] = "completed"
        meta["error"] = None
        meta["updatedAt"] = library.utc_now()
        library.write_meta(paths, meta)
        _push_event(stream, {"type": "done", "status": "completed"})
        stream.done = True
    except TranslatePaused:
        if paths.meta.is_file():
            meta = library.read_meta(paths)
            tr = load_translation_file(
                paths.translation.read_text(encoding="utf-8")
                if paths.translation.is_file()
                else None
            )
            if paths.reading_structure.is_file():
                meta["status"] = (
                    "partial" if tr.get("completedSections") else "ready_source"
                )
            else:
                meta["status"] = "ready_source"
            meta["error"] = None
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
            _push_event(
                stream,
                {
                    "type": "paused",
                    "status": meta["status"],
                    "translation": tr,
                },
            )
        with stream.event_cv:
            stream.done = True
            stream.event_cv.notify_all()
    except Exception as exc:  # noqa: BLE001
        if paths.meta.is_file():
            meta = library.read_meta(paths)
            # Distinguish parse vs translate failure
            if not paths.reading_structure.is_file() or meta.get("status") == "parsing":
                meta["status"] = "parse_failed"
            else:
                # Keep completed sections; mark failed for manual retry
                tr = load_translation_file(
                    paths.translation.read_text(encoding="utf-8")
                    if paths.translation.is_file()
                    else None
                )
                meta["status"] = (
                    "partial" if tr.get("completedSections") else "translate_failed"
                )
                if meta["status"] == "partial":
                    # User asked: translate_failed for failure; but if partial exists
                    # after error, use translate_failed so manual retry is required
                    meta["status"] = "translate_failed"
            meta["error"] = str(exc)
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
        with stream.event_cv:
            stream.error = str(exc)
            stream.done = True
            stream.event_cv.notify_all()


def pause_translate(partition: str, slug: str) -> dict:
    """Stop in-flight translation; discard current unfinished section.

    Returns as soon as the cancel flag and meta status are written. The worker
    stops cooperatively on the next token — callers must not block the UI on
    that wait.
    """
    key = _paper_key(partition, slug)
    paths = library.paper_paths(partition, slug)
    with _translate_lock:
        stream = _translate_streams.get(key)
        if stream and not stream.done:
            stream.cancelled = True
            with stream.event_cv:
                stream.event_cv.notify_all()

    meta = library.read_meta(paths) if paths.meta.is_file() else {}
    tr = load_translation_file(
        paths.translation.read_text(encoding="utf-8")
        if paths.translation.is_file()
        else None
    )
    if paths.meta.is_file():
        if meta.get("status") in {"translating", "parsing"}:
            if paths.reading_structure.is_file():
                meta["status"] = (
                    "partial" if tr.get("completedSections") else "ready_source"
                )
            else:
                meta["status"] = "ready_source"
            meta["error"] = None
            meta["updatedAt"] = library.utc_now()
            library.write_meta(paths, meta)
    return {"ok": True, "status": meta.get("status"), "translation": tr}


def _wait_stream_done(stream: TranslateStream, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with stream.event_cv:
            if stream.done:
                return
            stream.event_cv.wait(timeout=0.2)


def retry_translate(partition: str, slug: str, *, full: bool = False) -> None:
    """Manual retry: parse_failed rebuilds structure; full clears translation only."""
    paths = library.paper_paths(partition, slug)
    key = _paper_key(partition, slug)
    stale: TranslateStream | None = None
    with _translate_lock:
        old = _translate_streams.get(key)
        if old and not old.done:
            old.cancelled = True
            with old.event_cv:
                old.event_cv.notify_all()
            stale = old
        elif old:
            _translate_streams.pop(key, None)
    if stale is not None:
        _wait_stream_done(stale, timeout=30.0)
        with _translate_lock:
            if _translate_streams.get(key) is stale:
                _translate_streams.pop(key, None)

    meta = library.read_meta(paths)
    status = meta.get("status")
    if status == "parse_failed":
        if paths.reading_structure.is_file():
            paths.reading_structure.unlink()
        meta["status"] = "ready_source"
    elif full:
        if paths.translation.is_file():
            paths.translation.unlink()
        meta["status"] = "ready_source"
    elif status in {"translate_failed", "partial", "completed"}:
        tr = load_translation_file(
            paths.translation.read_text(encoding="utf-8")
            if paths.translation.is_file()
            else None
        )
        meta["status"] = "partial" if tr.get("completedSections") else "ready_source"
    else:
        meta["status"] = "ready_source"
    meta["error"] = None
    meta["updatedAt"] = library.utc_now()
    library.write_meta(paths, meta)


# Back-compat aliases used by old routes
def stream_summary(partition: str, slug: str) -> Iterator[str]:
    yield from stream_translate(partition, slug)


def retry_summary(partition: str, slug: str) -> None:
    retry_translate(partition, slug, full=False)
