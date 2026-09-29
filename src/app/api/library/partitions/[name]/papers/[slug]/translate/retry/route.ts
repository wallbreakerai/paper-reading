import { retryTranslate } from "@/lib/jobs";
import { ensureLibrarySeeded } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    const url = new URL(req.url);
    const full =
      url.searchParams.get("full") === "1" ||
      url.searchParams.get("full") === "true";
    await retryTranslate(name, slug, { full });
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
