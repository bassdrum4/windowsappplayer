// WindowsAppPlayer — run user-supplied Windows .exe/.msi files in the browser.
// 32-bit apps: Boxedwine (Wine 1.7.55 + x86 emulator → WebAssembly).
// 64-bit apps: Boxedwine64 (Debian wine64, wasm64 pthreads build).
//
// Derived from the ExeBrowser glue code (https://github.com/andrewnakas/exebrowser,
// GPL-2.0), which drives the Boxedwine project's shells. GPL-2.0 applies.
//
// Pipeline (32-bit):
// 1. Load jszip.min.js + browserfs.boxedwine.js from runtime/.
// 2. Evaluate boxedwine-shell.js + a Config block as ONE inline script (the
//    shell's `let Config` is block-scoped).
// 3. Inject boxedwine.js — the Emscripten runtime that fetches boxedwine.wasm.
// The user's files are zipped in-memory into "userapp.zip" (mounted at D:) and
// an XHR interceptor feeds that zip to the shell without a network hit.
//
// Pipeline (64-bit): the page embeds an iframe to ./64/?chunked=1&p=<prog>.
// The wine64 runtime there (boxedwine64.js + rootfs parts) runs Debian wine64;
// user EXEs are staged by writing the file into the running wine's home and
// calling the launcher's uploadAndRunExe() hook — no reload, the session stays
// warm. See 64/wine64-launcher.js ( GPL-2.0, exebrowser) for the guest side.
(() => {
"use strict";

// ─── runtime paths (same-origin, downloaded by scripts/fetch-runtime.mjs) ──
// Site-relative so the app works both at a domain root (local server) and in
// a sub-path (GitHub Pages serves project sites at /<repo>/).
const SITE_BASE = location.pathname.replace(/[^/]*$/, "/") || "/";
const RUNTIME_BASE = SITE_BASE + "runtime/";
const FS_BASE = SITE_BASE + "fs/";
const ROOT_ZIP = "fullWine1.7.55-v8";
const OVERLAY_ZIP = "wine1.7.55-v8-min-online";
const VIRTUAL_APP_ZIP = "userapp.zip";

const els = {
  dropzone: document.getElementById("appDropzone"),
  exeInput: document.getElementById("exeInput"),
  folderInput: document.getElementById("folderInput"),
  zipInput: document.getElementById("zipInput"),
  pickBtn: document.getElementById("pickBtn"),
  pickFolderBtn: document.getElementById("pickFolderBtn"),
  pickZipBtn: document.getElementById("pickZipBtn"),
  entryPickerWrap: document.getElementById("entryPickerWrap"),
  entryPicker: document.getElementById("entryPicker"),
  fileInfo: document.getElementById("fileInfo"),
  runBtn: document.getElementById("runBtn"),
  demoBtn: document.getElementById("demoBtn"),
  saveStateBtn: document.getElementById("saveStateBtn"),
  stopBtn: document.getElementById("stopBtn"),
  arch32: document.getElementById("arch32"),
  arch64: document.getElementById("arch64"),
  bootStatus: document.getElementById("bootStatus"),
  bootProgress: document.getElementById("bootProgress"),
  logOutput: document.getElementById("logOutput"),
  canvas: document.getElementById("canvas"),
  screenContainer: document.getElementById("screen-container"),
  frameWrap: document.getElementById("frame-wrap"),
  appFrame: document.getElementById("appFrame"),
};

const state = {
  depsLoaded: false,
  stagedFiles: [],
  candidateExes: [],
  pickedExe: null,
  appZipBlob: null,
  bootInFlight: false,
  booted: false,
  arch: "32", // "32" | "64"
  frameReady: false,
};

// ─── helpers ────────────────────────────────────────────────────────────
function log(msg, level = "info") {
  const ts = new Date().toLocaleTimeString();
  const prefix = level === "error" ? "[!]" : level === "warn" ? "[~]" : "[·]";
  els.logOutput.textContent += `${ts} ${prefix} ${msg}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}
function setStatus(text) { els.bootStatus.textContent = text; }
window.__wapLog = log;
window.__wapStatus = setStatus;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return await r.text();
}

// Boxedwine's shell queries several DOM ids our minimal page doesn't have.
// Checkbox stubs MUST be real <input type="checkbox"> nodes so .checked reads work.
function ensureShellDomStubs() {
  const stubs = [
    ["status", "div"], ["progress", "progress"], ["spinner", "div"],
    ["output", "pre"],
    ["startbtn", "button"], ["uploadbtn", "button"], ["downloadbtn", "button"],
    ["inline-runbtn", "button"], ["inline", "div"], ["run-inline", "button"],
    ["loading", "div"],
    ["showConsole", "input", { type: "checkbox", checked: false }],
    ["sound-checkbox", "input", { type: "checkbox" }],
    ["soundToggle", "input", { type: "checkbox", checked: true }],
    ["message", "div"], ["modalLink", "a"], ["modalLinkExe", "a"],
    ["openModalExeClick", "button"], ["tree", "div"], ["items", "div"],
    ["selectedItem", "div"], ["loadStatus", "div"],
    ["dropzone", "div"],
  ];
  for (const [id, tag, attrs] of stubs) {
    if (!document.getElementById(id)) {
      const el = document.createElement(tag);
      el.id = id;
      if (attrs) for (const [k, v] of Object.entries(attrs)) el[k] = v;
      el.style.display = "none";
      document.body.appendChild(el);
    }
  }
}

// ─── XHR interception (feed the in-memory app zip to the shell) ─────────
function installXhrInterceptor() {
  if (installXhrInterceptor.done) return;
  installXhrInterceptor.done = true;
  const NativeXHR = window.XMLHttpRequest;
  const origOpen = NativeXHR.prototype.open;
  const origSend = NativeXHR.prototype.send;
  const origSetRequestHeader = NativeXHR.prototype.setRequestHeader;

  NativeXHR.prototype.open = function (method, url, async, user, pass) {
    let u = String(url);
    // The Boxedwine ondemand filesystem hardcodes "/api/fs/" as the prefix for
    // root-zip chunk fetches. A static host (GitHub Pages) has no such route,
    // so rewrite it to the same-origin fs/ directory that holds the zips.
    if (u.startsWith("/api/fs/")) u = FS_BASE + u.slice("/api/fs/".length);
    this.__wap_url = u;
    return origOpen.call(this, method, u, async !== false, user, pass);
  };
  NativeXHR.prototype.setRequestHeader = function (k, v) {
    if (this.__wap_url && this.__wap_url.includes(VIRTUAL_APP_ZIP)) {
      this.__wap_headers = this.__wap_headers || {};
      this.__wap_headers[k.toLowerCase()] = v;
      return;
    }
    return origSetRequestHeader.call(this, k, v);
  };
  NativeXHR.prototype.send = function (body) {
    const url = this.__wap_url || "";
    if (!url.includes(VIRTUAL_APP_ZIP)) return origSend.call(this, body);
    if (!state.appZipBlob) {
      log("Internal: XHR for user app zip but no blob ready.", "error");
      this.readyState = 4; this.status = 500;
      this.onreadystatechange && this.onreadystatechange();
      return;
    }
    const xhr = this;
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const headers = xhr.__wap_headers || {};
      let responseBytes = bytes;
      let status = 200;
      if (headers["range"]) {
        const m = /bytes=(\d+)-(\d+)?/.exec(headers["range"]);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10) + 1, bytes.length) : bytes.length;
          responseBytes = bytes.slice(start, end);
          status = 206;
        }
      }
      Object.defineProperty(xhr, "readyState", { value: 4, writable: true });
      Object.defineProperty(xhr, "status", { value: status, writable: true });
      let responseText = "";
      for (let i = 0; i < responseBytes.length; i++) {
        responseText += String.fromCharCode(responseBytes[i]);
      }
      Object.defineProperty(xhr, "responseText", { value: responseText, writable: true });
      Object.defineProperty(xhr, "response", { value: responseBytes.buffer, writable: true });
      xhr.getResponseHeader = function (name) {
        if (name.toLowerCase() === "content-length") return String(state.appZipBlob.size);
        return null;
      };
      if (xhr.onreadystatechange) xhr.onreadystatechange();
      if (xhr.onload) xhr.onload();
    };
    reader.readAsArrayBuffer(state.appZipBlob);
  };
}

// ─── 32-bit shell bootstrap ─────────────────────────────────────────────
async function loadBoxedwineDeps() {
  if (state.depsLoaded) return;
  setStatus("Loading Boxedwine runtime…");
  els.bootProgress.hidden = false;
  els.bootProgress.value = 10;
  await loadScript(RUNTIME_BASE + "jszip.min.js");
  els.bootProgress.value = 30;
  await loadScript(RUNTIME_BASE + "browserfs.boxedwine.js");
  els.bootProgress.value = 45;
  ensureShellDomStubs();
  state.depsLoaded = true;
  log("Runtime dependencies loaded.");
}

async function runShellWithConfig() {
  setStatus("Configuring Wine launch…");
  els.bootProgress.value = 55;
  const shellSrc = await fetchText(RUNTIME_BASE + "boxedwine-shell.js");

  const exeName = state.pickedExe.path.replace(/\//g, "\\");
  // NOTE: the shell's getParameter() does plain string splitting and never
  // URL-decodes, so p/root/app values must be passed raw.
  const urlParams = [
    "ondemand=root",
    "root=" + ROOT_ZIP,
    "inline-default-ondemand-root-overlay=" + OVERLAY_ZIP,
    "app=" + VIRTUAL_APP_ZIP.replace(/\.zip$/, ""),
    "p=" + "d:\\userapp\\" + exeName,
    "auto=true",
    "sound=true",
    "bpp=32",
  ].join("&");

  const configCode = `
Config.isRunningInline = true;
Config.locateRootBaseUrl = ${JSON.stringify(FS_BASE)};
Config.locateAppBaseUrl = ${JSON.stringify(FS_BASE)};
Config.locateOverlayBaseUrl = ${JSON.stringify(FS_BASE)};
Config.urlParams = ${JSON.stringify(urlParams)};
var __origPreRun = Module.preRun ? Module.preRun.slice() : [];
Module.canvas = document.getElementById("canvas");
Module.print = function (t) { window.__wapLog(String(t)); };
Module.printErr = function (t) { window.__wapLog(String(t), "warn"); };
Module.setStatus = function (t) { if (t) window.__wapStatus(t); };
Module.locateFile = function (path) { return ${JSON.stringify(RUNTIME_BASE)} + path; };
window.__BoxedwineConfig = Config;
window.__BoxedwineModule = Module;
`;
  await runInlineScript(shellSrc + "\n;\n" + configCode);
  if (!window.__BoxedwineConfig) {
    throw new Error("Combined shell+config script failed to expose Config.");
  }
  log(`Wine 32-bit shell configured (program=${state.pickedExe.path}).`);
}

function runInlineScript(code) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.textContent = code;
    s.onerror = () => reject(new Error("inline script error"));
    try {
      document.head.appendChild(s);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

async function startEmulator() {
  setStatus("Starting emulator…");
  els.bootProgress.value = 80;
  await loadScript(RUNTIME_BASE + "boxedwine.js");
  els.bootProgress.value = 100;
  els.bootProgress.hidden = true;
  installAudioReviver();
}

// Chrome blocks AudioContext until a user gesture; Boxedwine creates one
// inside SDL_OpenAudio and never resumes it. Poll and resume on any gesture.
function installAudioReviver() {
  let resumed = false;
  const tryResume = () => {
    const ctx = window.Module && window.Module.SDL2 && window.Module.SDL2.audioContext;
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      ctx.resume().then(
        () => log("AudioContext resumed."),
        (e) => log("AudioContext resume failed: " + e, "warn")
      );
    }
    resumed = true;
    return true;
  };
  const start = Date.now();
  const poll = setInterval(() => {
    if (resumed || Date.now() - start > 30000) clearInterval(poll);
    else tryResume();
  }, 250);
  window.addEventListener("click", tryResume, { capture: true });
  window.addEventListener("keydown", tryResume, { capture: true });
}

// ─── staging user files ────────────────────────────────────────────────
function clearStaged() {
  state.stagedFiles = [];
  state.candidateExes = [];
  state.pickedExe = null;
  els.entryPickerWrap.hidden = true;
  els.entryPicker.innerHTML = "";
  els.fileInfo.textContent = "";
  els.runBtn.disabled = true;
}

function refreshEntryPicker() {
  state.candidateExes = state.stagedFiles
    .filter((f) => /\.(exe|bat|msi)$/i.test(f.path))
    .sort((a, b) => {
      const rank = (p) => (/\.exe$/i.test(p) ? 0 : /\.msi$/i.test(p) ? 1 : 2);
      return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
    });
  if (state.candidateExes.length === 0) {
    els.entryPickerWrap.hidden = true;
    els.runBtn.disabled = true;
    state.pickedExe = null;
    log("No .exe, .msi or .bat found in the supplied files.", "warn");
    setStatus("No runnable program found — try a .exe, or a folder/zip that contains one.");
    return;
  }
  if (state.candidateExes.length === 1) {
    els.entryPickerWrap.hidden = true;
    setEntry(state.candidateExes[0]);
    return;
  }
  els.entryPicker.innerHTML = "";
  for (const f of state.candidateExes) {
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = `${f.path} (${formatBytes(f.bytes.length)})`;
    els.entryPicker.appendChild(opt);
  }
  els.entryPickerWrap.hidden = false;
  setEntry(state.candidateExes[0]);
}

function setEntry(stagedFile) {
  const baseName = stagedFile.path.split("/").pop();
  state.pickedExe = {
    path: stagedFile.path,
    name: baseName,
    originalName: baseName,
    bytes: stagedFile.bytes,
  };
  const totalSize = state.stagedFiles.reduce((n, f) => n + f.bytes.length, 0);
  const suffix = state.stagedFiles.length > 1
    ? ` · ${state.stagedFiles.length} files, ${formatBytes(totalSize)} total`
    : "";
  const archLabel = state.arch === "64" ? "64-bit wine" : "32-bit Wine";
  els.fileInfo.textContent = `Entry: ${stagedFile.path} (${archLabel})${suffix}`;
  els.runBtn.disabled = false;
  setStatus(`Ready: ${baseName}. Click Run.`);
}

function warnIfNotPe(path, bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    log(`Warning: ${path} doesn't start with PE 'MZ' magic — it may not run.`, "warn");
  }
}

// Smell-test the PE header: a 64-bit (PE32+) binary can't run on the 32-bit
// engine, and 64-bit users should know before a baffling boot.
function peArch(bytes) {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const peOff = view.getUint32(0x3c, true);
    if (peOff + 6 > bytes.length) return null;
    const magic = view.getUint16(peOff + 0x18, true); // PE32=0x10b, PE32+=0x20b
    if (magic === 0x20b) return "64";
    if (magic === 0x10b) return "32";
  } catch (e) { /* fall through */ }
  return null;
}

