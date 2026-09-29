import "server-only";

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fetchAr5ivHtml } from "./ar5iv";
import { parseArxivUrl } from "./arxiv-url";
import * as library from "./library";
import { TranslatePaused } from "./llm";
import { localizeAr5ivHtml } from "./localize";
import { blocksToJsonable, parseAr5ivHtml } from "./parser";
import { getLlm, llmConfigured } from "./settings";
import {
  AUTHORS_DETAIL_VERSION,
  STRUCTURE_VERSION,
  buildReadingStructure,
  ensureReadingStructure,
  extractAuthorsDetail,
} from "./structure";
import {
  loadTranslationFile,
  mergeSectionTranslation,
  pendingSections,
} from "./translation-store";
import {
  chunkSentences,
  translateSentencesWithRetry,
} from "./translator";
import type { ReadingStructure, Translation } from "./types";

export type Job = {
  id: string;
  partition: string;
  slug: string;
  phase: string;
  status: string;
  progress: number;
  message: string;
  error: string | null;
  paperSlug: string | null;
};

const jobs = new Map<string, Job>();
const queue: string[] = [];
let workerRunning = false;

function updateJob(job: Job, patch: Partial<Job>): void {
  Object.assign(job, patch);
}

function failJob(job: Job, message: string): void {
  const paths = library.paperPaths(job.partition, job.paperSlug || job.slug);
  if (fs.existsSync(paths.meta)) {
    const meta = library.readMeta(paths);
    meta.status = "failed";
    meta.error = message;
    meta.updatedAt = library.utcNow();
    library.writeMeta(paths, meta);
  }
  updateJob(job, {
    status: "failed",
    phase: "failed",
    error: message,
    message,
    progress: 1.0,
  });
}

async function runImport(job: Job): Promise<void> {
  let paths = library.paperPaths(job.partition, job.slug);
  const meta = library.readMeta(paths);
  const sourceUrl = String(meta.sourceUrl);
  // arxivId unused but kept for parity

  let lastMetaWrite = 0;
  const onProg = (p: number, msg: string) => {
    updateJob(job, { phase: "download", progress: p * 0.7, message: msg });
    // Throttle disk writes — Python felt faster partly because we were
    // rewriting meta.json on every HTML chunk in the TS port.
    const now = Date.now();
    if (now - lastMetaWrite < 400) return;
    lastMetaWrite = now;
    const metaLocal = library.readMeta(paths);
    metaLocal.status = "downloading";
    metaLocal.updatedAt = library.utcNow();
    library.writeMeta(paths, metaLocal);
  };

  meta.status = "downloading";
  meta.updatedAt = library.utcNow();
  library.writeMeta(paths, meta);

  const html = await fetchAr5ivHtml(sourceUrl, onProg);
  fs.writeFileSync(paths.source, html, "utf-8");

  updateJob(job, { phase: "parse", progress: 0.72, message: "本地化资源…" });

  const onAsset = (p: number, msg: string) => {
    updateJob(job, { phase: "parse", progress: p, message: msg });
  };

  const articleHtml = await localizeAr5ivHtml(html, {
    pageUrl: sourceUrl,
    assetsDir: paths.assets,
    onProgress: onAsset,
  });
  fs.writeFileSync(paths.article, articleHtml, "utf-8");

  updateJob(job, { phase: "parse", progress: 0.97, message: "解析正文…" });
  const { title, blocks, authors } = parseAr5ivHtml(html);

  const dup = library.findDuplicate(job.partition, {
    title,
    excludeSlug: job.slug,
  });
  if (dup) {
    library.deletePaper(job.partition, job.slug);
    throw new Error(`同标题论文已存在：${dup}`);
  }

  fs.writeFileSync(
    paths.blocks,
    `${JSON.stringify(blocksToJsonable(blocks), null, 2)}\n`,
    "utf-8",
  );

  let newSlug = library.allocateTitleSlug(job.partition, title, job.slug);
  if (newSlug !== job.slug) {
    try {
      paths = library.renamePaperDir(job.partition, job.slug, newSlug);
    } catch {
      newSlug = job.slug;
      paths = library.paperPaths(job.partition, newSlug);
    }
  }

  const meta2 = library.readMeta(paths);
  meta2.title = title;
  meta2.authors = authors;
  try {
    const detail = extractAuthorsDetail(articleHtml);
    if (detail.length) {
      meta2.authorsDetail = detail;
      meta2.authorsDetailVersion = AUTHORS_DETAIL_VERSION;
      meta2.authors = detail.map((d) => d.name);
    }
  } catch {
    /* ignore */
  }
  meta2.slug = path.basename(paths.root);
  meta2.status = "ready_source";
  meta2.error = null;
  meta2.updatedAt = library.utcNow();
  library.writeMeta(paths, meta2);

  updateJob(job, {
    status: "completed",
    phase: "ready",
    progress: 1.0,
    message: "原文就绪",
    paperSlug: path.basename(paths.root),
    slug: path.basename(paths.root),
    error: null,
  });
}

