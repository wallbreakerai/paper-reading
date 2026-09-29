import "server-only";

import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const ROOT = path.resolve(process.cwd());
export const DATA_DIR = path.join(ROOT, "data");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
export const ENV_PATH = path.join(ROOT, ".env");
export const DEFAULT_LIBRARY_DIR = path.join(DATA_DIR, "library");

let dotenvLoaded = false;
const lock = createMutex();

function createMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      const run = chain.then(() => fn(), () => fn());
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

function loadDotenv(envPath: string = ENV_PATH): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) return;
  let text: string;
  try {
    text = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Eagerly load .env (call once on boot). */
export function ensureDotenvLoaded(): void {
  loadDotenv();
}

function env(...names: string[]): string {
  loadDotenv();
  for (const name of names) {
    const value = process.env[name];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeApiBase(base: string): string {
  base = base.trim().replace(/\/+$/, "");
  if (!base) return "";
  try {
    const parsed = new URL(base);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${base}/v1`;
    }
  } catch {
    /* keep as-is */
  }
  return base;
}

function readRaw(): Record<string, unknown> {
  try {
    if (!fs.existsSync(SETTINGS_PATH) || !fs.statSync(SETTINGS_PATH).isFile()) {
      return {};
    }
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeRaw(data: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    SETTINGS_PATH,
    `${JSON.stringify(data, null, 2)}\n`,
    "utf-8",
  );
}

export function getLibraryDir(): string {
  // sync path for callers that need immediate path; mutate under lock when writing
  const raw = readRaw();
  const value = raw.libraryDir;
  let dir: string;
  if (typeof value === "string" && value.trim()) {
    dir = path.resolve(value.replace(/^~(?=\/|$)/, process.env.HOME || ""));
  } else {
    dir = DEFAULT_LIBRARY_DIR;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export type LlmConfig = {
  apiBase: string;
  apiKey: string;
  model: string;
  source: "env";
};

export function getLlm(): LlmConfig {
  const apiBase = normalizeApiBase(env("BASE_URL", "BBOLUO_BASE_URL"));
  const apiKey = env("API_KEY", "BBOLUO_API_KEY");
  const model = env("MODEL", "BBOLUO_MODEL");
  return { apiBase, apiKey, model, source: "env" };
}

export function llmConfigured(): boolean {
  const llm = getLlm();
  return Boolean(llm.apiBase && llm.model && llm.apiKey);
}

export function settingsPublic(): {
  libraryDir: string;
  llm: {
    apiBase: string;
    model: string;
    apiKeyMasked: string;
    configured: boolean;
    source: string;
  };
} {
  const llm = getLlm();
  const key = llm.apiKey;
  let masked = "";
  if (key) {
    masked = "*".repeat(Math.max(0, key.length - 4)) + key.slice(-4);
  }
  return {
    libraryDir: getLibraryDir(),
    llm: {
      apiBase: llm.apiBase,
      model: llm.model,
      apiKeyMasked: masked,
      configured: llmConfigured(),
      source: llm.source,
    },
  };
}

export async function updateSettings(opts: {
  libraryDir?: string | null;
}): Promise<ReturnType<typeof settingsPublic>> {
  return lock.run(() => {
    const raw = readRaw();
    if (opts.libraryDir != null) {
      const text = opts.libraryDir.trim();
      if (!text) throw new Error("libraryDir 不能为空");
      const resolved = path.resolve(
        text.replace(/^~(?=\/|$)/, process.env.HOME || ""),
      );
      fs.mkdirSync(resolved, { recursive: true });
      raw.libraryDir = resolved;
    }
    delete raw.llm;
    delete raw.summaryMaxChars;
    writeRaw(raw);
    return settingsPublic();
  });
}

// snake_case aliases
export {
  getLibraryDir as get_library_dir,
  getLlm as get_llm,
  llmConfigured as llm_configured,
  settingsPublic as settings_public,
  updateSettings as update_settings,
  ensureDotenvLoaded as _load_dotenv,
};