function isMsiEntry(f) { return /\.msi$/i.test(f.path); }

async function handleSingleExe(file) {
  if (!file) return;
  clearStaged();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const safe = sanitizeExeName(file.name);
  warnIfNotPe(file.name, bytes);
  state.stagedFiles.push({ path: safe, bytes });
  log(`Loaded ${file.name} → ${safe} (${formatBytes(file.size)}).`);
  refreshEntryPicker();
}

function sanitizeExeName(name) {
  let base = name.replace(/^.*[\\/]/, "").replace(/\.(exe|msi)$/i, "");
  base = base.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  if (base.length === 0) base = "USERAPP";
  if (base.length > 8) base = base.slice(0, 8);
  return base + ".EXE";
}

function sanitizeRelPath(rel) {
  const parts = rel.split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..");
  if (parts.length === 0) return null;
  const out = parts.map((seg, i) => {
    const isLast = i === parts.length - 1;
    if (isLast && /\.(exe|msi)$/i.test(seg)) {
      return /\.msi$/i.test(seg)
        ? seg.replace(/[^A-Za-z0-9_.]/g, "_").toUpperCase()
        : sanitizeExeName(seg);
    }
    let s = seg.replace(/[^A-Za-z0-9_.()\- ]/g, "_");
    if (s.length === 0) s = "_";
    return s.toUpperCase();
  });
  return out.join("/");
}