async function workerLoop(): Promise<void> {
  while (true) {
    const jobId = queue.shift();
    if (!jobId) {
      workerRunning = false;
      return;
    }
    const job = jobs.get(jobId);
    if (!job) continue;
    updateJob(job, {
      status: "running",
      phase: "download",
      message: "开始下载",
    });
    try {
      await runImport(job);
    } catch (exc) {
      failJob(job, exc instanceof Error ? exc.message : String(exc));
    }
  }
}

function ensureWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  void workerLoop();
}

export function enqueueImport(
  partition: string,
  url: string,
): { jobId: string; paperSlug: string; arxivId: string } {
  const parsed = parseArxivUrl(url);
  const jobId = randomUUID().replace(/-/g, "");
  const { slug } = library.createPaperStub(partition, {
    arxivId: parsed.arxivId,
    sourceUrl: parsed.ar5ivHtml,
    jobId,
  });
  const job: Job = {
    id: jobId,
    partition,
    slug,
    paperSlug: slug,
    phase: "queued",
    status: "queued",
    progress: 0,
    message: "",
    error: null,
  };
  jobs.set(jobId, job);
  queue.push(jobId);
  ensureWorker();
  return { jobId, paperSlug: slug, arxivId: parsed.arxivId };
}

export function getJob(jobId: string): Record<string, unknown> | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    partition: job.partition,
    slug: job.paperSlug || job.slug,
    phase: job.phase,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
  };
}

// --- translate streaming ---

type TranslateEvent = Record<string, unknown>;

type TranslateStream = {
  preview: string;
  phase: string;
  done: boolean;
  error: string | null;
  cancelled: boolean;
  events: TranslateEvent[];
  waiters: Array<() => void>;
};

const translateStreams = new Map<string, TranslateStream>();

function paperKey(partition: string, slug: string): string {
  return `${partition}::${slug}`;
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function notify(stream: TranslateStream): void {
  const waiters = stream.waiters.splice(0);
  for (const w of waiters) w();
}

function pushEvent(stream: TranslateStream, event: TranslateEvent): void {
  if (event.type === "preview") {
    stream.preview = String(event.text || "");
    notify(stream);
    return;
  }
  stream.events.push(event);
  notify(stream);
}

function waitStream(stream: TranslateStream, timeoutMs = 200): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const i = stream.waiters.indexOf(resolve);
      if (i >= 0) stream.waiters.splice(i, 1);
      resolve();
    }, timeoutMs);
    stream.waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitStreamDone(
  stream: TranslateStream,
  timeout = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stream.done) return;
    await waitStream(stream, 200);
  }
}

