// SPA entry point: open/save .wfp, render workspace, run workflows, settings.

import { openWfp, saveWfp, loadLlmConfig, saveLlmConfig, clearLlmConfig } from "./storage";
import { runWorkflow } from "./runner";
import { WFP_FORMAT_VERSION, type LlmConfig, type RunMessage, type Tool, type WfpFile } from "./types";
import { envelopeFromDataEntry, parseCsv } from "wfp-api";
import type { PausePrompt, PauseResult } from "wfp-api";
import type { FormField } from "wfp-format";
import { API_REFERENCE } from "wfp-llm-context";

interface AppState {
  file: WfpFile | null;
  fileName: string;
  fileHandle: FileSystemFileHandle | null;
  llmConfig: LlmConfig | null;
}

const state: AppState = {
  file: null,
  fileName: "",
  fileHandle: null,
  llmConfig: loadLlmConfig(),
};

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
};

declare const marked: { parse: (s: string) => string } | undefined;

function renderMarkdown(s: string): string {
  if (typeof marked !== "undefined") {
    try { return marked.parse(s); } catch { /* fall through */ }
  }
  return `<pre>${escapeHtml(s)}</pre>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderWorkspace(): void {
  if (!state.file) return;
  $("workspace-name").textContent = state.file.metadata?.workspace || "(unnamed)";
  $("file-name").textContent = state.fileName ? `(${state.fileName})` : "";
  ($("btn-save") as HTMLButtonElement).disabled = false;

  // Workflows
  const wfList = $("workflow-list");
  const workflows = state.file.workflows || [];
  if (workflows.length === 0) {
    wfList.innerHTML = '<li class="empty">No workflows.</li>';
  } else {
    wfList.innerHTML = workflows
      .map(
        (w) => `
        <li>
          <span class="name" title="${escapeHtml(w.description || "")}">${escapeHtml(w.name)}</span>
          <button class="run" data-run-id="${escapeHtml(w.id)}">Run</button>
          <button class="run" data-modify-id="${escapeHtml(w.id)}">Modify</button>
        </li>`,
      )
      .join("");
  }

  // Data files
  const dList = $("data-list");
  const data = state.file.data || {};
  const dataEntries = Object.entries(data);
  dList.innerHTML = dataEntries.length === 0
    ? '<li class="empty">None.</li>'
    : dataEntries
        .map(([name]) => `<li><span class="name">${escapeHtml(name)}</span><button class="run" data-data-name="${escapeHtml(name)}">Edit</button></li>`)
        .join("");
  dList.querySelectorAll<HTMLButtonElement>("button[data-data-name]").forEach((btn) => {
    btn.addEventListener("click", () => openDataEditor(btn.dataset.dataName!));
  });

  // Knowledge packs
  const kList = $("knowledge-list");
  const packs = state.file.knowledge || [];
  kList.innerHTML = packs.length === 0
    ? '<li class="empty">None.</li>'
    : packs
        .map((p) => `<li><span class="name">${escapeHtml(p.name)}</span><span class="meta">${escapeHtml(p.scope || "")}</span></li>`)
        .join("");

  // Custom tools are intentionally not shown in the sidebar.
  // They are edited via per-workflow "Modify" (the AI manages them) or directly in the .wfp.
  ($("btn-new-workflow") as HTMLButtonElement).disabled = false;

  // Bind workflow buttons (Run + Modify)
  wfList.querySelectorAll<HTMLButtonElement>("button[data-run-id]").forEach((btn) => {
    btn.addEventListener("click", () => handleRun(btn.dataset.runId!));
  });
  wfList.querySelectorAll<HTMLButtonElement>("button[data-modify-id]").forEach((btn) => {
    btn.addEventListener("click", () => openModifyModal(btn.dataset.modifyId!));
  });
}

function appendLogEntry(msg: RunMessage): void {
  const log = $("log");
  // Clear placeholder on first entry
  log.querySelector(".placeholder")?.remove();

  // chat_download emits a tool message with a structured `json` payload that
  // the runner renders as a download button + open-in-tab link. Recognize
  // that shape here so the user gets the rich UI instead of just the
  // markdown stub.
  if (msg.json && typeof msg.json === "object" && (msg.json as { kind?: unknown }).kind === "wfp:download") {
    const j = msg.json as {
      filename?: string;
      inline?: boolean;
      content?: string;
      label?: string;
    };
    const filename = j.filename || "download.txt";
    const content = j.content || "";
    const mimeType = filename.endsWith(".html") ? "text/html"
      : filename.endsWith(".json") ? "application/json"
      : filename.endsWith(".csv") ? "text/csv"
      : "text/plain";
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const entry = document.createElement("div");
    entry.className = "log-entry tool report";
    entry.innerHTML = `
      <div class="head">
        <span class="label">${escapeHtml(j.label || "Download")}</span>
        <span class="source">${escapeHtml(filename)} · ${content.length.toLocaleString()} chars</span>
      </div>
      <div class="body">
        <div class="report-actions">
          <a class="btn-action primary" href="${url}" download="${escapeHtml(filename)}">Download</a>
          <a class="btn-action secondary" href="${url}" target="_blank" rel="noopener">Open in new tab</a>
        </div>
      </div>
    `;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    // Blob URL is intentionally not revoked; both links need it. Browser
    // releases it on page unload.
    return;
  }

  const entry = document.createElement("div");
  entry.className = `log-entry ${msg.role}`;
  const labelText = msg.nodeLabel ? `${msg.nodeLabel}` : msg.source;
  const bodyHtml = msg.html
    ? msg.html
    : msg.markdown
      ? renderMarkdown(msg.markdown)
      : msg.voice
        ? renderMarkdown(msg.voice)
        : "";
  entry.innerHTML = `
    <div class="head">
      <span class="label">${escapeHtml(labelText)}</span>
      <span class="source">${escapeHtml(msg.source)}</span>
    </div>
    <div class="body">${bodyHtml}</div>
  `;

  if (msg.role === "error" && msg.markdown?.includes("LLM not configured")) {
    const btn = document.createElement("button");
    btn.textContent = "Open LLM Settings";
    btn.className = "btn-action primary";
    btn.style.marginTop = "8px";
    btn.addEventListener("click", openSettings);
    entry.querySelector(".body")?.appendChild(btn);
  }

  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

// ── Pause for input ──────────────────────────────────────────────────────────
//
// Renders the prompt body (markdown/html), then either:
//   - a structured form (when `prompt.form` is provided), returning
//     { kind: "form", values } on submit, or
//   - a single textarea fallback, returning { kind: "text", value }.
// Cancel always returns { kind: "cancelled" }.

function fieldInputId(name: string): string {
  return `pause-field-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function renderFormFieldHtml(field: FormField): string {
  const id = fieldInputId(field.name);
  const required = field.required ? " required" : "";
  const requiredMark = field.required
    ? ` <span style="color:#b91c1c;" title="required">*</span>`
    : "";
  const labelText = `${escapeHtml(field.label || field.name)}${requiredMark}`;
  const desc = field.description
    ? `<small class="muted" style="display:block;margin-top:2px;">${escapeHtml(field.description)}</small>`
    : "";
  const defaultStr =
    field.value !== undefined && field.value !== null ? String(field.value) : "";

  switch (field.type) {
    case "textarea":
      return `
        <label style="display:block;margin-top:12px;">${labelText}
          <textarea id="${id}" class="text-area-short" spellcheck="false"${required}>${escapeHtml(defaultStr)}</textarea>
        </label>${desc}`;
    case "number":
      return `
        <label style="display:block;margin-top:12px;">${labelText}
          <input id="${id}" type="number" value="${escapeHtml(defaultStr)}"${required} />
        </label>${desc}`;
    case "date":
      return `
        <label style="display:block;margin-top:12px;">${labelText}
          <input id="${id}" type="date" value="${escapeHtml(defaultStr)}"${required} />
        </label>${desc}`;
    case "boolean": {
      const checked = field.value === true || field.value === "true" ? " checked" : "";
      return `
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;">
          <input id="${id}" type="checkbox"${checked} />
          <span>${labelText}</span>
        </label>${desc}`;
    }
    case "select": {
      const opts = (field.options || [])
        .map((o) => {
          const sel = String(o.value) === defaultStr ? " selected" : "";
          return `<option value="${escapeHtml(String(o.value))}"${sel}>${escapeHtml(o.label)}</option>`;
        })
        .join("");
      const placeholder = field.required ? "" : `<option value="">— select —</option>`;
      return `
        <label style="display:block;margin-top:12px;">${labelText}
          <select id="${id}"${required}>${placeholder}${opts}</select>
        </label>${desc}`;
    }
    case "text":
    default:
      return `
        <label style="display:block;margin-top:12px;">${labelText}
          <input id="${id}" type="text" value="${escapeHtml(defaultStr)}"${required} />
        </label>${desc}`;
  }
}

function collectFormValues(fields: FormField[]): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const el = document.getElementById(fieldInputId(field.name)) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (!el) continue;

    let raw: unknown;
    if (field.type === "boolean") {
      raw = (el as HTMLInputElement).checked;
    } else if (field.type === "number") {
      const text = (el as HTMLInputElement).value;
      if (text === "") {
        if (field.required) return { ok: false, error: `"${field.label || field.name}" is required.` };
        continue;
      }
      const num = Number(text);
      if (Number.isNaN(num)) return { ok: false, error: `"${field.label || field.name}" must be a number.` };
      raw = num;
    } else {
      const text = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
      if (field.required && !text.trim()) {
        return { ok: false, error: `"${field.label || field.name}" is required.` };
      }
      raw = text;
    }
    values[field.name] = raw;
  }
  return { ok: true, values };
}

