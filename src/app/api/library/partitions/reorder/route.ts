import { ensureLibrarySeeded, reorderPartitions } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { names?: string[] };
    if (!Array.isArray(body.names) || !body.names.length) {
      return jsonError(new Error("顺序列表不能为空"));
    }
    return jsonOk({ partitions: reorderPartitions(body.names) });
  } catch (e) {
    return jsonError(e);
  }
}