export async function* streamTranslate(
  partition: string,
  slug: string,
): AsyncGenerator<string, void, unknown> {
  const paths = library.paperPaths(partition, slug);
  if (!fs.existsSync(paths.meta)) {
    yield sse({ type: "error", message: "论文不存在" });
    return;
  }

  const meta = library.readMeta(paths);
  if (meta.status === "pending" || meta.status === "downloading") {
    yield sse({ type: "error", message: "原文尚未就绪" });
    return;
  }

  if (meta.status === "completed" && fs.existsSync(paths.readingStructure)) {
    const translation = loadTranslationFile(
      fs.existsSync(paths.translation)
        ? fs.readFileSync(paths.translation, "utf-8")
        : null,
    );
    const structure = JSON.parse(
      fs.readFileSync(paths.readingStructure, "utf-8"),
    ) as ReadingStructure;
    yield sse({
      type: "snapshot",
      readingStructure: structure,
      translation,
      status: "completed",
    });
    yield sse({ type: "done", status: "completed" });
    return;
  }

  const key = paperKey(partition, slug);
  let stale: TranslateStream | null = null;
  let stream: TranslateStream | null = null;
  let replay: TranslateEvent[] = [];
  let preview0 = "";

  {
    const existing = translateStreams.get(key);
    if (
      existing &&
      !existing.done &&
      existing.error == null &&
      !existing.cancelled
    ) {
      stream = existing;
      replay = [...existing.events];
      preview0 = existing.preview;
    } else {
      if (existing && !existing.done) {
        existing.cancelled = true;
        notify(existing);
        stale = existing;
      }
    }
  }

  if (stale) {
    await waitStreamDone(stale, 60_000);
    if (translateStreams.get(key) === stale) translateStreams.delete(key);
  }

  if (!stream) {
    const existing = translateStreams.get(key);
    if (
      existing &&
      !existing.done &&
      existing.error == null &&
      !existing.cancelled
    ) {
      stream = existing;
      replay = [...existing.events];
      preview0 = existing.preview;
    } else {
      stream = {
        preview: "",
        phase: "idle",
        done: false,
        error: null,
        cancelled: false,
        events: [],
        waiters: [],
      };
      translateStreams.set(key, stream);
      void runTranslate(partition, slug, stream);
      replay = [];
      preview0 = "";
    }
  }

  for (const ev of replay) yield sse(ev);
  if (preview0) yield sse({ type: "preview", text: preview0 });

  let idx = replay.length;
  let lastPreview = preview0;
  while (true) {
    while (
      idx >= stream.events.length &&
      stream.preview === lastPreview &&
      !stream.done &&
      stream.error == null
    ) {
      await waitStream(stream, 200);
    }
    const batch = stream.events.slice(idx);
    idx = stream.events.length;
    const preview = stream.preview;
    const done = stream.done;
    const err = stream.error;
    if (preview !== lastPreview) {
      yield sse({ type: "preview", text: preview });
      lastPreview = preview;
    }
    for (const ev of batch) yield sse(ev);
    if (err) {
      yield sse({ type: "error", message: err });
      return;
    }
    if (done) return;
  }
}