function pauseForInput(prompt: PausePrompt): Promise<PauseResult> {
  return new Promise((resolve) => {
    const promptArea = $("pause-prompt");
    const inputArea = $("pause-input") as HTMLTextAreaElement;
    const textWrap = $("pause-text-wrap");
    const formArea = $("pause-form-fields");
    const validationArea = $("pause-validation");
    validationArea.textContent = "";

    if (prompt.html) {
      promptArea.innerHTML = prompt.html;
    } else if (prompt.markdown) {
      promptArea.innerHTML = renderMarkdown(prompt.markdown);
    } else if (!prompt.form) {
      promptArea.innerHTML = `<p>Provide input to continue.</p>`;
    } else {
      promptArea.innerHTML = "";
    }

    const fields = prompt.form?.fields || [];
    const useForm = fields.length > 0;

    if (useForm) {
      formArea.innerHTML = fields.map(renderFormFieldHtml).join("");
      formArea.classList.remove("hidden");
      textWrap.classList.add("hidden");
    } else {
      formArea.innerHTML = "";
      formArea.classList.add("hidden");
      textWrap.classList.remove("hidden");
      inputArea.value = "";
    }

    const continueBtn = $("btn-pause-continue");
    const cancelBtn = $("btn-pause-cancel");

    const cleanup = (): void => {
      continueBtn.removeEventListener("click", onContinue);
      cancelBtn.removeEventListener("click", onCancel);
      $("pause-modal").classList.add("hidden");
    };
    const onContinue = (): void => {
      if (useForm) {
        const result = collectFormValues(fields);
        if (!result.ok) {
          validationArea.textContent = result.error;
          return;
        }
        cleanup();
        resolve({ kind: "form", values: result.values });
      } else {
        cleanup();
        resolve({ kind: "text", value: inputArea.value });
      }
    };
    const onCancel = (): void => {
      cleanup();
      resolve({ kind: "cancelled" });
    };

    continueBtn.addEventListener("click", onContinue);
    cancelBtn.addEventListener("click", onCancel);
    $("pause-modal").classList.remove("hidden");
    if (useForm) {
      const first = formArea.querySelector("input,textarea,select") as HTMLElement | null;
      first?.focus();
    } else {
      inputArea.focus();
    }
  });
}

