import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await req.text();
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/reorder`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    ),
  );
}
