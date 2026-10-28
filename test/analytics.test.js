const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const A = require("../public/js/analytics.js");

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/records.seed.json"), "utf8"));

test("seed has at least 50 rows with unique ids", () => {
  assert.ok(seed.length >= 50);
  assert.equal(new Set(seed.map((r) => r.id)).size, seed.length);
});

test("every seed row passes the same validation the server applies", () => {
  for (const r of seed) {
    const v = A.validateRecord(r);
    assert.ok(v.ok, `${r.id}: ${v.errors.join("; ")}`);
  }
});

test("KPI sales equals plain sum of qty*price (matches Excel Total Sales column)", () => {
  const expected = seed.reduce((a, r) => a + r.quantity * r.unitPrice, 0);
  assert.equal(A.kpis(seed).sales, expected);
  assert.equal(A.kpis(seed).orders, seed.length);
});

test("reconciliation passes for ALL and for every filter combination", () => {
  const combos = [{}, { range: 7 }, { range: 30 }, { range: 60 }, { regions: ["Bali"] }, { categories: ["Home", "Fashion"], statuses: ["Completed"] },
    { range: 7, regions: ["Jakarta", "Medan"], statuses: ["Pending", "Refunded"] }, { regions: ["Nowhere"] }];
  for (const f of combos) {
    const rows = A.filterRecords(seed, f);
    for (const c of A.reconcile(rows)) assert.ok(c.ok, `${JSON.stringify(f)} -> ${c.label}: ${c.actual} vs ${c.expected}`);
  }
});

test("empty selection produces zeros, not NaN", () => {
  const k = A.kpis([]);
  assert.deepEqual([k.sales, k.orders, k.aov, k.completionRate, k.avgRating], [0, 0, 0, 0, 0]);
  assert.deepEqual(A.byDay([]), []);
});

test("range filter is anchored on the latest record and inclusive", () => {
  const rows = [
    { id: "a", timestamp: "2026-10-01T10:00:00", region: "Bali", category: "Home", status: "Completed", quantity: 1, unitPrice: 1000 },
    { id: "b", timestamp: "2026-09-25T10:00:00", region: "Bali", category: "Home", status: "Completed", quantity: 1, unitPrice: 1000 },
    { id: "c", timestamp: "2026-09-24T23:59:59", region: "Bali", category: "Home", status: "Completed", quantity: 1, unitPrice: 1000 },
  ];
  assert.deepEqual(A.filterRecords(rows, { range: 7 }).map((r) => r.id), ["a", "b"]); // Sep 25..Oct 1 = 7 days
});

test("byDay is continuous (gap days are zero) and totals are preserved", () => {
  const rows = [
    { timestamp: "2026-02-27T08:00:00", quantity: 1, unitPrice: 5000 },
    { timestamp: "2026-03-02T08:00:00", quantity: 2, unitPrice: 5000 },
  ];
  const d = A.byDay(rows);
  assert.deepEqual(d.map((x) => x.date), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.deepEqual(d.map((x) => x.sales), [5000, 0, 0, 10000]);
});

test("validation rejects bad input", () => {
  const good = seed[0];
  const bad = [
    { ...good, region: "Atlantis" }, { ...good, quantity: 0 }, { ...good, quantity: 1.5 }, { ...good, unitPrice: -5 },
    { ...good, timestamp: "yesterday" }, { ...good, timestamp: "2026-02-31T10:00:00" }, { ...good, status: "Lost" },
    { ...good, product: "Laptop", category: "Grocery" }, { ...good, rating: 9, status: "Completed" },
  ];
  for (const b of bad) assert.equal(A.validateRecord(b).ok, false, JSON.stringify(b));
});

test("validation normalises: rating dropped for non-completed, name sanitised", () => {
  const v = A.validateRecord({ ...seed[0], status: "Pending", rating: 5, updatedBy: "<b>Eve</b>" });
  assert.ok(v.ok);
  assert.equal(v.value.rating, null);
  assert.equal(v.value.updatedBy, "bEve/b");
});

test("CSV: header, row count, quoting and formula-injection guard", () => {
  const csv = A.toCSV(seed);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, seed.length + 1);
  assert.equal(lines[0], A.CSV_HEADERS.join(","));
  const evil = A.toCSV([{ ...seed[0], updatedBy: '=HYPERLINK("x")', product: "A,B" }]);
  assert.match(evil, /"'=HYPERLINK\(""x""\)"/);
  assert.match(evil, /"A,B"/);
});

test("random records are always valid", () => {
  for (let i = 0; i < 500; i++) assert.ok(A.validateRecord(A.randomRecord()).ok);
});

test("currency formatting", () => {
  assert.equal(A.fmtIDR(1234567), "Rp 1,234,567");
  assert.equal(A.fmtIDR(12400000, true), "Rp 12.4M");
  assert.equal(A.fmtIDR(2500000000, true), "Rp 2.5B");
  assert.equal(A.fmtIDR(0, true), "Rp 0");
});
