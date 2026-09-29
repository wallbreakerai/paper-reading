/**
 * Internal DOM/text helpers for reading-structure extraction (cheerio port of
 * python/app/structure.py + parser._clean_text / _heading_*).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";

export type CheerioAPI = cheerio.CheerioAPI;

export const STYLE_CLASSES = new Set([
  "ltx_font_bold",
  "ltx_font_italic",
  "ltx_font_smallcaps",
  "ltx_font_typewriter",
  "ltx_font_slanted",
  "ltx_font_mathsf",
  "ltx_font_mathcaligraphic",
  "ltx_font_upright",
  "ltx_font_medium",
  "ltx_emph",
]);

export const STYLE_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "u",
  "mark",
  "code",
]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function unescapeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(Number(n)),
    )
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function classSet(el: Element): Set<string> {
  const raw = el.attribs?.class || "";
  return new Set(raw.split(/\s+/).filter(Boolean));
}

export function classList(el: Element): string {
  return el.attribs?.class || "";
}

export function hasClassToken(el: Element, token: string): boolean {
  return classSet(el).has(token);
}

export function isElement(node: AnyNode | null | undefined): node is Element {
  return !!node && node.type === "tag";
}

export function isText(node: AnyNode | null | undefined): node is Text {
  return !!node && node.type === "text";
}

export function outerHtml($: CheerioAPI, el: Element): string {
  const raw = $.html(el) ?? "";
  return sanitizeMathHtml(raw);
}

/** Strip LaTeXML MathML quirks that browsers show as literal text. */
export function sanitizeMathHtml(html: string): string {
  if (!html) return html;
  let out = html;
  if (/<annotation\b/i.test(out)) {
    out = out
      .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi, "")
      .replace(/<annotation-xml\b[^>]*>[\s\S]*?<\/annotation-xml>/gi, "");
  }
  if (/>\s*OPEN\s*</i.test(out) || />\s*CLOSE\s*</i.test(out)) {
    out = out
      .replace(/<mo\b[^>]*>\s*OPEN\s*<\/mo>/gi, "")
      .replace(/<mo\b[^>]*>\s*CLOSE\s*<\/mo>/gi, "");
  }
  return out;
}

export function tagName(el: Element): string {
  return (el.name || "").toLowerCase();
}

export function* elementParents(el: Element): Generator<Element> {
  let p: AnyNode | null = el.parent;
  while (p) {
    if (isElement(p)) yield p;
    p = (p as Element).parent ?? null;
  }
}

export function cleanText(
  $ctx: CheerioAPI,
  node: AnyNode | null | undefined,
): string {
  if (!node) return "";
  if (isText(node)) return unescapeHtml(node.data || "");
  if (!isElement(node)) return "";
  const html = sanitizeMathHtml(outerHtml($ctx, node));
  const $ = cheerio.load(html);
  $("annotation, annotation-xml, .ltx_nop, .ltx_ERROR, script, style").remove();
  // Also drop fence markers if any remained as text nodes
  $("mo").each((_, el) => {
    const t = ($(el).text() || "").trim();
    if (t === "OPEN" || t === "CLOSE") $(el).remove();
  });
  let text = $.root().text();
  text = unescapeHtml(text);
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\\[a-zA-Z]+\b/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function headingLevel(el: Element): number {
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
    if (classes.split(/\s+/).includes(token)) return level;
  }
  const name = tagName(el);
  if (name.length === 2 && name[0] === "h" && /\d/.test(name[1]!)) {
    return Number(name[1]);
  }
  return 2;
}

export function headingAnchor(el: Element): string | null {
  if (el.attribs?.id) return String(el.attribs.id);
  const classes = classList(el);
  if (classes.split(/\s+/).includes("ltx_title_abstract")) {
    for (const parent of elementParents(el)) {
      if (hasClassToken(parent, "ltx_abstract")) {
        if (!parent.attribs?.id) {
          parent.attribs = parent.attribs || {};
          parent.attribs.id = "abstract";
        }
        return String(parent.attribs.id);
      }
    }
    return "abstract";
  }
  for (const parent of elementParents(el)) {
    if (tagName(parent) === "article") break;
    const pid = parent.attribs?.id;
    if (!pid) continue;
    const pclasses = classList(parent);
    const tokens = pclasses.split(/\s+/);
    if (
      tagName(parent) === "section" ||
      tokens.some((tok) =>
        [
          "ltx_section",
          "ltx_subsection",
          "ltx_subsubsection",
          "ltx_paragraph",
          "ltx_abstract",
        ].includes(tok),
      )
    ) {
      return String(pid);
    }
  }
  return null;
}

