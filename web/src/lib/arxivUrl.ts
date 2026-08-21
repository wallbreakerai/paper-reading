const ARXIV_ID_RE =
  /^(?:(?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i;

const ARXIV_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
]);

const AR5IV_HOSTS = new Set(["ar5iv.labs.arxiv.org", "ar5iv.org"]);

export type ParsedPaperUrl = {
  arxivId: string;
  ar5ivHtml: string;
};

function stripVersion(id: string): string {
  return id.replace(/v\d+$/i, "");
}

/** Parse abs / pdf / ar5iv html links into a canonical arXiv id. */
export function parsePaperUrl(raw: string): ParsedPaperUrl {
  const text = raw.trim();
  if (!text) throw new Error("请输入链接");
  const withProto = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    throw new Error("链接格式无效");
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname || "";
  let rawId = "";

  if (ARXIV_HOSTS.has(host)) {
    const m = path.match(/\/(abs|pdf|html|ps|e-print|ftp)\/([^/?#]+)/i);
    if (!m) throw new Error("无法从 arxiv 链接解析论文 id");
    rawId = m[2];
    if (rawId.toLowerCase().endsWith(".pdf")) rawId = rawId.slice(0, -4);
  } else if (AR5IV_HOSTS.has(host)) {
    const m = path.match(/\/html\/([^/?#]+)/i);
    if (!m) throw new Error("无法从 ar5iv 链接解析论文 id");
    rawId = m[1];
  } else {
    throw new Error("暂未支持：目前仅支持 arxiv.org 或 ar5iv 链接");
  }

  rawId = rawId.replace(/^\/+|\/+$/g, "");
  if (!ARXIV_ID_RE.test(rawId)) {
    throw new Error(`无效的 arXiv id：${rawId}`);
  }

  const arxivId = stripVersion(rawId);
  return {
    arxivId,
    ar5ivHtml: `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
  };
}

export function validatePaperUrl(
  raw: string,
): { ok: true; arxivId: string } | { ok: false; message: string } {
  try {
    const parsed = parsePaperUrl(raw);
    return { ok: true, arxivId: parsed.arxivId };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "链接格式无效",
    };
  }
}
