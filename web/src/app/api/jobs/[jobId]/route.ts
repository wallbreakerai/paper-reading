import { forwardResponse, proxyToPython } from "@/lib/python";

type Ctx = { params: Promise<{ jobId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { jobId } = await ctx.params;
  return forwardResponse(await proxyToPython(`/jobs/${encodeURIComponent(jobId)}`));
}
