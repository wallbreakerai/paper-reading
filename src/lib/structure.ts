import "server-only";

import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import type { OutlineItem, ReadingStructure, SectionBlock, SentenceUnit } from "./types";
import {
  applyStyleSnippets,
  classList,
  cleanText,
  collectStyleSnippets,
  deepClone,
  escapeHtml,
  findArticle,
  flattenWithEmbeds,
  flexFigurePanels,
  figureHtmlWithoutCaption,
  hasClassToken,
  headingAnchor,
  headingLevel,
  isBibitem,
  isCaption,
  isDisplayMath,
  isElement,
  isFigureOrTable,
  isHeading,
  isStyleNode,
  outerHtml,
  paragraphHosts,
  plainTextFast,
  sentenceHtmlFromText,
  tagName,
  type CheerioAPI,
  type Embed,
  elementParents,
} from "./structure-helpers";

export const STRUCTURE_VERSION = 10;
export const AUTHORS_DETAIL_VERSION = 2;

export type AuthorDetail = { name: string; affiliation: string };

export type StructureProgressEvent =
  | {
      type: "progress";
      current: number;
      total: number;
      message: string;
    }
  | { type: "done"; sections: number; sentences: number };

export type StructureBuildResult = {
  structure: ReadingStructure;
  events: StructureProgressEvent[];
};

export type StructureEnsureResult = {
  structure: ReadingStructure;
  changed: boolean;
};

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/;
const DECIMAL = /\d+\.\d+/g;
const EMAIL_RE_SRC = String.raw`[A-Z0-9._%+\-{}]+@[A-Z0-9.\-]+\.[A-Z]{2,}`;
const AFF_LABEL_RE =
  /^(affiliation|email|e-?mail|contact)\s*:?\s*/i;
const GROUP_EMAIL_RE_SRC =
  String.raw`\{([^{}]+)\}@([A-Z0-9.\-]+\.[A-Z]{2,})`;

function emailRe(): RegExp {
  return new RegExp(EMAIL_RE_SRC, "gi");
}
function groupEmailRe(): RegExp {
  return new RegExp(GROUP_EMAIL_RE_SRC, "gi");
}

const DOMAIN_ORGS: Record<string, string> = {
  "stanford.edu": "Stanford University",
  "berkeley.edu": "UC Berkeley",
  "mit.edu": "MIT",
  "cmu.edu": "Carnegie Mellon University",
  "washington.edu": "University of Washington",
  "illinois.edu": "University of Illinois",
  "buffalo.edu": "University at Buffalo",
  "nyu.edu": "New York University",
  "princeton.edu": "Princeton University",
  "harvard.edu": "Harvard University",
  "ox.ac.uk": "University of Oxford",
  "cam.ac.uk": "University of Cambridge",
  "tsinghua.edu.cn": "Tsinghua University",
  "pku.edu.cn": "Peking University",
  "google.com": "Google",
  "deepmind.com": "Google DeepMind",
  "openai.com": "OpenAI",
  "fb.com": "Meta",
  "meta.com": "Meta",
  "microsoft.com": "Microsoft",
  "apple.com": "Apple",
};

/** Split English prose on .?! followed by whitespace + capital/digit/quote. */
export function splitSentences(text: string): string[] {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const protectedVals: string[] = [];
  const masked = normalized.replace(DECIMAL, (m) => {
    protectedVals.push(m);
    return `⟦D${protectedVals.length - 1}⟧`;
  });
  const parts = masked.split(SENTENCE_END);
  const out: string[] = [];
  for (const part of parts) {
    let s = part.trim();
    if (!s) continue;
    for (let i = 0; i < protectedVals.length; i++) {
      s = s.replaceAll(`⟦D${i}⟧`, protectedVals[i]!);
    }
    out.push(s);
  }
  return out;
}

function normalizeAffiliation(text: string): string {
  let t = (text || "").trim();
  t = t.replace(AFF_LABEL_RE, "").replace(/^[\s,;|]+|[\s,;|]+$/g, "");
  return t;
}

function isContactOnlyAffiliation(text: string): boolean {
  const t = normalizeAffiliation(text);
  if (!t) return true;
  const emails = t.match(emailRe()) || [];
  if (!emails.length) return false;
  let remainder = t.replace(emailRe(), " ");
  remainder = remainder.replace(/[\s,;|/&]+/g, "");
  if (emails.length >= 1 && remainder.length <= 4) return true;
  if (emails.length >= 2 && remainder.length < 24) return true;
  return false;
}