export function isHeading(el: Element): boolean {
  const name = tagName(el);
  const classes = classSet(el);
  if (classes.has("ltx_runin") || classes.has("ltx_title_theorem")) return false;
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(name)) return true;
  return classes.has("ltx_title") && !["span", "em", "strong"].includes(name);
}

export function isDisplayMath(el: Element): boolean {
  const classes = classSet(el);
  if (classes.has("ltx_equation") || classes.has("ltx_equationgroup")) {
    return true;
  }
  if (tagName(el) === "math" && el.attribs?.display === "block") return true;
  return false;
}

export function isCaption(el: Element): boolean {
  const classes = classSet(el);
  return (
    tagName(el) === "figcaption" ||
    tagName(el) === "caption" ||
    classes.has("ltx_caption")
  );
}

export function isFigureOrTable(el: Element): boolean {
  if (isDisplayMath(el)) return false;
  const name = tagName(el);
  const classes = classSet(el);
  if (name === "figure" || classes.has("ltx_figure")) return true;
  if (classes.has("ltx_float") && !classes.has("ltx_equation")) return true;
  if (classes.has("ltx_table") && !classes.has("ltx_equation")) return true;
  if (name === "table" && classes.has("ltx_tabular")) return true;
  return false;
}

export function isBibitem(el: Element): boolean {
  return classSet(el).has("ltx_bibitem");
}

export function isStyleNode(el: Element): boolean {
  const name = tagName(el);
  if (STYLE_TAGS.has(name)) return true;
  const classes = classSet(el);
  for (const c of classes) {
    if (STYLE_CLASSES.has(c)) return true;
  }
  return false;
}

export function plainTextFast(node: Element): string {
  const walk = (n: AnyNode): string => {
    if (isText(n)) return n.data || "";
    if (!isElement(n)) return "";
    return (n.children || []).map(walk).join(" ");
  };
  return walk(node).replace(/\s+/g, " ").trim();
}

export function sentenceHtmlFromText(text: string): string {
  return `<span class="sent-text">${escapeHtml(text)}</span>`;
}

export function extractHtmlFragment($: CheerioAPI, el: Element): string {
  const inner = ($(el).html() || "").trim();
  return inner || outerHtml($, el);
}

export function figureHtmlWithoutCaption($ctx: CheerioAPI, el: Element): string {
  const $ = cheerio.load(outerHtml($ctx, el));
  const name = tagName(el);
  let rootEl = name ? $(name).get(0) : $("*").get(0);
  if (!isElement(rootEl)) return outerHtml($ctx, el);
  const root = $(rootEl);
  root.find("figcaption, .ltx_caption").remove();
  root.find("object").each((_, obj) => {
    if (!isElement(obj)) return;
    const data = (obj.attribs?.data || "").trim();
    if (!data) {
      $(obj).remove();
      return;
    }
    const img = $("<img>");
    img.attr("src", data);
    for (const attr of ["width", "height", "id", "alt", "class", "style"] as const) {
      if (obj.attribs?.[attr]) img.attr(attr, obj.attribs[attr]);
    }
    if (!img.attr("alt")) img.attr("alt", "Refer to caption");
    $(obj).replaceWith(img);
  });
  rootEl = name ? $(name).get(0) : $("*").get(0);
  return isElement(rootEl) ? ($.html(rootEl) ?? "") : outerHtml($ctx, el);
}

export type PanelInfo = {
  kind: string;
  text: string;
  html: string;
  caption_text?: string;
  caption_html?: string;
};

function panelKindAndHtml(
  $: CheerioAPI,
  cell: Element,
): { kind: string; text: string; html: string } | null {
  const table = $(cell).find("table").get(0);
  let img = $(cell).find("img").get(0);
  if (!img) {
    const obj = $(cell).find("object").get(0);
    if (isElement(obj) && (obj.attribs?.data || "").trim()) {
      img = obj;
    }
  }
  if (isElement(table) && !img) {
    const text = cleanText($, table) || "[table]";
    return { kind: "table", text, html: outerHtml($, table) };
  }
  if (isElement(img)) {
    if (tagName(img) === "object") {
      const src = (img.attribs?.data || "").trim();
      const alt = (img.attribs?.alt || "").trim() || "Refer to caption";
      const cls = classList(img) || "ltx_graphics";
      let html = `<img class="${cls}" src="${src}" alt="${alt}"`;
      for (const attr of ["width", "height", "id"] as const) {
        if (img.attribs?.[attr]) html += ` ${attr}="${img.attribs[attr]}"`;
      }
      html += "/>";
      return { kind: "figure", text: alt, html };
    }
    const alt = (img.attribs?.alt || "").trim();
    const text = alt || cleanText($, cell) || "[figure]";
    return { kind: "figure", text, html: outerHtml($, img) };
  }
  const text = cleanText($, cell);
  if (!text) return null;
  return { kind: "figure", text, html: outerHtml($, cell) };
}

