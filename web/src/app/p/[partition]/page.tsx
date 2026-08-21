"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileText, GripVertical, Plus, Trash2 } from "lucide-react";
import { validatePaperUrl } from "@/lib/arxivUrl";
import {
  canOpenReader,
  isDownloadLocked,
  type JobStatus,
  type PaperListItem,
} from "@/lib/types";

function formatApiDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "msg" in item) {
        return String((item as { msg: unknown }).msg);
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    });
    const text = parts.filter(Boolean).join("\n");
    if (text) return text;
  }
  if (detail != null) {
    try {
      return JSON.stringify(detail);
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

function SortablePaper({
  paper,
  job,
  onOpen,
  onDelete,
}: {
  paper: PaperListItem;
  job?: JobStatus;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: paper.slug });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const locked = isDownloadLocked(paper.status);
  const openable = canOpenReader(paper.status);
  const progress = job?.progress ?? (locked ? 0.05 : 0);
  const isError =
    paper.status === "failed" ||
    paper.status === "interrupted" ||
    paper.status === "summarize_failed" ||
    paper.status === "translate_failed" ||
    paper.status === "parse_failed";
  const failReason =
    [paper.error, job?.error, job?.message]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join(" · ") || paper.status || "failed";
  const bodyText = isError ? failReason : paper.title;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card-item paper-card${isDragging ? " dragging" : ""}${isError ? " is-error" : ""}`}
    >
      <div className="card-item-top">
        <div className="card-item-top-left">
          <button
            type="button"
            className="drag-handle"
            aria-label={`拖动排序 ${paper.title}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical size={16} />
          </button>
          <FileText size={16} aria-hidden className="card-item-icon" />
        </div>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={`删除 ${paper.title}`}
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="card-item-body"
        disabled={!openable}
        title={isError ? `${paper.title}\n${failReason}` : paper.title}
        onClick={onOpen}
      >
        <h3 className={`paper-card-title${isError ? " is-error-text" : ""}`}>
          {bodyText}
        </h3>
        {locked ? (
          <>
            <div className="progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="card-meta truncate-1">
              {job?.message ||
                (paper.status === "pending" ? "等待中…" : "下载中…")}
            </div>
          </>
        ) : null}
      </button>
    </div>
  );
}

export default function PartitionPapersPage() {
  const params = useParams<{ partition: string }>();
  const partition = decodeURIComponent(params.partition);
  const router = useRouter();
  const [papers, setPapers] = useState<PaperListItem[]>([]);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [jobs, setJobs] = useState<Record<string, JobStatus>>({});
  const mounted = useRef(true);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/library/partitions/${encodeURIComponent(partition)}/papers`,
    );
    const data = await res.json();
    if (!res.ok) {
      setError(typeof data.detail === "string" ? data.detail : "加载失败");
      return;
    }
    setPapers(data.papers || []);
    setError("");
  }, [partition]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // poll active jobs
  useEffect(() => {
    const active = papers.filter(
      (p) => p.jobId && isDownloadLocked(p.status),
    );
    if (active.length === 0) return;
    const timer = setInterval(async () => {
      for (const p of active) {
        if (!p.jobId) continue;
        const res = await fetch(`/api/jobs/${encodeURIComponent(p.jobId)}`);
        if (!res.ok) continue;
        const job = (await res.json()) as JobStatus;
        if (!mounted.current) return;
        setJobs((prev) => ({ ...prev, [p.jobId!]: job }));
        if (job.status === "completed" && job.phase === "ready") {
          await load();
          if (mounted.current) {
            router.push(
              `/p/${encodeURIComponent(partition)}/r/${encodeURIComponent(job.slug)}`,
            );
          }
        } else if (job.status === "failed") {
          await load();
        }
      }
    }, 800);
    return () => clearInterval(timer);
  }, [papers, partition, router, load]);

  async function addPaper() {
    const check = validatePaperUrl(url);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    const res = await fetch(
      `/api/library/partitions/${encodeURIComponent(partition)}/papers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      setError(formatApiDetail(data.detail, "添加失败"));
      return;
    }
    setModalOpen(false);
    setUrl("");
    setError("");
    await load();
  }

  async function removePaper(slug: string, title: string) {
    if (!window.confirm(`删除论文「${title}」？`)) return;
    const res = await fetch(
      `/api/library/partitions/${encodeURIComponent(partition)}/papers/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const data = await res.json();
      setError(typeof data.detail === "string" ? data.detail : "删除失败");
      return;
    }
    await load();
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = papers.findIndex((p) => p.slug === active.id);
    const newIndex = papers.findIndex((p) => p.slug === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(papers, oldIndex, newIndex);
    setPapers(next);
    const res = await fetch(
      `/api/library/partitions/${encodeURIComponent(partition)}/papers/reorder`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs: next.map((p) => p.slug) }),
      },
    );
    if (!res.ok) {
      const data = await res.json();
      setError(formatApiDetail(data.detail, "排序保存失败"));
      await load();
      return;
    }
    const data = await res.json();
    if (data.papers) setPapers(data.papers);
  }

  return (
    <div className="page">
      <p className="crumb">
        <Link href="/">档案库</Link>
        <span> / </span>
        <span>{partition}</span>
      </p>
      <div className="page-header">
        <h1 className="page-title">{partition}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
          <Plus size={16} />
          添加文章
        </button>
      </div>
      <p className="page-sub">
        粘贴 arXiv / ar5iv 链接导入；拖动手柄可调整文章顺序。
      </p>
      {!modalOpen && error ? <p className="error-box">{error}</p> : null}

      {papers.length === 0 ? (
        <div className="empty">这个分区还没有论文。</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => void onDragEnd(e)}
        >
          <SortableContext
            items={papers.map((p) => p.slug)}
            strategy={rectSortingStrategy}
          >
            <div className="card-grid">
              {papers.map((p) => (
                <SortablePaper
                  key={p.slug}
                  paper={p}
                  job={p.jobId ? jobs[p.jobId] : undefined}
                  onOpen={() => {
                    if (!canOpenReader(p.status)) return;
                    router.push(
                      `/p/${encodeURIComponent(partition)}/r/${encodeURIComponent(p.slug)}`,
                    );
                  }}
                  onDelete={() => void removePaper(p.slug, p.title)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {modalOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            setModalOpen(false);
            setError("");
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>添加文章</h2>
            <p className="modal-sub">
              支持 abs / pdf / ar5iv html，例如
              arxiv.org/abs/…、arxiv.org/pdf/…、ar5iv.labs.arxiv.org/html/…
            </p>
            <div className="field">
              <label htmlFor="paper-url">论文链接</label>
              <input
                id="paper-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://arxiv.org/pdf/2205.14135"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addPaper();
                }}
              />
            </div>
            {error ? <pre className="error-box">{error}</pre> : null}
            <div className="form-row">
              <button type="button" className="btn btn-primary" onClick={() => void addPaper()}>
                开始导入
              </button>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => {
                  setModalOpen(false);
                  setError("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