function expandEmails(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const src = text || "";
  for (const m of src.matchAll(groupEmailRe())) {
    const domain = m[2]!;
    for (const localRaw of m[1]!.split(/\s*,\s*/)) {
      const local = localRaw.trim();
      if (!local) continue;
      const email = `${local}@${domain}`.toLowerCase();
      if (!seen.has(email)) {
        seen.add(email);
        out.push(email);
      }
    }
  }
  const stripped = src.replace(groupEmailRe(), " ");
  for (const m of stripped.matchAll(emailRe())) {
    const email = m[0]!.toLowerCase();
    if (email.includes("{") || email.includes("}")) continue;
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

function orgFromEmail(email: string): string {
  const domain = (email.split("@").pop() || "").toLowerCase();
  if (DOMAIN_ORGS[domain]) return DOMAIN_ORGS[domain]!;
  const parts = domain.split(".");
  if (parts.length > 2) {
    const parent = parts.slice(-2).join(".");
    if (DOMAIN_ORGS[parent]) return DOMAIN_ORGS[parent]!;
    if (parts.length >= 3) {
      const parent3 = parts.slice(-3).join(".");
      if (DOMAIN_ORGS[parent3]) return DOMAIN_ORGS[parent3]!;
    }
  }
  const stem = parts.length >= 2 ? parts[parts.length - 2]! : domain;
  return stem
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function emailMatchesAuthor(name: string, email: string): boolean {
  let local = (email.split("@")[0] || "").toLowerCase();
  local = local.replace(/[^a-z]/g, "");
  const parts = (name || "").toLowerCase().match(/[a-z]+/g) || [];
  if (!local || !parts.length) return false;
  const last = parts[parts.length - 1]!;
  const first = parts[0]!;
  if (last && local.includes(last)) return true;
  if (first && local.startsWith(first)) return true;
  if (first && last) {
    if (local === first + last[0]) return true;
    if (local === first.slice(0, 3) + last.slice(0, 2)) return true;
    if (local === first.slice(0, 4) + last.slice(0, 2)) return true;
  }
  const initials = parts.map((p) => p[0]).join("");
  if (initials.length >= 2 && local.includes(initials)) return true;
  return false;
}

function creatorAffiliation($: CheerioAPI, creator: Element): string {
  const candidates: string[] = [];
  $(creator)
    .find(".ltx_affiliation, .ltx_role_affiliation, .ltx_author_notes")
    .each((_, el) => {
      if (!isElement(el)) return;
      const raw = cleanText($, el);
      const text = normalizeAffiliation(raw);
      if (!text) return;
      if (isContactOnlyAffiliation(raw)) return;
      candidates.push(text);
    });
  if (!candidates.length) return "";
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0]!;
}

function affiliationsFromSharedEmails(
  $: CheerioAPI,
  authorsRoot: Element,
  names: string[],
): Record<string, string> {
  const blobParts: string[] = [];
  $(authorsRoot)
    .find(".ltx_author_notes, .ltx_role_affiliation, .ltx_contact")
    .each((_, el) => {
      if (isElement(el)) blobParts.push(cleanText($, el));
    });
  const blob = blobParts.join(" ");
  const emails = expandEmails(blob);
  if (!emails.length) return {};
  const assigned: Record<string, string> = {};
  const used = new Set<string>();
  for (const name of names) {
    for (const email of emails) {
      if (used.has(email)) continue;
      if (emailMatchesAuthor(name, email)) {
        assigned[name] = orgFromEmail(email);
        used.add(email);
        break;
      }
    }
  }
  return assigned;
}

/** Return [{name, affiliation}, ...] from ar5iv author block. */
export function extractAuthorsDetail(html: string): AuthorDetail[] {
  const $ = cheerio.load(html);
  const out: AuthorDetail[] = [];
  const seen = new Set<string>();
  const authorsRoot = $(".ltx_authors").get(0);
  const creatorNodes = $(".ltx_authors .ltx_creator").toArray().filter(isElement);

  if (!creatorNodes.length) {
    $(".ltx_authors .ltx_personname").each((_, person) => {
      if (!isElement(person)) return;
      const name = cleanText($, person);
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({ name, affiliation: "" });
      }
    });
    return out;
  }

  for (const creator of creatorNodes) {
    const person = $(creator).find(".ltx_personname").get(0);
    const name = isElement(person) ? cleanText($, person) : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let affiliation = creatorAffiliation($, creator);
    if (affiliation === name) affiliation = "";
    out.push({ name, affiliation });
  }

  if (
    isElement(authorsRoot) &&
    out.length &&
    out.every((d) => !d.affiliation)
  ) {
    const inferred = affiliationsFromSharedEmails(
      $,
      authorsRoot,
      out.map((d) => d.name),
    );
    for (const d of out) {
      if (inferred[d.name]) d.affiliation = inferred[d.name]!;
    }
  }
  return out;
}

/** True if stored authorsDetail needs re-extract (email blob as unit, etc.). */
export function authorsDetailLooksStale(
  detail: unknown,
  meta?: Record<string, unknown> | null,
): boolean {
  if (meta != null) {
    let ver = 0;
    try {
      ver = Number.parseInt(String(meta.authorsDetailVersion ?? 0), 10) || 0;
    } catch {
      ver = 0;
    }
    if (ver < AUTHORS_DETAIL_VERSION) return true;
  }
  if (!Array.isArray(detail) || !detail.length) return true;
  for (const item of detail) {
    if (!item || typeof item !== "object") return true;
    const aff = String((item as { affiliation?: unknown }).affiliation || "");
    if (!aff) continue;
    if (aff.toLowerCase().trimStart().startsWith("affiliation:")) return true;
    if (isContactOnlyAffiliation(aff)) return true;
  }
  return false;
}

function reorderDetachedCaptions(
  structure: ReadingStructure,
): ReadingStructure {
  const reorder = (sents: SentenceUnit[]): SentenceUnit[] => {
    const out: SentenceUnit[] = [];
    let i = 0;
    const n = sents.length;
    while (i < n) {
      const kind = sents[i]!.kind;
      if (kind !== "figure" && kind !== "table") {
        out.push(sents[i]!);
        i += 1;
        continue;
      }
      const medias: SentenceUnit[] = [];
      while (
        i < n &&
        (sents[i]!.kind === "figure" || sents[i]!.kind === "table")
      ) {
        medias.push(sents[i]!);
        i += 1;
      }
      const caps: SentenceUnit[] = [];
      while (i < n && sents[i]!.kind === "caption") {
        caps.push(sents[i]!);
        i += 1;
      }
      if (caps.length >= 2 && caps.length === medias.length) {
        for (let j = 0; j < medias.length; j++) {
          out.push(medias[j]!);
          out.push(caps[j]!);
        }
      } else {
        out.push(...medias, ...caps);
      }
    }
    return out;
  };

  return {
    ...structure,
    sections: (structure.sections || []).map((sec) => {
      if (!sec || typeof sec !== "object") return sec;
      if (!Array.isArray(sec.sentences)) return sec;
      return { ...sec, sentences: reorder(sec.sentences) };
    }),
  };
}

type OpenSection = {
  id: string;
  level: number;
  anchor: string | null;
  sentences: SentenceUnit[];
};

/** Build reading_structure and progress events. */
export function buildReadingStructure(html: string): StructureBuildResult {
  const events: StructureProgressEvent[] = [];
  const $ = cheerio.load(html);
  const article = findArticle($);

  let title = "Untitled";
  let titleEl: Element | null = null;
  $("h1").each((_, el) => {
    if (titleEl) return;
    if (isElement(el) && /title/i.test(classList(el))) titleEl = el;
  });
  if (!titleEl) {
    const t = $("title").get(0);
    if (isElement(t)) titleEl = t;
  }
  if (titleEl) {
    title =
      cleanText($, titleEl)
        .replace(/^\s*Title:\s*/i, "")
        .trim() || title;
  }

  if (!article) {
    const structure: ReadingStructure = {
      version: 1,
      title,
      sections: [],
    };
    events.push({ type: "done", sections: 0, sentences: 0 });
    return { structure, events };
  }

  const contentHosts = paragraphHosts($, article);
  const contentHostIds = new Set(contentHosts);
  const ordered: Array<[string, Element]> = [];
  const seen = new Set<Element>();

  $(article)
    .find("*")
    .each((_, el) => {
      if (!isElement(el)) return;
      if (seen.has(el)) return;
      if (isHeading(el)) {
        seen.add(el);
        const classes = classList(el);
        const text = cleanText($, el);
        if (
          classes.split(/\s+/).includes("ltx_title_document") ||
          (title && text === title && tagName(el) === "h1")
        ) {
          ordered.push(["doc_title", el]);
        } else {
          ordered.push(["heading", el]);
        }
        return;
      }
      if (contentHostIds.has(el)) {
        for (const p of elementParents(el)) {
          if (isHeading(p)) return;
        }
        seen.add(el);
        if (isCaption(el)) {
          ordered.push(["caption", el]);
        } else if (isDisplayMath(el)) {
          ordered.push(["equation", el]);
        } else if (isFigureOrTable(el)) {
          const classes = classList(el);
          const tokens = new Set(classes.split(/\s+/).filter(Boolean));
          const kind =
            (tokens.has("ltx_table") || tagName(el) === "table") &&
            !tokens.has("ltx_figure")
              ? "table"
              : "figure";
          ordered.push([kind, el]);
        } else if (isBibitem(el)) {
          ordered.push(["reference", el]);
        } else {
          ordered.push(["prose", el]);
        }
      }
    });

  const total = Math.max(ordered.length, 1);
  const sections: OpenSection[] = [];
  let current: OpenSection | null = null;
  let sentI = 0;
  let secI = 0;
  const consumedCaptionIds = new Set<Element>();

  const ensureSection = (
    level = 0,
    anchor: string | null = null,
  ): OpenSection => {
    if (current === null) {
      secI += 1;
      current = {
        id: `sec-${secI}`,
        level,
        anchor,
        sentences: [],
      };
      sections.push(current);
    }
    return current;
  };

  const newSection = (level: number, anchor: string | null): OpenSection => {
    secI += 1;
    current = {
      id: `sec-${secI}`,
      level,
      anchor,
      sentences: [],
    };
    sections.push(current);
    return current;
  };

  const addSentence = (
    sec: OpenSection,
    opts: {
      kind: string;
      text: string;
      html: string;
      level?: number | null;
      embeds?: Embed[] | null;
      paraStart?: boolean;
    },
  ): void => {
    let text = (opts.text || "").trim();
    const kind = opts.kind;
    if (kind === "prose" && !text) return;
    if (opts.paraStart && kind === "prose" && sec.sentences.length) {
      const lastKind = sec.sentences[sec.sentences.length - 1]!.kind;
      if (lastKind !== "heading" && lastKind !== "spacer" && lastKind !== "author") {
        sentI += 1;
        sec.sentences.push({
          id: `s-${sentI}`,
          kind: "spacer",
          text: "",
          html: '<div class="para-spacer" aria-hidden="true"></div>',
        });
      }
    }
    sentI += 1;
    if (kind === "spacer") {
      sec.sentences.push({
        id: `s-${sentI}`,
        kind: "spacer",
        text: "",
        html:
          opts.html ||
          '<div class="para-spacer" aria-hidden="true"></div>',
      });
      return;
    }
    const item: SentenceUnit = {
      id: `s-${sentI}`,
      kind,
      text: text || opts.html,
      html: opts.html || sentenceHtmlFromText(text),
    };
    if (opts.level != null) item.level = opts.level;
    if (opts.embeds?.length) item.embeds = opts.embeds;
    sec.sentences.push(item);
  };

  const authorsEl = $(".ltx_authors").get(0);

  for (let idx = 0; idx < ordered.length; idx++) {
    const [kind, el] = ordered[idx]!;
    events.push({
      type: "progress",
      current: idx + 1,
      total,
      message: `解析结构 ${idx + 1}/${total}`,
    });

    if (kind === "doc_title") {
      const sec = newSection(1, headingAnchor(el) || "title");
      const text = cleanText($, el);
      addSentence(sec, {
        kind: "heading",
        text,
        html: outerHtml($, el),
        level: 1,
      });
      if (isElement(authorsEl)) {
        const atext = cleanText($, authorsEl);
        if (atext) {
          addSentence(sec, {
            kind: "author",
            text: atext,
            html: outerHtml($, authorsEl),
          });
        }
        $(authorsEl)
          .find(".ltx_personname")
          .each((_, person) => {
            if (!isElement(person)) return;
            const pname = cleanText($, person);
            if (pname && pname !== atext) {
              addSentence(sec, {
                kind: "author",
                text: pname,
                html: outerHtml($, person),
              });
            }
          });
      }
      continue;
    }

    if (kind === "heading") {
      const level = headingLevel(el);
      const anchor = headingAnchor(el);
      const text = cleanText($, el);
      if (!text) continue;
      const sec = newSection(level, anchor);
      addSentence(sec, {
        kind: "heading",
        text,
        html: outerHtml($, el),
        level,
      });
      continue;
    }

    const sec = ensureSection();
    if (kind === "caption") {
      if (consumedCaptionIds.has(el)) continue;
      const { text, embeds } = flattenWithEmbeds($, el);
      if (text) {
        addSentence(sec, {
          kind: "caption",
          text,
          html: outerHtml($, el),
          embeds: embeds.length ? embeds : null,
        });
      }
      continue;
    }
    if (kind === "equation") {
      addSentence(sec, {
        kind: "equation",
        text: cleanText($, el) || "[equation]",
        html: outerHtml($, el),
      });
      continue;
    }
    if (kind === "figure" || kind === "table") {
      const panels = flexFigurePanels($, el);
      if (panels.length) {
        $(el)
          .find("figcaption, .ltx_caption")
          .each((_, cap) => {
            if (!isElement(cap)) return;
            for (const p of elementParents(cap)) {
              if (hasClassToken(p, "ltx_flex_cell")) {
                consumedCaptionIds.add(cap);
                break;
              }
            }
          });
        for (const panel of panels) {
          addSentence(sec, {
            kind: panel.kind,
            text: panel.text,
            html: panel.html,
          });
          const capText = (panel.caption_text || "").trim();
          if (capText) {
            const capHtml = panel.caption_html || "";
            let capEmbeds: Embed[] | null = null;
            let flatText = capText;
            if (capHtml && capHtml.toLowerCase().includes("<math")) {
              const capSoup = cheerio.load(capHtml);
              const capRoot =
                capSoup("figcaption").get(0) ||
                capSoup(".ltx_caption").get(0) ||
                capSoup("*").get(0);
              if (isElement(capRoot)) {
                const flat = flattenWithEmbeds(capSoup, capRoot);
                flatText = flat.text || capText;
                capEmbeds = flat.embeds.length ? flat.embeds : null;
              }
            }
            addSentence(sec, {
              kind: "caption",
              text: flatText,
              html: capHtml,
              embeds: capEmbeds,
            });
          }
        }
        continue;
      }
      const figHtml = figureHtmlWithoutCaption($, el);
      const figSoup = cheerio.load(figHtml);
      const figRoot = figSoup("*").get(0);
      addSentence(sec, {
        kind,
        text:
          (isElement(figRoot) ? cleanText(figSoup, figRoot) : "") ||
          `[${kind}]`,
        html: figHtml,
      });
      continue;
    }
    if (kind === "reference") {
      const text = cleanText($, el);
      if (text) {
        addSentence(sec, {
          kind: "reference",
          text,
          html: outerHtml($, el),
        });
      }
      continue;
    }

    const flat = flattenWithEmbeds($, el);
    const styles = collectStyleSnippets($, el);
    let parts = splitSentences(flat.text);
    if (!parts.length && flat.text) parts = [flat.text];
    if (parts.length <= 1) {
      if (flat.text) {
        let htmlOut = flat.html || sentenceHtmlFromText(flat.text);
        if (!htmlOut.includes("ltx_font_") && !htmlOut.includes("ltx_emph")) {
          htmlOut = applyStyleSnippets(
            flat.text,
            htmlOut.includes("<")
              ? htmlOut
              : sentenceHtmlFromText(flat.text),
            styles,
          );
        }
        addSentence(sec, {
          kind: "prose",
          text: flat.text,
          html: htmlOut,
          embeds: flat.embeds.length ? flat.embeds : null,
          paraStart: true,
        });
      }
    } else {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const used: Embed[] = [];
        for (const emb of flat.embeds) {
          const token = `⟦M${emb.id.slice(1)}⟧`;
          if (part.includes(token)) used.push(emb);
        }
        let htmlOut = sentenceHtmlFromText(part);
        htmlOut = applyStyleSnippets(part, htmlOut, styles);
        for (const emb of used) {
          const token = `⟦M${emb.id.slice(1)}⟧`;
          htmlOut = htmlOut.replaceAll(
            escapeHtml(token),
            `<span class="sent-embed">${emb.html}</span>`,
          );
        }
        addSentence(sec, {
          kind: "prose",
          text: part,
          html: htmlOut,
          embeds: used.length ? used : null,
          paraStart: i === 0,
        });
      }
    }
  }

  const kept = sections.filter((s) => s.sentences.length);
  const structure: ReadingStructure = {
    version: STRUCTURE_VERSION,
    title,
    sections: kept.map((s) => ({
      id: s.id,
      level: s.level,
      anchor: s.anchor,
      sentences: s.sentences,
    })),
  };
  const nSent = kept.reduce((acc, s) => acc + s.sentences.length, 0);
  events.push({
    type: "done",
    sections: kept.length,
    sentences: nSent,
  });
  return { structure, events };
}

