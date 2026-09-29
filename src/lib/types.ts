export type PaperStatus =
  | "pending"
  | "downloading"
  | "ready_source"
  | "parsing"
  | "parse_failed"
  | "translating"
  | "partial"
  | "completed"
  | "failed"
  | "interrupted"
  | "translate_failed"
  /** @deprecated */
  | "summarizing"
  /** @deprecated */
  | "summarize_failed";

export type Partition = {
  name: string;
  paperCount: number;
};

export type PaperListItem = {
  slug: string;
  title: string;
  arxivId?: string;
  sourceUrl?: string;
  status?: PaperStatus;
  error?: string | null;
  jobId?: string;
  updatedAt?: string;
  createdAt?: string;
};

export type SentenceUnit = {
  id: string;
  kind: string;
  text: string;
  html: string;
  level?: number;
  embeds?: { id: string; html: string }[];
  /** @deprecated v6 uses explicit spacer units between paragraphs */
  paraStart?: boolean;
};

export type SectionBlock = {
  id: string;
  level: number;
  anchor?: string | null;
  sentences: SentenceUnit[];
};

export type ReadingStructure = {
  version: number;
  title: string;
  sections: SectionBlock[];
};

export type OutlineItem = {
  id: string;
  sectionId: string;
  type: string;
  level: number;
  text: string;
  anchor?: string | null;
};

export type Translation = {
  version?: number;
  completedSections?: string[];
  sentences?: Record<string, string>;
  /** @deprecated summary_v0 */
  blocks?: Record<string, { zh?: string; kind?: string }>;
};

export type JobStatus = {
  id: string;
  partition: string;
  slug: string;
  phase: string;
  status: string;
  progress: number;
  message: string;
  error?: string | null;
};

export function isDownloadLocked(status?: string | null): boolean {
  return status === "pending" || status === "downloading";
}

export function canOpenReader(status?: string | null): boolean {
  return (
    status === "ready_source" ||
    status === "parsing" ||
    status === "parse_failed" ||
    status === "translating" ||
    status === "partial" ||
    status === "completed" ||
    status === "translate_failed" ||
    status === "summarizing" ||
    status === "summarize_failed"
  );
}

/** Auto-start parse/translate on open (not for failed states). */
export function shouldAutoStartTranslate(status?: string | null): boolean {
  return (
    status === "ready_source" ||
    status === "parsing" ||
    status === "translating" ||
    status === "partial"
  );
}
