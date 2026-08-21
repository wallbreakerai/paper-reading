from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import jobs, library, qa_chat
from .settings import _load_dotenv, settings_public, update_settings

app = FastAPI(title="Paper Reading API")


@app.on_event("startup")
def on_startup() -> None:
    _load_dotenv()
    library.ensure_library_seeded()
    # Only on process boot: leftover pending/downloading jobs cannot resume.
    library.mark_orphaned_jobs_interrupted()


class PartitionBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RenamePartitionBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class AddPaperBody(BaseModel):
    url: str = Field(min_length=1)


class SettingsBody(BaseModel):
    libraryDir: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/settings")
def get_settings() -> dict:
    return settings_public()


@app.put("/settings")
def put_settings(body: SettingsBody) -> dict:
    try:
        return update_settings(library_dir=body.libraryDir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class ReorderPartitionsBody(BaseModel):
    names: list[str] = Field(min_length=1)


@app.get("/library/partitions")
def get_partitions() -> dict:
    return {"partitions": library.list_partitions()}


@app.post("/library/partitions")
def post_partition(body: PartitionBody) -> dict:
    try:
        return library.create_partition(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/library/partitions/reorder")
def put_partitions_reorder(body: ReorderPartitionsBody) -> dict:
    try:
        return {"partitions": library.reorder_partitions(body.names)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/library/partitions/{name}")
def patch_partition(name: str, body: RenamePartitionBody) -> dict:
    try:
        return library.rename_partition(name, body.name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/library/partitions/{name}")
def delete_partition(name: str) -> dict:
    try:
        library.delete_partition(name)
        return {"ok": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class ReorderPapersBody(BaseModel):
    slugs: list[str] = Field(min_length=1)


@app.get("/library/partitions/{name}/papers")
def get_papers(name: str) -> dict:
    try:
        return {"papers": library.list_papers(name)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/library/partitions/{name}/papers/reorder")
def put_papers_reorder(name: str, body: ReorderPapersBody) -> dict:
    try:
        return {"papers": library.reorder_papers(name, body.slugs)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/library/partitions/{name}/papers")
def post_paper(name: str, body: AddPaperBody) -> dict:
    try:
        return jobs.enqueue_import(name, body.url)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/library/partitions/{name}/papers/{slug}")
def delete_paper(name: str, slug: str) -> dict:
    try:
        library.delete_paper(name, slug)
        return {"ok": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/library/partitions/{name}/papers/{slug}")
def get_paper(name: str, slug: str) -> dict:
    try:
        return library.load_paper(name, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class NotesBody(BaseModel):
    content: str = ""


@app.get("/library/partitions/{name}/papers/{slug}/notes")
def get_notes(name: str, slug: str) -> dict:
    try:
        return {"content": library.read_notes(name, slug)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/library/partitions/{name}/papers/{slug}/notes")
def put_notes(name: str, slug: str, body: NotesBody) -> dict:
    try:
        return {"content": library.write_notes(name, slug, body.content)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class QaChatBody(BaseModel):
    content: str = Field(min_length=1)


@app.get("/library/partitions/{name}/papers/{slug}/qa/chat")
def get_qa_chat(name: str, slug: str) -> dict:
    try:
        return qa_chat.load_qa_chat(name, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/library/partitions/{name}/papers/{slug}/qa/chat")
def delete_qa_chat(name: str, slug: str) -> dict:
    try:
        return qa_chat.clear_qa_chat(name, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/library/partitions/{name}/papers/{slug}/qa/chat")
async def post_qa_chat(name: str, slug: str, body: QaChatBody, request: Request):
    aborted = {"v": False}

    async def watch_disconnect() -> None:
        while True:
            if await request.is_disconnected():
                aborted["v"] = True
                return
            await asyncio.sleep(0.25)

    def event_stream() -> Iterator[str]:
        try:
            for ev in qa_chat.stream_qa_reply(
                name,
                slug,
                body.content,
                should_abort=lambda: aborted["v"],
            ):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except qa_chat.QaAborted:
            yield f"data: {json.dumps({'type': 'aborted'}, ensure_ascii=False)}\n\n"
        except FileNotFoundError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    asyncio.create_task(watch_disconnect())
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/library/partitions/{name}/papers/{slug}/assets/{asset_path:path}")
def get_paper_asset(name: str, slug: str, asset_path: str):
    try:
        path = library.resolve_paper_asset(name, slug, asset_path)
        return FileResponse(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    data = jobs.get_job(job_id)
    if not data:
        raise HTTPException(status_code=404, detail="job 不存在")
    return data


@app.get("/library/partitions/{name}/papers/{slug}/translate/stream")
def translate_stream(name: str, slug: str) -> StreamingResponse:
    return StreamingResponse(
        jobs.stream_translate(name, slug),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/library/partitions/{name}/papers/{slug}/translate/retry")
def translate_retry(name: str, slug: str, full: bool = False) -> dict:
    try:
        jobs.retry_translate(name, slug, full=full)
        return {"ok": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/library/partitions/{name}/papers/{slug}/translate/pause")
def translate_pause(name: str, slug: str) -> dict:
    try:
        return jobs.pause_translate(name, slug)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/library/partitions/{name}/papers/{slug}/summary/stream")
def summary_stream(name: str, slug: str) -> StreamingResponse:
    # Alias → translate stream
    return translate_stream(name, slug)


@app.post("/library/partitions/{name}/papers/{slug}/summary/retry")
def summary_retry(name: str, slug: str) -> dict:
    return translate_retry(name, slug)
