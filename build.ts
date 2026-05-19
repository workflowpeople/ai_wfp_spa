// Build script: bundle src/main.ts -> dist/wfp-runner.js, copy HTML + CSS.

import { rm, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = import.meta.dir;
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

async function build() {
  if (existsSync(distDir)) await rm(distDir, { recursive: true });
  await mkdir(distDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [path.join(srcDir, "main.ts")],
    outdir: distDir,
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "linked",
    naming: "wfp-runner.js",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Copy CSS as-is
  await copyFile(path.join(srcDir, "style.css"), path.join(distDir, "style.css"));

  // Rewrite the HTML to point at the built bundle name
  const html = await readFile(path.join(srcDir, "index.html"), "utf8");
  const rewritten = html.replace(
    /<script type="module" src="\.\/main\.ts"><\/script>/,
    '<script src="./wfp-runner.js"></script>',
  );
  await writeFile(path.join(distDir, "index.html"), rewritten);

  console.log("Built dist/ — open dist/index.html or run `bun run serve`.");
}

await build();
