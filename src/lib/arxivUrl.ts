const ARXIV_ID_RE =
  /((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

const ARXIV_ID_FULL =
  /^(?:(?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i;

const ARXIV_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
]);

const AR5IV_HOSTS = new Set(["ar5iv.labs.arxiv.org", "ar5iv.org"]);

export class UnsupportedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedUrlError";
  }
}

export type ParsedPaperUrl = {
  arxivId: string;
  ar5ivHtml: string;
};

export type ParsedArxivUrl = {
  arxivId: string;
  arxivIdRaw: string;
  canonicalAbs: string;
  ar5ivHtml: string;
};

function stripVersion(id: string): string {
  return id.replace(/v\d+$/i, "");
}

/** Parse abs / pdf / ar5iv html links into a canonical arXiv id. */
export function parseArxivUrl(url: string): ParsedArxivUrl {
  let text = (url || "").trim();
  if (!text) throw new UnsupportedUrlError("链接不能为空");

  if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new UnsupportedUrlError("链接格式无效");
  }

  const host = (parsed.hostname || "").toLowerCase();
  const pathName = parsed.pathname || "";
  let rawId = "";

  if (ARXIV_HOSTS.has(host)) {
    const m = pathName.match(/\/(abs|pdf|html|ps|e-print|ftp)\/([^/?#]+)/i);
    if (!m) {
      const m2 = pathName.match(ARXIV_ID_RE);
      if (!m2) {
        throw new UnsupportedUrlError("无法从 arxiv 链接解析论文 id");
      }
      rawId = m2[1] || m2[0]!;
    } else {
      rawId = m[2]!;
      if (rawId.toLowerCase().endsWith(".pdf")) rawId = rawId.slice(0, -4);
    }
  } else if (AR5IV_HOSTS.has(host)) {
    const m = pathName.match(/\/html\/([^/?#]+)/i);
    if (!m) throw new UnsupportedUrlError("无法从 ar5iv 链接解析论文 id");
    rawId = m[1]!;
  } else {
    throw new UnsupportedUrlError(
      "暂未支持：目前仅支持 arxiv.org 或 ar5iv 链接",
    );
  }

  rawId = rawId.replace(/^\/+|\/+$/g, "");
  if (!ARXIV_ID_FULL.test(rawId)) {
    if (!ARXIV_ID_RE.test(rawId)) {
      throw new UnsupportedUrlError(`无效的 arXiv id：${rawId}`);
    }
  }

  const baseId = stripVersion(rawId);
  return {
    arxivId: baseId,
    arxivIdRaw: rawId,
    canonicalAbs: `https://arxiv.org/abs/${baseId}`,
    ar5ivHtml: `https://ar5iv.labs.arxiv.org/html/${baseId}`,
  };
}

export function parsePaperUrl(raw: string): ParsedPaperUrl {
  try {
    const p = parseArxivUrl(raw);
    return { arxivId: p.arxivId, ar5ivHtml: p.ar5ivHtml };
  } catch (e) {
    if (e instanceof UnsupportedUrlError) {
      // Match prior client messages where possible
      const msg = e.message === "链接不能为空" ? "请输入链接" : e.message;
      throw new Error(msg);
    }
    throw e;
  }
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
