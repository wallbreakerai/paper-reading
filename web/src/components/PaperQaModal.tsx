"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Eraser, MessageSquare, Square, X } from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";

export type QaMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type Props = {
  open: boolean;
  partition: string;
  slug: string;
  title: string;
  onClose: () => void;
};

export function PaperQaModal({
  open,
  partition,
  slug,
  title,
  onClose,
}: Props) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickRef = useRef(true);

  const apiBase = `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/qa/chat`;

  const scrollToBottom = useCallback((force = false) => {
    const el = listRef.current;
    if (!el) return;
    if (!force && !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(apiBase);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(
            typeof data.detail === "string" ? data.detail : "加载对话失败",
          );
        }
        setMessages(Array.isArray(data.messages) ? data.messages : []);
        setLoaded(true);
        requestAnimationFrame(() => scrollToBottom(true));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载对话失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, apiBase, scrollToBottom]);

  useEffect(() => {
    if (!open) return;
    scrollToBottom();
  }, [messages, streamText, streaming, open, scrollToBottom]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setStreamText("");
  }, []);

  const handleClose = useCallback(() => {
    stop();
    onClose();
  }, [onClose, stop]);

  const clearChat = useCallback(async () => {
    if (streaming) return;
    setError(null);
    try {
      const res = await fetch(apiBase, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string" ? data.detail : "清空失败",
        );
      }
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "清空失败");
    }
  }, [apiBase, streaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    setStreaming(true);
    setStreamText("");
    stickRef.current = true;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `请求失败 (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let draft = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let ev: {
            type?: string;
            text?: string;
            message?: QaMessage | string;
          };
          try {
            ev = JSON.parse(raw);
          } catch {
            continue;
          }
          if (ev.type === "user" && ev.message && typeof ev.message === "object") {
            setMessages((prev) => [...prev, ev.message as QaMessage]);
          } else if (ev.type === "token" && typeof ev.text === "string") {
            draft += ev.text;
            setStreamText(draft);
          } else if (
            ev.type === "done" &&
            ev.message &&
            typeof ev.message === "object"
          ) {
            setMessages((prev) => [...prev, ev.message as QaMessage]);
            draft = "";
            setStreamText("");
          } else if (ev.type === "aborted") {
            draft = "";
            setStreamText("");
          } else if (ev.type === "error") {
            throw new Error(
              typeof ev.message === "string" ? ev.message : "问答失败",
            );
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // closed / stopped
      } else {
        setError(err instanceof Error ? err.message : "问答失败");
      }
      setStreamText("");
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [apiBase, input, streaming]);

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void send();
    }
  };

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  if (!open) return null;

  return (
    <div
      className="qa-modal-backdrop"
      onClick={handleClose}
      role="presentation"
    >
      <div
        className="qa-modal"
        role="dialog"
        aria-modal="true"
        aria-label="论文问答"
        onClick={(ev) => ev.stopPropagation()}
      >
        <header className="qa-modal-head">
          <div className="qa-modal-title">
            <MessageSquare size={16} />
            <span>论文问答</span>
            <span className="qa-modal-sub" title={title}>
              {title}
            </span>
          </div>
          <div className="qa-modal-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              title="清空对话"
              aria-label="清空对话"
              disabled={streaming || messages.length === 0}
              onClick={() => void clearChat()}
            >
              <Eraser size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              title="关闭"
              aria-label="关闭"
              onClick={handleClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div
          className="qa-modal-list"
          ref={listRef}
          onScroll={onListScroll}
        >
          {loading && !loaded ? (
            <p className="qa-modal-empty">加载中…</p>
          ) : messages.length === 0 && !streaming && !streamText ? (
            <p className="qa-modal-empty">
              基于本篇原文回答问题。可问方法、实验、公式含义等。
            </p>
          ) : (
            <>
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`qa-bubble qa-bubble-${m.role}`}
                >
                  {m.role === "assistant" ? (
                    <ChatMarkdown content={m.content} />
                  ) : (
                    <div className="qa-bubble-plain">{m.content}</div>
                  )}
                </div>
              ))}
              {streaming && !streamText ? (
                <div
                  className="qa-bubble qa-bubble-assistant qa-bubble-thinking"
                  aria-live="polite"
                >
                  <span className="qa-thinking-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  正在推理…
                </div>
              ) : null}
              {streamText ? (
                <div className="qa-bubble qa-bubble-assistant">
                  <ChatMarkdown content={streamText} streaming />
                  <span className="qa-stream-cursor" aria-hidden />
                </div>
              ) : null}
            </>
          )}
        </div>

        {error ? <p className="qa-modal-error">{error}</p> : null}

        <form
          className="qa-modal-input"
          onSubmit={(ev: FormEvent) => {
            ev.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={streaming}
            placeholder="问这篇论文…（Enter 发送，Shift+Enter 换行）"
          />
          <div className="qa-modal-input-actions">
            {streaming ? (
              <button
                type="button"
                className="btn btn-default btn-sm"
                onClick={stop}
                title="停止生成"
              >
                <Square size={14} />
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!input.trim()}
              >
                发送
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
