import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await req.text();
  return forwardResponse(
    await proxyToPython(`/library/partitions/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  return forwardResponse(
    await proxyToPython(`/library/partitions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  );
}
