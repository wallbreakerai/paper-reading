import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/translate/retry`,
      { method: "POST" },
    ),
  );
}
