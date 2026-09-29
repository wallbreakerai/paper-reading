"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ReaderShell } from "@/components/ReaderShell";
import {
  shouldAutoStartTranslate,
  type OutlineItem,
  type ReadingStructure,
  type Translation,
} from "@/lib/types";

type AuthorDetail = { name: string; affiliation?: string };

export default function ReaderPage() {
  const params = useParams<{ partition: string; slug: string }>();
  const partition = decodeURIComponent(params.partition);
  const slug = decodeURIComponent(params.slug);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState<string[]>([]);
  const [authorsDetail, setAuthorsDetail] = useState<AuthorDetail[]>([]);
  const [structure, setStructure] = useState<ReadingStructure | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [translation, setTranslation] = useState<Translation>({
    sentences: {},
    completedSections: [],
  });
  const [status, setStatus] = useState<string>("");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [arxivId, setArxivId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}`,
      );
      const data = await res.json();
      if (cancelled) return;
      if (!res.ok) {
        setError(typeof data.detail === "string" ? data.detail : "加载失败");
        return;
      }
      const st = data.meta?.status as string;
      if (st === "pending" || st === "downloading") {
        setError("原文尚未就绪，请返回列表等待下载完成");
        return;
      }
      const detail = Array.isArray(data.meta?.authorsDetail)
        ? (data.meta.authorsDetail as AuthorDetail[])
        : [];
      setTitle(data.meta?.title || slug);
      setAuthorsDetail(
        detail
          .map((d) => ({
            name: String(d.name || ""),
            affiliation: String(d.affiliation || ""),
          }))
          .filter((d) => d.name),
      );
      setAuthors(
        detail.length > 0
          ? detail.map((d) => String(d.name || "")).filter(Boolean)
          : Array.isArray(data.meta?.authors)
            ? data.meta.authors.map(String).filter(Boolean)
            : [],
      );
      setOutline(data.outline || []);
      setStatus(st);
      setSourceUrl(
        typeof data.meta?.sourceUrl === "string" ? data.meta.sourceUrl : null,
      );
      setArxivId(
        typeof data.meta?.arxivId === "string" ? data.meta.arxivId : null,
      );
      setStructure(data.readingStructure || null);
      setTranslation(
        data.translation || { sentences: {}, completedSections: [] },
      );
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [partition, slug]);

  if (error) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="page">
        <p className="muted">加载中…</p>
      </div>
    );
  }

  return (
    <ReaderShell
      partition={partition}
      slug={slug}
      title={title}
      authors={authors}
      authorsDetail={authorsDetail}
      initialStructure={structure}
      initialOutline={outline}
      translation={translation}
      autoStart={shouldAutoStartTranslate(status)}
      initialStatus={status}
      sourceUrl={sourceUrl}
      arxivId={arxivId}
    />
  );
}
