import "server-only";

import * as cheerio from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";

import { TranslatePaused, streamChatTokens } from "./llm";

export const SYSTEM = (
  "你是学术论文英译中译者。请对用户给出的句子做忠实全文翻译：" +
  "保留原意与信息量，不要总结、不要省略、不要添加原文没有的内容。" +
  "专有名词、变量名、⟦M0⟧ 这类公式/图表占位符必须原样保留" +
  "（不要展开成 d d、F_{1}、\\times 等明文；不要改写占位符编号）。\n" +
  "若原文含内联样式标签，译文必须在对应语义位置保留相同标签（可嵌套；" +
  "标签内写中文；不要发明原文没有的标签）：\n" +
  "  <b>加粗</b>  <i>斜体</i>  <em>强调</em>  <code>等宽</code>  " +
  "<u>下划线</u>  <sc>小型大写</sc>\n" +
  "严格按下面格式输出（不要 JSON、不要 Markdown 代码围栏）：\n" +
  "<<<句子id>>>\n" +
  "该句的中文译文\n" +
  "<<<下一句id>>>\n" +
  "该句的中文译文\n" +
  "必须为每个输入 id 恰好输出一块；不得增删 id；译文里不要再写 <<< >>> 标记。"
);

const BLOCK_RE =
  /<<<\s*([^>\s]+)\s*>>>\s*\n([\s\S]*?)(?=\n<<<\s*[^>\s]+\s*>>>|$)/g;

const JSON_PAIR_RE =
  /"id"\s*:\s*"([^"]+)"\s*,\s*"zh"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export const MAX_SENTENCES_PER_BATCH = 8;
export const MAX_CHARS_PER_BATCH = 2800;

const STYLE_HINT_RE =
  /ltx_font_(?:bold|italic|slanted|smallcaps|typewriter)|ltx_emph|<(?:b|strong|i|em|code|u|math)\b|ltx_Math/i;

function isElement(node: AnyNode): node is Element {
  return node.type === "tag";
}

function isText(node: AnyNode): node is Text {
  return node.type === "text";
}

function classSet(el: Element): Set<string> {
  const raw = el.attribs?.class || "";
  return new Set(raw.split(/\s+/).filter(Boolean));
}

function styleWrapTag(el: Element): string | null {
  const name = (el.name || "").toLowerCase();
  const classes = classSet(el);
  if (name === "b" || name === "strong" || classes.has("ltx_font_bold")) return "b";
  if (classes.has("ltx_font_smallcaps")) return "sc";
  if (
    name === "i" ||
    classes.has("ltx_font_italic") ||
    classes.has("ltx_font_slanted")
  ) {
    return "i";
  }
  if (name === "em" || classes.has("ltx_emph")) return "em";
  if (name === "code" || classes.has("ltx_font_typewriter")) return "code";
  if (name === "u") return "u";
  return null;
}

