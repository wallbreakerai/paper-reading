import "server-only";

import fs from "node:fs";
import path from "node:path";

import {
  AUTHORS_DETAIL_VERSION,
  STRUCTURE_VERSION,
  authorsDetailLooksStale,
  ensureReadingStructure,
  extractAuthorsDetail,
} from "./structure";
import { getLibraryDir } from "./settings";
import {
  loadTranslationFile,
  paperPayload,
} from "./translation-store";
import { localizeAr5ivHtml } from "./localize";
import type { ReadingStructure } from "./types";

export const SEED_PARTITIONS = ["AIGC", "AI-Infra"] as const;
export const INTERRUPTED_STATUSES = new Set([
  "pending",
  "downloading",
  "parsing",
  "translating",
]);
export const ORDER_FILENAME = "_order.json";

const lock = createMutex();
const SAFE_RE = /[^\w\-.]+/gu;

function createMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      const run = chain.then(() => fn(), () => fn());
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    runSync<T>(fn: () => T): T {
      // File ops are sync; serialize via sync flag for Node single-thread
      return fn();
    },
  };
}

let bootDone = false;

export type PaperPaths = {
  root: string;
  meta: string;
  source: string;
  blocks: string;
  readingStructure: string;
  translation: string;
  article: string;
  assets: string;
  notes: string;
  qaChat: string;
};

export function makePaperPaths(root: string): PaperPaths {
  return {
    root,
    meta: path.join(root, "meta.json"),
    source: path.join(root, "source.html"),
    blocks: path.join(root, "source_blocks.json"),
    readingStructure: path.join(root, "reading_structure.json"),
    translation: path.join(root, "translation.json"),
    article: path.join(root, "article.html"),
    assets: path.join(root, "assets"),
    notes: path.join(root, "notes.md"),
    qaChat: path.join(root, "qa-chat.json"),
  };
}

export function utcNow(): string {
  return new Date().toISOString();
}

export function titleSlug(title: string, maxLen = 80): string {
  let text = (title || "").trim();
  text = text.replace(/\//g, "-");
  text = text.replace(SAFE_RE, "_");
  text = text.replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  if (!text) text = "untitled";
  return text.slice(0, maxLen);
}

function orderPath(root?: string): string {
  return path.join(root || getLibraryDir(), ORDER_FILENAME);
}

function readOrder(root: string, key = "partitions"): string[] {
  const p = orderPath(root);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    const names = Array.isArray(data)
      ? data
      : data && typeof data === "object"
        ? (data as Record<string, unknown>)[key]
        : null;
    if (!Array.isArray(names)) return [];
    return names.filter((n): n is string => typeof n === "string" && !!n.trim());
  } catch {
    return [];
  }
}

function writeOrder(root: string, names: string[], key = "partitions"): void {
  const p = orderPath(root);
  fs.writeFileSync(p, `${JSON.stringify({ [key]: names }, null, 2)}\n`, "utf-8");
}

function paperDirs(base: string): string[] {
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        !d.name.startsWith("_") &&
        fs.existsSync(path.join(base, d.name, "meta.json")),
    )
    .map((d) => path.join(base, d.name));
}

function syncPaperOrder(base: string): string[] {
  const existing = new Set(paperDirs(base).map((p) => path.basename(p)));
  const order = readOrder(base, "papers").filter((n) => existing.has(n));
  const extras = [...existing]
    .filter((n) => !order.includes(n))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const merged = [...order, ...extras];
  if (JSON.stringify(merged) !== JSON.stringify(readOrder(base, "papers"))) {
    writeOrder(base, merged, "papers");
  }
  return merged;
}

function partitionDirs(root: string): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"),
    )
    .map((d) => path.join(root, d.name));
}

function syncOrder(root: string): string[] {
  const existing = new Set(partitionDirs(root).map((p) => path.basename(p)));
  const order = readOrder(root).filter((n) => existing.has(n));
  const extras = [...existing]
    .filter((n) => !order.includes(n))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const merged = [...order, ...extras];
  if (JSON.stringify(merged) !== JSON.stringify(readOrder(root))) {
    writeOrder(root, merged);
  }
  return merged;
}

