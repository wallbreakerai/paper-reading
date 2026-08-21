from __future__ import annotations

from collections.abc import Callable

import httpx

ProgressCb = Callable[[float, str], None]


def fetch_ar5iv_html(url: str, on_progress: ProgressCb | None = None) -> str:
    if on_progress:
        on_progress(0.05, "连接 ar5iv…")
    with httpx.Client(follow_redirects=True, timeout=120.0) as client:
        with client.stream("GET", url, headers={"User-Agent": "paper-reading/0.1"}) as resp:
            resp.raise_for_status()
            total = resp.headers.get("content-length")
            total_n = int(total) if total and total.isdigit() else None
            chunks: list[bytes] = []
            got = 0
            for chunk in resp.iter_bytes():
                chunks.append(chunk)
                got += len(chunk)
                if on_progress:
                    if total_n:
                        on_progress(min(0.95, got / total_n), f"下载中 {got // 1024} KB")
                    else:
                        on_progress(min(0.9, 0.1 + got / 5_000_000), f"下载中 {got // 1024} KB")
            data = b"".join(chunks)
    text = data.decode("utf-8", errors="replace")
    if on_progress:
        on_progress(1.0, "下载完成")
    return text