export function structureToOutline(
  structure: ReadingStructure | Record<string, unknown>,
): OutlineItem[] {
  const out: OutlineItem[] = [];
  const sections =
    ((structure as ReadingStructure).sections as SectionBlock[]) || [];
  for (const sec of sections) {
    for (const sent of sec.sentences || []) {
      if (sent.kind !== "heading") continue;
      out.push({
        id: sent.id,
        sectionId: sec.id,
        type: "heading",
        level: sent.level || sec.level || 2,
        text: sent.text || "",
        anchor: sec.anchor,
      });
      break;
    }
  }
  return out;
}

function sentenceFingerprint(sent: SentenceUnit): [string, string] {
  return [String(sent.kind || ""), (sent.text || "").slice(0, 240)];
}

function sectionFingerprint(sec: SectionBlock): string {
  for (const sent of sec.sentences || []) {
    if (sent.kind === "heading") return (sent.text || "").trim();
  }
  return String(sec.anchor || sec.id || "");
}

function nextSentenceNum(structure: ReadingStructure): number {
  let n = 0;
  for (const sec of structure.sections || []) {
    for (const sent of sec.sentences || []) {
      const sid = String(sent.id || "");
      if (sid.startsWith("s-")) {
        const v = Number.parseInt(sid.slice(2), 10);
        if (!Number.isNaN(v)) n = Math.max(n, v);
      }
    }
  }
  return n + 1;
}

