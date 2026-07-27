// Zero-dependency static server for the task-4 test page. Serves the page
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

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;

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
