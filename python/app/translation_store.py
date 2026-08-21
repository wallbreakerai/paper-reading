from __future__ import annotations

import json
from typing import Any

from .structure import structure_to_outline


def empty_translation() -> dict[str, Any]:
    return {"version": 1, "completedSections": [], "sentences": {}}


def load_translation_file(path_text: str | None) -> dict[str, Any]:
    if not path_text:
        return empty_translation()
    try:
        data = json.loads(path_text)
    except json.JSONDecodeError:
        return empty_translation()
    if not isinstance(data, dict):
        return empty_translation()
    # Legacy summary_v0 shape — treat as empty
    if "blocks" in data and "sentences" not in data:
        return empty_translation()
    sentences = data.get("sentences")
    if not isinstance(sentences, dict):
        sentences = {}
    completed = data.get("completedSections")
    if not isinstance(completed, list):
        completed = []
    return {
        "version": 1,
        "completedSections": [str(x) for x in completed],
        "sentences": {str(k): str(v) for k, v in sentences.items() if v is not None},
    }


def merge_section_translation(
    translation: dict[str, Any],
    section_id: str,
    sentence_map: dict[str, str],
) -> dict[str, Any]:
    sentences = dict(translation.get("sentences") or {})
    sentences.update(sentence_map)
    completed = list(translation.get("completedSections") or [])
    if section_id not in completed:
        completed.append(section_id)
    return {
        "version": 1,
        "completedSections": completed,
        "sentences": sentences,
    }


def pending_sections(structure: dict[str, Any], translation: dict[str, Any]) -> list[dict]:
    done = set(translation.get("completedSections") or [])
    return [s for s in (structure.get("sections") or []) if s.get("id") not in done]


def paper_payload(
    *,
    slug: str,
    meta: dict,
    structure: dict | None,
    translation: dict,
    has_article: bool = False,
) -> dict:
    structure = structure or {"version": 1, "title": meta.get("title") or slug, "sections": []}
    return {
        "slug": slug,
        "meta": meta,
        "readingStructure": structure,
        "outline": structure_to_outline(structure),
        "translation": translation,
        # Never inline article HTML — it doubles payload size and the reader
        # uses readingStructure instead.
        "articleHtml": "",
        "hasArticle": bool(has_article),
        # backward-compatible empty blocks for any leftover callers
        "blocks": [],
    }
