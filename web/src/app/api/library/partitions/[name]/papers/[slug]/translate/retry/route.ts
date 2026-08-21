import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  const url = new URL(req.url);
  const full = url.searchParams.get("full") === "1";
  const qs = full ? "?full=true" : "";
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/translate/retry${qs}`,
      { method: "POST" },
    ),
  );
}
