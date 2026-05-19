// Static reference for the api.* surface exposed to tool code.
// Pasted into LLM prompts so external LLMs can author working tools.
// Keep in lockstep with src/api.ts — drift means generated tools break.

export const API_REFERENCE = `# WFP Tool API Reference

Tool code is a JavaScript function body executed by the WFP runner in the browser.
Top-level \`await\` is allowed. Available global: \`api\`.

## Parameter access

- \`api.getParameter(name)\` → the raw value (unwrapped from the typed envelope)
- \`api.getParameterMeta(name)\` → \`{ type, columns?, rowCount?, length? }\`
- \`api.setParameter(name, value)\` — session-scoped, lost when workflow ends. Auto-wraps raw values.
- \`await api.setUserData(name, value)\` — persists to user data; user can save back to the .wfp.

Workflow data is automatically wrapped in typed envelopes. Tools work with raw values.

## Messaging

- \`api.addMessage({ markdown: "..." })\` — appends a message to the output log (markdown rendered)
- \`api.addMessage({ html: "..." })\` — same, but raw HTML
- Use this for status updates, summaries, intermediate results.

## HTTP

- \`await api.fetch(url, options?)\` → \`{ status, headers, data, text }\`
  - options: \`{ method?, headers?, body?, timeout? }\`
  - \`data\` is JSON-parsed when possible; otherwise it equals \`text\`.

## Knowledge packs

- \`api.getKnowledge(name)\` → string | null — returns a pack's markdown content.

## LLM calls

- \`await api.llm.complete({ messages, max_tokens?, response_format? })\` → \`{ text, model, usage }\`
  - \`messages\`: \`[{ role: "system" | "user" | "assistant", content: string }, ...]\`
  - \`response_format\`: \`"text"\` (default) or \`"json_object"\` (LLM returns valid JSON)
- \`await api.llm.classify({ data, categories, field?, context?, knowledge? })\` → \`{ data, summary }\`
  - Returns input rows with a \`field\` (default \`"category"\`) added.
  - \`knowledge\`: array of knowledge pack names to include as context.
- \`await api.llm.summarize({ data, focus?, context?, knowledge? })\` → \`{ summary }\`
  - Returns a plain-text narrative summary.

## Conventions

- Read inputs at the top: \`const x = api.getParameter("input_name");\`
- Write outputs near the end: \`api.setParameter("output_name", result);\`
- The next workflow node reads outputs by parameter name.
- For downloadable reports, set a parameter like \`"report_html"\` — the workflow's \`download_data\` node handles the download.
- Numbers in CSV-derived data are strings — use \`parseFloat()\` / \`parseInt()\` before math.

## Workflow node schema (for \`workflow.nodes\` — which is a JSON-encoded string)

Each node MUST follow this exact shape:

\`\`\`json
{
  "node_id": "node-<6 hex>",
  "workflow_id": "<the parent workflow_id>",
  "type": "tool",
  "label": "<short human label>",
  "step_order": <integer, 1-based>,
  "tool_id": "<the tool to run — see below>",
  "toolParameters": { "<param_name>": "<literal value or {{variable_name}}>" }
}
\`\`\`

Valid \`tool_id\` values:

- \`"workflow_start"\` — required first node. \`toolParameters\`: \`{}\`. type: \`"start"\`.
- \`"workflow_end"\` — required last node. \`toolParameters\`: \`{}\`. type: \`"end"\`.
- \`"download_data"\` — triggers a browser download. \`toolParameters\`: \`{ "data": "{{some_param}}", "filename": "report.html", "inline": "true" }\`.
- \`"llm_step"\` — calls the LLM with a prompt. \`toolParameters\`: \`{ "prompt": "<text or {{var}}>" }\`. Sets a parameter called \`"llm_response"\`.
- \`"ctool-<6 hex>"\` — a custom tool from \`app_custom_tools\`. The tool's code runs with the resolved \`toolParameters\` available via \`api.getParameter(name)\`.

Important:
- \`workflow.edges\` can be \`"[]"\` — execution order follows \`step_order\`.
- \`toolParameters\` values like \`"{{green_capital_holdings}}"\` mean "use the value of the parameter named \`green_capital_holdings\`" (set by user_data or a previous tool's output).
- Inside custom tool code, read inputs by parameter name: \`api.getParameter("green_capital_holdings")\`.

## Example tool

\`\`\`js
const transactions = api.getParameter("bank_statement");
const accounts = api.getParameter("chart_of_accounts");

const result = await api.llm.classify({
  data: transactions,
  categories: accounts.map(a => a.name),
  field: "account",
  context: "Categorize each bank transaction into the best matching account."
});

api.setParameter("categorized_transactions", result.data);
api.addMessage({ markdown: \`Categorized \${result.data.length} transactions into \${accounts.length} accounts.\` });
\`\`\`
`;
