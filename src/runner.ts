// Workflow runner: executes a workflow's nodes in step_order.
// Custom tool code runs via AsyncFunction with the `api` surface.

import { buildApi, envelopeFromUserDataEntry, type SessionState } from "./api";
import type { LlmConfig, RunMessage, TypedEnvelope, WfpCustomToolRow, WfpFile, WfpNode, WfpWorkflowRow } from "./types";

const VAR_RE = /^\{\{(.+?)\}\}$/;

export interface RunOptions {
  llmConfig: LlmConfig | null;
  onMessage?: (msg: RunMessage) => void;
  triggerDownload?: (data: string, filename: string, inline: boolean) => void;
}

export interface RunResult {
  messages: RunMessage[];
  parameters: Record<string, TypedEnvelope>;
  pendingUserDataWrites: Map<string, TypedEnvelope>;
}

export async function runWorkflow(file: WfpFile, workflowId: string, opts: RunOptions): Promise<RunResult> {
  const workflowRow = file.app_workflows?.find((w) => w.workflow_id === workflowId);
  if (!workflowRow) throw new Error(`Workflow not found: ${workflowId}`);

  const nodes = parseNodes(workflowRow).sort((a, b) => a.step_order - b.step_order);
  const session = initSession(file);
  const customTools = new Map<string, WfpCustomToolRow>(
    (file.app_custom_tools || []).map((t) => [t.tool_id, t])
  );

  const pushMsg = (m: RunMessage) => {
    session.messages.push(m);
    opts.onMessage?.(m);
  };

  for (const node of nodes) {
    resolveNodeParameters(node, session);

    const api = buildApi({
      session,
      file,
      llmConfig: opts.llmConfig,
      toolId: node.tool_id,
      nodeLabel: node.label,
    });

    try {
      await executeNode(node, customTools, api, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushMsg({
        role: "error",
        source: node.tool_id,
        nodeLabel: node.label,
        markdown: `**Error in ${node.label}** (${node.tool_id}): ${message}`,
        timestamp: new Date().toISOString(),
      });
      throw err;
    }

    // Flush any messages the api buffered (it pushes to session.messages directly).
    // Notify the caller about new messages since the previous flush.
    if (opts.onMessage) {
      // No-op: api.addMessage pushes to session.messages directly.
      // We re-emit only the newest message for liveness.
      const last = session.messages[session.messages.length - 1];
      if (last) opts.onMessage(last);
    }
  }

  return {
    messages: session.messages,
    parameters: session.parameters,
    pendingUserDataWrites: session.pendingUserDataWrites,
  };
}

function initSession(file: WfpFile): SessionState {
  const parameters: Record<string, TypedEnvelope> = {};
  if (file.user_data) {
    for (const [name, entry] of Object.entries(file.user_data)) {
      parameters[name] = envelopeFromUserDataEntry(entry);
    }
  }
  return { parameters, messages: [], pendingUserDataWrites: new Map() };
}

function parseNodes(row: WfpWorkflowRow): WfpNode[] {
  let raw: unknown;
  try { raw = JSON.parse(row.nodes || "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => normalizeNode(n, row.workflow_id));
}

const NATIVE_TOOL_IDS = new Set(["workflow_start", "workflow_end", "download_data", "llm_step"]);

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// LLMs sometimes invent slightly different node shapes (id vs node_id, name vs label,
// type containing the tool_id, config as a stringified JSON, etc.). Normalize them
// so the runner works with both canonical and common LLM variants.
function normalizeNode(raw: unknown, workflowId: string): WfpNode {
  const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};

  const node_id = (r.node_id as string) || (r.id as string) || `node-${Math.random().toString(16).slice(2, 8)}`;
  const label = (r.label as string) || (r.name as string) || "Step";
  const step_order = typeof r.step_order === "number" ? r.step_order : 0;

  // Resolve tool_id from several common shapes:
  let tool_id = (r.tool_id as string) || "";
  if (!tool_id && typeof r.type === "string" && NATIVE_TOOL_IDS.has(r.type)) {
    tool_id = r.type;
  }
  if (!tool_id && r.config !== undefined) {
    const cfg = typeof r.config === "string" ? safeJsonParse(r.config) : r.config;
    if (cfg && typeof cfg === "object" && typeof (cfg as Record<string, unknown>).tool_id === "string") {
      tool_id = (cfg as Record<string, unknown>).tool_id as string;
    }
  }

  // Normalize high-level type
  let type: "start" | "tool" | "end" = "tool";
  if (tool_id === "workflow_start" || r.type === "start") type = "start";
  else if (tool_id === "workflow_end" || r.type === "end") type = "end";

  // toolParameters — accept several common locations
  let toolParameters: Record<string, string> | undefined;
  if (r.toolParameters && typeof r.toolParameters === "object") {
    toolParameters = r.toolParameters as Record<string, string>;
  } else if (r.params && typeof r.params === "object") {
    toolParameters = r.params as Record<string, string>;
  } else if (typeof r.config === "string") {
    const cfg = safeJsonParse(r.config) as Record<string, unknown> | null;
    if (cfg && cfg.parameters && typeof cfg.parameters === "object") {
      toolParameters = cfg.parameters as Record<string, string>;
    }
  }

  return {
    node_id,
    workflow_id: (r.workflow_id as string) || workflowId,
    type,
    label,
    step_order,
    tool_id,
    toolParameters,
  };
}

function resolveNodeParameters(node: WfpNode, session: SessionState): void {
  if (!node.toolParameters) return;
  for (const [paramName, rawValue] of Object.entries(node.toolParameters)) {
    if (typeof rawValue !== "string") continue;
    const match = rawValue.match(VAR_RE);
    if (match) {
      const varName = match[1].trim();
      if (varName === paramName) continue; // already aligned
      const existing = session.parameters[varName];
      if (existing) session.parameters[paramName] = existing;
    } else {
      // Literal value — wrap as text envelope
      session.parameters[paramName] = { _meta: { type: "text", length: rawValue.length }, data: rawValue };
    }
  }
}

async function executeNode(
  node: WfpNode,
  customTools: Map<string, WfpCustomToolRow>,
  api: ReturnType<typeof buildApi>,
  opts: RunOptions,
): Promise<void> {
  switch (node.tool_id) {
    case "workflow_start":
      api.addMessage({ role: "system", markdown: `**Starting:** ${node.label}` });
      return;

    case "workflow_end":
      api.addMessage({ role: "system", markdown: `**Finished:** ${node.label}` });
      return;

    case "download_data": {
      const data = api.getParameter("data");
      const filename = (api.getParameter("filename") as string) || "download.txt";
      const inlineParam = api.getParameter("inline");
      const inline = inlineParam === "true" || inlineParam === true;
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      if (opts.triggerDownload) {
        opts.triggerDownload(text, filename, inline);
      } else {
        api.addMessage({ role: "tool", markdown: `Report ready: \`${filename}\` (${text.length.toLocaleString()} chars).` });
      }
      return;
    }

    case "llm_step": {
      const prompt = api.getParameter("prompt") as string;
      if (!prompt) throw new Error("llm_step: missing 'prompt' parameter");
      const result = await api.llm.complete({
        messages: [{ role: "user", content: prompt }],
      });
      // Store the response under a conventional name so subsequent nodes can read it.
      api.setParameter("llm_response", result.text);
      api.addMessage({ role: "tool", markdown: result.text });
      return;
    }

    default: {
      if (!node.tool_id) {
        throw new Error(`Node "${node.label}" has no tool_id. Each node must include a "tool_id" field (e.g. "workflow_start" or "ctool-<id>").`);
      }
      if (node.tool_id.startsWith("ctool-")) {
        const tool = customTools.get(node.tool_id);
        if (!tool) throw new Error(`Custom tool not found: ${node.tool_id}`);
        if (!tool.code?.trim()) throw new Error(`Custom tool has no code: ${node.tool_id}`);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction("api", tool.code);
        await fn(api);
        return;
      }
      // Unknown native tool — log and continue.
      api.addMessage({
        role: "system",
        markdown: `Skipping unknown tool \`${node.tool_id}\` (\`${node.label}\`). Not implemented in this runner.`,
      });
    }
  }
}
