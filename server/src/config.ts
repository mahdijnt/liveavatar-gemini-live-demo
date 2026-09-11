/**
 * Env-driven configuration. One `.env` at the repo root feeds everything —
 * the browser never sees any of it.
 *
 * GPT-Live is generally available; the model defaults to `gpt-live-1`.
 */

import { fileURLToPath } from "node:url";

// Loaded before anything reads process.env. Missing file is fine — deployed
// environments use real env vars.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* no .env — ambient env only */
}

const env = (name: string, fallback = ""): string =>
  process.env[name] ?? fallback;

export const config = {
  port: Number(env("PORT", "8787")),

  liveavatar: {
    apiUrl: env("LIVEAVATAR_API_URL", "https://api.liveavatar.com").replace(
      /\/+$/,
      "",
    ),
    apiKey: env("LIVEAVATAR_API_KEY"),
    /** Optional — empty means "pick the first public avatar" (liveavatar.ts). */
    avatarId: env("LIVEAVATAR_AVATAR_ID"),
  },

  gemini: {
    apiKey: env("GEMINI_API_KEY"),
    model: env("GEMINI_MODEL", "gemini-2.5-flash-native-audio-latest"),
    voice: env("GEMINI_VOICE", "Aoede"),
    debug: Boolean(env("GEMINI_DEBUG")),
  },
};

/**
 * Names of required vars that are missing. Checked at boot (a warning) and at
 * `/api/session/start` (a 500 naming them) — not a crash, so `pnpm dev` works
 * before the `.env` is filled in and the failure explains itself.
 */
export function missingConfig(): string[] {
  const required: [string, string][] = [
    ["LIVEAVATAR_API_KEY", config.liveavatar.apiKey],
    ["GEMINI_API_KEY", config.gemini.apiKey],
  ];
  return required.filter(([, value]) => !value).map(([name]) => name);
}

