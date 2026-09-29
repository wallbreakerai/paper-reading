import fs from "node:fs";

import { ensureLibrarySeeded, resolvePaperAsset } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { guessMime, jsonError } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = {
  params: Promise<{ name: string; slug: string; asset_path: string[] }>;
};

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { name, slug, asset_path } = await ctx.params;
    const rel = (asset_path || []).join("/");
    const filePath = resolvePaperAsset(name, slug, rel);
    const buf = fs.readFileSync(filePath);
    return new Response(buf, {
      headers: {
        "content-type": guessMime(filePath),
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return jsonError(e);
  }
}