function nextSectionNum(structure: ReadingStructure): number {
  let n = 0;
  for (const sec of structure.sections || []) {
    const sid = String(sec.id || "");
    if (sid.startsWith("sec-")) {
      const v = Number.parseInt(sid.slice(4), 10);
      if (!Number.isNaN(v)) n = Math.max(n, v);
    }
  }
  return n + 1;
}

function ensureUniqueIds(structure: ReadingStructure): ReadingStructure {
  const usedSec = new Set<string>();
  const usedSent = new Set<string>();
  let nextSec = nextSectionNum(structure);
  let nextSent = nextSentenceNum(structure);
  for (const sec of structure.sections || []) {
    let sid = String(sec.id || "");
    if (!sid || usedSec.has(sid)) {
      sid = `sec-${nextSec}`;
      nextSec += 1;
      sec.id = sid;
    }
    usedSec.add(sid);
    for (const sent of sec.sentences || []) {
      let tid = String(sent.id || "");
      if (!tid || usedSent.has(tid)) {
        tid = `s-${nextSent}`;
        nextSent += 1;
        sent.id = tid;
      }
      usedSent.add(tid);
    }
  }
  return structure;
}

/** Reuse old sentence/section ids where fingerprints match. */
export function remapStructureIds(
  old: ReadingStructure,
  neu: ReadingStructure,
): ReadingStructure {
  const out = deepClone(neu);
  const oldSentQueues = new Map<string, string[]>();
  for (const sec of old.sections || []) {
    for (const sent of sec.sentences || []) {
      const fp = sentenceFingerprint(sent).join("\0");
      const q = oldSentQueues.get(fp) || [];
      q.push(String(sent.id || ""));
      oldSentQueues.set(fp, q);
    }
  }
  const oldSecQueues = new Map<string, string[]>();
  for (const sec of old.sections || []) {
    const sfp = sectionFingerprint(sec);
    if (sfp) {
      const q = oldSecQueues.get(sfp) || [];
      q.push(String(sec.id || ""));
      oldSecQueues.set(sfp, q);
    }
  }
  let nextN = nextSentenceNum(old);
  let nextSec = nextSectionNum(old);
  for (const sec of out.sections || []) {
    const sfp = sectionFingerprint(sec);
    const queue = sfp ? oldSecQueues.get(sfp) : undefined;
    if (queue?.length) {
      sec.id = queue.shift()!;
    } else {
      sec.id = `sec-${nextSec}`;
      nextSec += 1;
    }
    for (const sent of sec.sentences || []) {
      const fp = sentenceFingerprint(sent).join("\0");
      const sq = oldSentQueues.get(fp) || [];
      if (sq.length) {
        sent.id = sq.shift()!;
      } else {
        sent.id = `s-${nextN}`;
        nextN += 1;
      }
    }
  }
  out.version = STRUCTURE_VERSION;
  return ensureUniqueIds(out);
}

