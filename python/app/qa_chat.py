from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from typing import Any

from . import library
from .llm.client import LlmClient, TranslatePaused
from .settings import get_llm, llm_configured

QA_CHAT_VERSION = 1
QA_HISTORY_WINDOW = 30

# Skip empty media/spacer units in the document context.
_SKIP_KINDS = frozenset({"spacer", "author"})


class QaAborted(Exception):
    """Raised when the client aborts an in-flight Paper QA stream."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return f"m-{uuid.uuid4().hex[:12]}"


def empty_chat() -> dict[str, Any]:
    return {"version": QA_CHAT_VERSION, "messages": []}


def load_qa_chat(partition: str, slug: str) -> dict[str, Any]:
    paths = library.paper_paths(partition, slug)
    if not paths.root.is_dir():
        raise FileNotFoundError("论文不存在")
    if not paths.qa_chat.is_file():
        return empty_chat()
    try:
        data = json.loads(paths.qa_chat.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty_chat()
    if not isinstance(data, dict):
        return empty_chat()
    msgs = data.get("messages")
    if not isinstance(msgs, list):
        msgs = []
    clean: list[dict[str, Any]] = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        clean.append(
            {
                "id": str(m.get("id") or _new_id()),
                "role": role,
                "content": content,
                "createdAt": str(m.get("createdAt") or _utc_now()),
            }
        )
    return {"version": QA_CHAT_VERSION, "messages": clean}


def save_qa_chat(partition: str, slug: str, chat: dict[str, Any]) -> dict[str, Any]:
    paths = library.paper_paths(partition, slug)
    if not paths.root.is_dir():
        raise FileNotFoundError("论文不存在")
    out = {
        "version": QA_CHAT_VERSION,
        "messages": list(chat.get("messages") or []),
    }
    paths.qa_chat.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return out


def clear_qa_chat(partition: str, slug: str) -> dict[str, Any]:
    return save_qa_chat(partition, slug, empty_chat())


def structure_document_context(structure: dict[str, Any]) -> str:
    """Flatten reading_structure into English plain text for the system prompt."""
    parts: list[str] = []
    title = (structure.get("title") or "").strip()
    if title:
        parts.append(f"# {title}")
    for sec in structure.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for sent in sec.get("sentences") or []:
            if not isinstance(sent, dict):
                continue
            kind = sent.get("kind") or "prose"
            if kind in _SKIP_KINDS:
                continue
            text = (sent.get("text") or "").strip()
            if not text:
                continue
            if kind == "heading":
                parts.append(f"\n## {text}")
            elif kind in {"figure", "table", "equation", "caption", "reference"}:
                parts.append(f"[{kind}] {text}")
            else:
                parts.append(text)
    return "\n".join(parts).strip()


def load_structure_or_raise(partition: str, slug: str) -> dict[str, Any]:
    paths = library.paper_paths(partition, slug)
    if not paths.root.is_dir():
        raise FileNotFoundError("论文不存在")
    if not paths.reading_structure.is_file():
        raise FileNotFoundError("阅读结构未就绪")
    return json.loads(paths.reading_structure.read_text(encoding="utf-8"))


def build_system_prompt(structure: dict[str, Any]) -> str:
    doc = structure_document_context(structure)
    title = (structure.get("title") or "").strip() or "（无标题）"
    return (
        "你是这篇学术论文的问答助手（Paper QA）。\n"
        "根据下方「论文原文」回答用户问题。"
        "默认用中文回答；专有名词、变量名、公式符号与 ⟦Mn⟧ 占位符保持原文，不要硬译。\n"
        "忠实依据原文：不要编造原文没有的内容；不确定时明确说明。\n"
        "针对问题作答，不要把整篇论文重写一遍。\n"
        "行内公式用 $...$ 包裹，独立公式用 $$...$$（也可使用 \\(...\\) / \\[...\\]）；"
        "不要把公式写成未加分隔符的纯 TeX 碎片。\n"
        f"论文标题：{title}\n\n"
        "—— 论文原文 ——\n"
        f"{doc}\n"
        "—— 原文结束 ——"
    )


def append_message(
    chat: dict[str, Any],
    *,
    role: str,
    content: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    msg = {
        "id": _new_id(),
        "role": role,
        "content": content,
        "createdAt": _utc_now(),
    }
    messages = list(chat.get("messages") or [])
    messages.append(msg)
    chat = {**chat, "messages": messages, "version": QA_CHAT_VERSION}
    return chat, msg


def llm_messages_for_prompt(
    system: str,
    history: list[dict[str, Any]],
    *,
    window: int = QA_HISTORY_WINDOW,
) -> list[dict[str, str]]:
    sliced = history[-window:] if window > 0 else history
    out: list[dict[str, str]] = [{"role": "system", "content": system}]
    for m in sliced:
        role = m.get("role")
        content = m.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            out.append({"role": role, "content": content})
    return out


def stream_qa_reply(
    partition: str,
    slug: str,
    user_text: str,
    *,
    should_abort: Callable[[], bool] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield SSE-friendly dict events; persists user immediately, assistant on finish."""
    text = (user_text or "").strip()
    if not text:
        raise ValueError("问题不能为空")
    if not llm_configured():
        raise RuntimeError("未配置 LLM（请检查 .env 的 API_KEY / BASE_URL / MODEL）")

    structure = load_structure_or_raise(partition, slug)
    system = build_system_prompt(structure)

    chat = load_qa_chat(partition, slug)
    chat, user_msg = append_message(chat, role="user", content=text)
    save_qa_chat(partition, slug, chat)
    yield {"type": "user", "message": user_msg}

    prompt_msgs = llm_messages_for_prompt(system, chat["messages"])
    llm = get_llm()
    client = LlmClient(llm["apiBase"], llm["apiKey"], llm["model"])

    chunks: list[str] = []
    try:
        for token in client.chat_stream(
            prompt_msgs,
            temperature=0.3,
            should_abort=should_abort,
        ):
            if should_abort and should_abort():
                raise QaAborted()
            chunks.append(token)
            yield {"type": "token", "text": token}
    except TranslatePaused as exc:
        raise QaAborted() from exc

    if should_abort and should_abort():
        raise QaAborted()

    full = "".join(chunks).strip()
    if not full:
        raise RuntimeError("模型未返回内容")

    # Reload in case another writer touched the file (unlikely); keep our user msg.
    chat = load_qa_chat(partition, slug)
    # Ensure the user message we saved is still the last user turn; append assistant.
    chat, assistant_msg = append_message(chat, role="assistant", content=full)
    save_qa_chat(partition, slug, chat)
    yield {"type": "done", "message": assistant_msg}
