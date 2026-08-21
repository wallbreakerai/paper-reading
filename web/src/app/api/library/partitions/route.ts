import { forwardResponse, proxyToPython } from "@/lib/python";

export async function GET() {
  return forwardResponse(await proxyToPython("/library/partitions"));
}

export async function POST(req: Request) {
  const body = await req.text();
  return forwardResponse(
    await proxyToPython("/library/partitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}
