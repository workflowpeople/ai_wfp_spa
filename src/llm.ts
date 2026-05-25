// Generic OpenAI-compatible chat completions client.
// Works with OpenAI, OpenRouter, Groq, Together, Anthropic's OpenAI-compat endpoint,
// local Ollama (with /v1/chat/completions), etc.
//
// This module is the runner's *transport* — `wfp-api` does not import it.
// Instead, the runner wraps `llmCall` into an `LlmClient` adapter and passes
// it to `executeWorkflow`.

import type {
  ChatMessage,
  LlmCallOptions,
  LlmCallResult,
  LlmClient,
} from "wfp-api";
import type { LlmConfig } from "./types";

export type { ChatMessage, LlmCallOptions, LlmCallResult };

export async function llmCall(config: LlmConfig, options: LlmCallOptions): Promise<LlmCallResult> {
  if (!config.base_url) throw new Error("LLM base_url not configured");
  if (!config.api_key) throw new Error("LLM api_key not configured");

  // Canonicalize the base URL — accept any of these:
  //   https://api.openai.com/v1
  //   https://api.openai.com/v1/
  //   https://api.openai.com/v1/chat/completions   (some users paste the full endpoint)
  //   https://api.openai.com/v1/responses
  //   https://api.openai.com/v1/messages
  // …all resolve to the chat/completions endpoint.
  const base = config.base_url
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|completions|responses|messages)$/, "");
  const url = base + "/chat/completions";

  const body: Record<string, unknown> = {
    model: options.model || config.model,
    messages: options.messages,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;
  if (options.response_format === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.api_key}`,
  };

  // Anthropic blocks direct browser calls unless this header is set explicitly.
  // The OpenAI-compat endpoint at https://api.anthropic.com/v1/chat/completions
  // accepts bearer auth, but still enforces the browser-access opt-in.
  if (/(^|\.)anthropic\.com/i.test(new URL(url).hostname)) {
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM call failed: ${resp.status} ${resp.statusText} — ${errText.slice(0, 500)}`);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content ?? "";

  return {
    text,
    model: data?.model || body.model as string,
    usage: data?.usage,
  };
}

/**
 * Wrap an LlmConfig into an LlmClient adapter that wfp-api / wfp-core can use.
 * Returns null if the config is missing — wfp-api treats that as "LLM not
 * configured" and throws a clear error when a tool tries to use `api.llm.*`.
 */
export function makeLlmClient(config: LlmConfig | null): LlmClient | null {
  if (!config) return null;
  return (options) => llmCall(config, options);
}
