"use client";

import { useEffect, useState } from "react";
import { useTheme, type ThemePreference } from "@/components/ThemeProvider";

type Settings = {
  libraryDir: string;
  llm: {
    apiBase: string;
    model: string;
    apiKeyMasked: string;
    configured: boolean;
    source?: string;
  };
};

export default function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [libraryDir, setLibraryDir] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) {
        setError("加载设置失败");
        return;
      }
      setSettings(data);
      setLibraryDir(data.libraryDir || "");
    })();
  }, []);

  async function save() {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        libraryDir,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(typeof data.detail === "string" ? data.detail : "保存失败");
      return;
    }
    setSettings(data);
    setMessage("已保存");
    setError("");
  }

  const themes: { id: ThemePreference; label: string }[] = [
    { id: "system", label: "跟随系统" },
    { id: "light", label: "白天" },
    { id: "dark", label: "黑夜" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          保存
        </button>
      </div>
      <p className="page-sub">
        主题保存在浏览器；库路径写入 data/settings.json；LLM 从项目根目录 .env 读取。
      </p>

      <div className="settings-stack">
        <section className="settings-section">
          <h2>主题</h2>
          <p className="muted">默认跟随系统外观。</p>
          <div className="theme-row">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                className={preference === t.id ? "active" : undefined}
                onClick={() => setPreference(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h2>LLM（.env）</h2>
          {settings?.llm.configured ? (
            <p className="muted">
              已从环境变量加载（key: {settings.llm.apiKeyMasked || "无"}）
            </p>
          ) : (
            <p className="error-text">
              未配置 LLM。请在项目根目录 .env 设置 API_KEY、BASE_URL、MODEL 后重启。
            </p>
          )}
          <div className="field">
            <label>BASE_URL</label>
            <input value={settings?.llm.apiBase || ""} readOnly />
          </div>
          <div className="field">
            <label>MODEL</label>
            <input value={settings?.llm.model || ""} readOnly />
          </div>
          <div className="field">
            <label>API_KEY</label>
            <input value={settings?.llm.apiKeyMasked || "（未设置）"} readOnly />
          </div>
        </section>

        <section className="settings-section">
          <h2>库目录</h2>
          <div className="field">
            <label htmlFor="libraryDir">库目录</label>
            <input
              id="libraryDir"
              value={libraryDir}
              onChange={(e) => setLibraryDir(e.target.value)}
            />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          {message ? <p className="muted">{message}</p> : null}
        </section>
      </div>
    </div>
  );
}
