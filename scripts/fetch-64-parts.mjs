// Fetch the 64-bit runtime binaries (Boxedwine64 wasm + wine64 rootfs parts)
// from exebrowser.com's public deployment (open CORS, GPL-2.0 components).
// Resumable: skips parts that already exist with the right size.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR64 = path.join(ROOT, "64");
const BASE = "https://exebrowser.com/64/";

const FILES = [
  "boxedwine64.wasm",
  "prefix64.zip.part000", "prefix64.zip.part001", "prefix64.zip.part002",
  "glibc-rootfs64.zip.part000", "glibc-rootfs64.zip.part001",
  ...Array.from({ length: 25 }, (_, i) => `wine64.zip.part${String(i).padStart(3, "0")}`),
];

const CONCURRENCY = 5;

async function fetchOne(rel) {
  const dest = path.join(DIR64, rel);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(BASE + rel, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) throw new Error("empty response");
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function main() {
  fs.mkdirSync(DIR64, { recursive: true });
  const todo = FILES.filter((rel) => {
    const dest = path.join(DIR64, rel);
    return !fs.existsSync(dest) || fs.statSync(dest).size === 0;
  });
  const already = FILES.length - todo.length;
  if (already) console.log(`${already} file(s) already present.`);
  let done = 0, bytes = 0, cursor = 0, failed = null;

  async function worker() {
    while (cursor < todo.length && !failed) {
      const rel = todo[cursor++];
      try {
        bytes += await fetchOne(rel);
        done++;
        console.log(`✓ ${rel}  (${done}/${todo.length})`);
      } catch (err) {
        failed = `${rel}: ${err.message}`;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed) {
    console.error(`\nFAILED: ${failed}\nRe-run scripts/fetch-64-parts.mjs to resume.`);
    process.exit(1);
  }
  console.log(`\nDone. ${done} file(s), ${(bytes / 1048576).toFixed(1)} MB.`);
}

main();