function clearLog(): void {
  $("log").innerHTML = '<div class="placeholder">Workflow output will appear here.</div>';
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function handleOpen(): Promise<void> {
  try {
    const result = await openWfp();
    if (!result) return;
    state.file = result.file;
    state.fileName = result.fileName;
    state.fileHandle = result.handle;
    clearLog();
    renderWorkspace();
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") return;
    alert(`Failed to open file: ${(err as Error).message}`);
  }
}

async function handleSave(): Promise<void> {
  if (!state.file) return;
  try {
    const newHandle = await saveWfp(state.file, state.fileName || "workspace.wfp", state.fileHandle);
    if (newHandle) {
      state.fileHandle = newHandle;
      state.fileName = (newHandle as FileSystemFileHandle).name || state.fileName;
      $("file-name").textContent = `(${state.fileName})`;
    }
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") return;
    alert(`Failed to save file: ${(err as Error).message}`);
  }
}

async function handleRun(workflowId: string): Promise<void> {
  if (!state.file) return;
  clearLog();
  const workflow = state.file.workflows?.find((w) => w.id === workflowId);
  $("output-title").textContent = `Output — ${workflow?.name || workflowId}`;

  try {
    const result = await runWorkflow(state.file, workflowId, {
      llmConfig: state.llmConfig,
      onMessage: appendLogEntry,
      pauseForInput,
    });

    // wfp-core flushes data writes and chat turns into the file internally.
    // We only need to re-render if anything changed.
    if (result.dataChanged || result.chatChanged) {
      renderWorkspace();
    }
  } catch (err: unknown) {
    appendLogEntry({
      role: "error",
      source: "runner",
      markdown: `Workflow failed: ${(err as Error).message}`,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Settings modal ───────────────────────────────────────────────────────────

function openSettings(): void {
  ($("cfg-base-url") as HTMLInputElement).value = state.llmConfig?.base_url || "";
  ($("cfg-api-key") as HTMLInputElement).value = state.llmConfig?.api_key || "";
  ($("cfg-model") as HTMLInputElement).value = state.llmConfig?.model || "";
  ($("cfg-provider-label") as HTMLInputElement).value = state.llmConfig?.provider_label || "";
  $("settings-modal").classList.remove("hidden");
}

function closeSettings(): void {
  $("settings-modal").classList.add("hidden");
}

function saveSettings(): void {
  const cfg: LlmConfig = {
    base_url: ($("cfg-base-url") as HTMLInputElement).value.trim(),
    api_key: ($("cfg-api-key") as HTMLInputElement).value.trim(),
    model: ($("cfg-model") as HTMLInputElement).value.trim(),
    provider_label: ($("cfg-provider-label") as HTMLInputElement).value.trim() || undefined,
  };
  saveLlmConfig(cfg);
  state.llmConfig = cfg;
  closeSettings();
}

function clearSettings(): void {
  clearLlmConfig();
  state.llmConfig = null;
  closeSettings();
}

// ── Tool editor modal ────────────────────────────────────────────────────────

let editingToolId: string | null = null;

function openToolEditor(toolId: string): void {
  if (!state.file?.tools) return;
  const tool = state.file.tools.find((t) => t.tool_id === toolId);
  if (!tool) return;
  editingToolId = toolId;
  $("tool-modal-title").textContent = `Edit tool: ${tool.tool_id}`;
  ($("tool-modal-name") as HTMLInputElement).value = tool.name || "";
  ($("tool-modal-description") as HTMLTextAreaElement).value = tool.description || "";
  ($("tool-modal-code") as HTMLTextAreaElement).value = tool.code || "";
  $("tool-modal").classList.remove("hidden");
}

function closeToolEditor(): void {
  editingToolId = null;
  $("tool-modal").classList.add("hidden");
}

function saveToolEditor(): void {
  if (!editingToolId || !state.file?.tools) return;
  const tool = state.file.tools.find((t) => t.tool_id === editingToolId);
  if (!tool) return;
  tool.name = ($("tool-modal-name") as HTMLInputElement).value.trim() || tool.tool_id;
  tool.description = ($("tool-modal-description") as HTMLTextAreaElement).value;
  tool.code = ($("tool-modal-code") as HTMLTextAreaElement).value;
  closeToolEditor();
  renderWorkspace();
}

function deleteCurrentTool(): void {
  if (!editingToolId || !state.file?.tools) return;
  const tool = state.file.tools.find((t) => t.tool_id === editingToolId);
  if (!tool) return;
  if (!confirm(`Delete tool "${tool.name}" (${tool.tool_id})? This cannot be undone unless you reopen the .wfp without saving.`)) return;
  state.file.tools = state.file.tools.filter((t) => t.tool_id !== editingToolId);
  closeToolEditor();
  renderWorkspace();
}

// ── Modify with AI (per-workflow) ────────────────────────────────────────────

let modifyingWorkflowId: string | null = null;

function getReferencedToolIds(workflow: { nodes?: Array<{ tool_id?: string }> }): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(workflow.nodes)) return ids;
  for (const n of workflow.nodes) {
    if (n.tool_id && typeof n.tool_id === "string") ids.add(n.tool_id);
  }
  return ids;
}

function findSharedTools(targetWorkflowId: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!state.file?.workflows) return result;
  const target = state.file.workflows.find((w) => w.id === targetWorkflowId);
  if (!target) return result;
  const targetToolIds = getReferencedToolIds(target);
  const customToolIds = new Set((state.file.tools || []).map((t) => t.tool_id));
  for (const toolId of targetToolIds) {
    if (!customToolIds.has(toolId)) continue; // skip native tools
    const otherUsers: string[] = [];
    for (const w of state.file.workflows) {
      if (w.id === targetWorkflowId) continue;
      if (getReferencedToolIds(w).has(toolId)) otherUsers.push(w.name);
    }
    if (otherUsers.length > 0) result.set(toolId, otherUsers);
  }
  return result;
}

function isEmptyWorkflowStub(workflow: { nodes?: unknown; description?: string }): boolean {
  const empty = !Array.isArray(workflow.nodes) || workflow.nodes.length === 0;
  return empty && !workflow.description;
}

function openModifyModal(workflowId: string): void {
  if (!state.file?.workflows) return;
  const workflow = state.file.workflows.find((w) => w.id === workflowId);
  if (!workflow) return;
  modifyingWorkflowId = workflowId;
  $("modify-modal-title").textContent = isEmptyWorkflowStub(workflow)
    ? "Create new workflow"
    : `Modify workflow: ${workflow.name}`;
  ($("modify-request") as HTMLTextAreaElement).value = "";
  ($("modify-response") as HTMLTextAreaElement).value = "";
  $("modify-copy-status").textContent = "";
  $("modify-apply-status").textContent = "";

  // Shared-tool warning
  const shared = findSharedTools(workflowId);
  const warningEl = $("modify-shared-warning");
  if (shared.size > 0) {
    const toolById = new Map((state.file.tools || []).map((t) => [t.tool_id, t.name] as const));
    const items: string[] = [];
    for (const [toolId, others] of shared) {
      const toolName = toolById.get(toolId) || toolId;
      items.push(`<li><b>${escapeHtml(toolName)}</b> — also used by: ${escapeHtml(others.join(", "))}</li>`);
    }
    warningEl.innerHTML = `<b>Heads up:</b> this workflow shares tools with other workflows. Changes to these tools will affect them too.<ul>${items.join("")}</ul>`;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }

  $("modify-modal").classList.remove("hidden");
}

function closeModifyModal(): void {
  // If a brand-new stub workflow was opened and never filled in, remove it.
  if (modifyingWorkflowId && state.file?.workflows) {
    const wf = state.file.workflows.find((w) => w.id === modifyingWorkflowId);
    if (wf && isEmptyWorkflowStub(wf)) {
      state.file.workflows = state.file.workflows.filter((w) => w.id !== modifyingWorkflowId);
      renderWorkspace();
    }
  }
  modifyingWorkflowId = null;
  $("modify-modal").classList.add("hidden");
}

function createNewWorkflow(): void {
  if (!state.file) return;
  if (!state.file.workflows) state.file.workflows = [];
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(3))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const workflowId = `wf-${hex}`;
  state.file.workflows.push({
    id: workflowId,
    name: "New Workflow",
    description: "",
    nodes: [],
  });
  renderWorkspace();
  openModifyModal(workflowId);
}

function buildUserDataSamples(): string {
  if (!state.file?.data) return "(none)";
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(state.file.data)) {
    const env = envelopeFromDataEntry(entry);
    const rowCount = env._meta.rowCount !== undefined ? ` (${env._meta.rowCount} rows)` : "";
    const cols = env._meta.columns ? `\n  columns: ${env._meta.columns.join(", ")}` : "";
    const sample = Array.isArray(env.data) && env.data.length > 0
      ? `\n  first 3 rows: ${JSON.stringify(env.data.slice(0, 3))}`
      : typeof env.data === "string" && env.data.length > 0
        ? `\n  first 500 chars: ${JSON.stringify(env.data.slice(0, 500))}`
        : "";
    lines.push(`### ${name}${rowCount}${cols}${sample}`);
  }
  return lines.join("\n\n");
}