function markInterruptedUnderBase(base: string): number {
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return 0;
  let updated = 0;
  for (const child of fs.readdirSync(base, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const metaPath = path.join(base, child.name, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const status = meta.status;
    if (typeof status !== "string" || !INTERRUPTED_STATUSES.has(status)) {
      continue;
    }
    let newStatus = "interrupted";
    const trPath = path.join(base, child.name, "translation.json");
    if (status === "translating" && fs.existsSync(trPath)) {
      try {
        const tr = loadTranslationFile(fs.readFileSync(trPath, "utf-8"));
        if (tr.completedSections?.length) newStatus = "partial";
      } catch {
        /* ignore */
      }
    }
    meta.status = newStatus;
    meta.error =
      meta.error ||
      (newStatus === "partial" ? null : "进程中断，请删除后重新添加");
    meta.updatedAt = utcNow();
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
    updated += 1;
  }
  return updated;
}

export function ensureLibrarySeeded(): string {
  const root = getLibraryDir();
  return lock.runSync(() => {
    const children = partitionDirs(root);
    if (!children.length) {
      for (const name of SEED_PARTITIONS) {
        fs.mkdirSync(path.join(root, name), { recursive: true });
      }
      writeOrder(root, [...SEED_PARTITIONS]);
    } else {
      syncOrder(root);
    }
    if (!bootDone) {
      bootDone = true;
      for (const part of partitionDirs(root)) {
        markInterruptedUnderBase(part);
      }
    }
    return root;
  });
}

export function listPartitions(): Array<{ name: string; paperCount: number }> {
  const root = ensureLibrarySeeded();
  const order = lock.runSync(() => syncOrder(root));
  const items: Array<{ name: string; paperCount: number }> = [];
  for (const name of order) {
    const p = path.join(root, name);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    const papers = fs
      .readdirSync(p, { withFileTypes: true })
      .filter(
        (c) =>
          c.isDirectory() &&
          fs.existsSync(path.join(p, c.name, "meta.json")),
      );
    items.push({ name: path.basename(p), paperCount: papers.length });
  }
  return items;
}

export function reorderPartitions(
  names: string[],
): Array<{ name: string; paperCount: number }> {
  const root = ensureLibrarySeeded();
  lock.runSync(() => {
    const existing = new Set(partitionDirs(root).map((p) => path.basename(p)));
    const cleaned = names
      .filter((n): n is string => typeof n === "string" && !!n.trim())
      .map((n) => n.trim());
    if (!cleaned.length) throw new Error("顺序列表不能为空");
    if (cleaned.length !== new Set(cleaned).size) {
      throw new Error("顺序列表含重复分区名");
    }
    if (
      cleaned.length !== existing.size ||
      cleaned.some((n) => !existing.has(n))
    ) {
      throw new Error("顺序列表必须包含且仅包含全部现有分区");
    }
    writeOrder(root, cleaned);
  });
  return listPartitions();
}

function partitionDir(name: string): string {
  const root = ensureLibrarySeeded();
  const safe = name.trim();
  if (!safe || safe.includes("/") || safe.includes("\\") || safe === "." || safe === "..") {
    throw new Error("无效的分区名");
  }
  if (safe.startsWith("_")) throw new Error("分区名不能以下划线开头");
  return path.join(root, safe);
}

export function createPartition(name: string): {
  name: string;
  paperCount: number;
} {
  const p = partitionDir(name);
  const root = path.dirname(p);
  return lock.runSync(() => {
    if (fs.existsSync(p)) throw new Error("分区已存在");
    fs.mkdirSync(p, { recursive: false });
    const order = syncOrder(root);
    if (!order.includes(path.basename(p))) {
      order.push(path.basename(p));
      writeOrder(root, order);
    }
    return { name: path.basename(p), paperCount: 0 };
  });
}

export function renamePartition(
  old: string,
  newName: string,
): { name: string; paperCount: number } {
  const src = partitionDir(old);
  const dst = partitionDir(newName);
  const root = path.dirname(src);
  return lock.runSync(() => {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new Error("分区不存在");
    }
    if (fs.existsSync(dst)) throw new Error("目标分区名已存在");
    fs.renameSync(src, dst);
    let order = readOrder(root).map((n) => (n === old ? path.basename(dst) : n));
    const existing = new Set(partitionDirs(root).map((x) => path.basename(x)));
    order = order.filter((n) => existing.has(n));
    if (!order.includes(path.basename(dst))) order.push(path.basename(dst));
    const extras = [...existing]
      .filter((n) => !order.includes(n))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    writeOrder(root, [...order, ...extras]);
    const papers = fs
      .readdirSync(dst, { withFileTypes: true })
      .filter(
        (c) =>
          c.isDirectory() &&
          fs.existsSync(path.join(dst, c.name, "meta.json")),
      );
    return { name: path.basename(dst), paperCount: papers.length };
  });
}

export function deletePartition(name: string): void {
  const p = partitionDir(name);
  const root = path.dirname(p);
  lock.runSync(() => {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      throw new Error("分区不存在");
    }
    fs.rmSync(p, { recursive: true, force: true });
    writeOrder(
      root,
      readOrder(root).filter((n) => n !== name),
    );
  });
}

