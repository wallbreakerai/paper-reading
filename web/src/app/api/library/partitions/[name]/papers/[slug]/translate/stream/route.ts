import { apiBase } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  const url = `${apiBase()}/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/translate/stream`;
  const res = await fetch(url, { cache: "no-store" });
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
