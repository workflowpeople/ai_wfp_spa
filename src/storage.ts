// File System Access API for .wfp open/save + localStorage for LLM settings.
// Save-to-disk requires a Chromium-based browser. Other browsers fall back to a download.

import type { LlmConfig, WfpFile } from "./types";
import { WFP_FORMAT_VERSION } from "./types";

const LLM_SETTINGS_KEY = "wfp-runner.llm-settings.v1";

export interface OpenedFile {
  file: WfpFile;
  fileName: string;
  handle: FileSystemFileHandle | null; // null when not supported
}

export function fsAccessSupported(): boolean {
  return typeof (window as any).showOpenFilePicker === "function";
}

// Parse + warn if the file's format_version is missing or unexpected.
// The runner still tries to load — most fields are forgiving — but the
// user gets a console hint when the file was written by a different version.
function parseAndCheck(text: string, fileName: string): WfpFile {
  const file = JSON.parse(text) as WfpFile;
  const v = file?.metadata?.format_version;
  if (!v) {
    console.warn(`[wfp-runner] ${fileName}: missing metadata.format_version. Expected "${WFP_FORMAT_VERSION}".`);
  } else if (v !== WFP_FORMAT_VERSION) {
    console.warn(`[wfp-runner] ${fileName}: format_version "${v}" — this runner targets "${WFP_FORMAT_VERSION}".`);
  }
  return file;
}

export async function openWfp(): Promise<OpenedFile | null> {
  if (fsAccessSupported()) {
    const [handle] = await (window as any).showOpenFilePicker({
      types: [{ description: "WFP workspace", accept: { "application/json": [".wfp"] } }],
      multiple: false,
    });
    const file = await handle.getFile();
    const text = await file.text();
    return { file: parseAndCheck(text, file.name), fileName: file.name, handle };
  }
  // Fallback: <input type="file">
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wfp,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const text = await f.text();
      resolve({ file: parseAndCheck(text, f.name), fileName: f.name, handle: null });
    };
    input.click();
  });
}

export async function saveWfp(file: WfpFile, fileName: string, handle: FileSystemFileHandle | null): Promise<FileSystemFileHandle | null> {
  const json = JSON.stringify(file, null, 2);

  if (handle) {
    const writable = await (handle as any).createWritable();
    await writable.write(json);
    await writable.close();
    return handle;
  }

  if (fsAccessSupported()) {
    const newHandle = await (window as any).showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: "WFP workspace", accept: { "application/json": [".wfp"] } }],
    });
    const writable = await newHandle.createWritable();
    await writable.write(json);
    await writable.close();
    return newHandle;
  }

  // Fallback: trigger a download
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

export function loadLlmConfig(): LlmConfig | null {
  const raw = localStorage.getItem(LLM_SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LlmConfig;
  } catch {
    return null;
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(config));
}

export function clearLlmConfig(): void {
  localStorage.removeItem(LLM_SETTINGS_KEY);
}