export function flexFigurePanels($: CheerioAPI, el: Element): PanelInfo[] {
  const flexNode = $(el).find(".ltx_flex_figure").first().get(0);
  if (!isElement(flexNode)) return [];
  const panels: PanelInfo[] = [];
  $(flexNode)
    .children("div")
    .each((_, cell) => {
      if (!isElement(cell)) return;
      const classes = classSet(cell);
      if (classes.has("ltx_flex_break") || !classes.has("ltx_flex_cell")) return;
      const capEl = $(cell).find("figcaption, .ltx_caption").first().get(0);
      let caption_text = "";
      let caption_html = "";
      if (isElement(capEl)) {
        caption_text = cleanText($, capEl);
        caption_html = outerHtml($, capEl);
      }
      const stripped = cheerio.load(outerHtml($, cell));
      stripped("figcaption, .ltx_caption").remove();
      const node =
        stripped("div.ltx_flex_cell").get(0) || stripped("*").get(0);
      if (!isElement(node)) return;
      const parsed = panelKindAndHtml(stripped, node);
      if (!parsed) return;
      const panel: PanelInfo = {
        kind: parsed.kind,
        text: parsed.text,
        html: parsed.html,
      };
      if (caption_text) {
        panel.caption_text = caption_text;
        panel.caption_html = caption_html;
      }
      panels.push(panel);
    });
  return panels.length >= 2 ? panels : [];
}

export function paragraphHosts($: CheerioAPI, article: Element): Element[] {
  const hosts: Element[] = [];
  $(article)
    .find("*")
    .each((_, el) => {
      if (!isElement(el)) return;
      const classes = classSet(el);
      const name = tagName(el);
      if (isHeading(el)) return;
      // Exact class token — never substring-match "ltx_p" against "ltx_para".
      if (name === "p" || classes.has("ltx_p")) {
        hosts.push(el);
        return;
      }
      if (isCaption(el)) {
        hosts.push(el);
        return;
      }
      if (isDisplayMath(el)) {
        hosts.push(el);
        return;
      }
      if (isFigureOrTable(el)) {
        hosts.push(el);
        return;
      }
      if (isBibitem(el)) {
        hosts.push(el);
        return;
      }
      if (name === "blockquote" || classes.has("ltx_blockquote")) {
        hosts.push(el);
      }
    });
  const hostIds = new Set(hosts);

  const nestedUnderOtherHost = (el: Element): boolean => {
    for (const parent of elementParents(el)) {
      if (!hostIds.has(parent)) continue;
      if (isCaption(el) && isFigureOrTable(parent)) return false;
      return true;
    }
    return false;
  };

  return hosts.filter((el) => !nestedUnderOtherHost(el));
}

export function collectStyleSnippets(
  $: CheerioAPI,
  el: Element,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  $(el)
    .find("*")
    .each((_, node) => {
      if (!isElement(node) || !isStyleNode(node)) return;
      let nested = false;
      for (const p of elementParents(node)) {
        if (p === el) break;
        if (isStyleNode(p)) {
          nested = true;
          break;
        }
      }
      if (nested) return;
      const text = plainTextFast(node);
      if (!text || text.length < 2) return;
      if (
        $(node).find("math").length ||
        $(node).find("img").length ||
        $(node).find("table").length
      ) {
        return;
      }
      out.push([text, outerHtml($, node)]);
    });
  out.sort((a, b) => b[0].length - a[0].length);
  return out;
}

