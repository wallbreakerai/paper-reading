import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeExportFileBase } from "@/lib/export-bilingual-html";

const EXPORT_TMP_BASENAME = "paper-reading-export";

function exportTempRoot(): string {
  const root = path.join(os.tmpdir(), EXPORT_TMP_BASENAME);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write bilingual HTML under system temp: `{slug}_{yyyyMMdd-HHmmss}/bilingual.html`. */
export function writeBilingualHtmlFile(input: {
  paper: string;
  html: string;
}): { dir: string; absDir: string; fileName: string; absPath: string } {
  const body = input.html.trim();
  if (!body) throw new Error("没有可导出的内容");

  const base = `${sanitizeExportFileBase(input.paper)}_${stamp()}`;
  const absDir = path.join(exportTempRoot(), base);
  fs.mkdirSync(absDir, { recursive: true });
  const fileName = "bilingual.html";
  const absPath = path.join(absDir, fileName);
  fs.writeFileSync(absPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return { dir: absDir, absDir, fileName, absPath };
}
