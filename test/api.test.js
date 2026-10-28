const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// isolated data dir so tests never touch real data
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
process.env.DATA_FILE = path.join(tmp, "records.json");
process.env.EDIT_KEY = "secret";
fs.copyFileSync(path.join(__dirname, "../data/records.seed.json"), process.env.DATA_FILE);
const { server } = require("../server.js");

let base;
const H = (extra) => ({ "Content-Type": "application/json", "x-edit-key": "secret", ...extra });
const good = { timestamp: "2026-10-01T12:00:00", region: "Bali", category: "Home", product: "Desk Lamp", quantity: 2, unitPrice: 280000, status: "Completed", rating: 4, updatedBy: "Tester" };

test.before(() => new Promise((r) => server.listen(0, () => { base = "http://127.0.0.1:" + server.address().port; r(); })));
test.after(() => { server.closeAllConnections?.(); server.close(); });

test("GET records returns seed", async () => {
  const d = await (await fetch(base + "/api/records")).json();
  assert.equal(d.records.length, 60);
});

test("writes require the edit key; reads do not", async () => {
  let r = await fetch(base + "/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(good) });
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/records", { method: "POST", headers: H({ "x-edit-key": "wrong" }), body: JSON.stringify(good) });
  assert.equal(r.status, 401);
  assert.equal((await fetch(base + "/api/records")).status, 200);
  assert.equal((await (await fetch(base + "/api/config")).json()).editKeyRequired, true);
});

test("create -> update -> version conflict -> delete -> restore", async () => {
  let r = await fetch(base + "/api/records", { method: "POST", headers: H(), body: JSON.stringify(good) });
  assert.equal(r.status, 201);
  const rec = await r.json();
  assert.equal(rec.id, "REC-0061"); assert.equal(rec.version, 1);

  r = await fetch(base + "/api/records/" + rec.id, { method: "PUT", headers: H(), body: JSON.stringify({ ...good, quantity: 3, baseVersion: 1 }) });
  assert.equal(r.status, 200);
  const upd = await r.json(); assert.equal(upd.version, 2); assert.equal(upd.quantity, 3);

  r = await fetch(base + "/api/records/" + rec.id, { method: "PUT", headers: H(), body: JSON.stringify({ ...good, quantity: 9, baseVersion: 1 }) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).current.quantity, 3);

  r = await fetch(base + "/api/records/" + rec.id, { method: "DELETE", headers: H() });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base + "/api/records/" + rec.id, { method: "DELETE", headers: H() })).status, 404);

  r = await fetch(base + "/api/records", { method: "POST", headers: H(), body: JSON.stringify({ ...upd }) }); // undo = restore with same id
  assert.equal(r.status, 201); assert.equal((await r.json()).id, rec.id);
});

test("invalid payloads are rejected with details", async () => {
  const r = await fetch(base + "/api/records", { method: "POST", headers: H(), body: JSON.stringify({ ...good, region: "Mars", quantity: -1 }) });
  assert.equal(r.status, 422);
  assert.ok((await r.json()).details.length >= 2);
  const r2 = await fetch(base + "/api/records", { method: "POST", headers: H(), body: "{not json" });
  assert.equal(r2.status, 400);
});

test("oversized body is rejected", async () => {
  const big = JSON.stringify({ ...good, updatedBy: "x".repeat(200 * 1024) });
  let status;
  try { status = (await fetch(base + "/api/records", { method: "POST", headers: H(), body: big })).status; } catch { status = 413; }
  assert.equal(status, 413);
});

test("SSE pushes changes to every connected client", async () => {
  const ac = new AbortController();
  const res = await fetch(base + "/api/stream", { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  const readUntil = async (re) => { while (!re.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
  await readUntil(/event: hello/);
  const p = await (await fetch(base + "/api/records", { method: "POST", headers: H(), body: JSON.stringify({ ...good, updatedBy: "Live" }) })).json();
  await readUntil(/event: upsert/);
  assert.match(buf, new RegExp(p.id));
  ac.abort();
});

test("CSV export matches the records and is Tableau-friendly", async () => {
  const csv = await (await fetch(base + "/api/export.csv")).text();
  const { records } = await (await fetch(base + "/api/records")).json();
  assert.equal(csv.trim().split("\n").length, records.length + 1);
  assert.match(csv.split("\n")[0], /^Record ID,Timestamp,Date,Region/);
});

test("persistence: data file and export.csv are written", async () => {
  await new Promise((r) => setTimeout(r, 400));
  const saved = JSON.parse(fs.readFileSync(process.env.DATA_FILE, "utf8"));
  assert.ok(saved.length >= 61);
  assert.ok(fs.existsSync(path.join(tmp, "export.csv")));
});

test("static: serves index, blocks path traversal", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/js/analytics.js")).status, 200);
  assert.equal((await fetch(base + "/..%2f..%2fserver.js")).status, 403);
  assert.equal((await fetch(base + "/nope.txt")).status, 404);
});

test("reset restores seed for everyone", async () => {
  const r = await fetch(base + "/api/reset", { method: "POST", headers: H() });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(base + "/api/records")).json()).records.length, 60);
});
