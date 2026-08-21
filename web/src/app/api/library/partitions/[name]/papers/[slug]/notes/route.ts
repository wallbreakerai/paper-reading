import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/notes`,
    ),
  );
}

export async function PUT(req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  const body = await req.text();
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/notes`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    ),
  );
}
