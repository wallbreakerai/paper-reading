from __future__ import annotations

import json

from app import qa_chat


def test_structure_document_context_skips_spacer_and_formats_heading():
    structure = {
        "title": "Demo Paper",
        "sections": [
            {
                "id": "sec-1",
                "sentences": [
                    {"id": "s-1", "kind": "heading", "text": "1 Intro"},
                    {"id": "s-2", "kind": "prose", "text": "Hello ⟦M0⟧ world."},
                    {"id": "s-3", "kind": "spacer", "text": ""},
                    {"id": "s-4", "kind": "caption", "text": "Figure 1."},
                ],
            }
        ],
    }
    text = qa_chat.structure_document_context(structure)
    assert "# Demo Paper" in text
    assert "## 1 Intro" in text
    assert "Hello ⟦M0⟧ world." in text
    assert "[caption] Figure 1." in text
    assert "spacer" not in text


def test_llm_messages_window():
    history = [
        {"role": "user", "content": f"u{i}"}
        if i % 2 == 0
        else {"role": "assistant", "content": f"a{i}"}
        for i in range(40)
    ]
    msgs = qa_chat.llm_messages_for_prompt("SYS", history, window=4)
    assert msgs[0] == {"role": "system", "content": "SYS"}
    assert len(msgs) == 5
    assert msgs[1]["content"] == "u36"


def test_load_save_clear_qa_chat(tmp_path, monkeypatch):
    root = tmp_path / "library"
    part = root / "AIGC" / "paper1"
    part.mkdir(parents=True)
    monkeypatch.setattr(qa_chat.library, "get_library_dir", lambda: root)

    assert qa_chat.load_qa_chat("AIGC", "paper1")["messages"] == []
    assert not (part / "qa-chat.json").is_file()

    chat, msg = qa_chat.append_message(
        qa_chat.empty_chat(), role="user", content="什么是 tiling？"
    )
    saved = qa_chat.save_qa_chat("AIGC", "paper1", chat)
    assert (part / "qa-chat.json").is_file()
    assert saved["messages"][0]["id"] == msg["id"]
    data = json.loads((part / "qa-chat.json").read_text(encoding="utf-8"))
    assert data["messages"][0]["content"] == "什么是 tiling？"

    cleared = qa_chat.clear_qa_chat("AIGC", "paper1")
    assert cleared["messages"] == []
