const DEFAULT_API = "http://127.0.0.1:8010";

export function apiBase(): string {
  return process.env.PAPER_READING_API_URL?.replace(/\/$/, "") || DEFAULT_API;
}

export async function proxyToPython(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${apiBase()}${path}`;
  return fetch(url, {
    ...init,
    cache: "no-store",
  });
}

export async function forwardResponse(res: Response): Promise<Response> {
  const contentType = res.headers.get("content-type") || "application/json";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    headers: {
      "content-type": contentType,
    },
  });
}
