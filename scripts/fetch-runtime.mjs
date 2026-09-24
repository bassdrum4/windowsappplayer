// One-time download of the free, GPL/LGPL-licensed runtime this site needs.
// Everything comes from public URLs (GitHub raw + the exebrowser asset worker)
// and lives locally afterwards — the site itself makes zero network calls at
// runtime except for these same-origin files.
//
// Total: ~62 MB. Re-run any time; existing files are skipped.
//
// Provenance: runtime/ files are the Boxedwine Emscripten build (GPL-2.0)
// as packaged by the exebrowser project; fs/ contains the Wine 1.7.55 root
// filesystem zip (LGPL-2.1) and a small overlay zip; demo/ is 7-Zip
// (LGPL + BSD, unmodified installer).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RUNTIME_BASE = "https://raw.githubusercontent.com/andrewnakas/exebrowser/main/public/boxedwine/build/default/";
const WORKER_FS_BASE = "https://boxedwine-assets.andrew-nakas.workers.dev/fs/";
const RAW_APPS_BASE = "https://raw.githubusercontent.com/andrewnakas/exebrowser/main/public/boxedwine/apps/";
const RAW_DEMO_BASE = "https://raw.githubusercontent.com/andrewnakas/exebrowser/main/public/apps/7-zip/";

// [localPath, url] — the shell appends .zip to the root name before
// requesting it, so the root is stored (and served) with the suffix.
const FILES = [
  ["runtime/jszip.min.js", RUNTIME_BASE + "jszip.min.js"],
  ["runtime/browserfs.boxedwine.js", RUNTIME_BASE + "browserfs.boxedwine.js"],
  ["runtime/boxedwine-shell.js", RUNTIME_BASE + "boxedwine-shell.js"],
  ["runtime/boxedwine.js", RUNTIME_BASE + "boxedwine.js"],
  ["runtime/boxedwine.wasm", RUNTIME_BASE + "boxedwine.wasm"],
  ["fs/wine1.7.55-v8-min-online.zip", RAW_APPS_BASE + "wine1.7.55-v8-min-online.zip"],
  ["fs/fullWine1.7.55-v8.zip", WORKER_FS_BASE + "fullWine1.7.55-v8.zip"],
  ["demo/7-zip.zip", RAW_DEMO_BASE + "7-zip.zip"],
];

function download(url, dest, attempt = 1) {
  return fetch(url, { redirect: "follow" }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return buf.length;
  }).catch(async (err) => {
    if (attempt < 3) {
      console.log(`  retry ${attempt}/2 for ${path.basename(dest)} (${err.message})`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return download(url, dest, attempt + 1);
    }
    throw err;
  });
}

async function main() {
  console.log("WindowsAppPlayer runtime setup\n");
  let total = 0;
  let skipped = 0;
  for (const [rel, url] of FILES) {
    const dest = path.join(ROOT, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`✓ ${rel} (already present)`);
      skipped++;
      continue;
    }
    process.stdout.write(`↓ ${rel} … `);
    try {
      const bytes = await download(url, dest);
      total += bytes;
      console.log(`${(bytes / 1048576).toFixed(1)} MB`);
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      console.error("\nIf a GitHub URL 404s, the upstream repo may have moved.");
      console.error("If the worker URL fails, re-run later or see NOTICE.md for mirrors.");
      process.exit(1);
    }
  }
  console.log(`\nDone. ${skipped} already present, ${(total / 1048576).toFixed(1)} MB downloaded.`);
  console.log("Run `npm start` and open http://localhost:8097");
}

main();
