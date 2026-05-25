// Build script: bundle src/main.ts and inline JS + CSS + the marked library
// into a self-contained dist/index.html. The output has no external
// dependencies: it runs from file:// or from any static host.

import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = import.meta.dir;
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const markedPath = path.join(srcDir, "vendor", "marked.umd.js");

const escapeForScript = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const escapeForStyle = (s: string) => s.replace(/<\/style/gi, "<\\/style");

async function build() {
  if (existsSync(distDir)) await rm(distDir, { recursive: true });
  await mkdir(distDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [path.join(srcDir, "main.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "none",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const jsArtifact = result.outputs.find((o) => o.kind === "entry-point");
  if (!jsArtifact) throw new Error("No JS entry point produced.");

  const [js, css, marked] = await Promise.all([
    jsArtifact.text(),
    readFile(path.join(srcDir, "style.css"), "utf8"),
    readFile(markedPath, "utf8"),
  ]);

  const html = await readFile(path.join(srcDir, "index.html"), "utf8");
  const inlined = html
    .replace(
      '<link rel="stylesheet" href="./style.css" />',
      `<style>\n${escapeForStyle(css)}\n</style>`,
    )
    .replace(
      '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
      `<script>\n${escapeForScript(marked)}\n</script>`,
    )
    .replace(
      '<script type="module" src="./main.ts"></script>',
      `<script>\n${escapeForScript(js)}\n</script>`,
    );

  for (const marker of ['href="./style.css"', "cdn.jsdelivr.net", 'src="./main.ts"']) {
    if (inlined.includes(marker)) {
      console.error(`Warning: "${marker}" still present in output — replacement may have missed.`);
    }
  }

  await writeFile(path.join(distDir, "index.html"), inlined);

  const sizeKb = (Buffer.byteLength(inlined, "utf8") / 1024).toFixed(1);
  console.log(
    `Built dist/index.html (${sizeKb} KB, self-contained). Open it directly, or run \`bun run serve\`.`,
  );
}

await build();