function nextSentenceIndex(structure: ReadingStructure): number {
  return nextSentenceNum(structure);
}

function injectBibliographyReferences(
  html: string,
  structure: ReadingStructure,
): ReadingStructure {
  const out = deepClone(structure);
  const $ = cheerio.load(html);
  const items = $(".ltx_bibitem").toArray().filter(isElement);
  if (!items.length) {
    out.version = STRUCTURE_VERSION;
    return out;
  }

  let refSec: SectionBlock | null = null;
  for (const sec of out.sections || []) {
    for (const sent of sec.sentences || []) {
      if (sent.kind !== "heading") continue;
      const t = (sent.text || "").trim().toLowerCase();
      if (t.includes("reference") || t.includes("bibliograph")) {
        refSec = sec;
        break;
      }
    }
    if (refSec) break;
  }

  if (!refSec) {
    const heading =
      $(".ltx_title_bibliography").get(0) ||
      $(".ltx_bibliography .ltx_title").get(0);
    const headingText = isElement(heading)
      ? cleanText($, heading)
      : "References";
    const headingHtml = isElement(heading)
      ? outerHtml($, heading)
      : `<h2>${escapeHtml(headingText)}</h2>`;
    let nextSec = 1;
    for (const sec of out.sections || []) {
      const sid = String(sec.id || "");
      if (sid.startsWith("sec-")) {
        const v = Number.parseInt(sid.slice(4), 10);
        if (!Number.isNaN(v)) nextSec = Math.max(nextSec, v + 1);
      }
    }
    let n = nextSentenceIndex(out);
    refSec = {
      id: `sec-${nextSec}`,
      level: 2,
      anchor: "bib",
      sentences: [
        {
          id: `s-${n}`,
          kind: "heading",
          text: headingText,
          html: headingHtml,
          level: 2,
        },
      ],
    };
    out.sections = out.sections || [];
    out.sections.push(refSec);
  }

  refSec.sentences = (refSec.sentences || []).filter(
    (s) => s.kind !== "reference",
  );
  let n = nextSentenceIndex(out);
  for (const el of items) {
    const text = cleanText($, el);
    if (!text) continue;
    refSec.sentences.push({
      id: `s-${n}`,
      kind: "reference",
      text,
      html: outerHtml($, el),
    });
    n += 1;
  }
  out.version = Math.max(Number(out.version || 1), 5);
  return out;
}

