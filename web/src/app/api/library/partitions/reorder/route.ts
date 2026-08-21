import { forwardResponse, proxyToPython } from "@/lib/python";

export async function PUT(req: Request) {
  const body = await req.text();
  return forwardResponse(
    await proxyToPython("/library/partitions/reorder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}