export function chunkSentences(
  sentences: Array<Record<string, unknown>>,
  opts?: { maxSentences?: number; maxChars?: number },
): Array<Array<Record<string, unknown>>> {
  const maxSentences = opts?.maxSentences ?? MAX_SENTENCES_PER_BATCH;
  const maxChars = opts?.maxChars ?? MAX_CHARS_PER_BATCH;
  const batches: Array<Array<Record<string, unknown>>> = [];
  let cur: Array<Record<string, unknown>> = [];
  let curChars = 0;
  for (const s of sentences) {
    const textLen = sentenceSourceForTranslate(s).length;
    if (cur.length && (cur.length >= maxSentences || curChars + textLen > maxChars)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += textLen;
  }
  if (cur.length) batches.push(cur);
  return batches.length ? batches : [[]];
}

export function htmlToTranslateMarkup(html: string): string {
  if (!(html || "").trim()) return "";
  const $ = cheerio.load(`<div id="_root">${html}</div>`);
  const root = $("#_root").get(0);
  if (!root || !isElement(root)) {
    return cheerio.load(html).root().text().replace(/\s+/g, " ").trim();
  }

  let embedI = 0;

  function walk(node: AnyNode): string {
    if (isText(node)) return node.data || "";
    if (!isElement(node)) return "";
    const name = (node.name || "").toLowerCase();
    const classes = classSet(node);
    if (["annotation", "annotation-xml", "script", "style"].includes(name)) {
      return "";
    }
    if (classes.has("sent-embed")) {
      const idx = node.attribs?.["data-embed"];
      if (idx != null && String(idx).trim() !== "") return `⟦M${idx}⟧`;
      return $(node).text().replace(/\s+/g, " ").trim();
    }
    if (name === "math" || classes.has("ltx_Math")) {
      const token = `⟦M${embedI}⟧`;
      embedI += 1;
      return token;
    }
    if (["img", "svg", "table", "figure"].includes(name)) {
      const token = `⟦M${embedI}⟧`;
      embedI += 1;
      return token;
    }
    const inner = (node.children || []).map(walk).join("");
    const wrap = styleWrapTag(node);
    if (wrap && inner) return `<${wrap}>${inner}</${wrap}>`;
    return inner;
  }

  const text = (root.children || []).map(walk).join("");
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

export function sentenceSourceForTranslate(
  sentence: Record<string, unknown>,
): string {
  const plain = String(sentence.text || "").trim();
  const html = String(sentence.html || "");
  if (!html) return plain;
  const hasStyle = STYLE_HINT_RE.test(html);
  const hasMath = html.toLowerCase().includes("<math") || html.includes("ltx_Math");
  const plainHasTokens = plain.includes("⟦M");
  if (
    hasStyle ||
    (hasMath && !plainHasTokens) ||
    (html.includes("sent-embed") && !plainHasTokens)
  ) {
    const marked = htmlToTranslateMarkup(html);
    if (marked) return marked;
  }
  return plain;
}

function sectionUserPrompt(
  sectionId: string,
  sentences: Array<Record<string, unknown>>,
): string {
  const lines = [
    `请翻译章节块 ${sectionId} 中的下列句子（严格一一对应，使用 <<<id>>> 格式；` +
      "保留 <b>/<i>/<em>/<code>/<u>/<sc> 与 ⟦Mn⟧）：",
    "",
  ];
  for (const s of sentences) {
    const sid = String(s.id || "");
    const kind = String(s.kind || "prose");
    const text = sentenceSourceForTranslate(s);
    lines.push(`[${kind}] ${sid}:`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function* runSectionTranslateStream(
  sectionId: string,
  sentences: Array<Record<string, unknown>>,
  opts?: { shouldAbort?: (() => boolean) | null },
): AsyncGenerator<string, void, unknown> {
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: sectionUserPrompt(sectionId, sentences) },
  ];
  yield* streamChatTokens(messages, {
    temperature: 0.2,
    shouldAbort: opts?.shouldAbort,
  });
}

function unescapeJsonStr(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
}

export function parseSectionTranslation(
  raw: string,
  expectedIds: string[],
): Record<string, string> {
  let text = (raw || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  const out: Record<string, string> = {};

  BLOCK_RE.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_RE)) {
    const sid = (m[1] || "").trim();
    const zh = (m[2] || "").trim();
    if (sid) out[sid] = zh;
  }

  if (Object.keys(out).length < expectedIds.length) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const data = JSON.parse(match[0]) as { sentences?: unknown };
        const items = data.sentences;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const sid = String((item as { id?: unknown }).id || "").trim();
            const zh = (item as { zh?: unknown }).zh;
            if (sid && !(sid in out)) {
              out[sid] = zh == null ? "" : String(zh).trim();
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (Object.keys(out).length < expectedIds.length) {
    JSON_PAIR_RE.lastIndex = 0;
    for (const m of text.matchAll(JSON_PAIR_RE)) {
      const sid = (m[1] || "").trim();
      if (sid && !(sid in out)) {
        out[sid] = unescapeJsonStr(m[2] || "").trim();
      }
    }
  }

  const missing = expectedIds.filter((i) => !(i in out));
  const extra = Object.keys(out).filter((i) => !expectedIds.includes(i));
  if (missing.length || extra.length) {
    throw new Error(
      `句对不对齐：缺少 ${missing.slice(0, 5).join(",")}${missing.length > 5 ? "…" : ""}，` +
        `多余 ${extra.slice(0, 5).join(",")}${extra.length > 5 ? "…" : ""}`,
    );
  }
  const result: Record<string, string> = {};
  for (const id of expectedIds) result[id] = out[id]!;
  return result;
}

export async function translateSentencesWithRetry(
  sectionId: string,
  sentences: Array<Record<string, unknown>>,
  opts?: {
    onPreview?: ((text: string) => void) | null;
    shouldAbort?: (() => boolean) | null;
    maxAttempts?: number;
  },
): Promise<Record<string, string>> {
  const expectedIds = sentences.map((s) => String(s.id));
  const maxAttempts = opts?.maxAttempts ?? 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.shouldAbort?.()) throw new TranslatePaused();
    const full: string[] = [];
    for await (const token of runSectionTranslateStream(sectionId, sentences, {
      shouldAbort: opts?.shouldAbort,
    })) {
      full.push(token);
      opts?.onPreview?.(full.join(""));
    }
    const raw = full.join("");
    try {
      return parseSectionTranslation(raw, expectedIds);
    } catch (exc) {
      if (exc instanceof TranslatePaused) throw exc;
      lastErr = exc;
      if (attempt + 1 >= maxAttempts) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export {
  chunkSentences as chunk_sentences,
  htmlToTranslateMarkup as html_to_translate_markup,
  sentenceSourceForTranslate as sentence_source_for_translate,
  parseSectionTranslation as parse_section_translation,
  translateSentencesWithRetry as translate_sentences_with_retry,
};