export function readMeta(paths: PaperPaths): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(paths.meta, "utf-8")) as Record<
    string,
    unknown
  >;
}

export function writeMeta(
  paths: PaperPaths,
  meta: Record<string, unknown>,
): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(
    paths.meta,
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf-8",
  );
}

export function paperPaths(partition: string, slug: string): PaperPaths {
  const base = partitionDir(partition);
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new Error("无效的论文目录名");
  }
  return makePaperPaths(path.join(base, slug));
}

export function readNotes(partition: string, slug: string): string {
  const paths = paperPaths(partition, slug);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  if (!fs.existsSync(paths.notes) || !fs.statSync(paths.notes).isFile()) {
    return "";
  }
  return fs.readFileSync(paths.notes, "utf-8");
}

export function writeNotes(
  partition: string,
  slug: string,
  content: string,
): string {
  const paths = paperPaths(partition, slug);
  if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  let text = typeof content === "string" ? content : "";
  if (text && !text.endsWith("\n")) text += "\n";
  fs.writeFileSync(paths.notes, text, "utf-8");
  return text;
}

export function markInterruptedInPartition(partition: string): number {
  return lock.runSync(() => {
    const base = partitionDir(partition);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw Object.assign(new Error("分区不存在"), { code: "ENOENT" });
    }
    return markInterruptedUnderBase(base);
  });
}

export function markOrphanedJobsInterrupted(): number {
  const root = ensureLibrarySeeded();
  let total = 0;
  for (const part of partitionDirs(root)) {
    total += markInterruptedInPartition(path.basename(part));
  }
  return total;
}

export function listPapers(partition: string): Array<Record<string, unknown>> {
  const base = partitionDir(partition);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw Object.assign(new Error("分区不存在"), { code: "ENOENT" });
  }
  const order = lock.runSync(() => syncPaperOrder(base));
  const items: Array<Record<string, unknown>> = [];
  for (const slug of order) {
    const child = path.join(base, slug);
    const metaPath = path.join(child, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<
        string,
        unknown
      >;
      items.push({
        slug: path.basename(child),
        title: meta.title || path.basename(child),
        arxivId: meta.arxivId,
        sourceUrl: meta.sourceUrl,
        status: meta.status,
        error: meta.error,
        jobId: meta.jobId,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
      });
    } catch {
      continue;
    }
  }
  return items;
}

