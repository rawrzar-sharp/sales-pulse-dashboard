/*
 * store.js — one interface, two backends:
 *   "live"  -> talks to server.js (REST + Server-Sent Events). Multi-user, real-time.
 *   "local" -> localStorage + BroadcastChannel. Used when the page is opened without the
 *              server (e.g. double-click index.html). Syncs between tabs of ONE browser only.
 * The UI never knows which one it is using.
 */
(function (root) {
  "use strict";
  const A = root.Analytics;

  function mkError(msg, status, extra) { return Object.assign(new Error(msg), { status }, extra || {}); }

  function Emitter() {
    const subs = new Set();
    return { on(fn) { subs.add(fn); return () => subs.delete(fn); }, emit(evt) { subs.forEach((fn) => { try { fn(evt); } catch (e) { console.error(e); } }); } };
  }

  /* =================== LIVE =================== */
  function LiveStore() {
    const em = Emitter();
    let records = [];
    let es = null, key = "", rev = 0, helloAt = 0, pollTimer = null, down = false, polling = false;
    try { key = sessionStorage.getItem("dash.editKey") || ""; } catch {}
    const self = {
      mode: "live", on: em.on, editKeyRequired: false,
      // "push" = instant (Server-Sent Events). "poll" = checks the server every ~1.5 s. Cloudflare QUICK tunnels
      // (trycloudflare.com) do not support SSE, so there the app automatically uses "poll".
      get transport() { return helloAt ? "push" : "poll"; },
      get records() { return records; },
      get exportUrl() { return "/api/export.csv"; },
      setKey(k) { key = k; try { sessionStorage.setItem("dash.editKey", k); } catch {} },
      hasKey() { return !!key || !self.editKeyRequired; },
    };

    async function api(method, url, body) {
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json", ...(key ? { "x-edit-key": key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      const xr = Number(res.headers.get("x-rev")); if (res.ok && method !== "GET" && xr === rev + 1) rev = xr; // only if nothing else slipped in between
      if (!res.ok) throw mkError(data.error || "Request failed (" + res.status + ")", res.status, { details: data.details, current: data.current });
      return data;
    }
    function upsertLocal(rec) {
      const i = records.findIndex((r) => r.id === rec.id);
      if (i >= 0) { if (records[i].version > rec.version) return false; records[i] = rec; } else records.push(rec);
      return true;
    }
    async function loadAll() {
      const d = await api("GET", "/api/records");
      records = d.records; rev = d.rev; em.emit({ type: "snapshot" });
    }
    // Safety net that makes live updates work through ANY proxy/tunnel: ask the server for its revision number.
    // If it is ahead of ours, we missed something (SSE blocked/buffered) -> reload. Cheap: one tiny request.
    async function watchdog() {
      clearTimeout(pollTimer);
      try {
        const h = await (await fetch("/api/health", { cache: "no-store" })).json();
        if (down) { down = false; em.emit({ type: "status", connected: true }); rev = -1; }
        if (typeof h.online === "number" && !helloAt) em.emit({ type: "presence", online: h.online });
        if (h.rev > rev) await loadAll();
      } catch {
        if (!down) { down = true; em.emit({ type: "status", connected: false }); }
      }
      pollTimer = setTimeout(watchdog, helloAt && !down ? 5000 : 1500);
    }

    self.init = async function () {
      const cfg = await api("GET", "/api/config");
      self.editKeyRequired = cfg.editKeyRequired;
      await loadAll();
      try {
        es = new EventSource("/api/stream");
        const setRev = (d) => { if (d.rev === rev + 1) rev = d.rev; }; // a gap means we missed something: the watchdog reloads
        es.addEventListener("hello", (e) => { const d = JSON.parse(e.data); helloAt = Date.now(); em.emit({ type: "presence", online: d.online }); });
        es.addEventListener("presence", (e) => em.emit({ type: "presence", online: JSON.parse(e.data).online }));
        es.addEventListener("upsert", (e) => {
          const d = JSON.parse(e.data); setRev(d);
          if (upsertLocal(d.record)) em.emit({ type: "upsert", record: d.record, op: d.op });
        });
        es.addEventListener("delete", (e) => {
          const d = JSON.parse(e.data); setRev(d);
          const i = records.findIndex((r) => r.id === d.id);
          if (i >= 0) { const [gone] = records.splice(i, 1); em.emit({ type: "delete", record: gone }); }
        });
        es.addEventListener("reset", (e) => { const d = JSON.parse(e.data); setRev(d); records = d.records; em.emit({ type: "snapshot", reset: true }); });
        es.addEventListener("error", () => { helloAt = 0; }); // browser retries by itself; meanwhile polling covers us
      } catch { /* no EventSource: polling only */ }
      watchdog();
    };

    self.create = (data) => api("POST", "/api/records", data).then((r) => { if (upsertLocal(r)) em.emit({ type: "upsert", record: r, op: "create" }); return r; });
    self.update = (id, data, baseVersion) => api("PUT", "/api/records/" + id, { ...data, baseVersion }).then((r) => { if (upsertLocal(r)) em.emit({ type: "upsert", record: r, op: "update" }); return r; });
    self.remove = (id) => api("DELETE", "/api/records/" + id).then(() => {
      const i = records.findIndex((r) => r.id === id);
      if (i >= 0) { const [gone] = records.splice(i, 1); em.emit({ type: "delete", record: gone }); }
    });
    self.restore = (rec) => api("POST", "/api/records", rec).then((r) => { if (upsertLocal(r)) em.emit({ type: "upsert", record: r, op: "create" }); return r; });
    self.reset = () => api("POST", "/api/reset").then(loadAll);
    return self;
  }

  /* =================== LOCAL =================== */
  function LocalStore() {
    const em = Emitter();
    const KEY = "dash.records.v1";
    let records = [];
    let bc = null;
    try { bc = new BroadcastChannel("dash-sync"); } catch {}
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(records)); } catch {} };
    const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(v)) return v; } catch {} return null; };
    const nextId = () => { let m = 0; records.forEach((r) => { const x = /^REC-(\d+)$/.exec(r.id); if (x) m = Math.max(m, +x[1]); }); return "REC-" + String(m + 1).padStart(4, "0"); };
    const ping = (msg) => { try { bc && bc.postMessage(msg); } catch {} };

    const self = {
      mode: "local", on: em.on, editKeyRequired: false,
      get records() { return records; },
      get exportUrl() { return null; },
      setKey() {}, hasKey() { return true; },
    };
    self.init = async function () {
      records = load() || JSON.parse(JSON.stringify(root.SEED_RECORDS || []));
      save();
      if (bc) bc.onmessage = (e) => {
        const m = e.data;
        if (m.type === "upsert") {
          const i = records.findIndex((r) => r.id === m.record.id);
          if (i >= 0) records[i] = m.record; else records.push(m.record);
          em.emit({ type: "upsert", record: m.record, op: m.op });
        } else if (m.type === "delete") {
          const i = records.findIndex((r) => r.id === m.id);
          if (i >= 0) { const [g] = records.splice(i, 1); em.emit({ type: "delete", record: g }); }
        } else if (m.type === "snapshot") { records = load() || []; em.emit({ type: "snapshot", reset: true }); }
      };
      em.emit({ type: "presence", online: 1 });
    };
    function check(data) { const v = A.validateRecord(data); if (!v.ok) throw mkError("Validation failed", 422, { details: v.errors }); return v.value; }

    self.create = async (data) => {
      const rec = { id: nextId(), ...check(data), lastUpdated: A.nowLocalISO(), version: 1 };
      records.push(rec); save(); ping({ type: "upsert", record: rec, op: "create" });
      em.emit({ type: "upsert", record: rec, op: "create" }); return rec;
    };
    self.update = async (id, data, baseVersion) => {
      const i = records.findIndex((r) => r.id === id);
      if (i < 0) throw mkError("Record not found (it may have been deleted in another tab).", 404);
      if (baseVersion !== undefined && baseVersion !== records[i].version) throw mkError("Another tab changed this record first.", 409, { current: records[i] });
      const rec = { id, ...check(data), lastUpdated: A.nowLocalISO(), version: records[i].version + 1 };
      records[i] = rec; save(); ping({ type: "upsert", record: rec, op: "update" });
      em.emit({ type: "upsert", record: rec, op: "update" }); return rec;
    };
    self.remove = async (id) => {
      const i = records.findIndex((r) => r.id === id);
      if (i < 0) throw mkError("Record not found", 404);
      const [g] = records.splice(i, 1); save(); ping({ type: "delete", id });
      em.emit({ type: "delete", record: g });
    };
    self.restore = async (rec) => {
      if (records.some((r) => r.id === rec.id)) throw mkError("id already exists", 409);
      const r2 = { ...rec, ...check(rec), id: rec.id, lastUpdated: A.nowLocalISO(), version: 1 };
      records.push(r2); save(); ping({ type: "upsert", record: r2, op: "create" });
      em.emit({ type: "upsert", record: r2, op: "create" }); return r2;
    };
    self.reset = async () => {
      records = JSON.parse(JSON.stringify(root.SEED_RECORDS || [])); save(); ping({ type: "snapshot" });
      em.emit({ type: "snapshot", reset: true });
    };
    return self;
  }

  async function createStore() {
    // Prefer the live server; fall back to local mode if /api is not reachable (e.g. file://)
    if (location.protocol.startsWith("http")) {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok && (r.headers.get("content-type") || "").includes("json")) { const s = LiveStore(); await s.init(); return s; }
      } catch {}
    }
    const s = LocalStore(); await s.init(); return s;
  }

  root.createStore = createStore;
})(typeof self !== "undefined" ? self : this);