async function handleFolder(fileList) {
  if (!fileList || fileList.length === 0) return;
  clearStaged();
  const files = Array.from(fileList);
  const firstSlash = (p) => p.indexOf("/");
  const topLevel = files
    .map((f) => f.webkitRelativePath || f.name)
    .map((p) => (firstSlash(p) >= 0 ? p.slice(0, firstSlash(p)) : ""))
    .filter(Boolean);
  const allSameTop = topLevel.length > 0 && topLevel.every((t) => t === topLevel[0]);
  for (const f of files) {
    const raw = f.webkitRelativePath || f.name;
    const stripped = allSameTop ? raw.slice(topLevel[0].length + 1) : raw;
    if (!stripped) continue;
    const safe = sanitizeRelPath(stripped);
    if (!safe) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
    state.stagedFiles.push({ path: safe, bytes });
  }
  log(`Loaded folder: ${state.stagedFiles.length} files staged.`);
  refreshEntryPicker();
}

async function handleZip(file) {
  if (!file) return;
  if (typeof JSZip === "undefined") {
    log("JSZip isn't loaded yet — try again in a moment.", "error");
    return;
  }
  clearStaged();
  const buf = await file.arrayBuffer();
  await stageFromZipBuffer(buf, file.name);
}

async function stageFromZipBuffer(buf, label) {
  const zip = new JSZip(buf); // JSZip 2.x: sync constructor
  for (const name of Object.keys(zip.files)) {
    const obj = zip.files[name];
    if (obj.dir) continue;
    const safe = sanitizeRelPath(name);
    if (!safe) continue;
    const bytes = obj.asUint8Array();
    if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
    state.stagedFiles.push({ path: safe, bytes });
  }
  log(`Loaded ${label}: ${state.stagedFiles.length} files staged.`);
  refreshEntryPicker();
}

