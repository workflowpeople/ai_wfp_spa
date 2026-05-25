// Thin runner adapter.
//
// The heavy lifting (node walking, parameter resolution, builtin dispatch,
// custom tool execution, session lifecycle) lives in `wfp-core`. This file
// only wires the SPA's environment — its LLM config and its pause UI hook —
// into wfp-core's executor.

import type { WfpFile } from "wfp-format";
import { executeWorkflow, type ExecuteResult } from "wfp-core";
import type { PausePrompt, PauseResult, RunMessage } from "wfp-api";
import { makeLlmClient } from "./llm";
import type { LlmConfig } from "./types";

export interface RunOptions {
  llmConfig: LlmConfig | null;
  onMessage?: (msg: RunMessage) => void;
  pauseForInput: (prompt: PausePrompt) => Promise<PauseResult>;
}

export type { ExecuteResult } from "wfp-core";

export async function runWorkflow(
  file: WfpFile,
  workflowId: string,
  opts: RunOptions,
): Promise<ExecuteResult> {
  return executeWorkflow(file, workflowId, {
    llm: makeLlmClient(opts.llmConfig),
    pauseForInput: opts.pauseForInput,
    onMessage: opts.onMessage,
  });
}
