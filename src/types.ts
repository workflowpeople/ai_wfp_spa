// Local types for the .wfp runner.
//
// File-format types come from `wfp-format`. Runtime types (envelopes,
// messages, the api surface) come from `wfp-api`. The only thing local to
// this runner is the LLM settings shape — that's UI/storage state, not
// part of the format.

export {
  WFP_FORMAT_VERSION,
  isEncryptionEnvelope,
} from "wfp-format";

export type {
  WfpFile,
  WfpFileOrEncrypted,
  Metadata,
  Workflow,
  Node,
  NodeKind,
  WorkflowKind,
  Tool,
  ToolInput,
  ToolOutput,
  DataEntry,
  KnowledgePack,
  KnowledgeScope,
  Session,
  SessionStatus,
  SessionKind,
  Message,
  MessageRole,
  SessionParameter,
  Extensions,
  EncryptionEnvelope,
} from "wfp-format";

export type {
  MetaType,
  MetaData,
  TypedEnvelope,
  RunMessage,
  ChatMessage,
} from "wfp-api";

// ── Runner-local ─────────────────────────────────────────────────────────────

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  provider_label?: string;
}
