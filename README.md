# 🪟 WindowsAppPlayer

Run real Windows `.exe` / `.msi` applications **in your browser tab** — no virtual
machine, no installation, nothing uploaded anywhere. Drop a file, click Run, and
the app's window appears on the page.

## How it works (no VM — really)

Three layers stacked in one browser tab, all client-side:

1. **x86 CPU interpreter compiled to WebAssembly** (`boxedwine.wasm`) executes
   the machine code inside your EXE.
2. **Wine 1.7.55** (the Linux port of the Windows API, running inside the
   emulator) satisfies the EXE's Windows calls — `CreateWindowExA`, `ReadFile`,
   and friends.
3. **A browser bridge** maps Wine's display to an HTML `<canvas>`, routes your
   keyboard/mouse into the emulated machine, and provides an in-memory
   filesystem: your dropped files land on virtual drive `D:\`.

This is the [Boxedwine](https://www.boxedwine.org/) project (GPL-2.0) running
Wine (LGPL-2.1). The glue code is adapted from
[exebrowser](https://github.com/andrewnakas/exebrowser) (GPL-2.0). See
[NOTICE.md](NOTICE.md) for full provenance.

## Setup

Requires Node 18+ (only for the local static server; the app itself is plain
HTML/JS). Two commands:

```bash
npm run setup   # one-time: downloads ~62 MB of free runtime assets (see below)
npm start       # serves the site at http://localhost:8097
```

Then open **http://localhost:8097**, drop an `.exe` (or click *Try demo* to run
7-Zip immediately).

`npm run setup` fetches everything from public, license-respecting sources:

| File | Size | What it is |
|---|---|---|
| `runtime/boxedwine.wasm` + `.js` + shell + BrowserFS + JSZip | ~2.7 MB | Boxedwine Emscripten runtime (GPL-2.0) |
| `fs/fullWine1.7.55-v8` | 50 MB | Wine 1.7.55 root filesystem zip (LGPL-2.1) |
| `fs/wine1.7.55-v8-min-online.zip` | 9.7 MB | Overlay zip with audio-driver fix (LGPL-2.1) |
| `demo/7-zip.zip` | 0.8 MB | 7-Zip 9.20 (LGPL/BSD) — the demo app |

Downloads are skipped if files already exist, so the setup is resumable.

## What works, what doesn't

**Works well:** classic 32-bit Win32 apps from roughly 1995–2010 — utilities,
games, GUI tools that don't need 3D acceleration or .NET. Portable/zip'd apps
are the happy path. The demo 7-Zip is a good benchmark.

**Doesn't / limits:**
- **64-bit apps**: run them with the **64-bit engine** (wine64 on Boxedwine64,
  selected in Step 2 or auto-picked from the EXE header). It's experimental:
  first boot downloads ~205 MB of rootfs, GUI apps need WebGL, and complex
  programs may fail — but a real wine64 session runs, and apps can be swapped
  into the live session without a reload.
- **32-bit classics**: Wine is 1.7.55 (2014-era). UWP, .NET-heavy, and modern
  installers generally fail on this engine.
- **Speed**: it's an interpreter, not a JIT — expect roughly 1990s-PC
  performance. Great for utilities and retro software, not for Chrome-era apps.
- **3D acceleration**: no hardware GL; DirectDraw-era 2D is fine.
- **Hosting note**: the 64-bit engine needs cross-origin isolation (for
  SharedArrayBuffer). The bundled coi-serviceworker provides it on any static
  host, including GitHub Pages.
- **.msi files**: handled by generating a small batch that calls Wine's
  `msiexec`. Wine 1.7.55's MSI support is dated — many installers (especially
  anything requiring .NET, VC++ runtimes, or admin elevation) will fail.
  Prefer portable `.exe` builds or a folder/zip of the already-installed app.
- Everything runs in-memory: files the app writes are discarded on reload
  (use *Download changed files* to export them).

## Using it

1. **Load an app** — drag a `.exe`/`.zip` onto the dropzone, or browse. A
   `.zip` (or a whole folder) is best when the app has DLLs/assets next to the
   EXE. If multiple executables exist, a picker appears.
2. **Run** — first run downloads the Wine system zip lazily (range requests,
   only the chunks actually touched). The app window appears in the right panel.
3. **Download changed files** — exports whatever the running app wrote
   (save games, configs, documents) as a zip.

### MSI flow

Dropping a `.msi` stages the file and launches it via an auto-generated
`RUN.MSI.BAT`:

```bat
@echo off
msiexec /i "d:\userapp\SETUP.MSI"
```

If the install succeeds you'll find the program under `C:\Program Files\...` —
launch those apps by dropping their folder (with the installed `.exe`) next
time, since the in-memory disk is wiped on reload.

## Project layout

```
WindowsAppPlayer/
├── index.html            # launcher UI
├── app.js                # Boxedwine glue (GPL-2.0, derived from exebrowser)
├── server.mjs            # static server with HTTP Range support (stdlib only)
├── scripts/fetch-runtime.mjs  # one-time asset download
├── runtime/ fs/ demo/    # downloaded by setup (gitignored)
├── NOTICE.md             # provenance + licenses
└── LICENSE               # GPL-2.0
```

## FAQ

**Is this a VM?** No. No OS image, no hypervisor, no container — it's a
user-space CPU interpreter + Wine compiled to WebAssembly, same security model
as any web page.

**Where do my files go?** Nowhere. Everything is read locally into in-memory
filesystems inside the tab. The only network traffic is downloading the runtime
assets from this same server on first boot.

**Why does the first run take a while?** The 50 MB Wine root is fetched lazily
in chunks as Wine touches files. Subsequent runs are faster (browser cache).

**Free?** Yes — the runtime is GPL/LGPL open source, the assets are from
public mirrors, and the site has no backend, accounts, or paid services.