function buildModifyPrompt(workflowId: string, userRequest: string): string {
  if (!state.file) return "";
  const workflow = state.file.workflows?.find((w) => w.id === workflowId);
  if (!workflow) return "";

  const referencedToolIds = getReferencedToolIds(workflow);
  const relevantTools = (state.file.tools || []).filter((t) => referencedToolIds.has(t.tool_id));

  const parts: string[] = [];

  const creating = isEmptyWorkflowStub(workflow);
  if (creating) {
    parts.push("You are creating a NEW workflow from scratch in a WFP (Workflow People) workspace.");
    parts.push("The workflow currently has no nodes and no custom tools. Design the steps, write the tool code, and wire them together. Return ONLY a JSON object.\n");
  } else {
    parts.push("You are modifying a single workflow in a WFP (Workflow People) workspace.");
    parts.push("You will be given the workflow, the custom tools it uses, and supporting context. Apply the user's change request and return ONLY a JSON object.\n");
  }

  parts.push("# USER REQUEST");
  parts.push(userRequest.trim() || "(no request — describe one and re-copy)");
  parts.push("");

  parts.push("# THE WORKFLOW TO MODIFY\n");
  parts.push("```json");
  parts.push(JSON.stringify(workflow, null, 2));
  parts.push("```\n");
  parts.push("Note: `nodes` is a real JSON array. Execution order follows `step_order` (1-based). There is no `edges` field.\n");

  parts.push("# CUSTOM TOOLS USED BY THIS WORKFLOW");
  parts.push("(Only the tools this workflow references — other tools in the workspace are not shown.)\n");
  parts.push("```json");
  parts.push(JSON.stringify(relevantTools, null, 2));
  parts.push("```\n");

  parts.push("# KNOWLEDGE PACKS (read via `api.getKnowledge(name)`)");
  parts.push("```json");
  parts.push(JSON.stringify(state.file.knowledge || [], null, 2));
  parts.push("```\n");

  parts.push("# data (READ-ONLY — sampled to first 3 rows)");
  parts.push(buildUserDataSamples());
  parts.push("");

  parts.push(API_REFERENCE);
  parts.push("");

  parts.push("# OUTPUT FORMAT — STRICT\n");
  parts.push("Return ONLY a single JSON object wrapped in a ```json code block. No other text.\n");
  parts.push("Shape:");
  parts.push("```json");
  parts.push(`{
  "workflows": [
    { "id": "${workflow.id}", "<changed field>": ... }
  ],
  "tools": [
    { "tool_id": "<existing or new>", "<changed field>": ... }
  ],
  "knowledge": [
    { "name": "<existing or new>", "<changed field>": ... }
  ]
}`);
  parts.push("```\n");
  parts.push("Rules:");
  parts.push("- Include ONLY items that changed. Don't echo unchanged items.");
  parts.push("- For changed items, include the primary key (`id` / `tool_id` / `name`) plus only the fields you changed.");
  parts.push("- Omit any top-level array that has no changes (e.g. if no tools changed, omit `tools` entirely).");
  parts.push(`- The workflow being modified is \`${workflow.id}\`. Only modify that workflow.`);
  parts.push("- To add a new tool: use a new `tool_id` like `ctool-<6 random hex>`.");
  parts.push("- For `workflows` items, `nodes` is a real JSON array of node objects. There is no `edges` field.");
  parts.push("- Each node has fields: `id`, `type` (\"start\" | \"end\" | \"tool\" | \"prompt\"), `label`, `step_order`, `tool_id`, `tool_parameters` (object).");
  parts.push("- For new tools, include: `tool_id`, `name`, `description`, `api_version: \"1.0.0\"`, `inputs: []`, `outputs: []`, `code`.");
  parts.push("- Code fields must be valid JavaScript function bodies using only the documented `api.*` methods.");
  parts.push("- DO NOT modify `data` — it is read-only context.");
  parts.push("- DO NOT include any commentary outside the ```json block.");

  return parts.join("\n");
}

