import { streamTranslate } from "@/lib/jobs";
import { ensureLibrarySeeded } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { sseResponse } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

export const maxDuration = 300;

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  return sseResponse(streamTranslate(name, slug));
}
