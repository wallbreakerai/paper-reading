import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string }> };

function qaPath(name: string, slug: string) {
  return `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/qa/chat`;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  return forwardResponse(await proxyToPython(qaPath(name, slug)));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  return forwardResponse(
    await proxyToPython(qaPath(name, slug), { method: "DELETE" }),
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  const body = await req.text();
  const res = await proxyToPython(qaPath(name, slug), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
