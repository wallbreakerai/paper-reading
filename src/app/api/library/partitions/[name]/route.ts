import {
  deletePartition,
  ensureLibrarySeeded,
  renamePartition,
} from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ name: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    const body = (await req.json()) as { name?: string };
    const newName = String(body.name || "").trim();
    if (!newName) return jsonError(new Error("name 不能为空"));
    return jsonOk(renamePartition(name, newName));
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { name } = await ctx.params;
    deletePartition(name);
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
