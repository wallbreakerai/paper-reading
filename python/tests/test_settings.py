from __future__ import annotations

from pathlib import Path

import pytest

from app import settings


@pytest.fixture()
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    env = tmp_path / ".env"
    monkeypatch.setattr(settings, "ROOT", tmp_path)
    monkeypatch.setattr(settings, "DATA_DIR", data)
    monkeypatch.setattr(settings, "SETTINGS_PATH", data / "settings.json")
    monkeypatch.setattr(settings, "ENV_PATH", env)
    monkeypatch.setattr(settings, "DEFAULT_LIBRARY_DIR", data / "library")
    monkeypatch.setattr(settings, "_dotenv_loaded", False)
    for key in (
        "API_KEY",
        "BASE_URL",
        "MODEL",
        "BBOLUO_API_KEY",
        "BBOLUO_BASE_URL",
        "BBOLUO_MODEL",
    ):
        monkeypatch.delenv(key, raising=False)
    return tmp_path


def test_llm_from_dotenv(isolated: Path, monkeypatch: pytest.MonkeyPatch):
    (isolated / ".env").write_text(
        "API_KEY=sk-test-abcdef\n"
        "BASE_URL=https://bboluo.com\n"
        "MODEL=(反重力)gemini-3.6-flash\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "_dotenv_loaded", False)
    llm = settings.get_llm()
    assert llm["apiKey"] == "sk-test-abcdef"
    assert llm["apiBase"] == "https://bboluo.com/v1"
    assert llm["model"] == "(反重力)gemini-3.6-flash"
    assert settings.llm_configured() is True

    public = settings.settings_public()
    assert public["llm"]["configured"] is True
    assert public["llm"]["apiKeyMasked"].endswith("cdef")
    assert "sk-test" not in public["llm"]["apiKeyMasked"]


def test_env_overrides_dotenv_file(isolated: Path, monkeypatch: pytest.MonkeyPatch):
    (isolated / ".env").write_text(
        "API_KEY=from-file\nBASE_URL=https://example.com/v1\nMODEL=file-model\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("API_KEY", "from-process")
    monkeypatch.setenv("MODEL", "process-model")
    monkeypatch.setattr(settings, "_dotenv_loaded", False)
    llm = settings.get_llm()
    assert llm["apiKey"] == "from-process"
    assert llm["model"] == "process-model"
    assert llm["apiBase"] == "https://example.com/v1"


def test_update_settings_does_not_persist_llm(isolated: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("API_KEY", "k")
    monkeypatch.setenv("BASE_URL", "https://example.com/v1")
    monkeypatch.setenv("MODEL", "m")
    monkeypatch.setattr(settings, "_dotenv_loaded", True)
    settings._write_raw({"summaryMaxChars": 12000, "llm": {"apiKey": "old"}})
    settings.update_settings(library_dir=str(isolated / "data" / "library"))
    raw = settings._read_raw()
    assert "llm" not in raw
    assert "summaryMaxChars" not in raw
    assert "libraryDir" in raw