async function copyModifyPrompt(): Promise<void> {
  if (!modifyingWorkflowId) return;
  const userRequest = ($("modify-request") as HTMLTextAreaElement).value;
  const prompt = buildModifyPrompt(modifyingWorkflowId, userRequest);
  try {
    await navigator.clipboard.writeText(prompt);
    const status = $("modify-copy-status");
    status.textContent = `Copied (${prompt.length.toLocaleString()} chars). Paste into your AI, then paste the response below.`;
    window.setTimeout(() => { status.textContent = ""; }, 8000);
  } catch (err) {
    alert(`Could not copy to clipboard: ${(err as Error).message}`);
  }
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Fallback: find first { ... balanced } in the text
  const start = text.indexOf("{");
  if (start === -1) return text.trim();
  const end = text.lastIndexOf("}");
  if (end > start) return text.slice(start, end + 1).trim();
  return text.trim();
}

interface ModifyChanges {
  workflows?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  knowledge?: Array<Record<string, unknown>>;
}

function applyModifyChanges(parsed: ModifyChanges): { workflows: number; tools: number; packs: number; added: number } {
  if (!state.file) throw new Error("No workspace loaded");
  let workflows = 0, tools = 0, packs = 0, added = 0;

  if (Array.isArray(parsed.workflows)) {
    if (!state.file.workflows) state.file.workflows = [];
    for (const wf of parsed.workflows) {
      // Tolerate LLM-emitted "workflow_id" alongside the canonical "id".
      const wfId = (wf.id || wf.workflow_id) as string | undefined;
      if (!wfId) continue;
      const incoming: Record<string, unknown> = { ...wf, id: wfId };
      delete incoming.workflow_id;
      // Coerce nodes from a JSON string back to an array if the AI returned a string.
      if (typeof incoming.nodes === "string") {
        try { incoming.nodes = JSON.parse(incoming.nodes); } catch { /* leave as-is */ }
      }
      // Drop edges if present — no longer part of the format.
      delete incoming.edges;
      const existing = state.file.workflows.find((w) => w.id === wfId);
      if (existing) {
        Object.assign(existing, incoming);
      } else {
        if (!incoming.nodes) incoming.nodes = [];
        state.file.workflows.push(incoming as any);
        added++;
      }
      workflows++;
    }
  }

  if (Array.isArray(parsed.tools)) {
    if (!state.file.tools) state.file.tools = [];
    for (const t of parsed.tools) {
      if (!t.tool_id) continue;
      const existing = state.file.tools.find((x) => x.tool_id === t.tool_id);
      if (existing) {
        Object.assign(existing, t);
      } else {
        state.file.tools.push(t as any);
        added++;
      }
      tools++;
    }
  }

  if (Array.isArray(parsed.knowledge)) {
    if (!state.file.knowledge) state.file.knowledge = [];
    for (const p of parsed.knowledge) {
      if (!p.name) continue;
      const existing = state.file.knowledge.find((x) => x.name === p.name);
      if (existing) {
        Object.assign(existing, p);
      } else {
        state.file.knowledge.push(p as any);
        added++;
      }
      packs++;
    }
  }

  return { workflows, tools, packs, added };
}

