# NOTICE — provenance and licenses

WindowsAppPlayer runs Windows applications in the browser by packaging three
open-source projects:

## Boxedwine — GPL-2.0
- Project: https://www.boxedwine.org/ · Source: https://github.com/danoon2/Boxedwine
- Files: `runtime/boxedwine.wasm`, `runtime/boxedwine.js`,
  `runtime/boxedwine-shell.js`, `runtime/browserfs.boxedwine.js`
- These are the Emscripten/WASM build of Boxedwine (x86 CPU interpreter +
  fake Linux kernel), as packaged by the exebrowser project. The
  `browserfs.boxedwine.js` file is BrowserFS with exebrowser's patch keeping
  on-demand root-zip fetches on same-origin paths.

## Wine 1.7.55 — LGPL-2.1
- Project: https://www.winehq.org/
- Files: `fs/fullWine1.7.55-v8` (root filesystem zip, range-fetched),
  `fs/wine1.7.55-v8-min-online.zip` (overlay with an audio-driver registry
  selection so apps can use the emulated OSS sound card). Both are Boxedwine's
  Wine filesystem zips; the overlay is the upstream file with one registry key
  (`Software\\Wine\\Drivers` → `Audio=oss`) documented at
  https://github.com/andrewnakas/exebrowser/blob/main/public/boxedwine/apps/NOTICE.md

## exebrowser glue — GPL-2.0
- Source: https://github.com/andrewnakas/exebrowser (© Andrew Nakas)
- `app.js` in this project is adapted from its `public/app.js` (user-file
  staging, virtual app zip + XHR interception, shell/Config injection,
  writable-layer export), reworked for a single Wine variant and local serving.
- `LICENSE` in this directory is the GPL-2.0 text applicable to this derived
  combination.

## JSZip — MIT
- File: `runtime/jszip.min.js` (bundled with Boxedwine's web build).

## Demo app — 7-Zip 9.20 (LGPL-2.1 + BSD)
- File: `demo/7-zip.zip`, unmodified, from exebrowser's license-clean app
  collection. https://www.7-zip.org/

## Trademarks
"Windows" is a trademark of Microsoft Corporation. This project is not
affiliated with, endorsed by, or sponsored by Microsoft, WineHQ, CodeWeavers,
or the Boxedwine project.
