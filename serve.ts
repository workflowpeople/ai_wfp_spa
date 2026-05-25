// Tiny static server for dist/. `bun run serve` then open http://localhost:5173.

import { file } from "bun";
import path from "node:path";

const distDir = path.join(import.meta.dir, "dist");
const port = Number(process.env.PORT || 5173);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    if (p === "/favicon.ico") return new Response(null, { status: 204 });
    const filePath = path.join(distDir, p);
    if (!filePath.startsWith(distDir)) return new Response("Not found", { status: 404 });
    const f = file(filePath);
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
    return new Response(f, {
      headers: { "Cache-Control": "no-store" },
    });
  },
});

console.log(`Serving dist/ at http://localhost:${port}`);
