import { createPartition, ensureLibrarySeeded, listPartitions } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

export async function GET() {
  return jsonOk({ partitions: listPartitions() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string };
    const name = String(body.name || "").trim();
    if (!name) return jsonError(new Error("name 不能为空"));
    return jsonOk(createPartition(name));
  } catch (e) {
    return jsonError(e);
  }
}
