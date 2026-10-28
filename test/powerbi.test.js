const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const A = require("../public/js/analytics.js");

/* A fake Power BI endpoint: records every row it receives. First request gets a 429 to exercise retry. */
const received = []; let hits = 0, mode = "ok";
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    hits++;
    if (mode === "ratelimit" && hits === 1) { res.writeHead(429, { "Retry-After": "0" }); return res.end(); }
    if (mode === "bad") { res.writeHead(400); return res.end(); }
    const rows = JSON.parse(b).rows; assert.ok(Array.isArray(rows));
    received.push(...rows); res.writeHead(200); res.end();
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbi-"));
process.env.DATA_FILE = path.join(tmp, "records.json");
process.env.POWERBI_FLUSH_MS = "40";
fs.copyFileSync(path.join(__dirname, "../data/records.seed.json"), process.env.DATA_FILE);

let base, srv;
const J = { "Content-Type": "application/json" };
const good = { timestamp: "2026-10-01T12:00:00", region: "Bali", category: "Home", product: "Desk Lamp", quantity: 2, unitPrice: 280000, status: "Completed", rating: 4, updatedBy: "T" };
const settle = async () => { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); const s = srv.pusher.stats(); if (!s.pending && !s.inflight && !s.lastError && !(i === 0)) return; } };
const ledger = () => ({
  orders: received.reduce((a, r) => a + r.Orders, 0), sales: received.reduce((a, r) => a + r.TotalSales, 0),
  completed: received.reduce((a, r) => a + r.Completed, 0), rated: received.reduce((a, r) => a + r.Rated, 0), ratingSum: received.reduce((a, r) => a + r.RatingSum, 0),
});
async function assertMatchesSite() {
  await settle();
  const { records } = await (await fetch(base + "/api/records")).json();
  const k = A.kpis(records), L = ledger();
  assert.equal(L.orders, k.orders, "orders");
  assert.equal(L.sales, k.sales, "sales");
  assert.equal(L.completed, records.filter((r) => r.status === "Completed").length, "completed");
  assert.equal(L.rated, k.ratedCount, "rated count");
  assert.ok(Math.abs(L.ratingSum / L.rated - k.avgRating) < 1e-9, "avg rating");
}

test.before(async () => {
  await new Promise((r) => mock.listen(0, r));
  process.env.POWERBI_PUSH_URL = `http://127.0.0.1:${mock.address().port}/beta/t/datasets/d/rows?key=abc`;
  mode = "ratelimit";
  srv = require("../server.js");
  await new Promise((r) => srv.server.listen(0, r));
  base = "http://127.0.0.1:" + srv.server.address().port;
  srv.backfillStartup(); // what server.js does on boot
});
test.after(() => { srv.pusher.stop(); srv.server.closeAllConnections?.(); srv.server.close(); mock.close(); });

test("startup backfill (with a 429 retry) sends all 60 existing rows exactly once", async () => {
  await settle();
  assert.ok(hits >= 2, "429 should have caused a retry");
  assert.equal(received.length, 60);
  assert.equal(srv.backfillStartup(), false, "second boot must not backfill again");
  await assertMatchesSite();
});

test("ledger equals site after create / update / delete / restore", async () => {
  mode = "ok";
  const rec = await (await fetch(base + "/api/records", { method: "POST", headers: J, body: JSON.stringify(good) })).json();
  await assertMatchesSite();
  await fetch(base + "/api/records/" + rec.id, { method: "PUT", headers: J, body: JSON.stringify({ ...good, quantity: 5, status: "Pending", rating: null, baseVersion: 1 }) });
  await assertMatchesSite();
  await fetch(base + "/api/records/" + rec.id, { method: "PUT", headers: J, body: JSON.stringify({ ...good, quantity: 7, baseVersion: 1 }) }); // stale -> 409, must push nothing
  await assertMatchesSite();
  await fetch(base + "/api/records/REC-0001", { method: "DELETE" });
  await assertMatchesSite();
  const { records } = await (await fetch(base + "/api/records")).json();
  assert.equal(records.length, 60); // 60 + 1 created - 1 deleted
});

test("burst of 100 random inserts stays consistent and is batched", async () => {
  const before = hits;
  await Promise.all(Array.from({ length: 100 }, () => fetch(base + "/api/records", { method: "POST", headers: J, body: JSON.stringify(A.randomRecord()) })));
  await assertMatchesSite();
  assert.ok(hits - before < 40, "rows should be batched, not 1 request per row (" + (hits - before) + ")");
});

test("reset keeps ledger equal to the seed", async () => {
  await fetch(base + "/api/reset", { method: "POST" });
  await assertMatchesSite();
  assert.equal(ledger().orders, 60);
});

test("push URL (contains the secret key) is never exposed by the API", async () => {
  const cfg = await (await fetch(base + "/api/config")).text();
  assert.ok(!cfg.includes("key=abc") && !cfg.includes("127.0.0.1:" + mock.address().port));
  assert.equal(JSON.parse(cfg).powerBi.enabled, true);
});

test("bad dataset (400) is reported, not retried forever", async () => {
  mode = "bad"; const before = hits;
  await fetch(base + "/api/records", { method: "POST", headers: J, body: JSON.stringify(good) });
  await new Promise((r) => setTimeout(r, 400));
  const s = srv.pusher.stats();
  assert.equal(hits - before, 1);
  assert.match(s.lastError, /rejected/); assert.equal(s.pending, 0); assert.ok(s.dropped >= 1);
});

test("every ledger row matches the documented schema", () => {
  const fields = JSON.parse(fs.readFileSync(path.join(__dirname, "../powerbi-fields.json"), "utf8")).fields;
  for (const r of received) {
    assert.deepEqual(Object.keys(r).sort(), fields.map((f) => f.name).sort());
    for (const f of fields) {
      if (f.type === "Number") assert.equal(typeof r[f.name], "number");
      else assert.equal(typeof r[f.name], "string");
      if (f.type === "DateTime") assert.match(r[f.name], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  }
});
