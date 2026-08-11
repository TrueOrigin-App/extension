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
const FRAME_PAGE = fileURLToPath(new URL("./frame.html", import.meta.url));
const FIXTURES = new URL("../src/providers/c2pa/fixtures/", import.meta.url);

// Explicit allowlist — nothing else in the fixtures directory (certs,
// configs) is served.
const FIXTURE_TYPES = new Map([
  ["ai_declared.png", "image/png"],
  ["ai_expired.png", "image/png"],
  ["C.jpg", "image/jpeg"],
  ["no_manifest.jpg", "image/jpeg"],
  ["cloud.jpg", "image/jpeg"],
]);

// This server sends no Access-Control-Allow-Origin header to any request
// from a real origin: the page loads from localhost, so a fixture
// referenced via 127.0.0.1 (a different origin) is a live strict-CORS
// case — in-page byte acquisition must fail and the task-5.5 worker
// fallback must take over. The one carve-out is `Origin: null` — an
// opaque-origin document (the data:-frame fixture) could otherwise never
// read fixture bytes in-page, and the extension deliberately never
// escalates opaque-origin frames to the worker (PR #13), so without ACAO
// that tier would be untestable. Real-origin requests never match, so the
// strict-CORS tier is unaffected.

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

  // Body is read before writeHead everywhere: headers committed before an
  // await mean a rejected read can only die on the catch's second
  // writeHead — ERR_HTTP_HEADERS_SENT as an unhandled rejection took the
  // whole server down (PR #13 review, finding 9).
  try {
    if (path === "/" || path === "/index.html") {
      const body = await readFile(PAGE);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }

    // Iframe fixture (roadmap chunk 2): embedded same-origin by the page
    // and cross-origin via the localhost/127.0.0.1 host flip.
    if (path === "/frame.html") {
      const body = await readFile(FRAME_PAGE);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
      return;
    }

    const fixture = path.startsWith("/fixtures/")
      ? decodeURIComponent(path.slice("/fixtures/".length))
      : undefined;
    const type = fixture ? FIXTURE_TYPES.get(fixture) : undefined;
    if (fixture && type) {
      const body = await readFile(new URL(fixture, FIXTURES));
      response.writeHead(200, {
        "content-type": type,
        // The Origin: null carve-out (header comment above). `*` rather
        // than echoing `null`: uncredentialed is the point.
        ...(request.headers.origin === "null"
          ? { "access-control-allow-origin": "*" }
          : {}),
      });
      response.end(body);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain" });
    }
    response.end(String(error));
  }
});

server.listen(PORT, () => {
  console.log(`TrueOrigin test page: http://localhost:${PORT}/`);
});
