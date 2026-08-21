import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers`,
    ),
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await req.text();
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    ),
  );
}
