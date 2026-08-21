"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Folder, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import type { Partition } from "@/lib/types";

function SortablePartition({
  partition,
  onOpen,
  onRename,
  onDelete,
}: {
  partition: Partition;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: partition.name });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card-item${isDragging ? " dragging" : ""}`}
    >
      <div className="card-item-top">
        <button
          type="button"
          className="drag-handle"
          aria-label={`拖动排序 ${partition.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={`重命名 ${partition.name}`}
            onClick={onRename}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={`删除 ${partition.name}`}
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <button type="button" className="card-item-body" onClick={onOpen}>
        <div className="card-item-title-row">
          <Folder size={20} aria-hidden className="card-item-icon" />
          <h3>{partition.name}</h3>
        </div>
        <div className="card-meta">
          <span className="status accent">{partition.paperCount} 篇</span>
        </div>
      </button>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const load = useCallback(async () => {
    const res = await fetch("/api/library/partitions");
    const data = await res.json();
    if (!res.ok) {
      setError(data.detail || "加载失败");
      return;
    }
    setPartitions(data.partitions || []);
    setError("");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createPartition() {
    const name = newName.trim();
    if (!name) return;
    const res = await fetch("/api/library/partitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(typeof data.detail === "string" ? data.detail : "创建失败");
      return;
    }
    setNewName("");
    setCreating(false);
    await load();
  }

  async function renamePartition(old: string) {
    const next = window.prompt("新分区名", old);
    if (!next || next.trim() === old) return;
    const res = await fetch(`/api/library/partitions/${encodeURIComponent(old)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(typeof data.detail === "string" ? data.detail : "重命名失败");
      return;
    }
    await load();
  }

  async function deletePartition(name: string) {
    if (!window.confirm(`删除分区「${name}」及其全部论文？此操作不可恢复。`)) {
      return;
    }
    const res = await fetch(`/api/library/partitions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
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
    const oldIndex = partitions.findIndex((p) => p.name === active.id);
    const newIndex = partitions.findIndex((p) => p.name === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(partitions, oldIndex, newIndex);
    setPartitions(next);
    const res = await fetch("/api/library/partitions/reorder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: next.map((p) => p.name) }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(typeof data.detail === "string" ? data.detail : "排序保存失败");
      await load();
      return;
    }
    const data = await res.json();
    if (data.partitions) setPartitions(data.partitions);
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">档案库</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          新建分区
        </button>
      </div>
      <p className="page-sub">
        按主题归档论文；拖动手柄可调整文件夹顺序。
      </p>
      {error ? <p className="error-text">{error}</p> : null}

      {partitions.length === 0 ? (
        <div className="empty">还没有文件夹，点击右上角新建。</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => void onDragEnd(e)}
        >
          <SortableContext
            items={partitions.map((p) => p.name)}
            strategy={rectSortingStrategy}
          >
            <div className="card-grid">
              {partitions.map((p) => (
                <SortablePartition
                  key={p.name}
                  partition={p}
                  onOpen={() =>
                    router.push(`/p/${encodeURIComponent(p.name)}`)
                  }
                  onRename={() => void renamePartition(p.name)}
                  onDelete={() => void deletePartition(p.name)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {creating ? (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>新建分区</h2>
            <p className="modal-sub">例如 AIGC、AI-Infra。</p>
            <div className="field">
              <label htmlFor="partition-name">名称</label>
              <input
                id="partition-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="AIGC"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createPartition();
                }}
              />
            </div>
            <div className="form-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void createPartition()}
              >
                创建
              </button>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setCreating(false)}
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