async function runTranslate(
  partition: string,
  slug: string,
  stream: TranslateStream,
): Promise<void> {
  const paths = library.paperPaths(partition, slug);
  const aborted = () => stream.cancelled;

  try {
    if (!fs.existsSync(paths.article)) {
      throw new Error("缺少 article.html，无法解析结构");
    }

    let existingStructure: ReadingStructure | null = null;
    if (fs.existsSync(paths.readingStructure)) {
      try {
        existingStructure = JSON.parse(
          fs.readFileSync(paths.readingStructure, "utf-8"),
        ) as ReadingStructure;
      } catch {
        existingStructure = null;
      }
    }

    const needParse =
      existingStructure == null ||
      Number(existingStructure.version || 1) < STRUCTURE_VERSION;

    let structure: ReadingStructure;

    if (needParse) {
      const meta = library.readMeta(paths);
      meta.status = "parsing";
      meta.error = null;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
      stream.phase = "parsing";
      pushEvent(stream, { type: "phase", phase: "parsing" });

      if (aborted()) throw new TranslatePaused();

      const html = fs.readFileSync(paths.article, "utf-8");
      if (existingStructure == null) {
        const built = buildReadingStructure(html);
        structure = built.structure;
        for (const ev of built.events) {
          if (aborted()) throw new TranslatePaused();
          if (ev.type === "progress") {
            pushEvent(stream, {
              type: "parse_progress",
              current: ev.current,
              total: ev.total,
              message: ev.message,
            });
          }
        }
      } else {
        pushEvent(stream, {
          type: "parse_progress",
          current: 1,
          total: 1,
          message: "升级阅读结构（补全公式/图/表）…",
        });
        const ensured = ensureReadingStructure(html, existingStructure);
        structure = ensured.structure;
      }
      fs.writeFileSync(
        paths.readingStructure,
        `${JSON.stringify(structure, null, 2)}\n`,
        "utf-8",
      );
      pushEvent(stream, {
        type: "structure_ready",
        readingStructure: structure,
        sections: structure.sections?.length || 0,
      });
    } else {
      structure = existingStructure!;
      pushEvent(stream, {
        type: "structure_ready",
        readingStructure: structure,
        sections: structure.sections?.length || 0,
      });
    }

    if (aborted()) throw new TranslatePaused();

    let translation = loadTranslationFile(
      fs.existsSync(paths.translation)
        ? fs.readFileSync(paths.translation, "utf-8")
        : null,
    );
    const pending = pendingSections(structure, translation);
    if (!pending.length) {
      const meta = library.readMeta(paths);
      meta.status = "completed";
      meta.error = null;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
      pushEvent(stream, {
        type: "snapshot",
        readingStructure: structure,
        translation,
        status: "completed",
      });
      pushEvent(stream, { type: "done", status: "completed" });
      stream.done = true;
      notify(stream);
      return;
    }

    if (!llmConfigured()) {
      const meta = library.readMeta(paths);
      meta.status = "translate_failed";
      meta.error = "请先在设置中配置 LLM";
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
      throw new Error("请先在设置中配置 LLM");
    }

    {
      const meta = library.readMeta(paths);
      meta.status = "translating";
      meta.error = null;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
    }
    stream.phase = "translating";
    pushEvent(stream, { type: "phase", phase: "translating" });

    // ensure LLM config is loadable
    getLlm();
    const total = structure.sections?.length || 0;
    let doneN = (translation.completedSections || []).length;

    for (const section of pending) {
      if (aborted()) throw new TranslatePaused();
      const secId = String(section.id);
      let sentences = (
        (section.sentences as Array<Record<string, unknown>>) || []
      ).filter((s) => s.kind !== "author");

      if (sentences.length && sentences[0]!.kind === "heading") {
        const t0 = String(sentences[0]!.text || "").trim();
        const metaTitle = String(library.readMeta(paths).title || "").trim();
        if (t0 && metaTitle && t0 === metaTitle) {
          sentences = sentences.slice(1);
        }
      }

      const expectedIds = sentences.map((s) => String(s.id));
      const mediaKinds = new Set([
        "equation",
        "figure",
        "table",
        "reference",
        "spacer",
      ]);
      const mediaMap: Record<string, string> = {};
      for (const s of sentences) {
        if (mediaKinds.has(String(s.kind))) mediaMap[String(s.id)] = "";
      }
      const llmSentences = sentences.filter(
        (s) => !mediaKinds.has(String(s.kind)),
      );

      if (!expectedIds.length) {
        translation = mergeSectionTranslation(translation, secId, {});
        fs.writeFileSync(
          paths.translation,
          `${JSON.stringify(translation, null, 2)}\n`,
          "utf-8",
        );
        doneN += 1;
        pushEvent(stream, {
          type: "section_done",
          sectionId: secId,
          sentences: {},
          index: doneN,
          total,
        });
        continue;
      }

      if (!llmSentences.length) {
        translation = mergeSectionTranslation(translation, secId, mediaMap);
        fs.writeFileSync(
          paths.translation,
          `${JSON.stringify(translation, null, 2)}\n`,
          "utf-8",
        );
        doneN += 1;
        pushEvent(stream, {
          type: "section_done",
          sectionId: secId,
          sentences: mediaMap,
          index: doneN,
          total,
        });
        continue;
      }

      pushEvent(stream, {
        type: "section_start",
        sectionId: secId,
        index: doneN + 1,
        total,
        message: `翻译章节块 ${doneN + 1}/${total}`,
      });

      const mapping: Record<string, string> = { ...mediaMap };
      const batches = chunkSentences(llmSentences);
      for (let bi = 0; bi < batches.length; bi++) {
        if (aborted()) throw new TranslatePaused();
        const batch = batches[bi]!;
        if (!batch.length) continue;
        const part = await translateSentencesWithRetry(
          batches.length > 1 ? `${secId}#${bi + 1}` : secId,
          batch,
          { onPreview: null, shouldAbort: aborted },
        );
        Object.assign(mapping, part);
      }

      if (aborted()) throw new TranslatePaused();

      for (const sid of expectedIds) {
        if (!(sid in mapping)) mapping[sid] = "";
      }

      translation = mergeSectionTranslation(translation, secId, mapping);
      fs.writeFileSync(
        paths.translation,
        `${JSON.stringify(translation, null, 2)}\n`,
        "utf-8",
      );
      doneN += 1;
      pushEvent(stream, {
        type: "section_done",
        sectionId: secId,
        sentences: mapping,
        index: doneN,
        total,
      });
    }

    {
      const meta = library.readMeta(paths);
      meta.status = "completed";
      meta.error = null;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
    }
    pushEvent(stream, { type: "done", status: "completed" });
    stream.done = true;
    notify(stream);
  } catch (exc) {
    if (exc instanceof TranslatePaused) {
      if (fs.existsSync(paths.meta)) {
        const meta = library.readMeta(paths);
        const tr = loadTranslationFile(
          fs.existsSync(paths.translation)
            ? fs.readFileSync(paths.translation, "utf-8")
            : null,
        );
        if (fs.existsSync(paths.readingStructure)) {
          meta.status = tr.completedSections?.length
            ? "partial"
            : "ready_source";
        } else {
          meta.status = "ready_source";
        }
        meta.error = null;
        meta.updatedAt = library.utcNow();
        library.writeMeta(paths, meta);
        pushEvent(stream, {
          type: "paused",
          status: meta.status,
          translation: tr,
        });
      }
      stream.done = true;
      notify(stream);
      return;
    }

    const message = exc instanceof Error ? exc.message : String(exc);
    if (fs.existsSync(paths.meta)) {
      const meta = library.readMeta(paths);
      if (
        !fs.existsSync(paths.readingStructure) ||
        meta.status === "parsing"
      ) {
        meta.status = "parse_failed";
      } else {
        meta.status = "translate_failed";
      }
      meta.error = message;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
    }
    stream.error = message;
    stream.done = true;
    notify(stream);
  }
}