function applyModifyResponse(): void {
  if (!state.file) return;
  const response = ($("modify-response") as HTMLTextAreaElement).value.trim();
  const status = $("modify-apply-status");
  if (!response) {
    status.textContent = "Paste the AI response first.";
    return;
  }
  const jsonText = extractJsonBlock(response);
  let parsed: ModifyChanges;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    status.textContent = `Parse failed: ${(err as Error).message}. Check the response is a valid JSON block.`;
    return;
  }
  try {
    const result = applyModifyChanges(parsed);
    const total = result.workflows + result.tools + result.packs;
    if (total === 0) {
      status.textContent = "Parsed OK but no recognized changes (need workflows, tools, or knowledge).";
      return;
    }
    renderWorkspace();
    status.textContent = `Applied: ${result.workflows} workflow(s), ${result.tools} tool(s), ${result.packs} pack(s) (${result.added} new). Click "Save to Disk" to persist.`;
  } catch (err) {
    status.textContent = `Apply failed: ${(err as Error).message}`;
  }
}

// ── AI prompt for editing a tool ─────────────────────────────────────────────

function generateToolId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ctool-${hex}`;
}

function createBlankTool(): void {
  if (!state.file) return;
  if (!state.file.tools) state.file.tools = [];
  const tool: Tool = {
    tool_id: generateToolId(),
    name: "New Tool",
    description: "",
    api_version: "1.0.0",
    inputs: [],
    outputs: [],
    code: "",
  };
  state.file.tools.push(tool);
  renderWorkspace();
  openToolEditor(tool.tool_id);
}

function buildToolEditPrompt(current: { name: string; description: string; code: string }): string {
  if (!state.file) return "";
  const parts: string[] = [];

  parts.push("You are editing a custom tool for the WFP runner.");
  parts.push("The tool is a JavaScript function body executed in the browser with access to an `api` object.\n");

  parts.push("# USER REQUEST\n");
  parts.push("[Replace this line with what you want changed. Then send to the AI.]\n");

  parts.push("# CURRENT TOOL\n");
  parts.push(`## Name\n${current.name || "(empty)"}\n`);
  parts.push(`## Description\n${current.description || "(empty)"}\n`);
  parts.push(`## Code\n\`\`\`js\n${current.code || "// (empty — write a new tool from scratch)"}\n\`\`\`\n`);

  parts.push(API_REFERENCE);
  parts.push("");

  // Data manifest
  const dataEntries = Object.entries(state.file.data || {});
  if (dataEntries.length > 0) {
    parts.push("# Available user data");
    parts.push("Read these with `api.getParameter(\"<name>\")`. CSV-derived data is an array of objects (column names below). Numbers are strings — use parseFloat()/parseInt().\n");
    for (const [name, entry] of dataEntries) {
      const env = envelopeFromDataEntry(entry);
      const cols = env._meta.columns ? `\nColumns: ${env._meta.columns.join(", ")}` : "";
      const rowCount = env._meta.rowCount !== undefined ? ` (${env._meta.rowCount} rows)` : "";
      const samples = Array.isArray(env.data) && env.data.length > 0
        ? `\nFirst 3 rows: ${JSON.stringify(env.data.slice(0, 3))}`
        : "";
      parts.push(`### ${name}${rowCount}${cols}${samples}\n`);
    }
  }

  // Other tools
  const otherTools = (state.file.tools || []).filter((t) => t.name !== current.name || t.description !== current.description);
  if (otherTools.length > 0) {
    parts.push("# Other tools in this workspace");
    parts.push("(For reference — your tool may read parameters these tools produce.)\n");
    for (const t of otherTools) {
      const desc = (t.description || "").trim().split("\n")[0].slice(0, 200);
      parts.push(`- **${t.name}** (\`${t.tool_id}\`) — ${desc}`);
    }
    parts.push("");
  }

  // Knowledge packs
  const packs = state.file.knowledge || [];
  if (packs.length > 0) {
    parts.push("# Available knowledge packs");
    parts.push("Read content with `api.getKnowledge(\"<name>\")` — returns markdown text or null.\n");
    for (const p of packs) {
      parts.push(`- **${p.name}** (scope: ${p.scope || "chat+workflow"})`);
    }
    parts.push("");
  }

  parts.push("# OUTPUT FORMAT");
  parts.push("Return your response in two clearly-labeled parts so the user can copy each into the matching field:\n");
  parts.push("**Description**");
  parts.push("(A short paragraph describing what the tool does after your changes. Plain text. The user will paste this into the Description field.)\n");
  parts.push("**Code**");
  parts.push("```js");
  parts.push("// Complete updated function body. The user will paste this into the Code field.");
  parts.push("```");
  parts.push("\nIf only one of them changes, return both anyway (unchanged for the other).");

  return parts.join("\n");
}