function convertParastartToSpacers(
  structure: ReadingStructure,
): ReadingStructure {
  const out = deepClone(structure);
  let n = nextSentenceIndex(out);
  for (const sec of out.sections || []) {
    const rebuilt: SentenceUnit[] = [];
    for (let sent of sec.sentences || []) {
      if (sent.paraStart && sent.kind === "prose") {
        if (
          rebuilt.length &&
          !["heading", "spacer", "author"].includes(
            rebuilt[rebuilt.length - 1]!.kind,
          )
        ) {
          rebuilt.push({
            id: `s-${n}`,
            kind: "spacer",
            text: "",
            html: '<div class="para-spacer" aria-hidden="true"></div>',
          });
          n += 1;
        }
        const { paraStart: _p, ...rest } = sent;
        void _p;
        sent = rest;
      }
      rebuilt.push(sent);
    }
    sec.sentences = rebuilt;
  }
  out.version = Math.max(Number(out.version || 1), 6);
  return out;
}

function splitCompositeFigureUnits(
  structure: ReadingStructure,
): ReadingStructure {
  const out = deepClone(structure);
  let n = nextSentenceIndex(out);
  for (const sec of out.sections || []) {
    const rebuilt: SentenceUnit[] = [];
    for (const sent of sec.sentences || []) {
      const kind = sent.kind;
      const html = sent.html || "";
      if (
        (kind !== "figure" && kind !== "table") ||
        !html.toLowerCase().includes("<table") ||
        !html.toLowerCase().includes("<img")
      ) {
        rebuilt.push(sent);
        continue;
      }
      const soup = cheerio.load(html);
      const root =
        soup("figure").get(0) || soup("div").get(0) || soup("*").get(0);
      let panels = isElement(root) ? flexFigurePanels(soup, root) : [];
      if (panels.length < 2) {
        const table = soup("table").get(0);
        const img = soup("img").get(0);
        panels = [];
        if (isElement(table)) {
          panels.push({
            kind: "table",
            text: cleanText(soup, table) || "[table]",
            html: outerHtml(soup, table),
          });
        }
        if (isElement(img)) {
          panels.push({
            kind: "figure",
            text: (img.attribs?.alt || "").trim() || "[figure]",
            html: outerHtml(soup, img),
          });
        }
      }
      if (panels.length < 2) {
        rebuilt.push(sent);
        continue;
      }
      for (let i = 0; i < panels.length; i++) {
        const panel = panels[i]!;
        if (i === 0) {
          rebuilt.push({
            ...sent,
            kind: panel.kind,
            text: panel.text,
            html: panel.html,
          });
        } else {
          rebuilt.push({
            id: `s-${n}`,
            kind: panel.kind,
            text: panel.text,
            html: panel.html,
          });
          n += 1;
        }
      }
    }
    sec.sentences = rebuilt;
  }
  out.version = Math.max(Number(out.version || 1), 7);
  return out;
}

