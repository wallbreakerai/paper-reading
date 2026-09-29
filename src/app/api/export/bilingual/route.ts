import { NextResponse } from "next/server";

import { writeBilingualHtmlFile } from "@/lib/bilingual-export-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { paper?: string; html?: string };
    const result = writeBilingualHtmlFile({
      paper: body.paper?.trim() || "paper",
      html: body.html || "",
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[export/bilingual]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
