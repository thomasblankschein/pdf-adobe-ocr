import { createAnthropicClient } from "./anthropic";
import { createOpenAiClient } from "./openai";
import type { LlmClient, Provider } from "./types";

export type { LlmClient, Provider } from "./types";

// Anbieter und Modell kommen ausschließlich aus der Umgebung (.env):
//   LLM_PROVIDER  anthropic | openai (leer = LLM-Nachbearbeitung nicht verfügbar)
//   LLM_MODEL     Modellname; Standard nur bei Anthropic (claude-opus-5), bei OpenAI Pflicht
// Env wird zur Laufzeit gelesen: die .env wird nach den Imports geladen.

export type LlmSetup =
  | { status: "off" }
  | { status: "error"; reason: string }
  | { status: "ready"; provider: Provider; model: string };

const KEY_NAMES: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const MODEL_RE = /^[\w.:\-/]{1,100}$/;

function isProvider(value: string): value is Provider {
  return value === "anthropic" || value === "openai";
}

/** Liest und prüft die LLM-Konfiguration. */
export function llmSetup(): LlmSetup {
  const provider = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider || provider === "none") return { status: "off" };
  if (!isProvider(provider)) return { status: "error", reason: `LLM_PROVIDER "${provider}" ist ungültig (anthropic | openai).` };
  if (!process.env[KEY_NAMES[provider]]) return { status: "error", reason: `${KEY_NAMES[provider]} ist nicht gesetzt.` };
  // OpenAI-Modellnamen ändern sich häufig – dort bewusst kein fester Standard
  const model = (process.env.LLM_MODEL ?? "").trim() || (provider === "anthropic" ? "claude-opus-5" : "");
  if (!model) return { status: "error", reason: "LLM_MODEL ist nicht gesetzt (bei openai Pflicht)." };
  if (!MODEL_RE.test(model)) return { status: "error", reason: `LLM_MODEL "${model}" ist kein gültiger Modellname.` };
  return { status: "ready", provider, model };
}

export function createLlmClient(setup: Extract<LlmSetup, { status: "ready" }>): LlmClient {
  const timeoutMs = Number(process.env.LLM_TIMEOUT_S ?? 180) * 1000;
  const key = process.env[KEY_NAMES[setup.provider]] ?? "";
  return setup.provider === "anthropic"
    ? createAnthropicClient(setup.model, key, timeoutMs)
    : createOpenAiClient(setup.model, key, timeoutMs);
}
