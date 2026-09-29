import { getJob } from "@/lib/jobs";
import { ensureLibrarySeeded } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

type Ctx = { params: Promise<{ jobId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { jobId } = await ctx.params;
    const data = getJob(jobId);
    if (!data) return jsonError(new Error("job 不存在"), 404);
    return jsonOk(data);
  } catch (e) {
    return jsonError(e);
  }
}
