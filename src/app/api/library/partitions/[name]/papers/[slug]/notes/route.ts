import { ensureLibrarySeeded, readNotes, writeNotes } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    return jsonOk({ content: readNotes(name, slug) });
  } catch (e) {
    return jsonError(e);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    const body = (await req.json()) as { content?: string };
    return jsonOk({
      content: writeNotes(name, slug, body.content ?? ""),
    });
  } catch (e) {
    return jsonError(e);
  }
}
