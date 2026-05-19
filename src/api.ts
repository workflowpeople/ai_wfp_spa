// The `api` surface exposed to tool code.
// Tools read and write through this — they do not see the runtime directly.

import { llmCall, type ChatMessage } from "./llm";
import type { LlmConfig, MetaData, MetaType, RunMessage, TypedEnvelope, WfpFile } from "./types";

export interface SessionState {
  parameters: Record<string, TypedEnvelope>;
  messages: RunMessage[];
  // Mutations the runner needs to flush back to the .wfp file on save:
  pendingUserDataWrites: Map<string, TypedEnvelope>;
}

export interface ApiContext {
  session: SessionState;
  file: WfpFile;
  llmConfig: LlmConfig | null;
  toolId: string;
  nodeLabel: string;
}

function isEnvelope(v: unknown): v is TypedEnvelope {
  return !!(v && typeof v === "object" && "_meta" in v && "data" in v && typeof (v as TypedEnvelope)._meta?.type === "string");
}

function autoWrap(value: unknown): TypedEnvelope {
  if (isEnvelope(value)) return value;
  if (typeof value === "string") return { _meta: { type: "text", length: value.length }, data: value };
  if (typeof value === "number") return { _meta: { type: "number" }, data: value };
  if (typeof value === "boolean") return { _meta: { type: "boolean" }, data: value };
  if (Array.isArray(value)) {
    const columns = value.length > 0 && typeof value[0] === "object" && value[0] !== null
      ? Object.keys(value[0] as object)
      : undefined;
    return { _meta: { type: "json_array", rowCount: value.length, columns }, data: value };
  }
  if (value && typeof value === "object") return { _meta: { type: "json_object" }, data: value };
  return { _meta: { type: "string" }, data: String(value ?? "") };
}

export function buildApi(ctx: ApiContext) {
  const { session, file, llmConfig, toolId, nodeLabel } = ctx;

  const addMessage = (msg: { role?: "tool" | "system" | "error"; markdown?: string; html?: string }) => {
    session.messages.push({
      role: msg.role || "tool",
      source: toolId,
      nodeLabel,
      markdown: msg.markdown,
      html: msg.html,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    // ── Parameter access ───────────────────────────────────────────────────
    getParameter(name: string): unknown {
      return session.parameters[name]?.data;
    },
    getParameterMeta(name: string): MetaData | undefined {
      return session.parameters[name]?._meta;
    },
    setParameter(name: string, value: unknown): void {
      session.parameters[name] = autoWrap(value);
    },
    async setUserData(name: string, value: unknown): Promise<void> {
      const envelope = autoWrap(value);
      const safeName = String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (!safeName) throw new Error('setUserData: name must contain at least one alphanumeric character');
      session.parameters[safeName] = envelope;
      session.pendingUserDataWrites.set(safeName, envelope);
    },

    // ── Messages ───────────────────────────────────────────────────────────
    addMessage,

    // ── HTTP fetch ─────────────────────────────────────────────────────────
    async fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string | Record<string, unknown>; timeout?: number }) {
      const method = (options?.method || "GET").toUpperCase();
      const headers: Record<string, string> = { ...(options?.headers || {}) };
      let body: string | undefined;
      if (options?.body !== undefined) {
        if (typeof options.body === "string") {
          body = options.body;
        } else {
          body = JSON.stringify(options.body);
          if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        }
      }
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), Math.min(options?.timeout || 30_000, 60_000));
      try {
        const resp = await fetch(url, { method, headers, body, signal: controller.signal });
        const text = await resp.text();
        let data: unknown = text;
        try { data = JSON.parse(text); } catch { /* not json */ }
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        return { status: resp.status, headers: respHeaders, data, text };
      } finally {
        window.clearTimeout(timeoutId);
      }
    },

    // ── Knowledge packs (read-only) ────────────────────────────────────────
    getKnowledge(name: string): string | null {
      const pack = file.app_knowledge_packs?.find((p) => p.name === name);
      return pack ? pack.content : null;
    },

    // ── LLM ────────────────────────────────────────────────────────────────
    llm: {
      async complete(opts: { messages: ChatMessage[]; model?: string; temperature?: number; max_tokens?: number; response_format?: "text" | "json_object" }) {
        if (!llmConfig) throw new Error("LLM not configured. Open Settings and set base URL, API key, and model.");
        return await llmCall(llmConfig, opts);
      },

      async classify(opts: { data: Record<string, unknown>[]; categories: string[]; field?: string; context?: string; knowledge?: string[] }) {
        if (!llmConfig) throw new Error("LLM not configured. Open Settings and set base URL, API key, and model.");
        const { data, categories, field = "category", context, knowledge } = opts;
        if (!Array.isArray(data) || data.length === 0) throw new Error("api.llm.classify(): data must be a non-empty array of objects");
        if (!Array.isArray(categories) || categories.length === 0) throw new Error("api.llm.classify(): categories must be a non-empty array of strings");

        const knowledgeBlock = loadKnowledgeBlock(file, knowledge);
        const contextBlock = [context, knowledgeBlock].filter(Boolean).join("\n\n");
        const systemPrompt = `You are a precise data classifier.${contextBlock ? `\n\nBackground context:\n${contextBlock}` : ""}\n\nClassify each row into exactly one of the provided categories. Return strict JSON with this shape:\n{ "data": [<input rows with "${field}" added>], "summary": "<one-sentence description of what you did>" }\nDo not return any text outside the JSON.`;
        const userMessage = `Classify each row into one of these categories: ${categories.join(", ")}\n\nAdd the category as a field called "${field}" to each row.\n\nData (${data.length} rows):\n${JSON.stringify(data, null, 2)}`;

        const result = await llmCall(llmConfig, {
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
          max_tokens: 16384,
          response_format: "json_object",
        });

        const parsed = safeParseJson(result.text);
        if (!parsed || !Array.isArray(parsed.data)) {
          throw new Error("api.llm.classify(): LLM did not return an array in the 'data' field");
        }
        return {
          data: parsed.data as Record<string, unknown>[],
          summary: typeof parsed.summary === "string" && parsed.summary.trim()
            ? parsed.summary
            : `Classified ${parsed.data.length} rows into ${categories.length} categories`,
        };
      },

      async summarize(opts: { data: unknown; focus?: string; context?: string; knowledge?: string[] }) {
        if (!llmConfig) throw new Error("LLM not configured. Open Settings and set base URL, API key, and model.");
        const { data, focus, context, knowledge } = opts;
        if (data == null) throw new Error("api.llm.summarize(): data is required");

        const knowledgeBlock = loadKnowledgeBlock(file, knowledge);
        const contextBlock = [context, knowledgeBlock].filter(Boolean).join("\n\n");
        const systemPrompt = `You are a precise financial summarizer.${contextBlock ? `\n\nBackground context:\n${contextBlock}` : ""}\n\nWrite a clear, plain-text narrative summary. Be exact with numbers. Return strict JSON with this shape:\n{ "summary": "<plain text narrative>" }\nDo not return any text outside the JSON.`;
        const focusLine = focus ? `Focus on: ${focus}\n\n` : "";
        const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        const userMessage = `${focusLine}Summarize this data:\n${dataStr}`;

        const result = await llmCall(llmConfig, {
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
          max_tokens: 2048,
          response_format: "json_object",
        });

        const parsed = safeParseJson(result.text);
        const summary = (parsed?.summary as string | undefined) || result.text || "No summary generated";
        return { summary };
      },
    },
  };
}

