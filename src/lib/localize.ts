import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { Agent, fetch as undiciFetch } from "undici";

import type { ProgressCb } from "./ar5iv";

const ASSET_ATTRS: [string, string][] = [
  ["img", "src"],
  ["image", "href"],
  ["source", "src"],
  ["video", "src"],
  ["audio", "src"],
  ["use", "href"],
  ["object", "data"],
];

/** Reuse TLS connections like Python httpx.Client (same host for most assets). */
const assetAgent = new Agent({
  connections: 16,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 30_000 },
  bodyTimeout: 120_000,
  headersTimeout: 60_000,
});

const ASSET_CONCURRENCY = 8;

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  };
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => run()));
}

async function fetchAssetBytes(absUrl: string): Promise<Buffer | null> {
  try {
    const resp = await undiciFetch(absUrl, {
      dispatcher: assetAgent,
      headers: { "User-Agent": "paper-reading/0.1" },
      redirect: "follow",
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

function isElement(node: unknown): node is Element {
  return Boolean(node && typeof node === "object" && (node as Element).type === "tag");
}

export function convertGraphicsObjects($: cheerio.CheerioAPI): number {
  let converted = 0;
  $("object").each((_, obj) => {
    if (!isElement(obj)) return;
    const data = (obj.attribs?.data || "").trim();
    const typ = (obj.attribs?.type || "").toLowerCase();
    const classes = obj.attribs?.class || "";
    const isImage =
      typ.startsWith("image/") ||
      classes.includes("ltx_graphics") ||
      /\.(svg|png|jpe?g|gif|webp)(?:\?|$)/i.test(data);
    if (!data || !isImage) return;
    const $img = $("<img>");
    $img.attr("src", data);
    for (const attr of ["width", "height", "id", "alt", "class", "style"]) {
      if (obj.attribs?.[attr]) $img.attr(attr, obj.attribs[attr]);
    }
    if (!$img.attr("alt")) $img.attr("alt", "Refer to caption");
    const cls = (obj.attribs?.class || "").split(/\s+/).filter(Boolean);
    if (!cls.includes("ltx_graphics")) cls.push("ltx_graphics");
    $img.attr("class", cls.join(" "));
    $(obj).replaceWith($img);
    converted += 1;
  });
  return converted;
}

function safeRelpath(urlPath: string): string {
  let p: string;
  try {
    p = new URL(urlPath).pathname || urlPath;
  } catch {
    p = urlPath;
  }
  p = p.replace(/^\/+/, "");
  p = p.replace(/^html\/[^/]+\//, "");
  p = p.replace(/\\/g, "/");
  let parts = p.split("/").filter((x) => x && x !== "." && x !== "..");
  if (parts[0] === "assets") parts = parts.slice(1);
  if (!parts.length) {
    const digest = crypto.createHash("sha1").update(urlPath).digest("hex").slice(0, 12);
    return `misc/${digest}`;
  }
  return parts.join("/");
}

export async function localizeAr5ivHtml(
  html: string,
  opts: {
    pageUrl: string;
    assetsDir: string;
    onProgress?: ProgressCb | null;
  },
): Promise<string> {
  const { pageUrl, assetsDir, onProgress } = opts;
  const $ = cheerio.load(html);
  convertGraphicsObjects($);
  $("script, iframe, embed").remove();
  $("object").remove();

  let article =
    $("article").first().get(0) ||
    $("div[class*='ltx_page_main' i]").first().get(0) ||
    $("body").first().get(0);
  if (!article) throw new Error("无法从 ar5iv HTML 提取正文");

  $(article)
    .find(".ltx_abstract")
    .each((_, el) => {
      if (!$(el).attr("id")) $(el).attr("id", "abstract");
    });
  $(article)
    .find(".ltx_title_abstract")
    .each((_, el) => {
      const parent = $(el).closest(".ltx_abstract");
      if (parent.length && !parent.attr("id")) parent.attr("id", "abstract");
    });

  $(article)
    .find(".ltx_bibitem")
    .each((i, item) => {
      const bid = String($(item).attr("id") || "");
      let m = bid.match(/bib\.?bib(\d+)\s*$/i);
      if (!m) m = bid.match(/(\d+)\s*$/);
      const num = m?.[1] || String(i + 1);
      const label = `[${num}]`;
      let tag = $(item)
        .find(".ltx_tag_bibitem, .ltx_tag.ltx_role_refnum, .ltx_tag")
        .first();
      if (tag.length) {
        tag.empty().text(label);
      } else {
        $(item).prepend(
          `<span class="ltx_tag ltx_role_refnum ltx_tag_bibitem">${label}</span>`,
        );
      }
    });

  const bibTitles: Record<string, string> = {};
  $(".ltx_bibliography [id], .ltx_biblist [id]").each((_, bib) => {
    const bid = $(bib).attr("id");
    if (!bid) return;
    const text = $(bib).text().replace(/\s+/g, " ").trim();
    if (text) bibTitles[bid] = text.slice(0, 300);
  });
  $(article)
    .find("a.ltx_ref[href^='#']")
    .each((_, a) => {
      const href = $(a).attr("href") || "";
      const target = href.slice(1);
      if (target in bibTitles && !($(a).attr("title") || "").trim()) {
        $(a).attr("title", bibTitles[target]);
      }
    });

  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    page = new URL("https://ar5iv.labs.arxiv.org/");
  }
  const origin = `${page.protocol}//${page.host}`;
  const base = pageUrl.endsWith("/")
    ? pageUrl
    : `${pageUrl.replace(/\/[^/]*$/, "")}/`;

  type FetchItem = { el: Element; attr: string; absUrl: string };
  const toFetch: FetchItem[] = [];

  function enqueue(el: Element, attr: string, raw: string | undefined) {
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return;
    let absUrl: string;
    try {
      absUrl = new URL(raw, base).href;
    } catch {
      return;
    }
    if (absUrl.startsWith("//")) absUrl = `https:${absUrl}`;
    if (!absUrl.startsWith("http")) {
      if (raw.startsWith("/")) absUrl = origin + raw;
      else return;
    }
    let host = "";
    try {
      host = new URL(absUrl).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!host.includes("arxiv.org") && !host.includes("ar5iv")) return;
    toFetch.push({ el, attr, absUrl });
  }

  for (const [name, attr] of ASSET_ATTRS) {
    $(article)
      .find(`${name}[${attr}]`)
      .each((_, el) => {
        if (!isElement(el)) return;
        enqueue(el, attr, el.attribs?.[attr]);
      });
    $(article)
      .find(`${name}[xlink\\:href]`)
      .each((_, el) => {
        if (!isElement(el)) return;
        enqueue(el, "xlink:href", el.attribs?.["xlink:href"]);
      });
  }

  fs.mkdirSync(assetsDir, { recursive: true });

  // Unique URLs first — Python reused one httpx client; we keep-alive + parallelize.
  const uniqueUrls: string[] = [];
  const seenUrl = new Set<string>();
  for (const item of toFetch) {
    if (seenUrl.has(item.absUrl)) continue;
    seenUrl.add(item.absUrl);
    uniqueUrls.push(item.absUrl);
  }

  const urlToRel: Record<string, string> = {};
  const total = Math.max(uniqueUrls.length, 1);
  let done = 0;

  await mapPool(uniqueUrls, ASSET_CONCURRENCY, async (absUrl) => {
    let rel = safeRelpath(absUrl);
    let parsedPath = "";
    try {
      parsedPath = new URL(absUrl).pathname;
    } catch {
      parsedPath = "";
    }
    if (!path.basename(rel).includes(".") && path.basename(parsedPath).includes(".")) {
      rel = `${rel}${path.extname(parsedPath)}`;
    }
    const dest = path.join(assetsDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      const buf = await fetchAssetBytes(absUrl);
      if (buf) fs.writeFileSync(dest, buf);
      else return;
    }
    urlToRel[absUrl] = `assets/${rel}`;
    done += 1;
    onProgress?.(
      0.7 + 0.25 * (done / total),
      `下载资源 ${done}/${uniqueUrls.length}`,
    );
  });

  for (const { el, attr, absUrl } of toFetch) {
    const localRef = urlToRel[absUrl];
    if (localRef) $(el).attr(attr, localRef);
  }

  $(article).find("link").remove();

  const articleHtml = $(article).html() || "";
  const wrapped = `<div class="ar5iv-article ltx_document" data-paper-root="1">${articleHtml}</div>`;
  onProgress?.(0.96, "资源本地化完成");
  return wrapped;
}

export {
  localizeAr5ivHtml as localize_ar5iv_html,
  convertGraphicsObjects as convert_graphics_objects,
};