// ─── demo app (7-Zip, license-clean) ────────────────────────────────────
async function runDemo() {
  if (state.booted) {
    log("An app is already running. Reload the page (F5) first.", "warn");
    return;
  }
  try {
    els.demoBtn.disabled = true;
    setStatus("Fetching demo app…");
    await loadBoxedwineDeps(); // JSZip must exist before we stage the zip
    const r = await fetch(SITE_BASE + "demo/7-zip.zip");
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching demo`);
    const buf = await r.arrayBuffer();
    clearStaged(); // don't mix the demo with whatever the user dropped earlier
    await stageFromZipBuffer(buf, "7-Zip demo");
    // Prefer the GUI file manager over the console binary so the demo shows
    // a visible window instead of help text on the log.
    const fm = state.candidateExes.find((f) => /7ZFM\.EXE$/i.test(f.path));
    if (fm) setEntry(fm);
    log("Demo staged. Launching…");
    await bootAndRun();
  } catch (err) {
    log("Demo failed: " + err.message, "error");
    setStatus("Demo failed — see console.");
  } finally {
    els.demoBtn.disabled = false;
  }
}

// ─── packaging + boot (32-bit) ──────────────────────────────────────────
async function buildAppZip() {
  if (typeof JSZip === "undefined") throw new Error("JSZip not loaded.");
  if (state.stagedFiles.length === 0 || !state.pickedExe) throw new Error("No files staged.");

  // The shell derives the working dir from the app zip basename (sans .zip):
  // userapp.zip → /root/files/userapp → drive D:\userapp.
  const zip = new JSZip();
  const ROOT = "userapp/";
  for (const f of state.stagedFiles) {
    zip.file(ROOT + f.path, f.bytes);
  }
  const entry = state.stagedFiles.find((f) => f.path === state.pickedExe.path);
  if (entry && isMsiEntry(entry)) {
    const msiName = entry.path.split("/").pop();
    const bat =
      "@echo off\r\n" +
      "msiexec /i \"d:\\userapp\\" + msiName.replace(/\//g, "\\") + "\"\r\n";
    zip.file(ROOT + "RUN.MSI.BAT", bat);
    log(`MSI entry: generated RUN.MSI.BAT → msiexec /i ${msiName}`);
  }
  const bytes = zip.generate({ type: "uint8array", compression: "STORE" });
  state.appZipBlob = new Blob([bytes], { type: "application/zip" });
  log(`Packaged ${state.stagedFiles.length} file(s) into virtual app zip (${formatBytes(state.appZipBlob.size)}).`);
}

async function bootAndRun() {
  if (state.bootInFlight) return;
  if (state.booted) {
    log("An app is already running. Reload the page (F5) to run a different one.", "warn");
    setStatus("Already running — reload the page to switch apps.");
    return;
  }
  if (!state.pickedExe) {
    log("Pick an app first.", "error");
    return;
  }
  if (state.arch === "64") {
    await bootAndRun64();
    return;
  }

  state.bootInFlight = true;
  els.runBtn.disabled = true;
  try {
    installXhrInterceptor();
    await loadBoxedwineDeps();
    await buildAppZip();
    await runShellWithConfig();
    els.screenContainer.classList.add("has-content");
    await startEmulator();
    state.booted = true;
    state.bootInFlight = false;
    els.saveStateBtn.disabled = false;
    els.stopBtn.disabled = false;
    setStatus(`Running ${state.pickedExe.originalName}… (32-bit)`);
    log("Launch dispatched. The app window will appear when Wine is ready.");
  } catch (err) {
    log("Boot failed: " + err.message, "error");
    setStatus("Boot failed — see console log.");
    els.runBtn.disabled = false;
    state.bootInFlight = false;
  }
}

// ─── 64-bit boot: drive the Boxedwine64 page in an iframe ──────────────
// First boot downloads the rootfs parts (~205 MB raw, less over the wire);
// after that the wine session stays warm in the frame and new apps spawn
// into it with no reload.
//
// Sequencing matters: the frame must boot WITH a program (?p=notepad.exe) —
// that mounts the pre-booted prefix, brings up the wineserver session, and
// pins it persistent. Booting the frame bare (no ?p) mounts no prefix and no
// session, and a later launchApp() would fall back to a full page reload,
// wiping anything we staged. Notepad is the warm-up app: once the session is
// ready we stage the user's files and spawn their app into the live kernel
// (the launcher's spawnIntoSession kills Notepad and adopts the new window).
const WARMUP_PROG = "notepad.exe";

function ensureFrame64() {
  return new Promise((resolve, reject) => {
    if (state.frameReady) return resolve();
    if (!els.appFrame.getAttribute("src")) {
      els.appFrame.src = `${SITE_BASE}64/?chunked=1&p=${encodeURIComponent(WARMUP_PROG)}&gltrace=0`;
    }
    let waited = 0;
    const iv = setInterval(() => {
      const w = els.appFrame.contentWindow;
      if (w && typeof w.uploadAndRunExe === "function" && typeof w.launchApp === "function") {
        clearInterval(iv);
        state.frameReady = true;
        resolve();
      } else if ((waited += 500) > 60000) {
        clearInterval(iv);
        reject(new Error("64-bit runtime page did not load (is 64/ deployed alongside this page?)"));
      }
    }, 500);
  });
}

// Wait until the frame's Emscripten runtime is up (Module.FS exists) and the
// wine session is ready (bw64_session_ready() === 1). First boot includes a
// ~205 MB rootfs download plus a slow emulated wineboot — hence the long cap.
function waitRuntime64(w, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const step = 500;
    (function poll() {
      const M = w.Module;
      const fsUp = M && M.FS && typeof M.FS.writeFile === "function";
      let session = false;
      if (fsUp && typeof M.ccall === "function") {
        try { session = M.ccall("bw64_session_ready", "number", [], []) === 1; } catch (e) {}
      }
      if (fsUp && session) return resolve();
      waited += step;
      if (waited > timeoutMs) {
        return reject(new Error("wine64 session did not become ready (first boot downloads ~205 MB and boots slowly; retry once it settles)"));
      }
      if (waited % 15000 === 0) {
        setStatus(`Booting wine64… (${Math.round(waited / 1000)}s — first boot fetches the rootfs once)`);
      }
      setTimeout(poll, step);
    })();
  });
}

// Write one file into the running wine64 session's home (Z:\home\username\userapp)
// and register it in Boxedwine's VFS — same mechanics as the launcher's own
// uploadAndRunExe, minus the auto-launch.
function putFile64(w, name, bytes) {
  const FS = w.Module.FS;
  const dest = "/home/username/userapp/" + name;
  const parts = dest.split("/").filter(Boolean);
  let p = "";
  for (const part of parts.slice(0, -1)) {
    p += "/" + part;
    try { FS.mkdir(p); } catch (e) { /* EEXIST */ }
  }
  try { FS.unlink(dest); } catch (e) { /* not there yet */ }
  FS.writeFile(dest, bytes);
  // The prefix dir was scanned (and cached) at boot; raw MEMFS writes are
  // invisible to the guest path resolver until registered.
  try {
    w.Module.ccall("bw64_register_file", "number", ["string"], ["/home/username/userapp/" + name]);
  } catch (e) {
    log(`VFS registration failed for ${name}: ${e}`, "warn");
  }
}

async function bootAndRun64() {
  state.bootInFlight = true;
  els.runBtn.disabled = true;
  try {
    if (isMsiEntry(state.pickedExe)) {
      // The 64-bit runtime stages plain files; msiexec needs the .bat launcher
      // flow, which only the 32-bit shell drives today.
      log("MSI files run on the 32-bit engine. Switching to 32-bit and booting there.", "warn");
      state.arch = "32";
      els.arch32.checked = true;
      els.arch64.checked = false;
      setArch("32");
      state.bootInFlight = false;
      return bootAndRun();
    }

    setStatus("Booting wine64 (first boot downloads the rootfs — progress shows in the frame)…");
    await ensureFrame64();
    const w = els.appFrame.contentWindow;
    await waitRuntime64(w);

    // Stage EVERY staged file so sibling DLLs/assets ride along, then spawn
    // the entry exe into the warm session (this replaces the Notepad warm-up).
    const entryName = state.pickedExe.path;
    log(`Staging ${state.stagedFiles.length} file(s) into the wine64 session…`);
    for (const f of state.stagedFiles) {
      putFile64(w, f.path, f.bytes);
    }
    const runProg = "Z:\\home\\username\\userapp\\" + entryName.replace(/\//g, "\\");
    log(`Launching ${runProg} under wine64.`);
    w.launchApp(runProg);
    els.screenContainer.classList.add("has-content");
    state.booted = true;
    state.bootInFlight = false;
    els.stopBtn.disabled = false;
    setStatus(`Running ${state.pickedExe.originalName}… (wine64)`);
  } catch (err) {
    log("64-bit boot failed: " + err.message, "error");
    setStatus("64-bit boot failed — see console log.");
    els.runBtn.disabled = false;
    state.bootInFlight = false;
  }
}

// ─── export what the app wrote (32-bit writable overlay delta) ─────────
function getWritableLayers() {
  const BFS = window.BrowserFS;
  if (!BFS) throw new Error("BrowserFS not initialized — run an app first.");
  const fs = BFS.BFSRequire("fs");
  const root = fs.getRootFS && fs.getRootFS();
  if (!root || !root.mntMap) throw new Error("BrowserFS root not mounted.");
  const cfg = window.__BoxedwineConfig || {};
  const homeMount = (cfg.appDirPrefix || "").replace(/\/$/, "");
  const out = [];
  for (const [mount, ov] of Object.entries(root.mntMap)) {
    if (mount !== "/root/base" && mount !== homeMount) continue;
    if (ov && typeof ov.getOverlayedFileSystems === "function") {
      const { writable } = ov.getOverlayedFileSystems();
      if (writable) out.push({ mount, writable });
    }
  }
  if (out.length === 0) throw new Error("No overlay layers found.");
  return out;
}

function collectWritableFiles(layer, mount = "", dir = "/") {
  const out = [];
  let entries;
  try { entries = layer.readdirSync(dir); } catch { return out; }
  const rootFs = mount ? window.BrowserFS.BFSRequire("fs") : null;
  for (const name of entries) {
    const full = dir === "/" ? "/" + name : dir + "/" + name;
    if (full === "/.deletedFiles.log") continue;
    let stat;
    try { stat = layer.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      out.push(...collectWritableFiles(layer, mount, full));
    } else if (stat.isFile()) {
      let buf;
      try {
        buf = rootFs ? rootFs.readFileSync(mount + full) : layer.readFileSync(full);
      } catch { continue; }
      out.push({ path: full.replace(/^\//, ""), bytes: buf });
    }
  }
  return out;
}

async function downloadWritableLayer() {
  try {
    if (state.arch === "64" && els.appFrame.contentWindow && els.appFrame.contentWindow.downloadSavedFiles) {
      els.appFrame.contentWindow.downloadSavedFiles();
      log("Export requested in the wine64 session.");
      return;
    }
    const layers = getWritableLayers();
    const zip = new JSZip();
    let totalBytes = 0, totalFiles = 0;
    for (const { mount, writable } of layers) {
      const files = collectWritableFiles(writable, mount);
      const folder = mount === "/root/base" ? "system" : "appdir";
      for (const f of files) {
        const bytes = f.bytes.buffer
          ? new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)
          : new Uint8Array(f.bytes);
        zip.file(`${folder}/${f.path}`, bytes);
        totalBytes += bytes.length;
        totalFiles++;
      }
    }
    if (totalFiles === 0) {
      log("Nothing was written yet — the app hasn't saved any files.", "warn");
      return;
    }
    const zipBytes = zip.generate({ type: "uint8array", compression: "DEFLATE" });
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    a.href = url;
    a.download = `windowsappplayer-output-${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    log(`Exported ${totalFiles} file(s), ${formatBytes(totalBytes)} → your downloads.`);
  } catch (err) {
    log("Export failed: " + err.message, "error");
  }
}

// ─── arch switching + stop ──────────────────────────────────────────────
function setArch(arch) {
  if (state.booted || state.bootInFlight) {
    log("Lock the architecture before running an app (reload to change).", "warn");
    // revert the toggle
    if (arch === "32") els.arch64.checked = true; else els.arch32.checked = true;
    return;
  }
  state.arch = arch;
  if (arch === "64") {
    els.appFrame.style.display = "";
    els.frameWrap.classList.add("active");
    els.canvas.style.display = "none";
    setStatus("64-bit mode: wine64 loads on first Run (~205 MB rootfs, cached after).");
    log("Switched to 64-bit (wine64) engine.");
  } else {
    els.appFrame.style.display = "none";
    els.frameWrap.classList.remove("active");
    els.canvas.style.display = "";
    setStatus("32-bit mode: classic Wine 1.7.55 engine.");
    log("Switched to 32-bit (Wine 1.7.55) engine.");
  }
}

function stopApp() {
  if (state.arch === "64") {
    // The 64-bit engine has no in-page teardown that survives (non-MODULARIZE
    // build); a frame reload is the honest stop.
    els.appFrame.src = `${SITE_BASE}64/?chunked=1`;
    state.frameReady = false;
    state.booted = false;
    log("wine64 session reset (frame reloaded).");
    return;
  }
  // 32-bit: the emulator can't re-init in-page; reload is the reliable stop.
  location.reload();
}

// ─── wiring ─────────────────────────────────────────────────────────────
els.pickBtn.addEventListener("click", (e) => { e.stopPropagation(); els.exeInput.click(); });
els.pickFolderBtn.addEventListener("click", (e) => { e.stopPropagation(); els.folderInput.click(); });
els.pickZipBtn.addEventListener("click", (e) => { e.stopPropagation(); els.zipInput.click(); });
els.exeInput.addEventListener("change", (e) => handleSingleExe(e.target.files[0]));
els.folderInput.addEventListener("change", (e) => handleFolder(e.target.files));
els.zipInput.addEventListener("change", (e) => handleZip(e.target.files[0]));
els.entryPicker.addEventListener("change", (e) => {
  const f = state.candidateExes.find((c) => c.path === e.target.value);
  if (f) setEntry(f);
});
els.runBtn.addEventListener("click", bootAndRun);
els.demoBtn.addEventListener("click", runDemo);
els.saveStateBtn.addEventListener("click", downloadWritableLayer);
els.stopBtn.addEventListener("click", stopApp);
els.arch32.addEventListener("change", () => els.arch32.checked && setArch("32"));
els.arch64.addEventListener("change", () => els.arch64.checked && setArch("64"));

els.dropzone.addEventListener("click", () => els.exeInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.exeInput.click(); }
});
els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("hover");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("hover"));
els.dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("hover");
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length === 0) return;
  if (files.length === 1 && /\.(exe|msi)$/i.test(files[0].name)) {
    handleSingleExe(files[0]);
  } else if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    handleZip(files[0]);
  } else {
    clearStaged();
    for (const f of files) {
      const safe = sanitizeRelPath(f.name);
      if (!safe) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
      state.stagedFiles.push({ path: safe, bytes });
    }
    log(`Dropped ${state.stagedFiles.length} file(s) (flat).`);
    refreshEntryPicker();
  }
});

// After an exe is staged, sniff its PE header: on 64-bit mode a 32-bit-only
// exe can't run (and vice versa) — flip the toggle automatically so the user
// doesn't have to know what they're holding.
const _origSetEntry = setEntry;
setEntry = function (stagedFile) {
  const arch = peArch(stagedFile.bytes);
  if (arch && !state.booted && !state.bootInFlight && state.arch !== arch) {
    log(`PE header says this is a ${arch}-bit binary — switching engine automatically.`);
    state.arch = arch;
    els.arch32.checked = arch === "32";
    els.arch64.checked = arch === "64";
    setArch(arch);
  }
  _origSetEntry(stagedFile);
};

// keep the canvas focusable so the app can take keyboard input
els.canvas.tabIndex = 0;

log("WindowsAppPlayer ready. Drop a .exe/.msi, or click 'Try demo (7-Zip)'.");
log("Modern/64-bit apps: flip the wine64 toggle — first boot fetches its rootfs once.");
})();
