import {
  QaAborted,
  clearQaChat,
  loadQaChat,
  streamQaReply,
} from "@/lib/qa-chat";
import { ensureLibrarySeeded } from "@/lib/library";
import { ensureDotenvLoaded } from "@/lib/settings";
import { jsonError, jsonOk, sseHeaders } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

export const maxDuration = 300;

type Ctx = { params: Promise<{ name: string; slug: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    return jsonOk(loadQaChat(name, slug));
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { name, slug } = await ctx.params;
    return jsonOk(clearQaChat(name, slug));
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const { name, slug } = await ctx.params;
  let content = "";
  try {
    const body = (await req.json()) as { content?: string };
    content = String(body.content || "");
  } catch {
    return jsonError(new Error("问题不能为空"));
  }

  const aborted = { v: false };
  req.signal.addEventListener("abort", () => {
    aborted.v = true;
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(ev)}\n\n`),
        );
      };
      try {
        for await (const ev of streamQaReply(name, slug, content, {
          shouldAbort: () => aborted.v,
        })) {
          send(ev);
        }
      } catch (e) {
        if (e instanceof QaAborted) {
          send({ type: "aborted" });
        } else {
          send({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
