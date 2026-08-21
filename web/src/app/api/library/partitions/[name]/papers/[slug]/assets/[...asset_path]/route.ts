import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ name: string; slug: string; asset_path: string[] }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { name, slug, asset_path } = await ctx.params;
  const rel = (asset_path || []).join("/");
  return forwardResponse(
    await proxyToPython(
      `/library/partitions/${encodeURIComponent(name)}/papers/${encodeURIComponent(slug)}/assets/${rel
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    ),
  );
}