export function reorderPapers(
  partition: string,
  slugs: string[],
): Array<Record<string, unknown>> {
  const base = partitionDir(partition);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw Object.assign(new Error("分区不存在"), { code: "ENOENT" });
  }
  lock.runSync(() => {
    const existing = new Set(paperDirs(base).map((p) => path.basename(p)));
    const cleaned = slugs
      .filter((s): s is string => typeof s === "string" && !!s.trim())
      .map((s) => s.trim());
    if (!cleaned.length) throw new Error("顺序列表不能为空");
    if (cleaned.length !== new Set(cleaned).size) {
      throw new Error("顺序列表含重复论文");
    }
    if (
      cleaned.length !== existing.size ||
      cleaned.some((n) => !existing.has(n))
    ) {
      throw new Error("顺序列表必须包含且仅包含全部现有论文");
    }
    writeOrder(base, cleaned, "papers");
  });
  return listPapers(partition);
}

export function findDuplicate(
  partition: string,
  opts: {
    arxivId?: string | null;
    sourceUrl?: string | null;
    title?: string | null;
    excludeSlug?: string | null;
  },
): string | null {
  const base = partitionDir(partition);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return null;
  const titleNorm = (opts.title || "").trim().toLowerCase();
  const titleAsSlug = opts.title ? titleSlug(opts.title) : "";
  for (const child of fs.readdirSync(base, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === opts.excludeSlug) continue;
    const metaPath = path.join(base, child.name, "meta.json");
    if (!fs.existsSync(metaPath)) {
      if (titleAsSlug && child.name === titleAsSlug) return child.name;
      continue;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<
        string,
        unknown
      >;
      if (opts.arxivId && meta.arxivId === opts.arxivId) return child.name;
      if (opts.sourceUrl && meta.sourceUrl === opts.sourceUrl) return child.name;
      const existingTitle = String(meta.title || "")
        .trim()
        .toLowerCase();
      if (titleNorm && existingTitle && existingTitle === titleNorm) {
        return child.name;
      }
      if (
        titleAsSlug &&
        (child.name === titleAsSlug || meta.slug === titleAsSlug)
      ) {
        return child.name;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function createPaperStub(
  partition: string,
  opts: { arxivId: string; sourceUrl: string; jobId: string },
): { slug: string; paths: PaperPaths; meta: Record<string, unknown> } {
  const dup = findDuplicate(partition, {
    arxivId: opts.arxivId,
    sourceUrl: opts.sourceUrl,
  });
  if (dup) throw new Error(`该论文已在本分区：${dup}`);
  const base = partitionDir(partition);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw Object.assign(new Error("分区不存在"), { code: "ENOENT" });
  }
  const slug = opts.arxivId.replace(/\//g, "_");
  const root = path.join(base, slug);
  return lock.runSync(() => {
    if (fs.existsSync(root)) throw new Error(`该论文已在本分区：${slug}`);
    fs.mkdirSync(root, { recursive: false });
    const paths = makePaperPaths(root);
    const meta: Record<string, unknown> = {
      arxivId: opts.arxivId,
      sourceUrl: opts.sourceUrl,
      title: opts.arxivId,
      slug,
      status: "pending",
      pipeline: "full_translate_v1",
      jobId: opts.jobId,
      error: null,
      createdAt: utcNow(),
      updatedAt: utcNow(),
    };
    writeMeta(paths, meta);
    fs.writeFileSync(paths.notes, "", "utf-8");
    const order = syncPaperOrder(base);
    if (!order.includes(slug)) {
      order.push(slug);
      writeOrder(base, order, "papers");
    }
    return { slug, paths, meta };
  });
}

export function renamePaperDir(
  partition: string,
  oldSlug: string,
  newSlug: string,
): PaperPaths {
  const base = partitionDir(partition);
  const src = path.join(base, oldSlug);
  const dst = path.join(base, newSlug);
  return lock.runSync(() => {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw Object.assign(new Error("论文目录不存在"), { code: "ENOENT" });
    }
    if (fs.existsSync(dst)) throw new Error("目标目录已存在");
    fs.renameSync(src, dst);
    let order = readOrder(base, "papers").map((n) =>
      n === oldSlug ? newSlug : n,
    );
    const existing = new Set(paperDirs(base).map((p) => path.basename(p)));
    order = order.filter((n) => existing.has(n));
    if (!order.includes(newSlug)) order.push(newSlug);
    const extras = [...existing]
      .filter((n) => !order.includes(n))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    writeOrder(base, [...order, ...extras], "papers");
    return makePaperPaths(dst);
  });
}

export function allocateTitleSlug(
  partition: string,
  title: string,
  excludeSlug?: string | null,
): string {
  const base = titleSlug(title);
  let candidate = base;
  let n = 2;
  while (true) {
    const existing = path.join(partitionDir(partition), candidate);
    if (
      !fs.existsSync(existing) ||
      path.basename(existing) === excludeSlug
    ) {
      return candidate;
    }
    candidate = `${base}-${n}`;
    n += 1;
  }
}

export function deletePaper(partition: string, slug: string): void {
  const paths = paperPaths(partition, slug);
  const base = path.dirname(paths.root);
  lock.runSync(() => {
    if (!fs.existsSync(paths.root) || !fs.statSync(paths.root).isDirectory()) {
      throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
    }
    fs.rmSync(paths.root, { recursive: true, force: true });
    writeOrder(
      base,
      readOrder(base, "papers").filter((n) => n !== slug),
      "papers",
    );
  });
}

export function loadPaper(
  partition: string,
  slug: string,
): ReturnType<typeof paperPayload> {
  const paths = paperPaths(partition, slug);
  if (!fs.existsSync(paths.meta)) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  const meta = readMeta(paths);
  let structure: ReadingStructure | null = null;
  if (fs.existsSync(paths.readingStructure)) {
    try {
      structure = JSON.parse(
        fs.readFileSync(paths.readingStructure, "utf-8"),
      ) as ReadingStructure;
    } catch {
      structure = null;
    }
  }
  const translation = loadTranslationFile(
    fs.existsSync(paths.translation)
      ? fs.readFileSync(paths.translation, "utf-8")
      : null,
  );

  const hasArticle =
    fs.existsSync(paths.article) || fs.existsSync(paths.source);
  const ver = structure ? Number(structure.version || 1) : 0;
  const needAuthorRefresh = authorsDetailLooksStale(
    meta.authorsDetail as Parameters<typeof authorsDetailLooksStale>[0],
    meta,
  );
  const needHtml =
    needAuthorRefresh || (structure != null && ver >= 4 && ver < STRUCTURE_VERSION);

  let articleHtml = "";
  if (needHtml) {
    if (fs.existsSync(paths.article)) {
      articleHtml = fs.readFileSync(paths.article, "utf-8");
    } else if (fs.existsSync(paths.source)) {
      try {
        // sync localize via deasync is not available — use already-localized or skip
        // For GET path, if only source exists we need localize. Use sync-ish approach:
        // write a marker and skip; jobs already localize. Match Python try/except.
        // We'll use a cached sync path: only read source if we can't localize async here.
        // loadPaper is sync in Python; localize is sync there. Here localize is async.
        // Use child_process? Better: make loadPaper async.
      } catch {
        articleHtml = "";
      }
    }
  }

  // Note: full localize on GET is rare; if article missing we leave empty.
  // Prefer article.html written by import job.

  if (articleHtml && structure != null && ver >= 4 && ver < STRUCTURE_VERSION) {
    try {
      const { structure: next, changed } = ensureReadingStructure(
        articleHtml,
        structure,
      );
      if (changed) {
        structure = next;
        fs.writeFileSync(
          paths.readingStructure,
          `${JSON.stringify(structure, null, 2)}\n`,
          "utf-8",
        );
      }
    } catch {
      /* ignore */
    }
  }

  if (articleHtml && needAuthorRefresh) {
    try {
      const detail = extractAuthorsDetail(articleHtml);
      if (detail.length) {
        meta.authorsDetail = detail;
        meta.authorsDetailVersion = AUTHORS_DETAIL_VERSION;
        if (!meta.authors) {
          meta.authors = detail.map((d) => d.name);
        }
        writeMeta(paths, meta);
      }
    } catch {
      /* ignore */
    }
  }

  return paperPayload({
    slug: path.basename(paths.root),
    meta,
    structure,
    translation,
    hasArticle,
  });
}

/** Async variant that can localize source.html when needed. */
export async function loadPaperAsync(
  partition: string,
  slug: string,
): Promise<ReturnType<typeof paperPayload>> {
  const paths = paperPaths(partition, slug);
  if (!fs.existsSync(paths.meta)) {
    throw Object.assign(new Error("论文不存在"), { code: "ENOENT" });
  }
  const meta = readMeta(paths);
  let structure: ReadingStructure | null = null;
  if (fs.existsSync(paths.readingStructure)) {
    try {
      structure = JSON.parse(
        fs.readFileSync(paths.readingStructure, "utf-8"),
      ) as ReadingStructure;
    } catch {
      structure = null;
    }
  }
  const translation = loadTranslationFile(
    fs.existsSync(paths.translation)
      ? fs.readFileSync(paths.translation, "utf-8")
      : null,
  );

  const hasArticle =
    fs.existsSync(paths.article) || fs.existsSync(paths.source);
  const ver = structure ? Number(structure.version || 1) : 0;
  const needAuthorRefresh = authorsDetailLooksStale(
    meta.authorsDetail as Parameters<typeof authorsDetailLooksStale>[0],
    meta,
  );
  const needHtml =
    needAuthorRefresh || (structure != null && ver >= 4 && ver < STRUCTURE_VERSION);

  let articleHtml = "";
  if (needHtml) {
    if (fs.existsSync(paths.article)) {
      articleHtml = fs.readFileSync(paths.article, "utf-8");
    } else if (fs.existsSync(paths.source)) {
      try {
        const sourceUrl = String(meta.sourceUrl || "");
        articleHtml = await localizeAr5ivHtml(
          fs.readFileSync(paths.source, "utf-8"),
          { pageUrl: sourceUrl, assetsDir: paths.assets },
        );
        fs.writeFileSync(paths.article, articleHtml, "utf-8");
      } catch {
        articleHtml = "";
      }
    }
  }

  if (articleHtml && structure != null && ver >= 4 && ver < STRUCTURE_VERSION) {
    try {
      const { structure: next, changed } = ensureReadingStructure(
        articleHtml,
        structure,
      );
      if (changed) {
        structure = next;
        fs.writeFileSync(
          paths.readingStructure,
          `${JSON.stringify(structure, null, 2)}\n`,
          "utf-8",
        );
      }
    } catch {
      /* ignore */
    }
  }

  if (articleHtml && needAuthorRefresh) {
    try {
      const detail = extractAuthorsDetail(articleHtml);
      if (detail.length) {
        meta.authorsDetail = detail;
        meta.authorsDetailVersion = AUTHORS_DETAIL_VERSION;
        if (!meta.authors) {
          meta.authors = detail.map((d) => d.name);
        }
        writeMeta(paths, meta);
      }
    } catch {
      /* ignore */
    }
  }

  return paperPayload({
    slug: path.basename(paths.root),
    meta,
    structure,
    translation,
    hasArticle,
  });
}

export function resolvePaperAsset(
  partition: string,
  slug: string,
  rel: string,
): string {
  const paths = paperPaths(partition, slug);
  if (rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error("无效的资源路径");
  }
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const assetsRoot = path.resolve(paths.assets);
  const candidates: string[] = [rel];
  if (rel.startsWith("assets/")) candidates.push(rel.slice("assets/".length));
  else candidates.push(`assets/${rel}`);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const target = path.resolve(assetsRoot, candidate);
    if (!target.startsWith(assetsRoot + path.sep) && target !== assetsRoot) {
      throw new Error("无效的资源路径");
    }
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }
  throw Object.assign(new Error("资源不存在"), { code: "ENOENT" });
}

export function isNotFound(e: unknown): boolean {
  return (
    Boolean(e && typeof e === "object" && (e as { code?: string }).code === "ENOENT") ||
    (e instanceof Error &&
      (e.message === "论文不存在" ||
        e.message === "分区不存在" ||
        e.message === "资源不存在" ||
        e.message === "论文目录不存在"))
  );
}