export function applyStyleSnippets(
  part: string,
  htmlOutIn: string,
  styles: Array<[string, string]>,
): string {
  let htmlOut = htmlOutIn;
  for (const [text, nodeHtml] of styles) {
    if (!part.includes(text)) continue;
    if (htmlOut.includes(nodeHtml)) continue;
    const esc = escapeHtml(text);
    const idx = htmlOut.indexOf(esc);
    if (idx < 0) continue;
    const before = htmlOut.slice(0, idx);
    const opens = [
      ...before.matchAll(/<(span|strong|b|em|i|u|code|mark)\b([^>]*)>/gi),
    ];
    const closes = [
      ...before.matchAll(/<\/(span|strong|b|em|i|u|code|mark)>/gi),
    ];
    let depth = 0;
    let styledDepth = 0;
    const tokens: Array<{
      start: number;
      kind: "o" | "c";
      m: RegExpMatchArray;
    }> = [
      ...opens.map((m) => ({ start: m.index!, kind: "o" as const, m })),
      ...closes.map((m) => ({ start: m.index!, kind: "c" as const, m })),
    ].sort((a, b) => a.start - b.start);
    for (const { kind, m } of tokens) {
      if (kind === "o") {
        depth += 1;
        const attrs = m[2] || "";
        const tag = (m[1] || "").toLowerCase();
        if (
          STYLE_TAGS.has(tag) ||
          attrs.includes("ltx_font_") ||
          attrs.includes("ltx_emph")
        ) {
          styledDepth += 1;
        }
      } else {
        depth = Math.max(0, depth - 1);
        void depth;
        styledDepth = Math.max(0, styledDepth - 1);
      }
    }
    if (styledDepth > 0) continue;
    htmlOut = htmlOut.slice(0, idx) + nodeHtml + htmlOut.slice(idx + esc.length);
  }
  return htmlOut;
}

export type Embed = { id: string; html: string };

export function flattenWithEmbeds(
  $: CheerioAPI,
  el: Element,
): { text: string; embeds: Embed[]; html: string } {
  const embeds: Embed[] = [];
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  const walk = (node: AnyNode): void => {
    if (isText(node)) {
      const raw = unescapeHtml(node.data || "");
      if (raw.trim()) textParts.push(raw);
      htmlParts.push(escapeHtml(raw));
      return;
    }
    if (!isElement(node)) return;
    const name = tagName(node);
    const classSet_ = classSet(node);
    if (
      name === "annotation" ||
      name === "annotation-xml" ||
      name === "script" ||
      name === "style"
    ) {
      return;
    }
    if (classSet_.has("ltx_ERROR") || classSet_.has("ltx_nop")) return;
    if (
      name === "math" ||
      classSet_.has("ltx_Math") ||
      classSet_.has("ltx_equation")
    ) {
      const idx = embeds.length;
      embeds.push({ id: `m${idx}`, html: outerHtml($, node) });
      const token = `⟦M${idx}⟧`;
      textParts.push(token);
      htmlParts.push(
        `<span class="sent-embed" data-embed="${idx}">${outerHtml($, node)}</span>`,
      );
      return;
    }
    const href = String(node.attribs?.href || "");
    if (name === "a" && (classSet_.has("ltx_ref") || href.startsWith("#"))) {
      const idx = embeds.length;
      embeds.push({ id: `m${idx}`, html: outerHtml($, node) });
      const token = `⟦M${idx}⟧`;
      textParts.push(token);
      htmlParts.push(
        `<span class="sent-embed" data-embed="${idx}">${outerHtml($, node)}</span>`,
      );
      return;
    }
    if (name === "img" || isFigureOrTable(node) || name === "table") {
      const idx = embeds.length;
      embeds.push({ id: `m${idx}`, html: outerHtml($, node) });
      const token = `⟦M${idx}⟧`;
      textParts.push(token);
      htmlParts.push(
        `<span class="sent-embed" data-embed="${idx}">${outerHtml($, node)}</span>`,
      );
      return;
    }
    if (isStyleNode(node)) {
      let attrs = "";
      const cls = node.attribs?.class;
      if (cls) attrs += ` class="${cls}"`;
      htmlParts.push(`<${name}${attrs}>`);
      for (const child of node.children || []) walk(child);
      htmlParts.push(`</${name}>`);
      return;
    }
    for (const child of node.children || []) walk(child);
  };

  walk(el);
  const text = textParts.join("").replace(/\s+/g, " ").trim();
  const html = htmlParts.join("").trim() || extractHtmlFragment($, el);
  return { text, embeds, html };
}

export function findArticle($: CheerioAPI): Element | null {
  const article = $("article").get(0);
  if (isElement(article)) return article;
  let found: Element | null = null;
  $("div").each((_, el) => {
    if (found) return;
    if (isElement(el) && /ltx_page_main/i.test(classList(el))) {
      found = el;
    }
  });
  if (found) return found;
  const body = $("body").get(0);
  return isElement(body) ? body : null;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
