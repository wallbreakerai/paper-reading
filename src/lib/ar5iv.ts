import "server-only";

export type ProgressCb = (progress: number, message: string) => void;

export async function fetchAr5ivHtml(
  url: string,
  onProgress?: ProgressCb | null,
): Promise<string> {
  onProgress?.(0.05, "连接 ar5iv…");
  const res = await fetch(url, {
    headers: { "User-Agent": "paper-reading/0.1" },
    redirect: "follow",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`ar5iv HTTP ${res.status}`);
  }
  const totalHeader = res.headers.get("content-length");
  const totalN =
    totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;

  if (!res.body) {
    const text = await res.text();
    onProgress?.(1.0, "下载完成");
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      got += value.byteLength;
      if (onProgress) {
        if (totalN) {
          onProgress(Math.min(0.95, got / totalN), `下载中 ${Math.floor(got / 1024)} KB`);
        } else {
          onProgress(
            Math.min(0.9, 0.1 + got / 5_000_000),
            `下载中 ${Math.floor(got / 1024)} KB`,
          );
        }
      }
    }
  }
  const merged = new Uint8Array(got);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  onProgress?.(1.0, "下载完成");
  return text;
}

export { fetchAr5ivHtml as fetch_ar5iv_html };
