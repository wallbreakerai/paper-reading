/**
 * Build a standalone bilingual dual-column HTML document for download / tmp export.
 */

export const BILINGUAL_EXPORT_CSS = `
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --warn: oklch(0.65 0.14 70);
  --link: oklch(0.45 0.02 260);
  --radius: 0.75rem;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: "Source Han Sans SC", "Noto Sans SC", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.65;
}
.export-doc { max-width: 1200px; margin: 0 auto; padding: 0 0 48px; }
.export-meta {
  padding: 12px 24px;
  font-size: 0.78rem;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
  background: var(--muted);
}
.reader-hero {
  padding: 2rem 2rem 1.65rem;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, color-mix(in oklch, var(--muted) 55%, var(--card)) 0%, var(--card) 100%);
}
.reader-hero-title {
  margin: 0;
  font-size: 1.55rem;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -0.02em;
  text-align: center;
}
.reader-hero-authors {
  list-style: none;
  margin: 1.75rem auto 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.35rem 0.4rem;
  max-width: 56rem;
}
.reader-hero-author {
  margin: 0;
  text-align: center;
  min-width: 6.5rem;
  max-width: 11rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
  border-radius: calc(var(--radius) * 0.65);
  background: color-mix(in oklch, var(--muted) 40%, transparent);
}
.reader-hero-author-name {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
}
.reader-hero-author-aff {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.62rem;
  font-style: italic;
  color: var(--muted-foreground);
}
.col-heads {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border);
  background: var(--muted);
  position: sticky;
  top: 0;
  z-index: 2;
}
.col-heads span {
  padding: 0.45rem 1.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted-foreground);
  letter-spacing: 0.04em;
}
.col-heads span:first-child { border-right: 1px solid var(--border); }
.reader-pairs { min-width: 0; }
.section-group { min-width: 0; }
.sentence-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: stretch;
  border-bottom: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
}
.sentence-pair.kind-spacer-pair { min-height: 2.4rem; }
.sentence-pair.kind-heading-pair {
  background: color-mix(in oklch, var(--muted) 52%, transparent);
}
.pair-cell {
  min-width: 0;
  max-width: 100%;
  padding: 0.45rem 1.35rem;
  overflow-x: auto;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.pair-en { border-right: 1px solid var(--border); }
.sentence-unit { font-size: 0.95rem; line-height: 1.7; }
.sentence-unit.kind-heading {
  font-weight: 650;
  font-size: 1.05rem;
  line-height: 1.4;
}
.sentence-unit.kind-equation,
.sentence-unit.kind-figure,
.sentence-unit.kind-table,
.sentence-unit.kind-caption,
.sentence-unit.kind-reference {
  font-size: 0.92rem;
}
.para-spacer { min-height: 1.2rem; }
.media-frame { position: relative; }
.media-zoom-btn { display: none !important; }
.article-html img,
.article-html svg {
  max-width: 100%;
  height: auto;
}
.article-html math,
.article-html .ltx_Math {
  font-family: "Latin Modern Math", "STIX Two Math", "Cambria Math", serif;
}
.article-html annotation,
.article-html annotation-xml {
  display: none !important;
}
.article-html .ltx_equation,
.article-html .ltx_equationgroup {
  display: block;
  overflow-x: auto;
  margin: 1em 0;
}
.article-html .ltx_flex_figure {
  display: flex;
  flex-flow: column nowrap;
  gap: 0.85rem;
  width: 100%;
}
.article-html table {
  border-collapse: collapse;
  max-width: 100%;
}
.article-html a { color: var(--link); }
.zh-pending {
  color: var(--muted-foreground);
  font-style: italic;
  font-size: 0.88rem;
}
@media print {
  .export-meta { display: none; }
  .col-heads { position: static; }
  .sentence-pair { break-inside: avoid; }
}
`.trim();

export function sanitizeExportFileBase(name: string): string {
  const cleaned = (name || "paper")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 80);
  return cleaned || "paper";
}

/** Make root-relative URLs absolute so the file works while the app is running. */
export function absolutizeHtmlUrls(html: string, origin: string): string {
  const base = origin.replace(/\/$/, "");
  return html
    .replace(
      /\b(src|href|xlink:href)=(["'])(\/[^"']*)\2/gi,
      (_m, attr: string, q: string, path: string) =>
        `${attr}=${q}${base}${path}${q}`,
    )
    .replace(
      /\burl\((["']?)(\/[^)"']+)\1\)/gi,
      (_m, q: string, path: string) => `url(${q}${base}${path}${q})`,
    );
}

export function buildBilingualExportDocument(input: {
  title: string;
  bodyHtml: string;
  origin: string;
  partition?: string;
  slug?: string;
  exportedAt?: string;
}): string {
  const title = (input.title || "双语论文").trim() || "双语论文";
  const when =
    input.exportedAt ||
    new Date().toISOString().replace("T", " ").slice(0, 19);
  const body = absolutizeHtmlUrls(input.bodyHtml, input.origin);
  const metaBits = [
    input.partition ? `分区 ${escapeHtmlText(input.partition)}` : "",
    input.slug ? `目录 ${escapeHtmlText(input.slug)}` : "",
    `导出于 ${escapeHtmlText(when)}`,
    "资源路径依赖本地 paper-reading 服务（默认 :6864）",
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtmlText(title)} · 双语对照</title>
<style>
${BILINGUAL_EXPORT_CSS}
</style>
</head>
<body>
<div class="export-doc">
  <div class="export-meta">${metaBits.join(" · ")}</div>
  ${body}
</div>
</body>
</html>
`;
}

export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trigger a browser download of an HTML string. */
export function downloadHtmlFile(html: string, fileName: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".html") ? fileName : `${fileName}.html`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/**
 * Clone the reader dual-column DOM into export-ready HTML (hero + pairs).
 * Call after all sections have been revealed.
 */
export function collectReaderExportBodyHtml(root: ParentNode): string | null {
  const columns = root.querySelector(".reader-columns");
  if (!columns) return null;
  const clone = columns.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(
    ".media-zoom-btn, .reader-reveal-sentinel, button, .reader-progress-pin",
  ).forEach((el) => el.remove());
  clone
    .querySelectorAll(".is-active")
    .forEach((el) => el.classList.remove("is-active"));
  clone.removeAttribute("style");

  const heads = document.createElement("div");
  heads.className = "col-heads";
  heads.innerHTML = "<span>原文</span><span>译文</span>";

  const hero = clone.querySelector(".reader-hero");
  const pairs = clone.querySelector(".reader-pairs");
  const wrap = document.createElement("div");
  if (hero) wrap.appendChild(hero);
  wrap.appendChild(heads);
  if (pairs) wrap.appendChild(pairs);
  return wrap.innerHTML;
}