export function pauseTranslate(
  partition: string,
  slug: string,
): { ok: true; status: unknown; translation: Translation } {
  const key = paperKey(partition, slug);
  const paths = library.paperPaths(partition, slug);
  const stream = translateStreams.get(key);
  if (stream && !stream.done) {
    stream.cancelled = true;
    notify(stream);
  }

  const meta = fs.existsSync(paths.meta) ? library.readMeta(paths) : {};
  const tr = loadTranslationFile(
    fs.existsSync(paths.translation)
      ? fs.readFileSync(paths.translation, "utf-8")
      : null,
  );
  if (fs.existsSync(paths.meta)) {
    if (meta.status === "translating" || meta.status === "parsing") {
      if (fs.existsSync(paths.readingStructure)) {
        meta.status = tr.completedSections?.length
          ? "partial"
          : "ready_source";
      } else {
        meta.status = "ready_source";
      }
      meta.error = null;
      meta.updatedAt = library.utcNow();
      library.writeMeta(paths, meta);
    }
  }
  return { ok: true, status: meta.status, translation: tr };
}

export async function retryTranslate(
  partition: string,
  slug: string,
  opts?: { full?: boolean },
): Promise<void> {
  const full = opts?.full ?? false;
  const paths = library.paperPaths(partition, slug);
  const key = paperKey(partition, slug);
  const old = translateStreams.get(key);
  if (old && !old.done) {
    old.cancelled = true;
    notify(old);
    await waitStreamDone(old, 30_000);
    if (translateStreams.get(key) === old) translateStreams.delete(key);
  } else if (old) {
    translateStreams.delete(key);
  }

  const meta = library.readMeta(paths);
  const status = meta.status;
  if (status === "parse_failed") {
    if (fs.existsSync(paths.readingStructure)) {
      fs.unlinkSync(paths.readingStructure);
    }
    meta.status = "ready_source";
  } else if (full) {
    if (fs.existsSync(paths.translation)) fs.unlinkSync(paths.translation);
    meta.status = "ready_source";
  } else if (
    status === "translate_failed" ||
    status === "partial" ||
    status === "completed"
  ) {
    const tr = loadTranslationFile(
      fs.existsSync(paths.translation)
        ? fs.readFileSync(paths.translation, "utf-8")
        : null,
    );
    meta.status = tr.completedSections?.length ? "partial" : "ready_source";
  } else {
    meta.status = "ready_source";
  }
  meta.error = null;
  meta.updatedAt = library.utcNow();
  library.writeMeta(paths, meta);
}

export async function* streamSummary(
  partition: string,
  slug: string,
): AsyncGenerator<string, void, unknown> {
  yield* streamTranslate(partition, slug);
}

export async function retrySummary(
  partition: string,
  slug: string,
): Promise<void> {
  await retryTranslate(partition, slug, { full: false });
}
