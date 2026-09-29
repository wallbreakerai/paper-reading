import "server-only";

import { randomBytes } from "node:crypto";
import fs from "node:fs";

import * as library from "./library";
import { TranslatePaused, streamChatTokens } from "./llm";
import { getLlm, llmConfigured } from "./settings";
import type { ReadingStructure } from "./types";

export const QA_CHAT_VERSION = 1;
export const QA_HISTORY_WINDOW = 30;

const SKIP_KINDS = new Set(["spacer", "author"]);

export class QaAborted extends Error {
  constructor(message = "QaAborted") {
    super(message);
    this.name = "QaAborted";
  }
}

export type QaMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type QaChat = {
  version: number;
  messages: QaMessage[];
};

function utcNow(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `m-${randomBytes(6).toString("hex")}`;
}

export function emptyChat(): QaChat {
  return { version: QA_CHAT_VERSION, messages: [] };
}

export function loadQaChat(partition: string, slug: string): QaChat {
  const paths = library.paperPaths(partition, slug);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  if (!fs.existsSync(paths.qaChat)) return emptyChat();
  try {
    const data = JSON.parse(fs.readFileSync(paths.qaChat, "utf-8")) as unknown;
    if (!data || typeof data !== "object") return emptyChat();
    const msgs = (data as { messages?: unknown }).messages;
    if (!Array.isArray(msgs)) return emptyChat();
    const clean: QaMessage[] = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        continue;
      }
      clean.push({
        id: String((m as { id?: unknown }).id || newId()),
        role,
        content,
        createdAt: String((m as { createdAt?: unknown }).createdAt || utcNow()),
      });
    }
    return { version: QA_CHAT_VERSION, messages: clean };
  } catch {
    return emptyChat();
  }
}

export function saveQaChat(
  partition: string,
  slug: string,
  chat: QaChat,
): QaChat {
  const paths = library.paperPaths(partition, slug);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  const out: QaChat = {
    version: QA_CHAT_VERSION,
    messages: [...(chat.messages || [])],
  };
  fs.writeFileSync(paths.qaChat, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  return out;
}

export function clearQaChat(partition: string, slug: string): QaChat {
  return saveQaChat(partition, slug, emptyChat());
}

export function structureDocumentContext(
  structure: ReadingStructure | Record<string, unknown>,
): string {
  const parts: string[] = [];
  const title = String(structure.title || "").trim();
  if (title) parts.push(`# ${title}`);
  const sections = (structure.sections as Array<Record<string, unknown>>) || [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    const sentences =
      (sec.sentences as Array<Record<string, unknown>>) || [];
    for (const sent of sentences) {
      if (!sent || typeof sent !== "object") continue;
      const kind = String(sent.kind || "prose");
      if (SKIP_KINDS.has(kind)) continue;
      const text = String(sent.text || "").trim();
      if (!text) continue;
      if (kind === "heading") parts.push(`\n## ${text}`);
      else if (
        kind === "figure" ||
        kind === "table" ||
        kind === "equation" ||
        kind === "caption" ||
        kind === "reference"
      ) {
        parts.push(`[${kind}] ${text}`);
      } else {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
}

export function loadStructureOrRaise(
  partition: string,
  slug: string,
): ReadingStructure {
  const paths = library.paperPaths(partition, slug);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  if (!fs.existsSync(paths.readingStructure)) {
    throw Object.assign(new Error("阅读结构未就绪"), { code: "ENOENT" });
  }
  return JSON.parse(
    fs.readFileSync(paths.readingStructure, "utf-8"),
  ) as ReadingStructure;
}

export function buildSystemPrompt(
  structure: ReadingStructure | Record<string, unknown>,
): string {
  const doc = structureDocumentContext(structure);
  const title = String(structure.title || "").trim() || "（无标题）";
  return (
    "你是这篇学术论文的问答助手（Paper QA）。\n" +
    "根据下方「论文原文」回答用户问题。" +
    "默认用中文回答；专有名词、变量名、公式符号与 ⟦Mn⟧ 占位符保持原文，不要硬译。\n" +
    "忠实依据原文：不要编造原文没有的内容；不确定时明确说明。\n" +
    "针对问题作答，不要把整篇论文重写一遍。\n" +
    "行内公式用 $...$ 包裹，独立公式用 $$...$$（也可使用 \\(...\\) / \\[...\\]）；" +
    "不要把公式写成未加分隔符的纯 TeX 碎片。\n" +
    `论文标题：${title}\n\n` +
    "—— 论文原文 ——\n" +
    `${doc}\n` +
    "—— 原文结束 ——"
  );
}

export function appendMessage(
  chat: QaChat,
  opts: { role: "user" | "assistant"; content: string },
): { chat: QaChat; message: QaMessage } {
  const msg: QaMessage = {
    id: newId(),
    role: opts.role,
    content: opts.content,
    createdAt: utcNow(),
  };
  const next: QaChat = {
    version: QA_CHAT_VERSION,
    messages: [...(chat.messages || []), msg],
  };
  return { chat: next, message: msg };
}

export function llmMessagesForPrompt(
  system: string,
  history: QaMessage[],
  opts?: { window?: number },
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const window = opts?.window ?? QA_HISTORY_WINDOW;
  const sliced = window > 0 ? history.slice(-window) : history;
  const out: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [{ role: "system", content: system }];
  for (const m of sliced) {
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export async function* streamQaReply(
  partition: string,
  slug: string,
  userText: string,
  opts?: { shouldAbort?: (() => boolean) | null },
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const text = (userText || "").trim();
  if (!text) throw new Error("问题不能为空");
  if (!llmConfigured()) {
    throw new Error("未配置 LLM（请检查 .env 的 API_KEY / BASE_URL / MODEL）");
  }

  const structure = loadStructureOrRaise(partition, slug);
  const system = buildSystemPrompt(structure);

  let chat = loadQaChat(partition, slug);
  const appended = appendMessage(chat, { role: "user", content: text });
  chat = appended.chat;
  saveQaChat(partition, slug, chat);
  yield { type: "user", message: appended.message };

  const promptMsgs = llmMessagesForPrompt(system, chat.messages);
  getLlm(); // ensure env loaded

  const chunks: string[] = [];
  try {
    for await (const token of streamChatTokens(promptMsgs, {
      temperature: 0.3,
      shouldAbort: opts?.shouldAbort,
    })) {
      if (opts?.shouldAbort?.()) throw new QaAborted();
      chunks.push(token);
      yield { type: "token", text: token };
    }
  } catch (exc) {
    if (exc instanceof TranslatePaused) throw new QaAborted();
    throw exc;
  }

  if (opts?.shouldAbort?.()) throw new QaAborted();

  const full = chunks.join("").trim();
  if (!full) throw new Error("模型未返回内容");

  chat = loadQaChat(partition, slug);
  const done = appendMessage(chat, { role: "assistant", content: full });
  saveQaChat(partition, slug, done.chat);
  yield { type: "done", message: done.message };
}