function reinjectInlineStyles(
  html: string,
  structure: ReadingStructure,
): ReadingStructure {
  const out = deepClone(structure);
  const $ = cheerio.load(html);
  const article = findArticle($);
  if (!article) {
    out.version = Math.max(Number(out.version || 1), 8);
    return out;
  }

  const snippets: Array<[string, string]> = [];
  const seen = new Set<string>();
  $(article)
    .find("*")
    .each((_, node) => {
      if (!isElement(node) || !isStyleNode(node)) return;
      let nested = false;
      for (const p of elementParents(node)) {
        if (p === article) break;
        if (isStyleNode(p)) {
          nested = true;
          break;
        }
      }
      if (nested) return;
      if (
        $(node).find("math").length ||
        $(node).find("img").length ||
        $(node).find("table").length
      ) {
        return;
      }
      const text = plainTextFast(node);
      if (!text || text.length < 2 || seen.has(text)) return;
      if (text.length > 180) return;
      seen.add(text);
      snippets.push([text, outerHtml($, node)]);
    });
  snippets.sort((a, b) => b[0].length - a[0].length);

  for (const sec of out.sections || []) {
    for (const sent of sec.sentences || []) {
      if (sent.kind !== "prose") continue;
      const text = sent.text || "";
      if (!text) continue;
      let htmlOut = sent.html || "";
      if (!htmlOut || htmlOut === text) {
        htmlOut = sentenceHtmlFromText(text);
      }
      const cand = snippets.filter(([t]) => text.includes(t));
      if (!cand.length) continue;
      sent.html = applyStyleSnippets(text, htmlOut, cand);
    }
  }
  out.version = Math.max(Number(out.version || 1), 8);
  return out;
}

