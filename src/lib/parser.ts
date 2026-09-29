import "server-only";

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type Block = {
  id: string;
  type: string; // title | heading | paragraph | author | other
  level: number;
  text: string;
  anchor: string | null;
};

function isElement(node: AnyNode | null | undefined): node is Element {
  return Boolean(node && node.type === "tag");
}

function classList(el: Element): string {
  const c = el.attribs?.class;
  return typeof c === "string" ? c : "";
}

function cleanText($: cheerio.CheerioAPI, node: AnyNode | cheerio.Cheerio<AnyNode>): string {
  // Never String(node): Element.toString() is "[object Object]", not HTML.
  const html = isElement(node as AnyNode)
    ? $.html(node as Element)
    : typeof (node as { html?: () => string }).html === "function"
      ? String((node as cheerio.Cheerio<AnyNode>).html() || "")
      : $.html(node as AnyNode);
  const clone = cheerio.load(`<div id="_root">${html || ""}</div>`);
  clone("annotation, annotation-xml, .ltx_nop, .ltx_ERROR, script, style").remove();
  let text = clone("#_root").text().replace(/\s+/g, " ").trim();
  text = text.replace(/\\[a-zA-Z]+\b/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function headingLevel(el: Element): number {
  const classes = classList(el);
  const mapping: [string, number][] = [
    ["ltx_title_part", 1],
    ["ltx_title_chapter", 1],
    ["ltx_title_section", 2],
    ["ltx_title_subsection", 3],
    ["ltx_title_subsubsection", 4],
    ["ltx_title_paragraph", 5],
    ["ltx_title_subparagraph", 6],
    ["ltx_title_abstract", 2],
  ];
  for (const [token, level] of mapping) {
    if (classes.includes(token)) return level;
  }
  const name = (el.name || "").toLowerCase();
  if (name.length === 2 && name[0] === "h" && /\d/.test(name[1]!)) {
    return Number(name[1]);
  }
  return 2;
}

function headingAnchor($: cheerio.CheerioAPI, el: Element): string | null {
  if (el.attribs?.id) return String(el.attribs.id);
  const classes = classList(el);
  if (classes.includes("ltx_title_abstract")) {
    const parent = $(el).closest(".ltx_abstract").get(0);
    if (parent && isElement(parent)) {
      if (!parent.attribs?.id) {
        $(parent).attr("id", "abstract");
      }
      return String(parent.attribs?.id || "abstract");
    }
    return "abstract";
  }
  let cur: Element | null = el.parent && isElement(el.parent) ? el.parent : null;
  while (cur) {
    if (cur.name === "article") break;
    const pid = cur.attribs?.id;
    if (pid) {
      const pclasses = classList(cur);
      if (
        cur.name === "section" ||
        ["ltx_section", "ltx_subsection", "ltx_subsubsection", "ltx_paragraph", "ltx_abstract"].some(
          (tok) => pclasses.includes(tok),
        )
      ) {
        return String(pid);
      }
    }
    cur = cur.parent && isElement(cur.parent) ? cur.parent : null;
  }
  return null;
}

export function parseAr5ivHtml(html: string): {
  title: string;
  blocks: Block[];
  authors: string[];
} {
  const $ = cheerio.load(html);
  let title = "";
  let titleEl =
    $("h1[class*='title' i]").first().get(0) ||
    $("h1.title").first().get(0) ||
    null;
  if (!titleEl) {
    const t = $("title").first().get(0);
    if (t) titleEl = t;
  }
  if (titleEl) {
    title = cleanText($, titleEl);
    title = title.replace(/^\s*Title:\s*/i, "");
  }

  const authors: string[] = [];
  $(".ltx_authors .ltx_personname, .ltx_creator .ltx_personname").each((_, el) => {
    if (!isElement(el)) return;
    const name = cleanText($, el);
    if (name && !authors.includes(name)) authors.push(name);
  });
  if (!authors.length) {
    const authorsEl = $(".ltx_authors").first().get(0);
    if (authorsEl) {
      const raw = cleanText($, authorsEl);
      const parts = raw.split(/\s{2,}|;|\band\b/);
      for (const p of parts) {
        const s = p.trim();
        if (s.length > 1) authors.push(s);
        if (authors.length >= 12) break;
      }
    }
  }

  const article =
    $("article").first().get(0) ||
    $("div[class*='ltx_page_main' i]").first().get(0) ||
    $("body").first().get(0);
  if (!article) {
    return { title: title || "Untitled", blocks: [], authors };
  }

  const blocks: Block[] = [];
  let idx = 0;

  function add(
    blockType: string,
    level: number,
    text: string,
    anchor: string | null = null,
  ): void {
    text = text.trim();
    if (!text) return;
    idx += 1;
    blocks.push({
      id: `b${idx}`,
      type: blockType,
      level,
      text,
      anchor,
    });
  }

  if (title) add("title", 1, title);
  if (authors.length) add("author", 0, authors.join(" · "));

  const seen = new Set<string>();
  $(article)
    .find("h1, h2, h3, h4, h5, h6")
    .each((_, el) => {
      if (!isElement(el)) return;
      const classes = classList(el);
      if (classes.includes("ltx_runin") || classes.includes("ltx_title_theorem")) {
        return;
      }
      const name = (el.name || "").toLowerCase();
      if (
        !classes.includes("ltx_title") &&
        !["h1", "h2", "h3", "h4", "h5", "h6"].includes(name)
      ) {
        return;
      }
      const level = headingLevel(el);
      const text = cleanText($, el);
      if (title && text === title) return;
      const key = `h:${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      add("heading", level, text, headingAnchor($, el));
    });

  if (!blocks.length && title) add("title", 1, title);

  return {
    title: title || (blocks[0]?.text ?? "Untitled"),
    blocks,
    authors,
  };
}

export function blocksToJsonable(blocks: Block[]): Block[] {
  return blocks.map((b) => ({ ...b }));
}

export function concatBlocksText(
  title: string,
  blocks: Block[] | Array<Record<string, unknown>>,
  maxChars: number,
): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  for (const b of blocks) {
    const text =
      typeof (b as Block).text === "string"
        ? (b as Block).text
        : String((b as Record<string, unknown>).text || "");
    const btype =
      typeof (b as Block).type === "string"
        ? (b as Block).type
        : String((b as Record<string, unknown>).type || "");
    if (!text) continue;
    if (btype === "heading") parts.push(`\n## ${text}\n`);
    else if (btype === "title" || btype === "author") {
      if (btype === "author") parts.push(`Authors: ${text}`);
      continue;
    } else parts.push(text);
  }
  const joined = parts.join("\n\n").trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars - 1)}…`;
}

export {
  parseAr5ivHtml as parse_ar5iv_html,
  blocksToJsonable as blocks_to_jsonable,
  concatBlocksText as concat_blocks_text,
};
