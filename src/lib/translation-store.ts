import "server-only";

import type { OutlineItem, ReadingStructure, Translation } from "./types";
import { structureToOutline } from "./structure";

export function emptyTranslation(): Translation {
  return { version: 1, completedSections: [], sentences: {} };
}

export function loadTranslationFile(
  pathText: string | null | undefined,
): Translation {
  if (!pathText) return emptyTranslation();
  let data: unknown;
  try {
    data = JSON.parse(pathText);
  } catch {
    return emptyTranslation();
  }
  if (!data || typeof data !== "object") return emptyTranslation();
  const obj = data as Record<string, unknown>;
  // Legacy summary_v0 shape — treat as empty
  if ("blocks" in obj && !("sentences" in obj)) return emptyTranslation();
  const sentencesRaw = obj.sentences;
  const sentences: Record<string, string> = {};
  if (sentencesRaw && typeof sentencesRaw === "object") {
    for (const [k, v] of Object.entries(sentencesRaw as Record<string, unknown>)) {
      if (v != null) sentences[String(k)] = String(v);
    }
  }
  const completedRaw = obj.completedSections;
  const completedSections = Array.isArray(completedRaw)
    ? completedRaw.map((x) => String(x))
    : [];
  return {
    version: 1,
    completedSections,
    sentences,
  };
}

export function mergeSectionTranslation(
  translation: Translation,
  sectionId: string,
  sentenceMap: Record<string, string>,
): Translation {
  const sentences = { ...(translation.sentences || {}), ...sentenceMap };
  const completed = [...(translation.completedSections || [])];
  if (!completed.includes(sectionId)) completed.push(sectionId);
  return {
    version: 1,
    completedSections: completed,
    sentences,
  };
}

export function pendingSections(
  structure: ReadingStructure | Record<string, unknown>,
  translation: Translation,
): Array<Record<string, unknown>> {
  const done = new Set(translation.completedSections || []);
  const sections =
    ((structure as ReadingStructure).sections as unknown as Array<
      Record<string, unknown>
    >) || [];
  return sections.filter((s) => !done.has(String(s.id || "")));
}

export function paperPayload(opts: {
  slug: string;
  meta: Record<string, unknown>;
  structure: ReadingStructure | null;
  translation: Translation;
  hasArticle?: boolean;
}): {
  slug: string;
  meta: Record<string, unknown>;
  readingStructure: ReadingStructure;
  outline: OutlineItem[];
  translation: Translation;
  articleHtml: string;
  hasArticle: boolean;
  blocks: unknown[];
} {
  const structure =
    opts.structure ||
    ({
      version: 1,
      title: String(opts.meta.title || opts.slug),
      sections: [],
    } satisfies ReadingStructure);
  return {
    slug: opts.slug,
    meta: opts.meta,
    readingStructure: structure,
    outline: structureToOutline(structure),
    translation: opts.translation,
    articleHtml: "",
    hasArticle: Boolean(opts.hasArticle),
    blocks: [],
  };
}

export {
  emptyTranslation as empty_translation,
  loadTranslationFile as load_translation_file,
  mergeSectionTranslation as merge_section_translation,
  pendingSections as pending_sections,
  paperPayload as paper_payload,
};
