/*
 * server.js — zero-dependency live data server (Node 18+).
 *   REST   : /api/records (GET/POST), /api/records/:id (PUT/DELETE)
 *   Live   : /api/stream  (Server-Sent Events: every change is pushed to every browser)
 *   Tableau: /api/export.csv + data/export.csv (rewritten after every change)
 *
 * Run:  node server.js            (PORT=3000 by default)
 * Lock writes with a shared key:   EDIT_KEY=mysecret node server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const A = require("./public/js/analytics.js");
const PBI = require("./powerbi.js");

const PORT = Number(process.env.PORT) || 3000;
const EDIT_KEY = process.env.EDIT_KEY || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "records.json");
const SEED_FILE = path.join(__dirname, "data", "records.seed.json");
const CSV_FILE = process.env.CSV_FILE || path.join(path.dirname(DATA_FILE), "export.csv");
const PUBLIC = path.join(__dirname, "public");
const MAX_BODY = 100 * 1024;
const PBI_URL = process.env.POWERBI_PUSH_URL || "";
const pusher = PBI.createPusher({ url: PBI_URL, flushMs: process.env.POWERBI_FLUSH_MS });
const PBI_STATE = path.join(path.dirname(DATA_FILE), "powerbi-state.json");

/* ---------------- storage ---------------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
if (!fs.existsSync(SEED_FILE) && fs.existsSync(DATA_FILE) && DATA_FILE.endsWith("records.json"))
  fs.copyFileSync(DATA_FILE, SEED_FILE); // keep a pristine copy for "Reset demo data"

let records = readJSON(DATA_FILE, []);
let rev = 1; // increments on every change; clients use it to detect missed updates

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(records, null, 1));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE); // atomic swap = no half-written file
      fs.writeFileSync(CSV_FILE, A.toCSV(records)); // Tableau Desktop can read this file
    } catch (e) { console.error("persist failed:", e.message); }
  }, 150);
}
function flushNow() { clearTimeout(saveTimer); saveTimer = null; try {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 1)); fs.writeFileSync(CSV_FILE, A.toCSV(records)); } catch {} }

function nextId() {
  let max = 0;
  for (const r of records) { const m = /^REC-(\d+)$/.exec(r.id); if (m) max = Math.max(max, Number(m[1])); }
  return "REC-" + String(max + 1).padStart(4, "0");
}

/* ---------------- live stream (SSE) ---------------- */
const clients = new Set();
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) send(c, event, data); }
function presence() { broadcast("presence", { online: clients.size }); }
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25000).unref(); // keeps tunnels (cloudflared) from idling out

