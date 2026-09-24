// WindowsAppPlayer — zero-dependency static server with HTTP Range support.
//
// The Boxedwine "ondemand" filesystem lazily range-fetches chunks out of the
// 50 MB Wine root zip, so the server MUST answer `Range: bytes=N-M` with
// 206 Partial Content (Node's stdlib doesn't give us that for free, hence
// this tiny handler).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8097;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath.endsWith("/")) urlPath += "index.html";

    // browserfs.boxedwine.js hardcodes on-demand root-zip fetches to /api/fs/;
    // serve the same files there as under /fs/.
    if (urlPath.startsWith("/api/fs/")) urlPath = "/fs/" + urlPath.slice("/api/fs/".length);

    // Contain every lookup inside the project directory.
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found: " + urlPath);
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found: " + urlPath);
      return;
    }

    const size = stat.size;
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const baseHeaders = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        let start, end;
        if (m[1] === "") {
          // suffix range: last N bytes
          const n = Number(m[2]);
          start = Math.max(0, size - n);
          end = size - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        }
        if (isNaN(start) || isNaN(end) || start > end || start >= size) {
          res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
          return;
        }
        const len = end - start + 1;
        res.writeHead(206, {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": len,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, { ...baseHeaders, "Content-Length": size });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("500: " + err.message);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is another server running?`);
    console.error(`Try: PORT=<other-port> npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`WindowsAppPlayer running at http://localhost:${PORT}`);
  console.log(`Drop a .exe on the page to run it — no VM, no upload, everything stays on this machine.`);
});
