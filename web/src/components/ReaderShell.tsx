"use client";

import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  List,
  ListX,
  Pause,
  X,
  ExternalLink,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  NotebookPen,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { PaperQaModal } from "@/components/PaperQaModal";
import type {
  OutlineItem,
  ReadingStructure,
  SectionBlock,
  SentenceUnit,
  Translation,
} from "@/lib/types";

type AuthorDetail = { name: string; affiliation?: string };

type Props = {
  partition: string;
  slug: string;
  title: string;
  authors: string[];
  authorsDetail: AuthorDetail[];
  initialStructure: ReadingStructure | null;
  initialOutline: OutlineItem[];
  translation: Translation;
  autoStart: boolean;
  initialStatus: string;
  sourceUrl?: string | null;
  arxivId?: string | null;
};

const OUTLINE_KEY = "paper-reading-outline-open";

function rewriteLocalAssets(html: string, partition: string, slug: string): string {
  const base = `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/assets/`;
  return stripMathAnnotations(html)
    .replace(/(src|href)=(["'])assets\//gi, `$1=$2${base}`)
    .replace(/(xlink:href)=(["'])assets\//gi, `$1=$2${base}`);
}

/** MathML <annotation> TeX often leaks as visible text beside the rendered math. */
function stripMathAnnotations(html: string): string {
  if (!html || !/<annotation\b/i.test(html)) return html;
  return html
    .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi, "")
    .replace(/<annotation-xml\b[^>]*>[\s\S]*?<\/annotation-xml>/gi, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape ZH text but keep LLM style tags as EN-matching class spans. */
function escapeZhKeepingStyles(zh: string): string {
  if (!zh) return "";
  const tokens: string[] = [];
  const protectedZh = zh.replace(
    /<\/?(?:b|i|em|code|u|sc)\b[^>]*>/gi,
    (tag) => {
      const i = tokens.length;
      tokens.push(tag);
      return `\uE000${i}\uE001`;
    },
  );
  let out = escapeHtml(protectedZh);
  out = out.replace(/\uE000(\d+)\uE001/g, (_, n) => {
    const tag = tokens[Number(n)] || "";
    const m = /^<\/?\s*([a-zA-Z]+)/.exec(tag);
    const name = (m?.[1] || "").toLowerCase();
    const closing = tag.trimStart().startsWith("</");
    if (closing) return "</span>";
    const cls =
      name === "b"
        ? "ltx_text ltx_font_bold"
        : name === "i"
          ? "ltx_text ltx_font_italic"
          : name === "em"
            ? "ltx_text ltx_emph"
            : name === "code"
              ? "ltx_text ltx_font_typewriter"
              : name === "sc"
                ? "ltx_text ltx_font_smallcaps"
                : name === "u"
                  ? "ltx_text ltx_font_underlined"
                  : "";
    return cls ? `<span class="${cls}">` : "";
  });
  return out;
}

const MEDIA_KINDS = new Set([
  "equation",
  "figure",
  "table",
  "reference",
  "spacer",
]);

type AnchorTarget = {
  sentenceId: string;
  kind: string;
  text: string;
  anchorId?: string;
};

const ANCHOR_KIND_PRIORITY: Record<string, number> = {
  reference: 50,
  caption: 45,
  figure: 40,
  table: 40,
  equation: 35,
  heading: 20,
  prose: 10,
};

function putAnchor(
  map: Map<string, AnchorTarget>,
  raw: string,
  target: AnchorTarget,
  foldCase = false,
) {
  const trimmed = raw.replace(/^#/, "").trim();
  if (!trimmed) return;
  const id = foldCase ? trimmed.toLowerCase() : trimmed;
  const prev = map.get(id);
  if (
    !prev ||
    (ANCHOR_KIND_PRIORITY[target.kind] || 0) >
      (ANCHOR_KIND_PRIORITY[prev.kind] || 0)
  ) {
    map.set(id, {
      ...target,
      anchorId: target.anchorId || trimmed,
    });
  }
}

function putFigLabel(map: Map<string, AnchorTarget>, n: string, target: AnchorTarget) {
  for (const k of [`fig.${n}`, `fig. ${n}`, `fig ${n}`, `figure ${n}`, `figure.${n}`]) {
    putAnchor(map, k, target, true);
  }
}

function putTableLabel(
  map: Map<string, AnchorTarget>,
  n: string,
  target: AnchorTarget,
) {
  for (const k of [`tab.${n}`, `tab. ${n}`, `table ${n}`, `table.${n}`]) {
    putAnchor(map, k, target, true);
  }
}

function putEqLabel(map: Map<string, AnchorTarget>, n: string, target: AnchorTarget) {
  for (const k of [`eq.${n}`, `eq. ${n}`, `equation ${n}`, `eq ${n}`]) {
    putAnchor(map, k, target, true);
  }
}

function buildAnchorIndex(sections: SectionBlock[]): Map<string, AnchorTarget> {
  const map = new Map<string, AnchorTarget>();
  for (const sec of sections) {
    const heading = sec.sentences.find((s) => s.kind === "heading");
    if (sec.anchor && heading) {
      putAnchor(map, sec.anchor, {
        sentenceId: heading.id,
        kind: "heading",
        text: heading.text,
        anchorId: sec.anchor,
      });
    }
    for (const sent of sec.sentences) {
      if (sent.kind === "spacer") continue;
      const target: AnchorTarget = {
        sentenceId: sent.id,
        kind: sent.kind,
        text: sent.text || "",
      };
      const html = sent.html || "";
      for (const m of html.matchAll(/\bid=["']([^"']+)["']/gi)) {
        const id = m[1];
        putAnchor(map, id, { ...target, anchorId: id });
        const fig = /\.F(\d+)\b/i.exec(id);
        if (fig) putFigLabel(map, fig[1], { ...target, kind: sent.kind === "caption" ? "caption" : "figure", anchorId: id });
        const tab = /\.T(\d+)\b/i.exec(id);
        if (tab) putTableLabel(map, tab[1], { ...target, kind: sent.kind === "caption" ? "caption" : "table", anchorId: id });
        const eq = /\.E(\d+)\b/i.exec(id);
        if (eq) putEqLabel(map, eq[1], { ...target, kind: "equation", anchorId: id });
        const bib = /bib\.?bib(\d+)\s*$/i.exec(id);
        if (bib) {
          putAnchor(map, bib[1], { ...target, kind: "reference", anchorId: id }, true);
          putAnchor(map, `[${bib[1]}]`, { ...target, kind: "reference", anchorId: id }, true);
        }
      }
      const text = sent.text || "";
      const cap = /^(Figure|Fig\.?|Table|Tab\.?|Equation|Eq\.?)\s*(\d+)\b/i.exec(
        text.trim(),
      );
      if (cap) {
        const n = cap[2];
        const kind = cap[1].toLowerCase();
        if (kind.startsWith("fig")) putFigLabel(map, n, { ...target, anchorId: target.anchorId });
        else if (kind.startsWith("tab")) putTableLabel(map, n, target);
        else putEqLabel(map, n, target);
      }
      const refNum = /^\[(\d+)\]/.exec(text.trim());
      if (refNum && sent.kind === "reference") {
        putAnchor(map, refNum[1], { ...target, kind: "reference" }, true);
        putAnchor(map, `[${refNum[1]}]`, { ...target, kind: "reference" }, true);
      }
    }
  }
  return map;
}

function lookupPlainRef(
  labelIndex: Map<string, AnchorTarget>,
  raw: string,
): AnchorTarget | null {
  const s = raw.trim();
  const named =
    /^(fig|figure|tab|table|eq|equation)\.?\s*(\d+)$/i.exec(s) ||
    /^(图|表|公式)\s*(\d+)$/u.exec(s);
  if (named) {
    const kind = named[1].toLowerCase();
    const n = named[2];
    const keys =
      kind.startsWith("fig") || kind === "图"
        ? [`fig.${n}`, `figure ${n}`, `fig. ${n}`]
        : kind.startsWith("tab") || kind === "表"
          ? [`table ${n}`, `tab.${n}`, `tab. ${n}`]
          : [`eq.${n}`, `equation ${n}`, `eq. ${n}`];
    for (const k of keys) {
      const hit = labelIndex.get(k.toLowerCase());
      if (hit) return hit;
    }
  }
  const bracket = /^\[(\d+)\]$/.exec(s);
  if (bracket) {
    return (
      labelIndex.get(bracket[1]) ||
      labelIndex.get(`[${bracket[1]}]`) ||
      null
    );
  }
  return labelIndex.get(s.toLowerCase()) || null;
}

/** Wrap plain Fig.1 / Table 2 / [80] / 图 1 in clickable anchors when links were lost. */
function linkifyPlainRefs(
  html: string,
  labelIndex: Map<string, AnchorTarget>,
): string {
  if (!html || labelIndex.size === 0) return html;
  const re =
    /\b((?:Fig|Figure|Tab|Table|Eq|Equation)\.?\s*\d+)\b|\[(\d+)\]|(图|表|公式)\s*(\d+)/giu;
  let out = "";
  let i = 0;
  let inTag = false;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      inTag = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ">") {
      inTag = false;
      out += ch;
      i += 1;
      continue;
    }
    if (inTag) {
      out += ch;
      i += 1;
      continue;
    }
    // Don't nest inside existing anchors
    if (html.slice(Math.max(0, i - 64), i).match(/<a\b[^>]*$/i)) {
      out += ch;
      i += 1;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(html);
    if (!m || m.index !== i) {
      out += ch;
      i += 1;
      continue;
    }
    // Skip if already inside an <a>...</a> — crude: look back for unclosed <a
    const before = out;
    const openA = before.lastIndexOf("<a ");
    const closeA = before.lastIndexOf("</a>");
    if (openA > closeA) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const label = m[1] || (m[2] ? `[${m[2]}]` : `${m[3]} ${m[4]}`);
    const hit = lookupPlainRef(labelIndex, label);
    if (!hit) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const href = hit.anchorId || hit.sentenceId;
    out += `<a class="ltx_ref plain-ref" href="#${escapeHtml(href)}" data-ref-sentence="${escapeHtml(hit.sentenceId)}">${m[0]}</a>`;
    i += m[0].length;
  }
  return out;
}

type CitePopupState = {
  label: string;
  body: string;
  html: string;
  targetId: string | null;
  kind: string;
};

type ExternalLinkPopupState = {
  href: string;
  label: string;
};

function isExternalHref(href: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith("#")) return false;
  if (h.startsWith("mailto:") || h.startsWith("tel:")) return true;
  if (/^https?:\/\//i.test(h) || h.startsWith("//")) return true;
  // Protocol-relative or bare domains sometimes appear in papers
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return true;
  return false;
}

function normalizeExternalHref(href: string): string {
  const h = href.trim();
  if (h.startsWith("//")) return `https:${h}`;
  return h;
}

function sentenceById(
  sections: SectionBlock[],
  id: string | null | undefined,
): SentenceUnit | null {
  if (!id) return null;
  for (const sec of sections) {
    for (const sent of sec.sentences) {
      if (sent.id === id) return sent;
    }
  }
  return null;
}

function captionFigTabNum(
  text: string,
): { kind: "figure" | "table"; n: string } | null {
  const named =
    /^(Figure|Fig\.?|Table|Tab\.?)\s*(\d+)\b/i.exec(text.trim()) ||
    /^(图|表)\s*(\d+)\b/u.exec(text.trim());
  if (!named) return null;
  const k = named[1].toLowerCase();
  const isTab = k.startsWith("tab") || k === "表";
  return { kind: isTab ? "table" : "figure", n: named[2] };
}

function extractFigTabNum(
  hit: AnchorTarget | null,
  sent: SentenceUnit | null,
): { kind: "figure" | "table"; n: string } | null {
  // Prefer human labels (Table 5) over LaTeXML parent ids (S4.T6 wraps both 5 & 6).
  const fromText = captionFigTabNum(sent?.text || hit?.text || "");
  if (fromText) return fromText;

  const aid = hit?.anchorId || "";
  const fig = /\.F(\d+)\b/i.exec(aid);
  if (fig) return { kind: "figure", n: fig[1] };
  const tab = /\.T(\d+)\b/i.exec(aid);
  if (tab) return { kind: "table", n: tab[1] };

  const html = `${sent?.html || ""} ${aid}`;
  const figH = /\.F(\d+)\b/i.exec(html);
  const tabH = /\.T(\d+)\b/i.exec(html);
  if (hit?.kind === "table" || sent?.kind === "table") {
    if (tabH) return { kind: "table", n: tabH[1] };
  }
  if (
    hit?.kind === "figure" ||
    sent?.kind === "figure" ||
    hit?.kind === "caption" ||
    sent?.kind === "caption"
  ) {
    if (figH) return { kind: "figure", n: figH[1] };
    if (tabH) return { kind: "table", n: tabH[1] };
  }
  if (figH) return { kind: "figure", n: figH[1] };
  if (tabH) return { kind: "table", n: tabH[1] };
  return null;
}

/** Same grouping as the reader body: consecutive media + following caption. */
function iterMediaCaptionGroups(
  sections: SectionBlock[],
): Array<{ medias: SentenceUnit[]; caption: SentenceUnit | null }> {
  const groups: Array<{
    medias: SentenceUnit[];
    caption: SentenceUnit | null;
  }> = [];
  for (const sec of sections) {
    const sents = sec.sentences;
    let i = 0;
    while (i < sents.length) {
      const kind = sents[i].kind;
      if (kind === "figure" || kind === "table") {
        const medias: SentenceUnit[] = [];
        while (
          i < sents.length &&
          (sents[i].kind === "figure" || sents[i].kind === "table")
        ) {
          medias.push(sents[i]);
          i += 1;
        }
        let caption: SentenceUnit | null = null;
        if (i < sents.length && sents[i].kind === "caption") {
          caption = sents[i];
          i += 1;
        }
        groups.push({ medias, caption });
        continue;
      }
      if (kind === "caption") {
        groups.push({ medias: [], caption: sents[i] });
      }
      i += 1;
    }
  }
  return groups;
}

function findMediaCaptionGroup(
  sections: SectionBlock[],
  hit: AnchorTarget | null,
  sent: SentenceUnit | null,
): { medias: SentenceUnit[]; caption: SentenceUnit | null } | null {
  const groups = iterMediaCaptionGroups(sections);
  const sid = hit?.sentenceId || sent?.id || "";
  if (sid) {
    for (const g of groups) {
      if (g.medias.some((m) => m.id === sid) || g.caption?.id === sid) {
        return g;
      }
    }
  }

  const ft =
    captionFigTabNum(sent?.text || "") ||
    captionFigTabNum(hit?.text || "") ||
    extractFigTabNum(hit, sent);
  if (ft) {
    for (const g of groups) {
      const capNum = g.caption ? captionFigTabNum(g.caption.text || "") : null;
      if (capNum && capNum.kind === ft.kind && capNum.n === ft.n) {
        return g;
      }
    }
  }
  return null;
}

/** Build rich popup HTML: figure/table media + caption, or bibliography markup. */
function buildCitePopupContent(
  sections: SectionBlock[],
  hit: AnchorTarget | null,
  partition: string,
  slug: string,
  fallbackBody: string,
): Pick<CitePopupState, "body" | "html" | "kind" | "targetId"> {
  const sent = sentenceById(sections, hit?.sentenceId);
  const kind = hit?.kind || sent?.kind || "ref";

  if (kind === "reference" || sent?.kind === "reference") {
    let refSent = sent;
    if (!refSent && hit?.anchorId) {
      const aid = hit.anchorId;
      outer: for (const sec of sections) {
        for (const s of sec.sentences) {
          if (s.kind !== "reference") continue;
          if (
            (s.html || "").includes(`id="${aid}"`) ||
            (s.html || "").includes(`id='${aid}'`) ||
            new RegExp(
              `\\bid=["']${aid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
            ).test(s.html || "")
          ) {
            refSent = s;
            break outer;
          }
          const num = /bib\.?bib(\d+)/i.exec(aid)?.[1];
          if (num && new RegExp(`^\\[${num}\\]`).test((s.text || "").trim())) {
            refSent = s;
            break outer;
          }
        }
      }
    }
    const html = rewriteLocalAssets(refSent?.html || "", partition, slug);
    const body = (refSent?.text || hit?.text || fallbackBody || "").trim();
    return {
      kind: "reference",
      body: html ? "" : body,
      html,
      targetId: refSent?.id || hit?.sentenceId || null,
    };
  }

  if (
    kind === "equation" ||
    sent?.kind === "equation" ||
    kind === "heading"
  ) {
    const html = rewriteLocalAssets(sent?.html || "", partition, slug);
    const body = (sent?.text || hit?.text || fallbackBody || "").trim();
    return {
      kind: kind === "heading" ? "heading" : "equation",
      body: html ? "" : body,
      html,
      targetId: hit?.sentenceId || sent?.id || null,
    };
  }

  const group = findMediaCaptionGroup(sections, hit, sent);
  const ft =
    (group?.caption && captionFigTabNum(group.caption.text || "")) ||
    extractFigTabNum(hit, sent);
  if (
    group &&
    (ft ||
      kind === "figure" ||
      kind === "table" ||
      kind === "caption" ||
      sent?.kind === "figure" ||
      sent?.kind === "table" ||
      sent?.kind === "caption")
  ) {
    const parts: string[] = [];
    for (const m of group.medias) {
      const h = (m.html || "").trim();
      if (!h) continue;
      parts.push(
        `<div class="cite-media">${rewriteLocalAssets(h, partition, slug)}</div>`,
      );
    }
    if (group.caption?.html) {
      parts.push(
        `<div class="cite-caption">${rewriteLocalAssets(group.caption.html, partition, slug)}</div>`,
      );
    }
    const html = parts.join("");
    const captionText = (group.caption?.text || "").trim();
    const body = html
      ? ""
      : captionText ||
        (sent?.kind === "caption" ? sent.text : "") ||
        fallbackBody;
    const popupKind =
      ft?.kind ||
      (kind === "caption" || sent?.kind === "caption"
        ? group.medias[0]?.kind === "table"
          ? "table"
          : "figure"
        : kind === "table" || sent?.kind === "table"
          ? "table"
          : "figure");
    return {
      kind: popupKind,
      body: (body || "").trim(),
      html,
      targetId:
        group.medias[0]?.id ||
        group.caption?.id ||
        hit?.sentenceId ||
        sent?.id ||
        null,
    };
  }

  // Fallback: show whatever HTML/text we have on the hit sentence.
  if (sent?.html) {
    return {
      kind,
      body: "",
      html: rewriteLocalAssets(sent.html, partition, slug),
      targetId: sent.id,
    };
  }
  const text = (sent?.text || hit?.text || fallbackBody || "").trim();
  return {
    kind,
    body: text === "[figure]" || text === "[table]" ? fallbackBody : text,
    html: "",
    targetId: hit?.sentenceId || null,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function embedIndex(emb: { id?: string }, fallback: number): string {
  const id = emb.id || "";
  if (id.startsWith("m") && id.length > 1) return id.slice(1);
  if (/^\d+$/.test(id)) return id;
  return String(fallback);
}

/** Pull math embeds from sentence.html when structure embeds are missing. */
function embedsForSentence(
  sent: SentenceUnit,
): { id: string; html: string }[] {
  if (sent.embeds?.length) return sent.embeds;
  const html = sent.html || "";
  if (!/<math\b/i.test(html) && !/<a\b/i.test(html)) return [];
  const embeds: { id: string; html: string }[] = [];
  // Prefer structure order from sent-embed wrappers when present.
  const wrapRe =
    /<span class="sent-embed"(?:\s+data-embed="(\d+)")?>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  let foundWrap = false;
  while ((m = wrapRe.exec(html))) {
    foundWrap = true;
    const idx = m[1] != null ? m[1] : String(embeds.length);
    embeds.push({ id: `m${idx}`, html: m[2] });
  }
  if (foundWrap) return embeds;
  const mathRe = /<math\b[\s\S]*?<\/math>/gi;
  while ((m = mathRe.exec(html))) {
    embeds.push({ id: `m${embeds.length}`, html: m[0] });
  }
  return embeds;
}

function mathPlainFromHtml(block: string): string {
  return block
    .replace(/<annotation[\s\S]*?<\/annotation>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mathTexFromHtml(block: string): string {
  const raw =
    /alttext="([^"]*)"/i.exec(block)?.[1] ||
    /application\/x-tex">([^<]*)</i.exec(block)?.[1] ||
    "";
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * When the model drops ⟦Mn⟧ and writes raw math / TeX / “d d”, map leftovers
 * back to the sentence embeds (must use real embed ids, not 0..n-1).
 */
function recoverZhEmbedTokens(
  zh: string,
  embeds: { id: string; html: string }[],
): string {
  if (!zh || !embeds.length) return zh;
  if (/⟦M\d+⟧/.test(zh)) return zh;

  // Opaque numeric masks — must not embed letters like “M0”, or the next
  // single-char math pass will match inside the mask itself.
  const held: string[] = [];
  const maskTok = (token: string) => {
    const i = held.length;
    held.push(token);
    return `\uE010${i}\uE011`;
  };
  const maskExisting = (s: string) =>
    s.replace(/⟦M\d+⟧/g, (m) => maskTok(m));
  const unmaskAll = (s: string) =>
    s
      .replace(/\uE010(\d+)\uE011/g, (_, n) => held[Number(n)] || "")
      .replace(/\uE010|\uE011/g, "");

  let out = zh;

  // 1) Math embeds first (longest tex first).
  const mathEmbeds = embeds
    .filter((e) => /<math\b/i.test(e.html || ""))
    .sort(
      (a, b) =>
        mathTexFromHtml(b.html || "").length -
        mathTexFromHtml(a.html || "").length,
    );

  for (const emb of mathEmbeds) {
    const num = embedIndex(emb, 0);
    const token = `⟦M${num}⟧`;
    if (out.includes(token)) continue;
    const block = emb.html || "";
    const tex = mathTexFromHtml(block);
    const plain = mathPlainFromHtml(block);
    let work = maskExisting(out);
    let placed = false;

    const candidates: { re: RegExp; group: boolean }[] = [];
    if (plain && tex && plain !== tex) {
      candidates.push({
        re: new RegExp(
          `${escapeRegExp(plain)}\\s*${escapeRegExp(tex)}`,
        ),
        group: false,
      });
      candidates.push({
        re: new RegExp(
          `${escapeRegExp(tex)}\\s*${escapeRegExp(plain)}`,
        ),
        group: false,
      });
    }
    if (plain) {
      // Model often writes “N N” / “d d” next to the same symbol.
      candidates.push({
        re: new RegExp(
          `${escapeRegExp(plain)}(?:\\s+${escapeRegExp(plain)})+`,
        ),
        group: false,
      });
      // Allow flexible commas/spaces in unicode math lists: 𝐐 , 𝐊 , 𝐕
      if (/[,，]/.test(plain)) {
        const flex = escapeRegExp(plain)
          .replace(/,/g, "[,，]\\s*")
          .replace(/ /g, "\\s*");
        candidates.push({ re: new RegExp(flex), group: false });
      }
    }
    if (tex) {
      candidates.push({ re: new RegExp(escapeRegExp(tex)), group: false });
      if (tex.startsWith("\\")) {
        candidates.push({
          re: new RegExp(escapeRegExp(tex.slice(1))),
          group: false,
        });
      }
    }
    if (plain && plain.length === 1) {
      candidates.push({
        re: new RegExp(
          `(^|[^A-Za-z0-9\\uE010\\uE011])${escapeRegExp(plain)}([^A-Za-z0-9\\uE010\\uE011]|$)`,
        ),
        group: true,
      });
    } else if (plain && plain.length > 1 && !/^\d+$/.test(plain)) {
      candidates.push({ re: new RegExp(escapeRegExp(plain)), group: false });
    }

    for (const { re, group } of candidates) {
      if (!re.test(work)) continue;
      work = group
        ? work.replace(re, `$1${token}$2`)
        : work.replace(re, token);
      placed = true;
      break;
    }
    if (!placed) continue;
    work = work.replaceAll(token, maskTok(token));
    const lastMask = `\uE010${held.length - 1}\uE011`;
    if (tex && tex.length > 1) {
      work = work.replace(new RegExp(`\\s*${escapeRegExp(tex)}\\s*`), " ");
    }
    // Drop leftover duplicate plain glyphs next to the placed token.
    if (plain && plain.length === 1) {
      work = work
        .replaceAll(
          new RegExp(
            `${escapeRegExp(lastMask)}(?:\\s*${escapeRegExp(plain)})+`,
            "g",
          ),
          lastMask,
        )
        .replaceAll(
          new RegExp(
            `(?:${escapeRegExp(plain)}\\s*)+${escapeRegExp(lastMask)}`,
            "g",
          ),
          lastMask,
        );
    }
    out = unmaskAll(work);
  }

  // 2) Link embeds — never match bare numbers like "12" alone.
  const linkEmbeds = embeds.filter((e) => /<a\b/i.test(e.html || ""));
  for (const emb of linkEmbeds) {
    const num = embedIndex(emb, 0);
    const token = `⟦M${num}⟧`;
    if (out.includes(token)) continue;
    const block = emb.html || "";
    const plain = mathPlainFromHtml(block);
    const href = /href=["']([^"']+)["']/i.exec(block)?.[1] || "";
    let work = maskExisting(out);
    let placed = false;

    const fig =
      /(?:Fig\.?|Figure|Tab\.?|Table)\s*(\d+)/i.exec(plain) ||
      /(?:Fig\.?|Figure|Tab\.?|Table)\s*(\d+)/i.exec(block);
    if (fig) {
      const n = fig[1];
      const isTab = /tab/i.test(fig[0]);
      const zhRef = new RegExp(
        `(?:${isTab ? "表" : "图"}|${isTab ? "Table|Tab\\.?" : "Fig\\.?|Figure"})\\s*${n}`,
        "i",
      );
      if (zhRef.test(work)) {
        work = work.replace(zhRef, token);
        placed = true;
      }
    }

    // Algorithm N / 算法 N
    const alg =
      /(?:Algorithm|Alg\.?)\s*(\d+)/i.exec(plain) ||
      /(?:Algorithm|Alg\.?)\s*(\d+)/i.exec(block);
    if (!placed && alg && !/\.l\d+/i.test(href)) {
      const n = alg[1];
      const zhAlg = new RegExp(`(?:算法|Algorithm|Alg\\.?)\\s*${n}`, "i");
      if (zhAlg.test(work)) {
        work = work.replace(zhAlg, token);
        placed = true;
      }
    }

    // Algorithm line N → keep「第 … 行」, only wrap the number (href …lN)
    const lineHref = /\.l(\d+)\b/i.exec(href);
    const linePlain = /^(?:line\s*)?(\d+)$/i.exec(plain.trim());
    if (!placed && (lineHref || linePlain)) {
      const n = lineHref?.[1] || linePlain?.[1] || "";
      if (n) {
        const zhLine = new RegExp(`(第\\s*)${n}(\\s*行)`);
        if (zhLine.test(work)) {
          work = work.replace(zhLine, `$1${token}$2`);
          placed = true;
        }
      }
    }

    if (!placed) continue;
    work = work.replaceAll(token, maskTok(token));
    out = unmaskAll(work);
  }

  return unmaskAll(out).replace(/[ \t]{2,}/g, " ").trim();
}

/** Rebuild ZH HTML: keep ⟦Mn⟧ embeds / mirror media units from the source sentence. */
function zhSentenceHtml(
  zh: string,
  sent: SentenceUnit,
  partition: string,
  slug: string,
): string {
  if (MEDIA_KINDS.has(sent.kind)) {
    return rewriteLocalAssets(sent.html || "", partition, slug);
  }
  const embeds = embedsForSentence(sent);
  const zhWithTokens = recoverZhEmbedTokens(zh || "", embeds);
  if (!embeds.length && !/⟦M\d+⟧/.test(zhWithTokens)) {
    return escapeZhKeepingStyles(zhWithTokens);
  }
  const byIdx = new Map<string, string>();
  for (const emb of embeds) {
    const id = emb.id || "";
    const num = embedIndex(emb, 0);
    byIdx.set(num, emb.html || "");
    byIdx.set(id, emb.html || "");
    byIdx.set(`m${num}`, emb.html || "");
  }
  let out = "";
  let last = 0;
  const re = /⟦M(\d+)⟧/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(zhWithTokens))) {
    out += escapeZhKeepingStyles(zhWithTokens.slice(last, m.index));
    const html = byIdx.get(m[1]) || byIdx.get(`m${m[1]}`);
    out += html
      ? `<span class="sent-embed">${html}</span>`
      : escapeZhKeepingStyles(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeZhKeepingStyles(zhWithTokens.slice(last));
  return rewriteLocalAssets(out, partition, slug);
}

/** Drop doc title / authors from dual-column body (shown in shared hero). */
function isAuthorish(text: string, authors: string[]): boolean {
  const t = text.trim();
  if (!t || authors.length === 0) return false;
  if (/Department of|University|Institute|Laboratory|Google|Meta AI|OpenAI/i.test(t)) {
    if (authors.some((a) => t.includes(a.split(/\s+/)[0] || ""))) return true;
  }
  for (const author of authors) {
    const a = author.trim();
    if (!a) continue;
    if (t === a || t.startsWith(`${a} `) || a.startsWith(t)) return true;
    if (t.includes(a) && t.length < a.length + 80) return true;
    const parts = a.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const withoutLast = parts.slice(0, -1).join(" ");
      const last = parts[parts.length - 1];
      if (t === withoutLast || t === last) return true;
      if (parts.every((p) => p.length <= 1 || t.includes(p)) && t.length <= a.length + 4) {
        return true;
      }
    } else if (parts[0] && t === parts[0]) {
      return true;
    }
  }
  // Multiple known author surnames jammed into one affiliation blob
  const hit = authors.filter((a) => t.includes(a)).length;
  if (hit >= 2) return true;
  return false;
}

function bodySections(
  structure: ReadingStructure | null,
  title: string,
  authors: string[],
): SectionBlock[] {
  if (!structure?.sections?.length) return [];
  const titleNorm = title.trim();

  return structure.sections
    .map((sec, secIdx) => {
      const sentences = sec.sentences.filter((sent, i) => {
        if (sent.kind === "author") return false;
        if (sent.kind === "spacer") return true;
        const text = (sent.text || "").trim();
        if (!text) return false;
        if (
          sent.kind === "heading" &&
          (text === titleNorm ||
            (secIdx === 0 && i === 0 && (sent.level || 1) <= 1))
        ) {
          return false;
        }
        if (isAuthorish(text, authors)) return false;
        return true;
      });
      return { ...sec, sentences };
    })
    .filter((sec) => sec.sentences.length > 0);
}

const SentenceHtml = memo(function SentenceHtml({
  html,
  className,
}: {
  html: string;
  className: string;
}) {
  return (
    <div className={className}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

function MediaUnitCell({
  side,
  sent,
  html,
  active,
  onOpenMedia,
}: {
  side: "en" | "zh";
  sent: SentenceUnit;
  html: string;
  active: boolean;
  onOpenMedia?: (sent: SentenceUnit) => void;
}) {
  const isFigure = sent.kind === "figure";
  const isTable = sent.kind === "table";
  if (!isFigure && !isTable) {
    return (
      <SentenceHtml
        className={`sentence-unit kind-${sent.kind}${active ? " is-active" : ""}`}
        html={html}
      />
    );
  }

  return (
    <div
      className={`media-frame kind-${sent.kind}${isFigure ? " media-frame-figure" : ""}`}
      onClick={(ev) => {
        if (!onOpenMedia) return;
        const t = ev.target as Element | null;
        if (!t?.closest) return;
        // Zoom button, or click directly on a figure image.
        if (t.closest(".media-zoom-btn")) {
          ev.preventDefault();
          ev.stopPropagation();
          onOpenMedia(sent);
          return;
        }
        if (isFigure && t.closest("img")) {
          ev.preventDefault();
          ev.stopPropagation();
          onOpenMedia(sent);
        }
      }}
    >
      <SentenceHtml
        className={`sentence-unit kind-${sent.kind}${active ? " is-active" : ""}`}
        html={html}
      />
      <button
        type="button"
        className="media-zoom-btn"
        title={isTable ? "放大查看表格" : "放大查看插图"}
        aria-label={isTable ? "放大查看表格" : "放大查看插图"}
        data-side={side}
        onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onOpenMedia?.(sent);
        }}
      >
        <Maximize2 size={14} strokeWidth={2.25} />
      </button>
    </div>
  );
}

function useLinkedHtml(
  html: string,
  partition: string,
  slug: string,
  labelIndex: Map<string, AnchorTarget>,
) {
  return useMemo(
    () =>
      linkifyPlainRefs(rewriteLocalAssets(html, partition, slug), labelIndex),
    [html, partition, slug, labelIndex],
  );
}

const SentencePairRow = memo(function SentencePairRow({
  sent,
  partition,
  slug,
  zh,
  ready,
  active,
  labelIndex,
  onOpenMedia,
}: {
  sent: SentenceUnit;
  partition: string;
  slug: string;
  zh: string | undefined;
  ready: boolean;
  active: boolean;
  labelIndex: Map<string, AnchorTarget>;
  onOpenMedia?: (sent: SentenceUnit) => void;
}) {
  const enHtml = useLinkedHtml(sent.html || "", partition, slug, labelIndex);
  const zhHtml = useMemo(() => {
    if (!ready) return "";
    return linkifyPlainRefs(
      zhSentenceHtml(zh || "", sent, partition, slug),
      labelIndex,
    );
  }, [ready, zh, sent, partition, slug, labelIndex]);

  return (
    <div
      className={`sentence-pair${sent.kind === "heading" ? " kind-heading-pair" : ""}${active ? " is-active" : ""}${sent.kind === "figure" || sent.kind === "table" ? " kind-media-pair" : ""}`}
      data-sentence-id={sent.id}
    >
      <div className="pair-cell pair-en article-html">
        <MediaUnitCell
          side="en"
          sent={sent}
          html={enHtml}
          active={active}
          onOpenMedia={onOpenMedia}
        />
      </div>
      <div className="pair-cell pair-zh article-html">
        {ready ? (
          <MediaUnitCell
            side="zh"
            sent={sent}
            html={zhHtml}
            active={active}
            onOpenMedia={onOpenMedia}
          />
        ) : (
          <div className="section-placeholder">待翻译</div>
        )}
      </div>
    </div>
  );
});

/** One bilingual row: consecutive figure/table units + optional shared caption. */
const MediaCaptionBlock = memo(function MediaCaptionBlock({
  medias,
  caption,
  partition,
  slug,
  zhMap,
  captionReady,
  activeSentenceId,
  labelIndex,
  onOpenMedia,
}: {
  medias: SentenceUnit[];
  caption: SentenceUnit | null;
  partition: string;
  slug: string;
  zhMap: Record<string, string>;
  captionReady: boolean;
  activeSentenceId: string | null;
  labelIndex: Map<string, AnchorTarget>;
  onOpenMedia?: (sent: SentenceUnit) => void;
}) {
  const ids = useMemo(() => {
    const list = medias.map((m) => m.id);
    if (caption) list.push(caption.id);
    return list;
  }, [medias, caption]);
  const active = activeSentenceId != null && ids.includes(activeSentenceId);

  const captionEnHtml = useLinkedHtml(
    caption?.html || "",
    partition,
    slug,
    labelIndex,
  );
  const captionZhHtml = useMemo(() => {
    if (!caption || !captionReady) return "";
    return linkifyPlainRefs(
      zhSentenceHtml(zhMap[caption.id] || "", caption, partition, slug),
      labelIndex,
    );
  }, [caption, captionReady, zhMap, partition, slug, labelIndex]);

  const mediaHtmls = useMemo(
    () =>
      medias.map((m) =>
        linkifyPlainRefs(
          rewriteLocalAssets(m.html || "", partition, slug),
          labelIndex,
        ),
      ),
    [medias, partition, slug, labelIndex],
  );

  const primaryId = medias[0]?.id || caption?.id || "";

  return (
    <div
      className={`sentence-pair kind-media-pair kind-media-block${active ? " is-active" : ""}`}
      data-sentence-id={primaryId}
    >
      <div className="pair-cell pair-en article-html">
        <div className="media-caption-stack">
          {medias.map((m, i) => (
            <div key={m.id} data-sentence-id={m.id}>
              <MediaUnitCell
                side="en"
                sent={m}
                html={mediaHtmls[i] || ""}
                active={activeSentenceId === m.id}
                onOpenMedia={onOpenMedia}
              />
            </div>
          ))}
          {caption ? (
            <div data-sentence-id={caption.id}>
              <SentenceHtml
                className={`sentence-unit kind-caption${activeSentenceId === caption.id ? " is-active" : ""}`}
                html={captionEnHtml}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="pair-cell pair-zh article-html">
        <div className="media-caption-stack">
          {medias.map((m, i) => (
            <div key={m.id} data-sentence-id={`zh-${m.id}`}>
              <MediaUnitCell
                side="zh"
                sent={m}
                html={mediaHtmls[i] || ""}
                active={activeSentenceId === m.id}
                onOpenMedia={onOpenMedia}
              />
            </div>
          ))}
          {caption ? (
            captionReady ? (
              <div data-sentence-id={`zh-${caption.id}`}>
                <SentenceHtml
                  className={`sentence-unit kind-caption${activeSentenceId === caption.id ? " is-active" : ""}`}
                  html={captionZhHtml}
                />
              </div>
            ) : (
              <div className="section-placeholder">待翻译</div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});

type SentenceRenderItem =
  | { key: string; type: "spacer"; sent: SentenceUnit }
  | { key: string; type: "single"; sent: SentenceUnit }
  | {
      key: string;
      type: "media-block";
      medias: SentenceUnit[];
      caption: SentenceUnit | null;
    };

/** Group consecutive figure/table (+ following caption) into one visual block. */
function groupSectionSentences(sentences: SentenceUnit[]): SentenceRenderItem[] {
  const items: SentenceRenderItem[] = [];
  let i = 0;
  while (i < sentences.length) {
    const sent = sentences[i];
    if (sent.kind === "spacer") {
      items.push({ key: sent.id, type: "spacer", sent });
      i += 1;
      continue;
    }
    if (sent.kind === "figure" || sent.kind === "table") {
      const medias: SentenceUnit[] = [];
      while (
        i < sentences.length &&
        (sentences[i].kind === "figure" || sentences[i].kind === "table")
      ) {
        medias.push(sentences[i]);
        i += 1;
      }
      let caption: SentenceUnit | null = null;
      if (i < sentences.length && sentences[i].kind === "caption") {
        caption = sentences[i];
        i += 1;
      }
      items.push({
        key: medias.map((m) => m.id).join("+") + (caption ? `+${caption.id}` : ""),
        type: "media-block",
        medias,
        caption,
      });
      continue;
    }
    items.push({ key: sent.id, type: "single", sent });
    i += 1;
  }
  return items;
}

/** One CSS grid row per sentence → EN/ZH share exact start/end edges. */
const SentencePairs = memo(function SentencePairs({
  sections,
  partition,
  slug,
  zhMap,
  completedSections,
  activeSentenceId,
  labelIndex,
  onOpenMedia,
}: {
  sections: SectionBlock[];
  partition: string;
  slug: string;
  zhMap: Record<string, string>;
  completedSections: Set<string>;
  activeSentenceId: string | null;
  labelIndex: Map<string, AnchorTarget>;
  onOpenMedia?: (sent: SentenceUnit) => void;
}) {
  return (
    <>
      {sections.map((sec, secIdx) => {
        const secDone = completedSections.has(sec.id);
        const items = groupSectionSentences(sec.sentences);
        return (
          <div
            key={`${sec.id}#${secIdx}`}
            className="section-group"
            data-section-id={sec.id}
          >
            {items.map((item) => {
              if (item.type === "spacer") {
                return (
                  <div
                    key={item.key}
                    className="sentence-pair kind-spacer-pair"
                    data-sentence-id={item.sent.id}
                    aria-hidden="true"
                  >
                    <div className="pair-cell pair-en">
                      <div className="para-spacer" aria-hidden="true" />
                    </div>
                    <div className="pair-cell pair-zh">
                      <div className="para-spacer" aria-hidden="true" />
                    </div>
                  </div>
                );
              }
              if (item.type === "media-block") {
                const captionReady =
                  !item.caption ||
                  (secDone &&
                    Object.prototype.hasOwnProperty.call(
                      zhMap,
                      item.caption.id,
                    ));
                return (
                  <MediaCaptionBlock
                    key={item.key}
                    medias={item.medias}
                    caption={item.caption}
                    partition={partition}
                    slug={slug}
                    zhMap={zhMap}
                    captionReady={captionReady}
                    activeSentenceId={activeSentenceId}
                    labelIndex={labelIndex}
                    onOpenMedia={onOpenMedia}
                  />
                );
              }
              const sent = item.sent;
              const zh = zhMap[sent.id];
              const isMedia = MEDIA_KINDS.has(sent.kind);
              const ready =
                isMedia ||
                (secDone &&
                  Object.prototype.hasOwnProperty.call(zhMap, sent.id));
              return (
                <SentencePairRow
                  key={item.key}
                  sent={sent}
                  partition={partition}
                  slug={slug}
                  zh={zh}
                  ready={ready}
                  active={activeSentenceId === sent.id}
                  labelIndex={labelIndex}
                  onOpenMedia={onOpenMedia}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
});

export function ReaderShell({
  partition,
  slug,
  title,
  authors,
  authorsDetail,
  initialStructure,
  initialOutline,
  translation: initialTranslation,
  autoStart,
  initialStatus,
  sourceUrl,
  arxivId,
}: Props) {
  const router = useRouter();
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [structure, setStructure] = useState<ReadingStructure | null>(
    initialStructure,
  );
  const [outline, setOutline] = useState<OutlineItem[]>(initialOutline);
  const [zhMap, setZhMap] = useState<Record<string, string>>(
    () => ({ ...(initialTranslation.sentences || {}) }),
  );
  const [completedSections, setCompletedSections] = useState<Set<string>>(
    () => new Set(initialTranslation.completedSections || []),
  );
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [phaseMsg, setPhaseMsg] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [citePopup, setCitePopup] = useState<CitePopupState | null>(null);
  const [linkPopup, setLinkPopup] = useState<ExternalLinkPopupState | null>(
    null,
  );
  const [linkCopied, setLinkCopied] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [qaOpen, setQaOpen] = useState(false);
  const [confirmRetranslate, setConfirmRetranslate] = useState(false);
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesTextRef = useRef("");
  const outlineNavRef = useRef<HTMLElement>(null);
  const outlineLockUntil = useRef(0);
  /** Shared scrollport — hero + EN/ZH pairs scroll together. */
  const columnsRef = useRef<HTMLDivElement>(null);
  const citePopupRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const revealSentinelRef = useRef<HTMLDivElement>(null);

  const originalHref = useMemo(() => {
    const src = (sourceUrl || "").trim();
    if (src) return src;
    const id = (arxivId || "").trim();
    if (id) return `https://ar5iv.labs.arxiv.org/html/${id}`;
    return "";
  }, [sourceUrl, arxivId]);

  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Browser may deny fullscreen without a user gesture or in iframe.
    }
  }, []);

  const notesApiUrl = useMemo(
    () =>
      `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/notes`,
    [partition, slug],
  );

  const persistNotes = useCallback(
    async (content: string) => {
      setNotesSaving(true);
      setNotesError(null);
      try {
        const res = await fetch(notesApiUrl, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(detail || `保存失败 (${res.status})`);
        }
        setNotesDirty(false);
      } catch (err) {
        setNotesError(err instanceof Error ? err.message : "保存失败");
      } finally {
        setNotesSaving(false);
      }
    },
    [notesApiUrl],
  );

  const scheduleNotesSave = useCallback(
    (content: string) => {
      notesTextRef.current = content;
      setNotesDirty(true);
      if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
      notesSaveTimer.current = setTimeout(() => {
        void persistNotes(content);
      }, 600);
    },
    [persistNotes],
  );

  const openNotes = useCallback(async () => {
    setNotesOpen(true);
    if (notesLoaded) return;
    setNotesError(null);
    try {
      const res = await fetch(notesApiUrl);
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `加载失败 (${res.status})`);
      }
      const data = (await res.json()) as { content?: string };
      const content = data.content ?? "";
      notesTextRef.current = content;
      setNotesText(content);
      setNotesLoaded(true);
      setNotesDirty(false);
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : "加载失败");
    }
  }, [notesApiUrl, notesLoaded]);

  const closeNotes = useCallback(async () => {
    if (notesSaveTimer.current) {
      clearTimeout(notesSaveTimer.current);
      notesSaveTimer.current = null;
    }
    if (notesDirty) {
      await persistNotes(notesTextRef.current);
    }
    setNotesOpen(false);
  }, [notesDirty, persistNotes]);

  useEffect(() => {
    notesTextRef.current = notesText;
  }, [notesText]);

  useEffect(() => {
    return () => {
      if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    };
  }, []);

  // Flush pending notes when leaving the page.
  useEffect(() => {
    const flush = () => {
      if (!notesDirty) return;
      const body = JSON.stringify({ content: notesTextRef.current });
      void fetch(notesApiUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [notesApiUrl, notesDirty]);

  const sections = useMemo(
    () => bodySections(structure, title, authors),
    [structure, title, authors],
  );

  // Mount a few sections first so the first paint stays interactive; reveal
  // the rest via idle callbacks + near-bottom scroll.
  const [revealCount, setRevealCount] = useState(2);
  useEffect(() => {
    setRevealCount(2);
  }, [structure]);

  useEffect(() => {
    if (revealCount >= sections.length) return;
    let cancelled = false;
    const bump = () => {
      if (cancelled) return;
      startTransition(() => {
        setRevealCount((n) => Math.min(n + 4, sections.length));
      });
    };
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const w = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(bump, { timeout: 180 });
    } else {
      timeoutId = setTimeout(bump, 32);
    }
    return () => {
      cancelled = true;
      if (idleId != null) w.cancelIdleCallback?.(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [revealCount, sections.length]);

  // If the user scrolls ahead of the idle preload, reveal more immediately.
  useEffect(() => {
    const root = columnsRef.current;
    const sentinel = revealSentinelRef.current;
    if (!root || !sentinel || revealCount >= sections.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        startTransition(() => {
          setRevealCount((n) => Math.min(n + 6, sections.length));
        });
      },
      { root, rootMargin: "600px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [revealCount, sections.length]);

  const visibleSections = useMemo(
    () => sections.slice(0, revealCount),
    [sections, revealCount],
  );

  const [anchorIndex, setAnchorIndex] = useState(
    () => new Map<string, AnchorTarget>(),
  );
  useEffect(() => {
    let cancelled = false;
    const build = () => {
      if (cancelled) return;
      setAnchorIndex(buildAnchorIndex(sections));
    };
    const w = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(build, { timeout: 400 });
    } else {
      timeoutId = setTimeout(build, 0);
    }
    return () => {
      cancelled = true;
      if (idleId != null) w.cancelIdleCallback?.(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [sections]);

  const revealThroughSection = useCallback(
    (sectionId: string) => {
      const idx = sections.findIndex((s) => s.id === sectionId);
      if (idx < 0) return;
      setRevealCount((n) => Math.max(n, idx + 1));
    },
    [sections],
  );

  const revealThroughSentence = useCallback(
    (sentenceId: string) => {
      const idx = sections.findIndex((s) =>
        s.sentences.some((x) => x.id === sentenceId),
      );
      if (idx < 0) return;
      setRevealCount((n) => Math.max(n, idx + 1));
    },
    [sections],
  );

  const progressRatio = useMemo(() => {
    if (progressTotal > 0) {
      return Math.min(1, progressCurrent / progressTotal);
    }
    const total = structure?.sections?.length || 0;
    if (total <= 0) return streaming ? 0.05 : 0;
    return Math.min(1, completedSections.size / total);
  }, [
    progressCurrent,
    progressTotal,
    structure,
    completedSections,
    streaming,
  ]);

  useEffect(() => {
    try {
      const v = localStorage.getItem(OUTLINE_KEY);
      if (v === "0") setOutlineOpen(false);
      if (v === "1") setOutlineOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  function toggleOutline() {
    setOutlineOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OUTLINE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const startStream = useCallback(async () => {
    setStreamError(null);
    setStreaming(true);
    setPhaseMsg("");
    streamAbortRef.current?.abort();
    const ac = new AbortController();
    streamAbortRef.current = ac;
    try {
      const res = await fetch(
        `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/translate/stream`,
        { signal: ac.signal },
      );
      if (!res.ok || !res.body) {
        // Newer startStream() may have replaced this controller — don't clobber it.
        if (streamAbortRef.current === ac) {
          setStreamError("无法开始翻译流");
          setStreaming(false);
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const raw = line.slice(5).trim();
          // Skip token-preview payloads without JSON.parse (can be huge).
          if (/"type"\s*:\s*"preview"/.test(raw)) continue;
          try {
            const ev = JSON.parse(raw) as Record<string, unknown>;
            const type = String(ev.type || "");
            if (type === "parse_progress") {
              setPhaseMsg(String(ev.message || "解析结构…"));
              setProgressCurrent(Number(ev.current) || 0);
              setProgressTotal(Number(ev.total) || 0);
            } else if (type === "phase") {
              if (ev.phase === "parsing") setPhaseMsg("解析结构…");
              if (ev.phase === "translating") {
                setPhaseMsg("全文翻译…");
                setStatus("translating");
              }
            } else if (type === "structure_ready" || type === "snapshot") {
              const rs = ev.readingStructure as ReadingStructure | undefined;
              if (rs) {
                startTransition(() => {
                  setStructure(rs);
                  setOutline(
                    (rs.sections || [])
                      .map((sec) => {
                        const heading = sec.sentences.find(
                          (s) => s.kind === "heading",
                        );
                        if (!heading) return null;
                        // Skip doc-title-only outline noise if level 1 matches paper title
                        if (
                          (heading.level || sec.level || 2) <= 1 &&
                          heading.text === (rs.title || title)
                        ) {
                          return null;
                        }
                        return {
                          id: heading.id,
                          sectionId: sec.id,
                          type: "heading",
                          level: heading.level || sec.level || 2,
                          text: heading.text,
                          anchor: sec.anchor,
                        } satisfies OutlineItem;
                      })
                      .filter(Boolean) as OutlineItem[],
                  );
                  const n = (rs.sections || []).length;
                  setProgressTotal(n);
                  setProgressCurrent(
                    (ev.translation as Translation | undefined)
                      ?.completedSections?.length || 0,
                  );
                });
              }
              const tr = ev.translation as Translation | undefined;
              if (tr?.sentences) {
                startTransition(() => {
                  setZhMap({ ...tr.sentences });
                  setCompletedSections(new Set(tr.completedSections || []));
                });
              }
              if (type === "structure_ready") {
                setPhaseMsg("结构就绪，开始翻译…");
              }
            } else if (type === "section_start") {
              setPhaseMsg(String(ev.message || "翻译章节块…"));
              if (ev.total != null) setProgressTotal(Number(ev.total) || 0);
              if (ev.index != null) {
                // index is 1-based for the section about to run
                setProgressCurrent(Math.max(0, Number(ev.index) - 1));
              }
            } else if (type === "preview") {
              // Token previews are not rendered (and should not be sent).
            } else if (type === "section_done") {
              const mapping = (ev.sentences || {}) as Record<string, string>;
              const secId = String(ev.sectionId || "");
              startTransition(() => {
                if (Object.keys(mapping).length > 0) {
                  setZhMap((prev) => ({ ...prev, ...mapping }));
                }
                if (secId) {
                  setCompletedSections((prev) => new Set(prev).add(secId));
                }
                if (ev.index != null) {
                  setProgressCurrent(Number(ev.index) || 0);
                }
                if (ev.total != null) {
                  setProgressTotal(Number(ev.total) || 0);
                }
              });
            } else if (type === "paused") {
              const tr = ev.translation as Translation | undefined;
              if (tr?.sentences) {
                setZhMap({ ...tr.sentences });
                setCompletedSections(new Set(tr.completedSections || []));
                setProgressCurrent((tr.completedSections || []).length);
              }
              setStatus(String(ev.status || "partial"));
              setPhaseMsg("");
              setStreamError(null);
            } else if (type === "done") {
              setPhaseMsg("");
              setStatus("completed");
              setProgressTotal((t) => {
                if (t > 0) setProgressCurrent(t);
                return t;
              });
            } else if (type === "error") {
              setStreamError(String(ev.message || "翻译失败"));
              setPhaseMsg("");
              setStatus((prev) =>
                prev === "parsing" ? "parse_failed" : "translate_failed",
              );
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      if (streamAbortRef.current === ac) {
        setStreamError(e instanceof Error ? e.message : "翻译失败");
      }
    } finally {
      // Only the active stream may clear streaming — an aborted predecessor
      // must not flip the button to「继续翻译」while a newer stream is live.
      if (streamAbortRef.current === ac) {
        streamAbortRef.current = null;
        setStreaming(false);
      }
    }
  }, [partition, slug, title]);

  useEffect(() => {
    if (!autoStart) return;
    void startStream();
    return () => {
      streamAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, partition, slug]);

  useEffect(() => {
    if (!activeOutlineId) return;
    const nav = outlineNavRef.current;
    if (!nav) return;
    const el = nav.querySelector(
      `[data-outline-id="${CSS.escape(activeOutlineId)}"]`,
    );
    if (!(el instanceof HTMLElement)) return;

    // Overflow lives on aside.reader-outline, not on the nav itself.
    const scroller =
      (nav.closest(".reader-outline") as HTMLElement | null) || nav;
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (scrollerRect.height <= 0) return;

    // Keep the active row in a comfortable band (~20%–65% of the viewport).
    const comfortTop = scrollerRect.top + scrollerRect.height * 0.2;
    const comfortBottom = scrollerRect.top + scrollerRect.height * 0.65;
    if (elRect.top >= comfortTop && elRect.bottom <= comfortBottom) return;

    const targetOffset = scrollerRect.height * 0.35;
    const delta = elRect.top - scrollerRect.top - targetOffset;
    if (Math.abs(delta) < 2) return;
    scroller.scrollBy({
      top: delta,
      behavior: Math.abs(delta) > 100 ? "smooth" : "auto",
    });
  }, [activeOutlineId]);

  // Column-scoped selection: DOM is row-major (EN|ZH), so a multi-row Range
  // always includes the other column. Keep the lock after mouseup and filter copy.
  useEffect(() => {
    const root = columnsRef.current;
    if (!root) return;

    let side: "en" | "zh" | null = null;
    let saved: Range | null = null;
    let dragging = false;
    let draggedSelect = false;

    const clear = () => {
      side = null;
      saved = null;
      draggedSelect = false;
      root.classList.remove("selecting-en", "selecting-zh");
    };

    const setSide = (next: "en" | "zh") => {
      side = next;
      root.classList.toggle("selecting-en", next === "en");
      root.classList.toggle("selecting-zh", next === "zh");
    };

    const snapshot = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      try {
        saved = sel.getRangeAt(0).cloneRange();
        draggedSelect = true;
      } catch {
        /* ignore */
      }
    };

    const restoreIfCleared = () => {
      if (!saved || !side || !draggedSelect) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) return;
      try {
        sel?.removeAllRanges();
        sel?.addRange(saved.cloneRange());
      } catch {
        /* ignore */
      }
    };

    const columnTextInSelection = (which: "en" | "zh"): string => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
      const range = sel.getRangeAt(0);
      const parts: string[] = [];
      root.querySelectorAll(`.pair-${which}`).forEach((cell) => {
        try {
          if (!range.intersectsNode(cell)) return;
        } catch {
          return;
        }
        const cellRange = document.createRange();
        cellRange.selectNodeContents(cell);
        if (cell.contains(range.startContainer)) {
          try {
            cellRange.setStart(range.startContainer, range.startOffset);
          } catch {
            /* ignore */
          }
        }
        if (cell.contains(range.endContainer)) {
          try {
            cellRange.setEnd(range.endContainer, range.endOffset);
          } catch {
            /* ignore */
          }
        }
        const text = cellRange.toString().replace(/[ \t]+\n/g, "\n").trim();
        if (text) parts.push(text);
      });
      return parts.join("\n\n");
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target) return;
      // New click should dismiss any previous selection — don't restore it later.
      saved = null;
      draggedSelect = false;
      dragging = true;
      if (target.closest(".pair-en")) {
        setSide("en");
        return;
      }
      if (target.closest(".pair-zh")) {
        setSide("zh");
        return;
      }
      clear();
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      // Only restore when mouseup wiped a real drag-selection (not a plain click).
      if (!draggedSelect || !saved) return;
      requestAnimationFrame(() => {
        restoreIfCleared();
        requestAnimationFrame(restoreIfCleared);
      });
    };

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        if (dragging) snapshot();
        if (!side) {
          const node = sel.anchorNode;
          const el =
            node instanceof Element ? node : node?.parentElement ?? null;
          if (el?.closest(".pair-en")) setSide("en");
          else if (el?.closest(".pair-zh")) setSide("zh");
        }
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      if (!side) return;
      const text = columnTextInSelection(side);
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };

    root.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    root.addEventListener("copy", onCopy);
    root.addEventListener("cut", onCopy);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      root.removeEventListener("copy", onCopy);
      root.removeEventListener("cut", onCopy);
      clear();
    };
  }, [sections.length]);

  async function retry(full: boolean) {
    await fetch(
      `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/translate/retry${full ? "?full=1" : ""}`,
      { method: "POST" },
    );
    setStatus(full ? "ready_source" : "partial");
    if (full) {
      setZhMap({});
      setCompletedSections(new Set());
      setProgressCurrent(0);
    }
    void startStream();
  }

  async function pauseTranslate() {
    // Optimistic UI — pause API used to block up to ~8s waiting on the LLM.
    const prevStatus = status;
    setStreaming(false);
    setPhaseMsg("");
    setStreamError(null);
    setStatus((s) =>
      s === "translating" || s === "parsing" || s === "summarizing"
        ? completedSections.size > 0
          ? "partial"
          : "ready_source"
        : s,
    );
    streamAbortRef.current?.abort();
    try {
      const res = await fetch(
        `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}/translate/pause`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        translation?: Translation;
      };
      if (data.translation?.sentences) {
        setZhMap({ ...data.translation.sentences });
        setCompletedSections(new Set(data.translation.completedSections || []));
        setProgressCurrent((data.translation.completedSections || []).length);
      }
      if (data.status) setStatus(data.status);
    } catch {
      setStatus(prevStatus);
      setStreamError("暂停失败，请重试");
    }
  }

  const translationComplete =
    status === "completed" ||
    (progressTotal > 0 &&
      completedSections.size >= progressTotal &&
      progressTotal === (structure?.sections?.length || progressTotal));

  const authorRows =
    authorsDetail.length > 0
      ? authorsDetail
      : authors.map((name) => ({ name, affiliation: "" }));

  function updateActiveOutline(root: HTMLDivElement) {
    if (Date.now() < outlineLockUntil.current) return;
    const rootTop = root.getBoundingClientRect().top;
    const threshold = 110;
    let current: OutlineItem | null = null;
    for (const h of outline) {
      const el = root.querySelector(
        `[data-section-id="${CSS.escape(h.sectionId)}"]`,
      );
      if (!el) continue;
      const top = el.getBoundingClientRect().top - rootTop;
      if (top <= threshold) current = h;
    }
    const nextId = current?.id ?? outline[0]?.id ?? null;
    setActiveOutlineId((prev) => (prev === nextId ? prev : nextId));
  }

  function onColumnsScroll(e: UIEvent<HTMLDivElement>) {
    updateActiveOutline(e.currentTarget);
  }

  function jumpToSentence(sentenceId: string) {
    revealThroughSentence(sentenceId);
    const root = columnsRef.current;
    if (!root) return;
    const tryScroll = () => {
      const el = root.querySelector(
        `[data-sentence-id="${CSS.escape(sentenceId)}"]`,
      );
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setActiveSentenceId(sentenceId);
      return true;
    };
    if (tryScroll()) {
      setCitePopup(null);
      setLinkPopup(null);
      return;
    }
    // Section may still be mounting after revealCount bump.
    requestAnimationFrame(() => {
      tryScroll();
      setCitePopup(null);
      setLinkPopup(null);
    });
  }

  const openMediaPopup = useCallback(
    (sent: SentenceUnit) => {
      const idMatch = /\bid=["']([^"']+)["']/i.exec(sent.html || "");
      const hit: AnchorTarget = {
        sentenceId: sent.id,
        kind: sent.kind,
        text: sent.text || "",
        anchorId: idMatch?.[1],
      };
      const content = buildCitePopupContent(
        sections,
        hit,
        partition,
        slug,
        sent.text || "",
      );
      const group = findMediaCaptionGroup(sections, hit, sent);
      const capLabel =
        captionFigTabNum(group?.caption?.text || "") &&
        /^(Figure|Fig\.?|Table|Tab\.?)\s*\d+/i.exec(
          (group?.caption?.text || "").trim(),
        )?.[0];
      setCitePopup({
        label: capLabel || "",
        body: content.body,
        html: content.html || rewriteLocalAssets(sent.html || "", partition, slug),
        targetId: content.targetId || sent.id,
        kind: content.kind || sent.kind,
      });
    },
    [sections, partition, slug],
  );

  function jumpTo(item: OutlineItem) {
    setActiveOutlineId(item.id);
    outlineLockUntil.current = Date.now() + 1000;
    revealThroughSection(item.sectionId);
    const tryScroll = () => {
      const el = columnsRef.current?.querySelector(
        `[data-section-id="${CSS.escape(item.sectionId)}"]`,
      );
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    tryScroll();
    requestAnimationFrame(tryScroll);
  }

  function onColumnsClick(e: ReactMouseEvent<HTMLDivElement>) {
    const target = e.target as Element | null;
    if (!target?.closest) return;
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    // Don't intercept UI chrome links outside article content.
    if (!link.closest(".article-html, .pair-cell, .reader-pairs")) return;

    const href = (link.getAttribute("href") || "").trim();
    if (!href) return;

    // Local assets / app routes — leave alone.
    if (
      href.startsWith("/api/") ||
      href.startsWith("assets/") ||
      href.startsWith("./") ||
      href.startsWith("../")
    ) {
      return;
    }

    if (isExternalHref(href)) {
      e.preventDefault();
      e.stopPropagation();
      setCitePopup(null);
      setLinkCopied(false);
      setLinkPopup({
        href: normalizeExternalHref(href),
        label: (link.textContent || "").trim() || href,
      });
      return;
    }

    if (!href.startsWith("#") || href.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const anchor = href.slice(1);
    const dataSent = link.getAttribute("data-ref-sentence");
    const hit =
      (dataSent
        ? [...anchorIndex.values()].find((t) => t.sentenceId === dataSent)
        : null) ||
      anchorIndex.get(anchor) ||
      lookupPlainRef(anchorIndex, (link.textContent || "").trim()) ||
      null;
    const titleAttr = (link.getAttribute("title") || "").trim();
    const labelText = (link.textContent || "").trim() || anchor;
    const fallbackBody =
      titleAttr.split("‣")[0]?.trim() || titleAttr || labelText;
    // If index is still warming up, synthesize a hit from the href (#S1.F1 …).
    const resolvedHit: AnchorTarget | null =
      hit ||
      (anchor
        ? {
            sentenceId: dataSent || "",
            kind: /\.T\d+/i.test(anchor)
              ? "table"
              : /\.F\d+/i.test(anchor)
                ? "figure"
                : /bib/i.test(anchor)
                  ? "reference"
                  : "ref",
            text: fallbackBody,
            anchorId: anchor,
          }
        : null);
    const content = buildCitePopupContent(
      sections,
      resolvedHit,
      partition,
      slug,
      fallbackBody,
    );
    setLinkPopup(null);
    setCitePopup({
      label: labelText,
      body: content.body,
      html: content.html,
      targetId: content.targetId || dataSent || null,
      kind: content.kind,
    });
  }

  async function copyExternalLink() {
    if (!linkPopup) return;
    try {
      await navigator.clipboard.writeText(linkPopup.href);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1600);
    } catch {
      setLinkCopied(false);
    }
  }

  function openExternalLink() {
    if (!linkPopup) return;
    window.open(linkPopup.href, "_blank", "noopener,noreferrer");
  }

  useEffect(() => {
    if (!citePopup && !linkPopup) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setCitePopup(null);
        setLinkPopup(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [citePopup, linkPopup]);

  const showProgress =
    streaming ||
    !!phaseMsg ||
    (progressTotal > 0 && progressRatio < 1);
  const showContinueTranslate =
    showProgress &&
    !streaming &&
    !translationComplete &&
    (status === "partial" ||
      status === "ready_source" ||
      status === "translate_failed" ||
      status === "parse_failed" ||
      status === "summarize_failed" ||
      status === "translating" ||
      (!!streamError && completedSections.size > 0));
  const progressLabel =
    phaseMsg ||
    (streaming
      ? "处理中…"
      : progressRatio >= 1
        ? "翻译完成"
        : progressTotal > 0
          ? `已翻译 ${completedSections.size}/${progressTotal} 节`
          : "");

  return (
    <div className={`reader${outlineOpen ? " outline-open" : ""}`}>
      <div className="reader-top">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={toggleOutline}
          aria-pressed={outlineOpen}
          title={outlineOpen ? "隐藏大纲" : "显示大纲"}
        >
          {outlineOpen ? <ListX size={16} /> : <List size={16} />}
          大纲
        </button>
        <div className="reader-top-spacer" />
        {originalHref ? (
          <a
            className="btn btn-ghost btn-sm btn-icon reader-open-source"
            href={originalHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="打开原文"
            title="在新标签页打开原文"
          >
            <ExternalLink size={18} />
          </a>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon reader-retranslate"
          onClick={() => setConfirmRetranslate(true)}
          disabled={streaming}
          aria-label="重新翻译"
          title="清空译文并重新翻译"
        >
          <RefreshCw size={18} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon reader-qa-toggle"
          aria-label="论文问答"
          title={structure ? "论文问答" : "结构未就绪，暂不可问答"}
          aria-pressed={qaOpen}
          disabled={!structure}
          onClick={() => setQaOpen(true)}
        >
          <MessageSquare size={18} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon reader-notes-toggle"
          aria-label={notesOpen ? "关闭笔记" : "打开笔记"}
          title={notesOpen ? "关闭笔记" : "笔记"}
          aria-pressed={notesOpen}
          onClick={() => {
            if (notesOpen) void closeNotes();
            else void openNotes();
          }}
        >
          <NotebookPen size={18} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon reader-fullscreen"
          aria-label={isFullscreen ? "退出全屏" : "全屏阅读"}
          title={isFullscreen ? "退出全屏" : "全屏"}
          aria-pressed={isFullscreen}
          onClick={() => void toggleFullscreen()}
        >
          {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon reader-close"
          aria-label="关闭并返回目录"
          title="关闭"
          onClick={() => router.push(`/p/${encodeURIComponent(partition)}`)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="reader-body">
        {outlineOpen ? (
          <aside className="reader-outline" aria-label="大纲">
            <div className="col-label">大纲</div>
            <nav className="outline-nav" ref={outlineNavRef}>
              {outline.length === 0 ? (
                <p className="outline-empty">
                  {streaming ? "解析中…" : "暂无标题"}
                </p>
              ) : (
                outline.map((h) => {
                  const level = Math.min(Math.max(h.level || 2, 1), 6);
                  const active = h.id === activeOutlineId;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      data-outline-id={h.id}
                      className={`outline-item level-${level}${active ? " active" : ""}`}
                      style={{ paddingLeft: `${0.5 + (level - 1) * 0.75}rem` }}
                      title={h.text}
                      onClick={() => jumpTo(h)}
                    >
                      {h.text}
                    </button>
                  );
                })
              )}
            </nav>
          </aside>
        ) : null}
        <div className="reader-main">
          {showProgress || streamError ? (
            <div className="reader-progress-pin">
              {showProgress ? (
                <div className="reader-hero-progress" aria-label="翻译进度">
                  <div className="reader-hero-progress-main">
                    <div className="reader-hero-progress-meta">
                      <span>{progressLabel}</span>
                      <span>{Math.round(progressRatio * 100)}%</span>
                    </div>
                    <div className="reader-hero-progress-track">
                      <span
                        style={{
                          width: `${Math.round(progressRatio * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  {streaming || showContinueTranslate ? (
                    <div className="reader-hero-progress-actions">
                      {streaming ? (
                        <button
                          type="button"
                          className="btn btn-default btn-sm"
                          onClick={() => void pauseTranslate()}
                          title="暂停翻译（丢弃当前未完成章节块）"
                        >
                          <Pause size={14} />
                          暂停
                        </button>
                      ) : null}
                      {showContinueTranslate ? (
                        <button
                          type="button"
                          className="btn btn-default btn-sm"
                          onClick={() => void retry(false)}
                        >
                          继续翻译
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {streamError ? (
                <p className="error-text reader-hero-error">
                  {streamError}{" "}
                  {streamError.includes("设置") ? (
                    <Link
                      href="/settings"
                      style={{
                        color: "var(--link)",
                        textDecoration: "underline",
                      }}
                    >
                      前往设置
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          <div
            className="reader-columns"
            ref={columnsRef}
            onScroll={onColumnsScroll}
            onClick={onColumnsClick}
          >
            <header className="reader-hero">
              <h1 className="reader-hero-title">{title}</h1>
              {authorRows.length > 0 ? (
                <ul className="reader-hero-authors">
                  {authorRows.map((a) => (
                    <li key={a.name} className="reader-hero-author">
                      <span className="reader-hero-author-name">{a.name}</span>
                      {a.affiliation ? (
                        <span className="reader-hero-author-aff">
                          {a.affiliation}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </header>
            <div className="reader-pairs">
              {sections.length === 0 ? (
                <p className="muted reader-pairs-empty">
                  {streaming ? "正在解析结构…" : "暂无结构"}
                </p>
              ) : (
                <>
                  <SentencePairs
                    sections={visibleSections}
                    partition={partition}
                    slug={slug}
                    zhMap={zhMap}
                    completedSections={completedSections}
                    activeSentenceId={activeSentenceId}
                    labelIndex={anchorIndex}
                    onOpenMedia={openMediaPopup}
                  />
                  {revealCount < sections.length ? (
                    <div
                      ref={revealSentinelRef}
                      className="reader-reveal-sentinel"
                      aria-hidden="true"
                    />
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
        {notesOpen ? (
          <aside className="reader-notes" aria-label="笔记">
            <div className="reader-notes-head">
              <div className="col-label">笔记</div>
              <span className="reader-notes-status" aria-live="polite">
                {notesError
                  ? "保存失败"
                  : notesSaving
                    ? "保存中…"
                    : notesDirty
                      ? "未保存"
                      : notesLoaded
                        ? "已保存"
                        : "加载中…"}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label="关闭笔记"
                title="关闭"
                onClick={() => void closeNotes()}
              >
                <X size={16} />
              </button>
            </div>
            {notesError ? <p className="reader-notes-error">{notesError}</p> : null}
            <textarea
              className="reader-notes-editor"
              value={notesText}
              placeholder="记录阅读要点、疑问、待查…"
              spellCheck={false}
              disabled={!notesLoaded && !notesError}
              onChange={(ev) => {
                const next = ev.target.value;
                setNotesText(next);
                scheduleNotesSave(next);
              }}
              onBlur={() => {
                if (notesDirty) void persistNotes(notesTextRef.current);
              }}
            />
          </aside>
        ) : null}
      </div>
      <PaperQaModal
        open={qaOpen}
        partition={partition}
        slug={slug}
        title={title}
        onClose={() => setQaOpen(false)}
      />
      {confirmRetranslate ? (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmRetranslate(false)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="确认重新翻译"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h2>重新翻译？</h2>
            <p className="modal-sub">
              将清空当前译文并从头重新翻译全文。此操作不可撤销。
            </p>
            <div className="form-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirmRetranslate(false);
                  void retry(true);
                }}
              >
                确认重新翻译
              </button>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setConfirmRetranslate(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {citePopup ? (
        <div
          className="cite-modal-backdrop"
          onClick={() => setCitePopup(null)}
          role="presentation"
        >
          <div
            ref={citePopupRef}
            className={`cite-popup cite-modal${citePopup.html && (citePopup.kind === "figure" || citePopup.kind === "table" || citePopup.kind === "caption") ? " cite-modal-media" : ""}${citePopup.kind === "reference" ? " cite-modal-ref" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label="引用预览"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="cite-popup-label">
              {citePopup.kind === "reference"
                ? "参考文献"
                : citePopup.kind === "figure"
                  ? "插图"
                  : citePopup.kind === "table"
                    ? "表格"
                    : citePopup.kind === "caption"
                      ? "题注"
                      : citePopup.kind === "heading"
                        ? "章节"
                        : citePopup.kind === "equation"
                          ? "公式"
                          : "引用"}
              {citePopup.label &&
              citePopup.label !== "表格" &&
              citePopup.label !== "插图" &&
              citePopup.label !== "题注" ? (
                <span className="cite-popup-tag">{citePopup.label}</span>
              ) : null}
            </div>
            {citePopup.html ? (
              <div
                className="cite-popup-body cite-popup-html article-html"
                dangerouslySetInnerHTML={{ __html: citePopup.html }}
                onClick={(ev) => {
                  const a = (ev.target as Element | null)?.closest?.(
                    "a[href]",
                  ) as HTMLAnchorElement | null;
                  if (!a) return;
                  const href = (a.getAttribute("href") || "").trim();
                  if (!isExternalHref(href)) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  setCitePopup(null);
                  setLinkCopied(false);
                  setLinkPopup({
                    href: normalizeExternalHref(href),
                    label: (a.textContent || "").trim() || href,
                  });
                }}
              />
            ) : (
              <p className="cite-popup-body">{citePopup.body}</p>
            )}
            {citePopup.targetId ? (
              <button
                type="button"
                className="btn btn-default btn-sm cite-popup-jump"
                onClick={() => jumpToSentence(citePopup.targetId!)}
              >
                跳转到对应位置
              </button>
            ) : (
              <p className="cite-popup-missing">未找到对应阅读块</p>
            )}
          </div>
        </div>
      ) : null}
      {linkPopup ? (
        <div
          className="cite-modal-backdrop"
          onClick={() => setLinkPopup(null)}
          role="presentation"
        >
          <div
            className="cite-popup cite-modal cite-modal-link"
            role="dialog"
            aria-modal="true"
            aria-label="外部链接"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="cite-popup-label">
              外部链接
              {linkPopup.label && linkPopup.label !== linkPopup.href ? (
                <span className="cite-popup-tag">{linkPopup.label}</span>
              ) : null}
            </div>
            <p className="cite-popup-warn" role="note">
              即将离开本应用并打开外部网站。请确认链接来源可信后再继续，谨防钓鱼、恶意下载等风险。
            </p>
            <div className="cite-link-url" title={linkPopup.href}>
              {linkPopup.href}
            </div>
            <div className="cite-link-actions">
              <button
                type="button"
                className="btn btn-default btn-sm"
                onClick={() => void copyExternalLink()}
              >
                {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                {linkCopied ? "已复制" : "复制链接"}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={openExternalLink}
              >
                <ExternalLink size={14} />
                打开链接
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