/* ---------------- http helpers ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".csv": "text/csv; charset=utf-8" };
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Rev": String(rev), ...SEC_HEADERS });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
function authorized(req) { return !EDIT_KEY || req.headers["x-edit-key"] === EDIT_KEY; }

/* ---------------- API ---------------- */
async function handleApi(req, res, url) {
  const { pathname } = url;
  const m = req.method;

  if (pathname === "/api/config" && m === "GET") return json(res, 200, { editKeyRequired: !!EDIT_KEY, online: clients.size, rev, rows: records.length, powerBi: pusher.stats() });
  if (pathname === "/api/health" && m === "GET") return json(res, 200, { ok: true, rev, rows: records.length, online: clients.size });
  if (pathname === "/api/powerbi/fields" && m === "GET") return json(res, 200, { dataset: "SalesPulseStream", historicDataAnalysis: true, fields: PBI.FIELDS.map(([name, type]) => ({ name, type })) });
  if (pathname === "/api/records" && m === "GET") return json(res, 200, { records, rev });

  if (pathname === "/api/export.csv" && m === "GET") {
    res.writeHead(200, { "Content-Type": MIME[".csv"], "Content-Disposition": 'attachment; filename="dashboard_data.csv"', "Cache-Control": "no-store", ...SEC_HEADERS });
    return res.end(A.toCSV(records));
  }

  if (pathname === "/api/stream" && m === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SEC_HEADERS });
    res.write("retry: 2000\n\n");
    clients.add(res);
    send(res, "hello", { rev, online: clients.size });
    presence();
    req.on("close", () => { clients.delete(res); presence(); });
    return;
  }

  // ---- everything below mutates data ----
  if (["POST", "PUT", "DELETE"].includes(m) && pathname.startsWith("/api/") && !authorized(req))
    return json(res, 401, { error: "Edit key required or incorrect." });

  if (pathname === "/api/reset" && m === "POST") {
    const before = records;
    records = readJSON(SEED_FILE, []);
    rev++; persist(); pusher.replaced(before, records);
    broadcast("reset", { rev, records });
    return json(res, 200, { ok: true, rev, rows: records.length });
  }

  if (pathname === "/api/records" && m === "POST") {
    const body = await readBody(req);
    const v = A.validateRecord(body);
    if (!v.ok) return json(res, 422, { error: "Validation failed", details: v.errors });
    let id = typeof body.id === "string" && /^REC-\d{4,}$/.test(body.id) ? body.id : null; // allows "undo delete" to restore the same id
    if (id && records.some((r) => r.id === id)) return json(res, 409, { error: "id already exists" });
    const rec = { id: id || nextId(), ...v.value, lastUpdated: A.nowLocalISO(), version: 1 };
    records.push(rec); rev++; persist(); pusher.created(rec);
    broadcast("upsert", { record: rec, rev, op: "create" });
    return json(res, 201, rec);
  }

  const mm = /^\/api\/records\/(REC-\d{4,})$/.exec(pathname);
  if (mm && m === "PUT") {
    const idx = records.findIndex((r) => r.id === mm[1]);
    if (idx < 0) return json(res, 404, { error: "Record not found (it may have been deleted by someone else)." });
    const body = await readBody(req);
    if (body.baseVersion !== undefined && Number(body.baseVersion) !== records[idx].version)
      return json(res, 409, { error: "Someone else changed this record first.", current: records[idx] });
    const v = A.validateRecord(body);
    if (!v.ok) return json(res, 422, { error: "Validation failed", details: v.errors });
    const rec = { id: records[idx].id, ...v.value, lastUpdated: A.nowLocalISO(), version: records[idx].version + 1 };
    const old = records[idx];
    records[idx] = rec; rev++; persist(); pusher.updated(old, rec);
    broadcast("upsert", { record: rec, rev, op: "update" });
    return json(res, 200, rec);
  }
  if (mm && m === "DELETE") {
    const idx = records.findIndex((r) => r.id === mm[1]);
    if (idx < 0) return json(res, 404, { error: "Record not found" });
    const [gone] = records.splice(idx, 1); rev++; persist(); pusher.deleted(gone);
    broadcast("delete", { id: gone.id, rev });
    return json(res, 200, { ok: true, id: gone.id });
  }

  return json(res, 404, { error: "Unknown API route" });
}

/* ---------------- static files ---------------- */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("Forbidden"); } // blocks ../ traversal
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ...SEC_HEADERS });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Server error" });
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  Dashboard live at  http://localhost:${PORT}`);
    console.log(`  Rows loaded        ${records.length}`);
    console.log(`  Edit protection    ${EDIT_KEY ? "ON (EDIT_KEY set)" : "OFF  -> set EDIT_KEY before sharing publicly"}`);
    console.log(`  Export CSV         ${CSV_FILE}`);
    console.log(`  Power BI push      ${pusher.enabled ? "ON  -> every change is sent to your streaming dataset" : "OFF -> set POWERBI_PUSH_URL to enable"}`);
    console.log(`  Share it           cloudflared tunnel --url http://localhost:${PORT}\n`);
    if (!fs.existsSync(CSV_FILE)) persist();
    if (PBI.backfillOnce(pusher, records, PBI_STATE, PBI_URL, process.env.POWERBI_BACKFILL === "1")) console.log(`  Power BI backfill  sending ${records.length} existing rows (one time)\n`);
  });
  const bye = () => { flushNow(); pusher.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
module.exports = { server, pusher, backfillStartup: () => PBI.backfillOnce(pusher, records, PBI_STATE, PBI_URL, process.env.POWERBI_BACKFILL === "1"), _state: () => ({ records, rev }) };
