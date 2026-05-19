// Generic OpenAI-compatible chat completions client.
// Works with OpenAI, OpenRouter, Groq, Together, Anthropic's OpenAI-compat endpoint,
// local Ollama (with /v1/chat/completions), etc.

import type { LlmConfig } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: "text" | "json_object";
}

export interface LlmCallResult {
  text: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function llmCall(config: LlmConfig, options: LlmCallOptions): Promise<LlmCallResult> {
  if (!config.base_url) throw new Error("LLM base_url not configured");
  if (!config.api_key) throw new Error("LLM api_key not configured");

  const url = config.base_url.replace(/\/$/, "") + "/chat/completions";

  const body: Record<string, unknown> = {
    model: options.model || config.model,
    messages: options.messages,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;
  if (options.response_format === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
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
