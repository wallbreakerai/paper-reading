import "server-only";

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

import { getLlm } from "./settings";

export class TranslatePaused extends Error {
  constructor(message = "TranslatePaused") {
    super(message);
    this.name = "TranslatePaused";
  }
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function openaiClient() {
  const llm = getLlm();
  return createOpenAI({
    apiKey: llm.apiKey,
    baseURL: llm.apiBase,
  });
}

/** Stream chat completion as string tokens (mirrors LlmClient.chat_stream). */
export async function* streamChatTokens(
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    shouldAbort?: (() => boolean) | null;
  },
): AsyncGenerator<string, void, unknown> {
  const temperature = opts?.temperature ?? 0.3;
  const shouldAbort = opts?.shouldAbort;
  const llm = getLlm();
  if (!llm.apiBase || !llm.model || !llm.apiKey) {
    throw new Error("未配置 LLM（请检查 .env 的 API_KEY / BASE_URL / MODEL）");
  }

  if (shouldAbort?.()) throw new TranslatePaused();

  const openai = openaiClient();
  const result = streamText({
    model: openai(llm.model),
    messages,
    temperature,
    abortSignal: undefined,
  });

  try {
    for await (const token of result.textStream) {
      if (shouldAbort?.()) throw new TranslatePaused();
      if (token) yield token;
    }
  } catch (e) {
    if (e instanceof TranslatePaused) throw e;
    if (shouldAbort?.()) throw new TranslatePaused();
    throw e;
  }
}

export {
  streamChatTokens as chat_stream,
  TranslatePaused as TranslatePausedError,
};
