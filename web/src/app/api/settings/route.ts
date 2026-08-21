import { forwardResponse, proxyToPython } from "@/lib/python";

export async function GET() {
  return forwardResponse(await proxyToPython("/settings"));
}

export async function PUT(req: Request) {
  const body = await req.text();
  return forwardResponse(
    await proxyToPython("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}
