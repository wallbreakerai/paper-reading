import {
  deletePaper,
  ensureLibrarySeeded,
  loadPaperAsync,
} from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    return jsonOk(await loadPaperAsync(name, slug));
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    deletePaper(name, slug);
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
