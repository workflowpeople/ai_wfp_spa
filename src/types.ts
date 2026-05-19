// .wfp file format — V1 (reset from V3; no backward compat).
// One file = one portable workspace.

export const WFP_FORMAT_VERSION = 1;

export interface WfpFile {
  meta: WfpMeta;
  app_workflows?: WfpWorkflowRow[];
  app_custom_tools?: WfpCustomToolRow[];
  app_knowledge_packs?: WfpKnowledgePack[];
  user_data?: Record<string, WfpUserDataEntry>;
}

export interface WfpMeta {
  format_version: number;
  workspace?: string;
  exported_at?: string;
}

// Workflow row as stored: nodes and edges are JSON strings.
export interface WfpWorkflowRow {
  workflow_id: string;
  name: string;
  description?: string;
  nodes: string;
  edges: string;
}

export interface WfpNode {
  node_id: string;
  workflow_id: string;
  type: "start" | "tool" | "end";
  label: string;
  step_order: number;
  tool_id: string;
  toolParameters?: Record<string, string>;
}

export interface WfpEdge {
  source: string;
  target: string;
}

export interface WfpCustomToolRow {
  tool_id: string;
  name: string;
  description?: string;
  code: string;
  definition_json?: string;
}

export interface ToolDefinition {
  inputs?: Array<{ name: string; type?: string; description?: string }>;
  outputs?: Array<{ name: string; type?: string; description?: string }>;
}

export interface WfpKnowledgePack {
  name: string;
  scope?: string;
  tags?: string[];
  content: string;
}

export interface WfpUserDataEntry {
  content: string;
  content_type?: "text" | "csv" | "json_array" | "json_object";
  content_json?: string | null;
  columns?: string | null;
  row_count?: number | null;
}

// ── Runtime ────────────────────────────────────────────────────────────────

export type MetaType = "string" | "number" | "boolean" | "csv" | "json_array" | "json_object" | "text";

export interface MetaData {
  type: MetaType;
  rowCount?: number;
  columns?: string[];
  length?: number;
}

export interface TypedEnvelope<T = unknown> {
  _meta: MetaData;
  data: T;
}

export interface RunMessage {
  role: "tool" | "system" | "error";
  source: string;
  nodeLabel?: string;
  markdown?: string;
  html?: string;
  timestamp: string;
}

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  provider_label?: string;
}
