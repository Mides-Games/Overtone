// Overtone in a browser: the same page, with the pywebview bridge carried over HTTP.
//
// The desktop window loads index.html from disk (file:) and pywebview supplies
// window.pywebview.api. Served by python/overtone_server.py (http: or https:),
// this script supplies it instead: every call is POST /api/v1/bridge/<method>,
// what Python pushes into the page arrives as server-sent events, and a file
// dialog is drawn here -- upload from this computer, or pick a file the
// server holds -- and answered back to the waiting Python thread.
(() => {
  "use strict";
  if (!/^https?:$/.test(location.protocol) || window.pywebview) return;

  const HEADERS = { "Content-Type": "application/json", "X-Overtone": "1" };

  async function post(url, body) {
    const reply = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body),
                                     credentials: "same-origin" });
    if (reply.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
    const data = await reply.json().catch(() => ({}));
    if (!reply.ok) throw new Error(data.error || `HTTP ${reply.status}`);
    return data;
  }

  const bridge = new Proxy({}, {
    get: (_target, method) => {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args) => post(`/api/v1/bridge/${encodeURIComponent(method)}`, { args })
        .then((data) => {
          // An export (.osz, CSV, click track) was written on the server:
          // offer it to this computer.
          if (data.result && data.result.download) offerDownload(data.result.download);
          return data.result;
        });
    },
  });

  // -- exports to this computer -------------------------------------------
  // The file is written on the server; a click here saves it on this PC.
  // Where the browser can ask for a place (Chrome, Edge), it does; elsewhere
  // it is an ordinary download.
  const TOAST_TEXT = {
    en: { ready: "{name} is ready ({size}). Download it to this computer?", yes: "Download",
          no: "Not now", busy: "Downloading {name}…", failed: "Could not download: {why}" },
    es: { ready: "{name} listo ({size}). ¿Descargarlo a esta PC?", yes: "Descargar",
          no: "Ahora no", busy: "Descargando {name}…", failed: "No se pudo descargar: {why}" },
  };

  function offerDownload(file) {
    // The page's own language (app.js sets it on <html>), English otherwise.
    const words = TOAST_TEXT[document.documentElement.lang] || TOAST_TEXT.en;
    const say = (key, values) => words[key].replace(/\{(\w+)\}/g, (_m, k) => values[k] ?? "");
    document.querySelectorAll(".ow-toast").forEach((old) => old.remove());
    const toast = document.createElement("div");
    toast.className = "ow-toast";
    toast.setAttribute("role", "status");
    toast.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99998;" +
      "display:flex;gap:12px;align-items:center;max-width:calc(100vw - 32px);padding:12px 14px 12px 16px;" +
      "border-radius:12px;background:#171a20;color:#e8eaee;border:1px solid #2a2f38;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.45);font:14px/1.4 system-ui,sans-serif";
    const text = document.createElement("span");
    const mb = file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    text.textContent = say("ready", { name: file.name, size: mb });
    text.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0";
    const yes = document.createElement("button");
    yes.textContent = say("yes", {});
    yes.style.cssText = "padding:7px 14px;border-radius:8px;border:0;background:#10b981;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer";
    const no = document.createElement("button");
    no.textContent = say("no", {});
    no.style.cssText = "padding:7px 10px;border-radius:8px;border:1px solid #2a2f38;background:transparent;color:inherit;font:13px system-ui,sans-serif;cursor:pointer";
    toast.append(text, yes, no);
    document.body.appendChild(toast);
    no.onclick = () => toast.remove();
    yes.onclick = async () => {
      const url = `/api/v1/download?${new URLSearchParams({ path: file.path })}`;
      try {
        if (window.showSaveFilePicker) {
          // Asked before anything is fetched, while the click still counts.
          const ext = (file.name.match(/\.[^.]+$/) || [""])[0];
          const handle = await window.showSaveFilePicker({ suggestedName: file.name,
            types: ext ? [{ description: ext.slice(1).toUpperCase(), accept: { "application/octet-stream": [ext] } }] : undefined });
          text.textContent = say("busy", { name: file.name });
          yes.disabled = no.disabled = true;
          const reply = await fetch(url, { credentials: "same-origin" });
          if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
          const writable = await handle.createWritable();
          await reply.body.pipeTo(writable);
        } else {
          const link = document.createElement("a");
          link.href = url; link.download = file.name;
          document.body.appendChild(link); link.click(); link.remove();
        }
        toast.remove();
      } catch (err) {
        if (err && err.name === "AbortError") { toast.remove(); return; }   // the person said no
        text.textContent = say("failed", { why: err.message || err });
        yes.disabled = no.disabled = false;
      }
    };
  }
  window.pywebview = { api: bridge, web: true };

  // -- Python -> page -------------------------------------------------------
  function listen() {
    const source = new EventSource("/api/v1/events", { withCredentials: true });
    source.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (event.kind === "js") {
        try { (0, eval)(event.code); } catch (err) { console.error("overtone event", err); }
      } else if (event.kind === "dialog") {
        openDialog(event);
      }
    };
    source.onerror = () => {
      // EventSource reconnects by itself, with Last-Event-ID; a lost session
      // is the one thing it cannot fix.
      fetch("/api/v1/whoami", { credentials: "same-origin" }).then((r) => {
        if (r.status === 401) location.href = "/login";
      }).catch(() => {});
    };
  }

  // -- file dialogs ---------------------------------------------------------
  const css = `
  .ow-veil { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 99999; }
  .ow-box { background: var(--bg-1, #171a20); color: var(--fg, #e8eaee); border: 1px solid var(--line, #2a2f38);
            border-radius: 12px; width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
            display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,.4); font: 14px/1.4 system-ui, sans-serif; }
  .ow-head { padding: 16px 18px 8px; font-weight: 600; font-size: 16px; }
  .ow-sub { padding: 0 18px 10px; opacity: .7; font-size: 13px; }
  .ow-path { padding: 0 18px 8px; font: 12px ui-monospace, monospace; opacity: .8; word-break: break-all; }
  .ow-list { overflow: auto; border-top: 1px solid var(--line, #2a2f38); border-bottom: 1px solid var(--line, #2a2f38); min-height: 160px; }
  .ow-row { display: flex; gap: 10px; align-items: center; padding: 7px 18px; cursor: pointer; }
  .ow-row:hover, .ow-row.on { background: rgba(16,185,129,.15); }
  .ow-row .ow-size { margin-left: auto; opacity: .6; font-size: 12px; }
  .ow-foot { display: flex; gap: 8px; padding: 12px 18px; align-items: center; flex-wrap: wrap; }
  .ow-foot input[type=text] { flex: 1; min-width: 160px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line, #2a2f38); background: transparent; color: inherit; }
  .ow-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line, #2a2f38); background: transparent; color: inherit; cursor: pointer; font: inherit; }
  .ow-btn.primary { background: #10b981; border-color: #10b981; color: #fff; font-weight: 600; }
  .ow-btn:disabled { opacity: .5; cursor: default; }
  .ow-note { padding: 0 18px 10px; font-size: 12px; opacity: .8; min-height: 1em; }`;

  function element(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function extensions(fileTypes) {
    // pywebview's "Audio files (*.mp3;*.ogg)" -> [".mp3", ".ogg"]
    const found = [];
    for (const type of fileTypes || []) {
      for (const match of String(type).matchAll(/\*(\.[\w]+)/g)) found.push(match[1].toLowerCase());
    }
    return found;
  }

  async function upload(file, folder) {
    const query = new URLSearchParams({ name: file.name });
    if (folder) query.set("folder", folder);
    const reply = await fetch(`/api/v1/upload?${query}`, {
      method: "PUT", headers: { "X-Overtone": "1" }, body: file, credentials: "same-origin" });
    const data = await reply.json().catch(() => ({}));
    if (!reply.ok) throw new Error(data.error || `HTTP ${reply.status}`);
    return data.path;
  }

  function openDialog(request) {
    if (!document.getElementById("ow-style")) {
      const style = element("style"); style.id = "ow-style"; style.textContent = css;
      document.head.appendChild(style);
    }
    const kind = request.type, multiple = request.multiple, exts = extensions(request.file_types);
    const titles = { open: multiple ? "Open files" : "Open a file", folder: "Choose a folder", save: "Save as" };
    const veil = element("div", "ow-veil"), box = element("div", "ow-box");
    const head = element("div", "ow-head", titles[kind] || "Choose");
    const sub = element("div", "ow-sub", kind === "save"
      ? "Saved on the server. Download it from the Exports folder here afterwards."
      : kind === "folder" ? "A folder on the server. Upload a whole folder from this computer, or pick one the server holds."
      : "Upload from this computer, or pick a file the server already holds.");
    const where = element("div", "ow-path"), list = element("div", "ow-list"), note = element("div", "ow-note");
    const foot = element("div", "ow-foot");
    box.append(head, sub, where, list, note, foot); veil.appendChild(box); document.body.appendChild(veil);

    let current = "", chosen = new Set(), answered = false;
    const finish = (paths) => {
      if (answered) return; answered = true;
      veil.remove();
      post("/api/v1/dialog", { id: request.id, paths: paths && paths.length ? paths : null })
        .catch((err) => console.error("overtone dialog", err));
    };

    const nameInput = element("input"); nameInput.type = "text"; nameInput.value = request.save_filename || "";
    const picker = element("input"); picker.type = "file"; picker.hidden = true;
    if (multiple || kind === "folder") picker.multiple = true;
    if (kind === "folder") picker.webkitdirectory = true;
    if (exts.length && kind === "open") picker.accept = exts.join(",");
    const uploadBtn = element("button", "ow-btn", kind === "folder" ? "Upload a folder…" : "Upload…");
    const okBtn = element("button", "ow-btn primary", kind === "save" ? "Save" : kind === "folder" ? "Use this folder" : "Open");
    const cancelBtn = element("button", "ow-btn", "Cancel");
    if (kind === "save") foot.append(nameInput);
    if (kind !== "save") foot.append(uploadBtn, picker);
    foot.append(cancelBtn, okBtn);

    const syncOk = () => {
      okBtn.disabled = kind === "save" ? !(nameInput.value.trim() && current)
        : kind === "folder" ? !current : chosen.size === 0;
    };

    async function show(path) {
      note.textContent = "";
      let data;
      try {
        const reply = await fetch(`/api/v1/browse?${new URLSearchParams({ path })}`, { credentials: "same-origin" });
        data = await reply.json();
        if (!reply.ok) throw new Error(data.error || `HTTP ${reply.status}`);
      } catch (err) { note.textContent = String(err.message || err); return; }
      current = data.path; chosen = new Set(); where.textContent = current || "Shared folders";
      list.replaceChildren();
      if (current) {
        const up = element("div", "ow-row", "⬑ ..");
        up.onclick = () => show(data.parent || "");
        list.appendChild(up);
      }
      for (const entry of data.entries) {
        const visible = entry.dir || kind === "save" || !exts.length
          || exts.some((ext) => entry.name.toLowerCase().endsWith(ext));
        if (!visible || (kind === "folder" && !entry.dir)) continue;
        const row = element("div", "ow-row");
        row.append(element("span", "", entry.dir ? "📁" : "🎵"), element("span", "", entry.name));
        if (!entry.dir) row.append(element("span", "ow-size", `${(entry.size / 1048576).toFixed(1)} MB`));
        row.onclick = () => {
          if (entry.dir) { show(entry.path); return; }
          if (kind === "save") { nameInput.value = entry.name; syncOk(); return; }
          if (!multiple) { chosen.clear(); list.querySelectorAll(".ow-row.on").forEach((r) => r.classList.remove("on")); }
          if (chosen.has(entry.path)) { chosen.delete(entry.path); row.classList.remove("on"); }
          else { chosen.add(entry.path); row.classList.add("on"); }
          syncOk();
        };
        row.ondblclick = () => { if (!entry.dir && kind === "open") finish([entry.path]); };
        list.appendChild(row);
      }
      syncOk();
    }

    uploadBtn.onclick = () => picker.click();
    picker.onchange = async () => {
      const files = Array.from(picker.files || []);
      if (!files.length) return;
      uploadBtn.disabled = okBtn.disabled = true;
      // A folder upload keeps its files together, named after the folder.
      const folder = kind === "folder" ? (files[0].webkitRelativePath || "").split("/")[0] || "folder"
        : files.length > 1 ? `batch-${Date.now()}` : "";
      const paths = [];
      try {
        for (const [i, file] of files.entries()) {
          note.textContent = `Uploading ${i + 1} of ${files.length}: ${file.name}`;
          paths.push(await upload(file, folder));
        }
      } catch (err) {
        note.textContent = `Upload failed: ${err.message || err}`;
        uploadBtn.disabled = false; syncOk(); return;
      }
      if (kind === "folder") {
        finish([paths[0].replace(/[\\/][^\\/]+$/, "")]);
      } else {
        finish(multiple ? paths : [paths[0]]);
      }
    };
    nameInput.oninput = syncOk;
    cancelBtn.onclick = () => finish(null);
    okBtn.onclick = () => {
      if (kind === "save") {
        const sep = current.includes("\\") ? "\\" : "/";
        finish([`${current}${sep}${nameInput.value.trim()}`]);
      } else if (kind === "folder") {
        finish([current]);
      } else {
        finish([...chosen]);
      }
    };
    veil.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(null); });
    show(request.directory || "");
  }

  // The server's measurement runs have a page of their own (runs.html).
  function testsLink() {
    const link = element("a", "", "Tests");
    link.href = "/runs.html";
    link.title = "Measurement runs on this server";
    link.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9000;padding:7px 14px;" +
      "border-radius:99px;background:#10b981;color:#fff;font:600 13px system-ui,sans-serif;" +
      "text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.25)";
    document.body.appendChild(link);
  }

  listen();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", testsLink);
  else testsLink();
  // app.js boots on pywebviewready; the bridge is ready as soon as this runs.
  const ready = () => window.dispatchEvent(new Event("pywebviewready"));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else setTimeout(ready, 0);
})();
