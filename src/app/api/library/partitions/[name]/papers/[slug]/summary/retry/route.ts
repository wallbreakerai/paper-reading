import { retryTranslate } from "@/lib/jobs";
import { ensureLibrarySeeded } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    await retryTranslate(name, slug, { full: false });
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