async function copyToolPromptForAi(): Promise<void> {
  const current = {
    name: ($("tool-modal-name") as HTMLInputElement).value,
    description: ($("tool-modal-description") as HTMLTextAreaElement).value,
    code: ($("tool-modal-code") as HTMLTextAreaElement).value,
  };
  const prompt = buildToolEditPrompt(current);
  try {
    await navigator.clipboard.writeText(prompt);
    const status = $("tool-copy-status");
    status.textContent = `Copied (${prompt.length.toLocaleString()} chars). Paste into Claude / Gemini / ChatGPT, then add your request.`;
    window.setTimeout(() => { status.textContent = ""; }, 8000);
  } catch (err) {
    alert(`Could not copy to clipboard: ${(err as Error).message}`);
  }
}

// ── Data editor modal ────────────────────────────────────────────────────────

let editingDataName: string | null = null;

function openDataEditor(name: string): void {
  if (!state.file?.data?.[name]) return;
  const entry = state.file.data[name];
  editingDataName = name;
  $("data-modal-title").textContent = `Edit: ${name}`;
  const type = entry.content_type || "text";
  const meta = entry.row_count != null ? `${type} · ${entry.row_count} rows` : type;
  $("data-modal-meta").textContent = meta;
  ($("data-modal-textarea") as HTMLTextAreaElement).value =
    typeof entry.content === "string" ? entry.content : "(encrypted — open with a runner that can decrypt this segment)";
  $("data-modal").classList.remove("hidden");
}

