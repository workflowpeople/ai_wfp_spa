# wfp-runner

Open-source browser runner and editor for `.wfp` workflow files.

- **No server.** Everything runs in the browser.
- **No install.** Open `dist/index.html` directly, or visit a hosted URL.
- **Your data stays on your machine.** `.wfp` files are read from and written to local disk via the File System Access API. The runner never uploads them anywhere.
- **Bring your own LLM key.** Stored only in your browser's `localStorage`. LLM calls go directly from your browser to the provider you configure.
- **Bring your own AI for authoring.** "Modify with AI" and "New Workflow" assemble a self-contained prompt you paste into Claude, Gemini, ChatGPT, or any chat LLM. The runner never makes those calls itself — paste the response back and it auto-applies.

## Run it

### Option A — open the file directly

```
dist/index.html
```

Double-click. Works in any modern Chromium-based browser (Chrome, Edge, Brave, Arc). Safari/Firefox work too but fall back to download-on-save instead of writing back to the original file handle.

### Option B — local dev server

```bash
bun run build      # produces dist/wfp-runner.js (single IIFE bundle, ~30 KB)
bun run serve      # serves dist/ at http://localhost:5173
```

Open `http://localhost:5173/`.

### Option C — host it

Deploy `dist/` to any static host (GitHub Pages, Cloudflare Pages, Netlify, S3 + CloudFront). Three files total: `index.html`, `wfp-runner.js`, `style.css`. Plus one external dependency loaded via CDN (marked.js, for markdown rendering — falls back to `<pre>` if blocked).

## What it does

| Surface | Behavior |
|---|---|
| **Open .wfp** | File System Access picker. The file's contents stay in memory until you Save. |
| **Save** | Writes the in-memory workspace back to the same file handle (or a new one via Save As on first save). Full round-trip — no fields dropped. |
| **New Workflow** | Creates an empty workflow stub and immediately opens the Modify-with-AI modal pre-targeted at it. If you cancel without applying anything, the stub is removed. |
| **Sidebar — Workflows** | One row per workflow with `[Run]` and `[Modify]` buttons. |
| **Sidebar — Data Files** | One row per user data file with `[Edit]`. Click Edit to view/modify the raw content (CSV / JSON / text). Includes a **Replace from file...** picker. CSV `row_count` and `columns` recompute on save. |
| **Sidebar — Knowledge Packs** | Read-only list (editor coming). |
| **Settings** | LLM provider config: base URL, API key, model. Stored in `localStorage`. |
| **Run** | Executes a workflow's nodes in `step_order`. Streams output to the log pane. `download_data` nodes produce a "Report ready" entry with **Download** and **Open in new tab** buttons. Markdown is rendered. |
| **Modify with AI** | Per-workflow. Type a change request, click **Copy Prompt**, paste into your chat LLM, paste their JSON response back, click **Apply**. The prompt is scoped to just that workflow + the custom tools it references (not the whole workspace). Warns if any of those tools are shared with other workflows. |

## How "Modify with AI" works

1. Click `[Modify]` on a workflow (or **New Workflow** for a blank stub).
2. Type what you want changed.
3. Click **Copy Prompt**. The clipboard now contains:
   - The full workflow JSON (one workflow only)
   - The custom tools referenced by that workflow's nodes (only those — not the whole `app_custom_tools`)
   - All knowledge packs (small, often referenced via `api.getKnowledge(name)`)
   - All `user_data` files, sampled to the first 3 rows of each CSV
   - The complete `api.*` reference, including the canonical node schema
   - Your change request
   - Strict output instructions: return a single ` ```json { ... } ``` ` block
4. Paste into Claude, Gemini, ChatGPT, etc.
5. Paste their response into the bottom textarea.
6. Click **Apply** — the parser extracts the JSON block (auto-strips the fence), matches each returned `app_workflows` / `app_custom_tools` / `app_knowledge_packs` entry to existing items by primary key (`workflow_id` / `tool_id` / `name`), and merges. New items (unmatched IDs) are added.
7. Click **Save to Disk** (in the same modal) to write the updated `.wfp` back to your file.

The parser is lenient — if a returned `nodes` field is an array instead of a JSON-encoded string, it gets stringified. If the LLM forgets the ` ```json ` fence, the parser finds the first `{...}` block.

## What's not in the runner

Intentional non-goals — these stay in the hosted product or never come to the OSS edition at all:

- Authoring chat (sessions, history, scoring)
- General ledger, `wfp_gl`, `wfp_budget`, `api.query`
- SQLite — workflows work with arrays and objects, not SQL
- Sandboxed tool execution (custom tool code runs via `new Function`; trust your `.wfp` source)
- Privacy map / entity masking (would require sending plaintext to an LLM you trust; in this model you bring your own and that boundary doesn't apply)
- Sharing, encryption envelopes, auth, multi-user

## `.wfp` format

The runner reads any `.wfp` file. New files saved by the runner are stamped `format_version: 1` (no backward-compat baggage — there's only one version going forward in OSS land). Older V2/V3 files from the hosted product load fine; resaving rewrites the `format_version`.

Save preserves everything in the file. Sessions, todos, dashboard state, tool data — all round-trip through, even though the runner doesn't use them. Bookkeepers keep their full history; nothing is silently dropped.

## API surface available to custom tool code

The full reference is in [`src/apiReference.ts`](./src/apiReference.ts) and is the same text bundled into the Modify prompts. Summary:

- `api.getParameter(name)` / `api.getParameterMeta(name)` / `api.setParameter(name, value)`
- `await api.setUserData(name, value)` — persists into the workspace
- `api.addMessage({ markdown? | html? })`
- `await api.fetch(url, options?)` → `{ status, headers, data, text }`
- `api.getKnowledge(name)` → string | null
- `await api.llm.complete({ messages, max_tokens?, response_format? })` → `{ text, model, usage }`
- `await api.llm.classify({ data, categories, field?, context?, knowledge? })` → `{ data, summary }`
- `await api.llm.summarize({ data, focus?, context?, knowledge? })` → `{ summary }`

## Security model

- **Trust the `.wfp` file before opening it.** Custom tool code runs as JavaScript in this page with full DOM access. A malicious tool can read your LLM API key from `localStorage` and exfiltrate it via `fetch`. The threat model is the same as opening any executable file — only open files from sources you trust.
- **LLM key in localStorage.** Same caveat. There's no encrypted vault.
- **Markdown is rendered as HTML.** Custom tools can emit arbitrary HTML via `api.addMessage({ html: ... })`. The runner does not sanitize. Same trust boundary as above.
- **No sandbox in v1.** A future version may move custom tool execution into a sandboxed iframe with `postMessage`-mediated `api` calls. That would close the localStorage exfiltration hole.

## Repo layout

```
src/
  index.html         SPA shell — toolbar, sidebar, log, modals
  style.css          Plain CSS, no framework
  main.ts            UI wiring: open/save, render, modal handlers, prompt assembly, apply parsed JSON
  runner.ts          Workflow execution: node normalization, step_order iteration, native + ctool dispatch
  api.ts             `api.*` surface exposed to tool code, plus CSV parser and envelope helpers
  llm.ts             OpenAI-compat chat completions fetch
  storage.ts         File System Access (open/save .wfp) + localStorage (LLM settings)
  types.ts           .wfp V1 types
  apiReference.ts    Static markdown reference bundled into Modify prompts

build.ts             Bun build script → dist/wfp-runner.js (IIFE, single bundle)
serve.ts             Tiny static server for dist/
dist/                Built artifacts (commit-gitignored)
```

## License

(TBD)