function loadKnowledgeBlock(file: WfpFile, names?: string[]): string {
  if (!names || names.length === 0) return "";
  const packs = names
    .map((n) => file.app_knowledge_packs?.find((p) => p.name === n)?.content)
    .filter((c): c is string => !!c);
  if (packs.length === 0) return "";
  return `Knowledge packs:\n${packs.join("\n\n---\n\n")}`;
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s); } catch { return null; }
}

export type WfpApi = ReturnType<typeof buildApi>;

// ── CSV → array helper (used at .wfp load time) ──────────────────────────────

export function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = splitCsvLines(text);
  if (lines.length === 0) return rows;
  const headers = parseCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function splitCsvLines(text: string): string[] {
  // Split on newlines but respect quoted fields.
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { fields.push(current); current = ""; }
      else current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function envelopeFromUserDataEntry(entry: { content: string; content_type?: string; content_json?: string | null; columns?: string | null; row_count?: number | null }): TypedEnvelope {
  const type = (entry.content_type as MetaType) || "text";
  // Prefer content_json when available — already parsed shape
  if (entry.content_json) {
    try {
      const data = JSON.parse(entry.content_json);
      const columns = entry.columns ? safeJsonParse<string[]>(entry.columns) : undefined;
      return { _meta: { type, rowCount: entry.row_count ?? undefined, columns }, data };
    } catch { /* fall through */ }
  }
  // CSV: parse to array of row objects
  if (type === "csv" || type === "json_array") {
    const data = parseCsv(entry.content);
    return { _meta: { type: "json_array", rowCount: data.length, columns: data.length > 0 ? Object.keys(data[0]) : [] }, data };
  }
  // Plain text
  return { _meta: { type, length: entry.content.length }, data: entry.content };
}

function safeJsonParse<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}
