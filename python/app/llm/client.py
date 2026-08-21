from __future__ import annotations

import json
from collections.abc import Callable, Iterator

import httpx


class TranslatePaused(Exception):
    """Raised when the user pauses an in-flight translation."""


class LlmClient:
    def __init__(self, api_base: str, api_key: str, model: str) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model

    def chat_stream(
        self,
        messages: list[dict],
        temperature: float = 0.3,
        *,
        should_abort: Callable[[], bool] | None = None,
    ) -> Iterator[str]:
        url = f"{self.api_base}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
        }
        with httpx.Client(timeout=httpx.Timeout(60.0, read=300.0)) as client:
            with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code >= 400:
                    err = resp.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"LLM 错误 {resp.status_code}: {err[:500]}")
                try:
                    for line in resp.iter_lines():
                        if should_abort and should_abort():
                            raise TranslatePaused()
                        if not line:
                            continue
                        if line.startswith("data:"):
                            data = line[5:].strip()
                        else:
                            data = line.strip()
                        if not data or data == "[DONE]":
                            if data == "[DONE]":
                                break
                            continue
                        try:
                            payload = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        choices = payload.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        content = delta.get("content")
                        if content:
                            yield content
                except TranslatePaused:
                    # Drop the HTTP stream so the provider stops generating sooner.
                    try:
                        resp.close()
                    except Exception:
                        pass
                    raise