function extractCaptionEmbeds(structure: ReadingStructure): ReadingStructure {
  const out = deepClone(structure);
  for (const sec of out.sections || []) {
    for (const sent of sec.sentences || []) {
      if (sent.kind !== "caption") continue;
      const html = sent.html || "";
      if (
        !html.toLowerCase().includes("<math") &&
        !html.includes("ltx_Math")
      ) {
        continue;
      }
      if (sent.embeds?.length && (sent.text || "").includes("⟦M")) continue;
      const soup = cheerio.load(html);
      const root =
        soup("figcaption").get(0) ||
        soup(".ltx_caption").get(0) ||
        soup("*").get(0);
      if (!isElement(root)) continue;
      const { text, embeds } = flattenWithEmbeds(soup, root);
      if (!embeds.length) continue;
      sent.embeds = embeds;
      if (text) sent.text = text;
    }
  }
  out.version = Math.max(Number(out.version || 1), 10);
  return out;
}

/** Build or upgrade structure to STRUCTURE_VERSION. */
export function ensureReadingStructure(
  html: string,
  existing: ReadingStructure | null | undefined,
): StructureEnsureResult {
  const ver = existing ? Number(existing.version || 1) : 0;
  if (existing && ver >= STRUCTURE_VERSION) {
    const before = JSON.stringify(
      (existing.sections || []).map((s) => [
        s.id,
        (s.sentences || []).map((x) => x.id),
      ]),
    );
    const fixed = ensureUniqueIds(existing);
    const after = JSON.stringify(
      (fixed.sections || []).map((s) => [
        s.id,
        (s.sentences || []).map((x) => x.id),
      ]),
    );
    return { structure: fixed, changed: before !== after };
  }
  if (existing && ver >= 4) {
    let out: ReadingStructure = existing;
    if (ver < 5) out = injectBibliographyReferences(html, out);
    if (ver < 6) out = convertParastartToSpacers(out);
    if (ver < 7) out = splitCompositeFigureUnits(out);
    if (ver < 8) out = reinjectInlineStyles(html, out);
    if (ver < 9) out = reorderDetachedCaptions(out);
    if (ver < 10) out = extractCaptionEmbeds(out);
    out.version = STRUCTURE_VERSION;
    return { structure: ensureUniqueIds(out), changed: true };
  }
  const { structure: fresh } = buildReadingStructure(html);
  if (!existing) {
    return { structure: ensureUniqueIds(fresh), changed: true };
  }
  return { structure: remapStructureIds(existing, fresh), changed: true };
}

// snake_case aliases matching Python public names
export {
  splitSentences as split_sentences,
  extractAuthorsDetail as extract_authors_detail,
  authorsDetailLooksStale as authors_detail_looks_stale,
  buildReadingStructure as build_reading_structure,
  structureToOutline as structure_to_outline,
  remapStructureIds as remap_structure_ids,
  ensureReadingStructure as ensure_reading_structure,
};
