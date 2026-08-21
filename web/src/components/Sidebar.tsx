"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen,
  PanelLeft,
  PanelLeftClose,
  Settings2,
} from "lucide-react";

const STORAGE_KEY = "paper-reading-sidebar-collapsed";

function isReaderPath(pathname: string): boolean {
  return /^\/p\/[^/]+\/r\//.test(pathname);
}

export function Sidebar() {
  const pathname = usePathname();
  const homeActive = pathname === "/";
  const settingsActive = pathname.startsWith("/settings");
  const onReader = isReaderPath(pathname);
  const [prefCollapsed, setPrefCollapsed] = useState(false);
  /** While reading, start collapsed; user may expand for this visit only. */
  const [readerExpanded, setReaderExpanded] = useState(false);

  useEffect(() => {
    try {
      setPrefCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setReaderExpanded(false);
  }, [pathname]);

  const collapsed = onReader ? !readerExpanded : prefCollapsed;

  function toggle() {
    if (onReader) {
      setReaderExpanded((prev) => !prev);
      return;
    }
    setPrefCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-brand-row">
        <Link href="/" className="sidebar-brand" title="Paper Reading">
          <span className="sidebar-brand-mark">PR</span>
          {!collapsed ? <h1>Paper Reading</h1> : null}
        </Link>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={toggle}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
      <nav className="sidebar-nav">
        <Link
          href="/"
          className={`nav-item${homeActive ? " active" : ""}`}
          title="档案库"
        >
          <BookOpen aria-hidden />
          {!collapsed ? <span>档案库</span> : null}
        </Link>
        <Link
          href="/settings"
          className={`nav-item${settingsActive ? " active" : ""}`}
          title="设置"
        >
          <Settings2 aria-hidden />
          {!collapsed ? <span>设置</span> : null}
        </Link>
      </nav>
      {!collapsed ? (
        <div className="sidebar-footer">英译中 · 本地工具</div>
      ) : null}
    </aside>
  );
}