function closeDataEditor(): void {
  editingDataName = null;
  $("data-modal").classList.add("hidden");
}

async function replaceDataFromFile(): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.json,.txt,text/*,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    ($("data-modal-textarea") as HTMLTextAreaElement).value = text;
  };
  input.click();
}

function saveDataEditor(): void {
  if (!editingDataName || !state.file?.data) return;
  const name = editingDataName;
  const newContent = ($("data-modal-textarea") as HTMLTextAreaElement).value;
  const existing = state.file.data[name];
  const type = existing.content_type || "text";

  let columns: string[] | undefined = Array.isArray(existing.columns) ? existing.columns : undefined;
  let row_count: number | undefined = typeof existing.row_count === "number" ? existing.row_count : undefined;
  let content_json: unknown = existing.content_json;

  if (type === "csv" || type === "json_array") {
    const rows = parseCsv(newContent);
    row_count = rows.length;
    columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    content_json = rows;
  } else if (type === "json_object") {
    try {
      content_json = JSON.parse(newContent);
    } catch {
      // Leave content_json as-is; runner will re-parse on next run.
    }
  } else {
    content_json = undefined;
  }

  state.file.data[name] = {
    content: newContent,
    content_type: type,
    ...(content_json !== undefined ? { content_json } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(row_count !== undefined ? { row_count } : {}),
    edited_at: new Date().toISOString(),
  };

  closeDataEditor();
  renderWorkspace();
}

// ── Wire up ──────────────────────────────────────────────────────────────────

$("btn-open").addEventListener("click", handleOpen);
$("btn-save").addEventListener("click", handleSave);
$("btn-settings").addEventListener("click", openSettings);
$("btn-cfg-save").addEventListener("click", saveSettings);
$("btn-cfg-cancel").addEventListener("click", closeSettings);
$("btn-cfg-clear").addEventListener("click", clearSettings);
$("btn-clear-log").addEventListener("click", clearLog);
$("btn-data-save").addEventListener("click", saveDataEditor);
$("btn-data-cancel").addEventListener("click", closeDataEditor);
$("btn-data-replace").addEventListener("click", replaceDataFromFile);
$("btn-tool-save").addEventListener("click", saveToolEditor);
$("btn-tool-cancel").addEventListener("click", closeToolEditor);
$("btn-tool-delete").addEventListener("click", deleteCurrentTool);
$("btn-tool-copy-prompt").addEventListener("click", copyToolPromptForAi);
$("btn-modify-copy").addEventListener("click", copyModifyPrompt);
$("btn-new-workflow").addEventListener("click", createNewWorkflow);
$("btn-modify-apply").addEventListener("click", applyModifyResponse);
$("btn-modify-cancel").addEventListener("click", closeModifyModal);
$("btn-modify-save").addEventListener("click", async () => {
  await handleSave();
  $("modify-apply-status").textContent = "Saved to disk.";
});

// Surface format version + pause-form build marker in title bar for debugging.
// If this title doesn't appear, the browser is loading a stale cached bundle.
document.title = `WFP Runner (format v${WFP_FORMAT_VERSION}) — pauseForm v1`;
console.log("[WFP] runner build: pauseForm v1");
