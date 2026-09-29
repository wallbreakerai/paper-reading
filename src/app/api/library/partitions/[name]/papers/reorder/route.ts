import { ensureLibrarySeeded, reorderPapers } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    const body = (await req.json()) as { slugs?: string[] };
    if (!Array.isArray(body.slugs) || !body.slugs.length) {
      return jsonError(new Error("顺序列表不能为空"));
    }
    return jsonOk({ papers: reorderPapers(name, body.slugs) });
  } catch (e) {
    return jsonError(e);
  }
}
