import { ensureLibrarySeeded, listPapers } from "@/lib/library";
import { enqueueImport } from "@/lib/jobs";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    return jsonOk({ papers: listPapers(name) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    const body = (await req.json()) as { url?: string };
    const url = String(body.url || "").trim();
    if (!url) return jsonError(new Error("url 不能为空"));
    return jsonOk(enqueueImport(name, url));
  } catch (e) {
    return jsonError(e);
  }
}
