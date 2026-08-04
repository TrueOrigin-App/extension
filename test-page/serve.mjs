// Zero-dependency static server for the checkpoint test page. Serves the page
// itself plus the C2PA fixtures already vendored in the repo. Dev-only —
// never part of the extension package.
//
//   npm run test-page   →  http://localhost:8917/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8917);
const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));
const FIXTURES = new URL("../src/providers/c2pa/fixtures/", import.meta.url);

// Explicit allowlist — nothing else in the fixtures directory (certs,
// configs) is served.
const FIXTURE_TYPES = new Map([
  ["ai_declared.png", "image/png"],
  ["C.jpg", "image/jpeg"],
  ["no_manifest.jpg", "image/jpeg"],
  ["cloud.jpg", "image/jpeg"],
]);

// This server deliberately sends no Access-Control-Allow-Origin header:
// the page loads from localhost, so a fixture referenced via 127.0.0.1 (a
// different origin) is a live strict-CORS case — in-page byte acquisition
// must fail and the task-5.5 worker fallback must take over.

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  // One line per hit, with the requested host so render (localhost),
  // blocked in-page analysis attempts, and worker-fallback fetches
  // (127.0.0.1) are tellable apart — the task-5.2 double-fetch collapse
  // and the task-5.5 fallback are both checkable from the server side.
  console.log(
    new Date().toISOString(),
    request.method,
    `${request.headers.host ?? "?"}${path}`,
  );

  try {
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await readFile(PAGE));
      return;
    }

    const fixture = path.startsWith("/fixtures/")
      ? decodeURIComponent(path.slice("/fixtures/".length))
      : undefined;
    const type = fixture ? FIXTURE_TYPES.get(fixture) : undefined;
    if (fixture && type) {
      response.writeHead(200, { "content-type": type });
      response.end(await readFile(new URL(fixture, FIXTURES)));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error));
  }
});

server.listen(PORT, () => {
  console.log(`TrueOrigin test page: http://localhost:${PORT}/`);
});
