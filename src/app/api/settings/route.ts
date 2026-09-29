import { ensureDotenvLoaded, settingsPublic, updateSettings } from "@/lib/settings";
import { ensureLibrarySeeded } from "@/lib/library";
import { jsonError, jsonOk } from "@/lib/http";

ensureDotenvLoaded();
ensureLibrarySeeded();

export async function GET() {
  return jsonOk(settingsPublic());
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { libraryDir?: string | null };
    return jsonOk(await updateSettings({ libraryDir: body.libraryDir }));
  } catch (e) {
    return jsonError(e);
  }
}
