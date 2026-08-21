from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data"
SETTINGS_PATH = DATA_DIR / "settings.json"
ENV_PATH = ROOT / ".env"
DEFAULT_LIBRARY_DIR = DATA_DIR / "library"

_lock = Lock()
_dotenv_loaded = False


def _load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE from .env into os.environ (does not override existing)."""
    global _dotenv_loaded
    if _dotenv_loaded:
        return
    _dotenv_loaded = True
    env_path = path if path is not None else ENV_PATH
    if not env_path.is_file():
        return
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ[key] = value


def _env(*names: str) -> str:
    _load_dotenv()
    for name in names:
        value = os.environ.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _normalize_api_base(base: str) -> str:
    base = base.strip().rstrip("/")
    if not base:
        return ""
    parsed = urlparse(base)
    if parsed.path in ("", "/"):
        return f"{base}/v1"
    return base


def _read_raw() -> dict:
    try:
        if not SETTINGS_PATH.is_file():
            return {}
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_raw(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def get_library_dir() -> Path:
    with _lock:
        raw = _read_raw()
        value = raw.get("libraryDir")
        if isinstance(value, str) and value.strip():
            path = Path(value).expanduser().resolve()
        else:
            path = DEFAULT_LIBRARY_DIR
        path.mkdir(parents=True, exist_ok=True)
        return path


def get_llm() -> dict:
    """LLM credentials come from .env (API_KEY / BASE_URL / MODEL)."""
    api_base = _normalize_api_base(_env("BASE_URL", "BBOLUO_BASE_URL"))
    api_key = _env("API_KEY", "BBOLUO_API_KEY")
    model = _env("MODEL", "BBOLUO_MODEL")
    return {
        "apiBase": api_base,
        "apiKey": api_key,
        "model": model,
        "source": "env",
    }


def llm_configured() -> bool:
    llm = get_llm()
    return bool(llm["apiBase"] and llm["model"] and llm["apiKey"])


def settings_public() -> dict:
    llm = get_llm()
    key = llm["apiKey"]
    masked = ""
    if key:
        masked = ("*" * max(0, len(key) - 4)) + key[-4:]
    return {
        "libraryDir": str(get_library_dir()),
        "llm": {
            "apiBase": llm["apiBase"],
            "model": llm["model"],
            "apiKeyMasked": masked,
            "configured": llm_configured(),
            "source": llm["source"],
        },
    }


def update_settings(
    *,
    library_dir: str | None = None,
) -> dict:
    with _lock:
        raw = _read_raw()
        if library_dir is not None:
            text = library_dir.strip()
            if not text:
                raise ValueError("libraryDir 不能为空")
            path = Path(text).expanduser().resolve()
            path.mkdir(parents=True, exist_ok=True)
            raw["libraryDir"] = str(path)
        # Drop legacy keys: LLM lives in .env; summaryMaxChars is unused.
        raw.pop("llm", None)
        raw.pop("summaryMaxChars", None)
        _write_raw(raw)
    return settings_public()
