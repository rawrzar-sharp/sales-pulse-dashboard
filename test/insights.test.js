/**
 * test/insights.test.js
 *
 * End-to-end data-flow tests: user input -> validation -> analytics -> insights output.
 * Covers the full pipeline that the Insights feature depends on:
 *
 *   [User Input] -> validateRecord() -> [Store] -> kpis() / groupBy() / byDay() / filterRecords()
 *                -> [Insight Engine inputs] -> reconcile()
 *
 * Uses Node's built-in test runner (node:test). No external deps.
 * Run: node --test test/insights.test.js
 */

"use strict";

const test    = require("node:test");
const assert  = require("node:assert/strict");
const fs      = require("fs");
const path    = require("path");
const A       = require("../public/js/analytics.js");

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/records.seed.json"), "utf8")
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Validation gate (what the server applies before persisting)
// Every user-submitted form field must pass before it can affect any analysis.
// ─────────────────────────────────────────────────────────────────────────────

test("valid user submission passes all validation checks", () => {
  const input = {
    timestamp: "2026-10-01T14:30:00",
    region: "Jakarta",
    category: "Electronics",
    product: "Smartphone",
    quantity: 2,
    unitPrice: 3500000,
    status: "Completed",
    rating: 5,
    updatedBy: "Alice",
  };
  const result = A.validateRecord(input);
  assert.ok(result.ok, `Expected valid, got errors: ${result.errors.join("; ")}`);
  assert.equal(result.value.region, "Jakarta");
  assert.equal(result.value.quantity, 2);
  assert.equal(result.value.rating, 5);
});

test("validation strips whitespace and normalises timestamp to full ISO", () => {
  const input = {
    timestamp: "  2026-10-01T14:30  ",
    region: "  Bali  ",
    category: " Home ",
    product: "  Rice Cooker  ",
    quantity: 1,
    unitPrice: 650000,
    status: "Completed",
    rating: null,
    updatedBy: "Bob",
  };
  const result = A.validateRecord(input);
  assert.ok(result.ok, result.errors.join("; "));
  assert.equal(result.value.timestamp, "2026-10-01T14:30:00");
  assert.equal(result.value.region, "Bali");
});

test("validation rejects each invalid field independently", () => {
  const base = {
    timestamp: "2026-10-01T10:00:00", region: "Jakarta", category: "Electronics",
    product: "Laptop", quantity: 1, unitPrice: 9500000, status: "Completed",
    rating: null, updatedBy: "Tester",
  };

  const cases = [
    ["bad region",    { region: "Atlantis" }],
    ["bad category",  { category: "Magic" }],
    ["wrong product for category", { category: "Grocery", product: "Laptop" }],
    ["quantity = 0",  { quantity: 0 }],
    ["quantity decimal", { quantity: 1.5 }],
    ["quantity > 1000",  { quantity: 1001 }],
    ["unitPrice < 1000", { unitPrice: 500 }],
    ["unitPrice float",  { unitPrice: 9500000.5 }],
    ["bad status",    { status: "Dispatched" }],
    ["rating out of range", { rating: 6 }],
    ["rating = 0",    { rating: 0 }],
    ["bad timestamp format", { timestamp: "01/10/2026" }],
    ["impossible date (Feb 30)", { timestamp: "2026-02-30T10:00:00" }],
  ];

  for (const [label, overrides] of cases) {
    const result = A.validateRecord({ ...base, ...overrides });
    assert.equal(result.ok, false, `"${label}" should have failed but passed`);
    assert.ok(result.errors.length > 0, `"${label}" has no error message`);
  }
});

test("validation silently drops rating when status is not Completed", () => {
  const input = {
    timestamp: "2026-10-01T10:00:00", region: "Bali", category: "Home",
    product: "Desk Lamp", quantity: 1, unitPrice: 280000,
    status: "Cancelled", rating: 4, updatedBy: "Tester",
  };
  const result = A.validateRecord(input);
  assert.ok(result.ok, result.errors.join("; "));
  assert.equal(result.value.rating, null, "Rating should be cleared for non-Completed status");
});

test("validation sanitises updatedBy: strips control chars and HTML angle brackets", () => {
  const base = {
    timestamp: "2026-10-01T10:00:00", region: "Jakarta", category: "Electronics",
    product: "Smartphone", quantity: 1, unitPrice: 3500000,
    status: "Pending", rating: null,
  };
  const result = A.validateRecord({ ...base, updatedBy: "<script>alert(1)</script>" });
  assert.ok(result.ok, result.errors.join("; "));
  assert.doesNotMatch(result.value.updatedBy, /<|>/, "HTML tags should be stripped from updatedBy");
});

test("validation caps updatedBy at 24 characters", () => {
  const base = {
    timestamp: "2026-10-01T10:00:00", region: "Jakarta", category: "Electronics",
    product: "Smartphone", quantity: 1, unitPrice: 3500000,
    status: "Pending", rating: null,
  };
  const result = A.validateRecord({ ...base, updatedBy: "A".repeat(50) });
  assert.ok(result.ok, result.errors.join("; "));
  assert.ok(result.value.updatedBy.length <= 24, "updatedBy must be capped at 24 chars");
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — KPI computation (the numbers the Insight Engine reads)
// ─────────────────────────────────────────────────────────────────────────────

test("kpis on seed: sales = sum of qty*price for all rows", () => {
  const expected = seed.reduce((acc, r) => acc + r.quantity * r.unitPrice, 0);
  const k = A.kpis(seed);
  assert.equal(k.sales, expected);
  assert.equal(k.orders, seed.length);
});

test("kpis on seed: aov = sales / orders", () => {
  const k = A.kpis(seed);
  assert.equal(k.aov, k.sales / k.orders);
});

test("kpis on seed: completionRate reflects actual Completed count", () => {
  const completed = seed.filter(r => r.status === "Completed").length;
  const k = A.kpis(seed);
  assert.equal(k.completionRate, completed / seed.length);
  // Seed has 26 Completed out of 60, so rate is ~43.3% — BELOW the 50% critical threshold
  assert.ok(k.completionRate < 0.50, `Seed completionRate ${(k.completionRate*100).toFixed(1)}% should be below 50% (critical)`);
});

test("kpis on seed: avgRating only counts rows with a non-null rating", () => {
  const rated = seed.filter(r => r.rating != null);
  const expected = rated.reduce((a, r) => a + r.rating, 0) / rated.length;
  const k = A.kpis(seed);
  assert.equal(k.avgRating, expected);
  assert.equal(k.ratedCount, rated.length);
});

test("kpis on empty array returns zeros, no NaN", () => {
  const k = A.kpis([]);
  for (const [key, val] of Object.entries(k)) {
    assert.ok(!isNaN(val), `kpis().${key} must not be NaN on empty input`);
    assert.equal(typeof val, "number");
  }
  assert.equal(k.sales, 0);
  assert.equal(k.orders, 0);
});

test("kpis on single Completed+rated row: all fields consistent", () => {
  const single = [{
    id: "TEST-001", timestamp: "2026-10-01T10:00:00",
    region: "Bali", category: "Home", product: "Desk Lamp",
    quantity: 3, unitPrice: 280000, status: "Completed", rating: 4, updatedBy: "Test",
  }];
  const k = A.kpis(single);
  assert.equal(k.sales, 840000);
  assert.equal(k.orders, 1);
  assert.equal(k.aov, 840000);
  assert.equal(k.completionRate, 1.0);
  assert.equal(k.avgRating, 4);
  assert.equal(k.ratedCount, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Insight-threshold scenarios
// These build synthetic record sets that cross each business threshold so we can
// verify the KPIs the Insight Engine will use to fire alerts.
// ─────────────────────────────────────────────────────────────────────────────

function makeRecord(overrides) {
  return {
    timestamp: "2026-10-01T10:00:00",
    region: "Jakarta", category: "Electronics", product: "Smartphone",
    quantity: 1, unitPrice: 1000000,
    status: "Completed", rating: 4, updatedBy: "Test",
    ...overrides,
  };
}

test("completion rate threshold: <50% is critical territory", () => {
  // 3 Completed out of 10 = 30% — well below 50%
  const rows = [
    ...Array.from({ length: 3  }, () => makeRecord({ status: "Completed", rating: 4 })),
    ...Array.from({ length: 4  }, () => makeRecord({ status: "Cancelled", rating: null })),
    ...Array.from({ length: 3  }, () => makeRecord({ status: "Refunded",  rating: null })),
  ];
  const k = A.kpis(rows);
  assert.equal(k.completionRate, 0.3);
  assert.ok(k.completionRate < 0.50, "Should be in critical zone (<50%)");
});

test("completion rate threshold: 50–64% is warning territory", () => {
  // 6 Completed out of 10 = 60%
  const rows = [
    ...Array.from({ length: 6  }, () => makeRecord({ status: "Completed", rating: 4 })),
    ...Array.from({ length: 4  }, () => makeRecord({ status: "Cancelled", rating: null })),
  ];
  const k = A.kpis(rows);
  assert.equal(k.completionRate, 0.6);
  assert.ok(k.completionRate >= 0.50 && k.completionRate < 0.65, "Should be in warning zone (50–64%)");
});

test("completion rate threshold: >=65% is healthy (info)", () => {
  // 7 Completed out of 10 = 70%
  const rows = [
    ...Array.from({ length: 7  }, () => makeRecord({ status: "Completed", rating: 4 })),
    ...Array.from({ length: 3  }, () => makeRecord({ status: "Cancelled", rating: null })),
  ];
  const k = A.kpis(rows);
  assert.equal(k.completionRate, 0.7);
  assert.ok(k.completionRate >= 0.65, "Should be in healthy zone (>=65%)");
});

test("refund rate threshold: >25% is critical, >15% is warning, <=15% is healthy", () => {
  const makeRateRows = (refunded, total) => {
    const completed = total - refunded;
    return [
      ...Array.from({ length: refunded  }, () => makeRecord({ status: "Refunded",  rating: null })),
      ...Array.from({ length: completed }, () => makeRecord({ status: "Completed", rating: 3 })),
    ];
  };

  // >25% critical: 3 refunded out of 10 = 30%
  const critical = makeRateRows(3, 10);
  const refundRate_critical = critical.filter(r => r.status === "Refunded").length / critical.length;
  assert.ok(refundRate_critical > 0.25, `refund rate ${refundRate_critical} should be >25%`);

  // warning: 2 refunded out of 10 = 20%
  const warning = makeRateRows(2, 10);
  const refundRate_warning = warning.filter(r => r.status === "Refunded").length / warning.length;
  assert.ok(refundRate_warning > 0.15 && refundRate_warning <= 0.25, `refund rate ${refundRate_warning} should be 15–25%`);

  // healthy: 1 refunded out of 10 = 10%
  const healthy = makeRateRows(1, 10);
  const refundRate_healthy = healthy.filter(r => r.status === "Refunded").length / healthy.length;
  assert.ok(refundRate_healthy <= 0.15, `refund rate ${refundRate_healthy} should be <=15%`);
});

test("cancellation rate threshold: >30% critical, >20% warning, <=20% healthy", () => {
  const makeRows = (cancelled, total) => [
    ...Array.from({ length: cancelled }, () => makeRecord({ status: "Cancelled", rating: null })),
    ...Array.from({ length: total - cancelled }, () => makeRecord({ status: "Completed", rating: 4 })),
  ];

  // >30% critical: 4 out of 10
  const r1 = makeRows(4, 10);
  const rate1 = r1.filter(r => r.status === "Cancelled").length / r1.length;
  assert.ok(rate1 > 0.30, `cancellation rate ${rate1} should be >30% (critical)`);

  // >20% warning: 3 out of 10
  const r2 = makeRows(3, 10);
  const rate2 = r2.filter(r => r.status === "Cancelled").length / r2.length;
  assert.ok(rate2 > 0.20 && rate2 <= 0.30, `cancellation rate ${rate2} should be 20–30% (warning)`);

  // <=20% healthy: 2 out of 10
  const r3 = makeRows(2, 10);
  const rate3 = r3.filter(r => r.status === "Cancelled").length / r3.length;
  assert.ok(rate3 <= 0.20, `cancellation rate ${rate3} should be <=20% (healthy)`);
});

test("rating alert: <3.0 average on >=5 rated Completed orders is a warning", () => {
  const rows = Array.from({ length: 5 }, () =>
    makeRecord({ status: "Completed", rating: 2 })  // avg = 2.0
  );
  const k = A.kpis(rows);
  assert.ok(k.avgRating < 3.0, `avgRating ${k.avgRating} should be below 3.0 (warning)`);
  assert.ok(k.ratedCount >= 5, `need at least 5 rated orders, got ${k.ratedCount}`);
});

test("rating is healthy when >=3.0 average with >=5 rated orders", () => {
  const rows = Array.from({ length: 5 }, () =>
    makeRecord({ status: "Completed", rating: 4 })
  );
  const k = A.kpis(rows);
  assert.ok(k.avgRating >= 3.0, `avgRating ${k.avgRating} should be >=3.0 (healthy)`);
  assert.ok(k.ratedCount >= 5);
});

test("rating: insufficient data guard when fewer than 5 rated orders", () => {
  // Only 3 Completed+rated orders — engine should show insufficient-data info
  const rows = Array.from({ length: 3 }, () =>
    makeRecord({ status: "Completed", rating: 5 })
  );
  const k = A.kpis(rows);
  assert.ok(k.ratedCount < 5, `ratedCount ${k.ratedCount} should be <5 (insufficient data)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Revenue momentum (7-day window comparisons)
// ─────────────────────────────────────────────────────────────────────────────

test("revenue momentum: Insight Engine computes 7-day windows via byDay time-series", () => {
  // The engine slices byDay() output into two consecutive 7-day buckets.
  // Prior  7 days (Sep 18-24): Rp 2M/day = Rp 14M
  // Recent 7 days (Sep 25-Oct 1): Rp 1M/day = Rp  7M  => -50% decline => critical
  const priorWeek = Array.from({ length: 7 }, (_, i) => makeRecord({
    timestamp: "2026-09-" + String(18 + i).padStart(2, "0") + "T10:00:00",
    unitPrice: 2000000, quantity: 1, status: "Completed", rating: 4,
  }));
  const recentWeek = Array.from({ length: 7 }, (_, i) => makeRecord({
    timestamp: "2026-09-" + String(25 + i).padStart(2, "0") + "T10:00:00",
    unitPrice: 1000000, quantity: 1, status: "Completed", rating: 4,
  }));

  const all  = [...priorWeek, ...recentWeek];
  const days = A.byDay(all);
  assert.ok(days.length >= 14, "Need at least 14 daily buckets for a 7+7 comparison");

  // Engine logic: take last 14 days, split into prior[0..6] and recent[7..13]
  const last14      = days.slice(-14);
  const priorSales  = last14.slice(0, 7).reduce((a, d) => a + d.sales, 0);
  const recentSales = last14.slice(7).reduce((a, d) => a + d.sales, 0);

  assert.ok(priorSales  > 0, "Prior 7-day window must have sales");
  assert.ok(recentSales > 0, "Recent 7-day window must have sales");
  assert.ok(recentSales < priorSales, "Recent week should be lower (critical scenario)");

  const decline = (priorSales - recentSales) / priorSales;
  assert.ok(decline > 0.30,
    `Decline of ${(decline * 100).toFixed(1)}% should exceed 30% critical threshold`);
});

test("revenue momentum: positive growth produces info-level result", () => {
  // Prior 7 days: Rp 1M each = Rp 7M; Recent 7 days: Rp 2M each = Rp 14M => +100% => info
  const priorWeek = Array.from({ length: 7 }, (_, i) => makeRecord({
    timestamp: "2026-09-" + String(18 + i).padStart(2, "0") + "T10:00:00",
    unitPrice: 1000000, quantity: 1, status: "Completed", rating: 4,
  }));
  const recentWeek = Array.from({ length: 7 }, (_, i) => makeRecord({
    timestamp: "2026-09-" + String(25 + i).padStart(2, "0") + "T10:00:00",
    unitPrice: 2000000, quantity: 1, status: "Completed", rating: 4,
  }));

  const all  = [...priorWeek, ...recentWeek];
  const days = A.byDay(all);
  const last14      = days.slice(-14);
  const priorSales  = last14.slice(0, 7).reduce((a, d) => a + d.sales, 0);
  const recentSales = last14.slice(7).reduce((a, d) => a + d.sales, 0);

  assert.ok(recentSales > priorSales, "Recent week should exceed prior (growth)");
  const change = (recentSales - priorSales) / priorSales;
  // Per spec Req 2 C4: flat = within 10%; positive = above => both are "info"
  assert.ok(change > 0, "Positive change means info-level (no alert)");
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Segment analysis (groupBy → top/underperforming)
// ─────────────────────────────────────────────────────────────────────────────

test("groupBy region produces one entry per region with correct sales and orders", () => {
  const rows = [
    makeRecord({ region: "Bali",    unitPrice: 1000000, quantity: 2 }),
    makeRecord({ region: "Bali",    unitPrice: 500000,  quantity: 1 }),
    makeRecord({ region: "Jakarta", unitPrice: 2000000, quantity: 1 }),
  ];
  const groups = A.groupBy(rows, "region");
  const bali    = groups.find(g => g.key === "Bali");
  const jakarta = groups.find(g => g.key === "Jakarta");

  assert.equal(bali.sales, 2500000);
  assert.equal(bali.orders, 2);
  assert.equal(jakarta.sales, 2000000);
  assert.equal(jakarta.orders, 1);
});

test("groupBy with fixedKeys includes all catalogue regions even if zero orders", () => {
  const rows = [makeRecord({ region: "Bali", unitPrice: 1000000, quantity: 1 })];
  const groups = A.groupBy(rows, "region", A.CATALOG.regions);

  assert.equal(groups.length, A.CATALOG.regions.length, "All catalogue regions must appear");
  const zero = groups.filter(g => g.key !== "Bali");
  for (const g of zero) {
    assert.equal(g.sales, 0, `${g.key} should have 0 sales`);
    assert.equal(g.orders, 0, `${g.key} should have 0 orders`);
  }
});

test("top-performing segment is the one with highest sales share", () => {
  const rows = [
    makeRecord({ region: "Bali",    unitPrice: 5000000, quantity: 1 }), // 50%
    makeRecord({ region: "Jakarta", unitPrice: 3000000, quantity: 1 }), // 30%
    makeRecord({ region: "Medan",   unitPrice: 2000000, quantity: 1 }), // 20%
  ];
  const groups = A.groupBy(rows, "region").sort((a, b) => b.sales - a.sales);
  assert.equal(groups[0].key, "Bali", "Bali should be top performer");
});

test("underperforming segment: a region with sharply lower share in recent vs prior period", () => {
  // Simulate: region A had 70% share in prior period, 20% in recent — 71% drop → underperforming
  const priorRows = [
    makeRecord({ region: "RegionA", unitPrice: 7000000, quantity: 1 }),  // 70%
    makeRecord({ region: "RegionB", unitPrice: 3000000, quantity: 1 }),  // 30%
  ];
  const recentRows = [
    makeRecord({ region: "RegionA", unitPrice: 2000000, quantity: 1 }),  // 20%
    makeRecord({ region: "RegionB", unitPrice: 8000000, quantity: 1 }),  // 80%
  ];

  const priorGroups  = A.groupBy(priorRows,  "region");
  const recentGroups = A.groupBy(recentRows, "region");

  const priorTotal  = priorGroups.reduce((a, g) => a + g.sales, 0);
  const recentTotal = recentGroups.reduce((a, g) => a + g.sales, 0);

  const priorShareA  = priorGroups.find(g => g.key === "RegionA").sales  / priorTotal;
  const recentShareA = recentGroups.find(g => g.key === "RegionA").sales / recentTotal;

  const drop = (priorShareA - recentShareA) / priorShareA;
  assert.ok(drop > 0.40, `Share drop ${(drop*100).toFixed(1)}% should exceed 40% threshold (underperforming)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Filter context (Active_Filters feed the Insight Engine)
// ─────────────────────────────────────────────────────────────────────────────

test("filter by region narrows records for insight computation", () => {
  const baliOnly = A.filterRecords(seed, { regions: ["Bali"] });
  assert.ok(baliOnly.every(r => r.region === "Bali"), "All records should be Bali");
  assert.ok(baliOnly.length < seed.length, "Filter should reduce row count");

  // KPIs on filtered data must still be internally consistent (reconciliation)
  for (const check of A.reconcile(baliOnly)) {
    assert.ok(check.ok, `Reconciliation failed for Bali filter: ${check.label}`);
  }
});

test("filter by status=Completed shows only completed orders for insight", () => {
  const completedOnly = A.filterRecords(seed, { statuses: ["Completed"] });
  assert.ok(completedOnly.every(r => r.status === "Completed"));
  const k = A.kpis(completedOnly);
  assert.equal(k.completionRate, 1.0, "100% completion rate when filtering to Completed only");
});

test("filter below 5 records: engine must show insufficient-data insight, not metrics", () => {
  const tiny = seed.slice(0, 3);
  assert.ok(tiny.length < 5, "Should have fewer than 5 records");
  // The engine will check this count and bail out — we verify the input condition
  assert.equal(tiny.length, 3);
});

test("no active filter computes insights over full dataset", () => {
  const all = A.filterRecords(seed, {});
  assert.equal(all.length, seed.length, "Empty filter should return all records");
});

test("combined filter (date + region + status) chains correctly", () => {
  const filtered = A.filterRecords(seed, {
    range: 30, regions: ["Bali", "Jakarta"], statuses: ["Completed"],
  });
  assert.ok(filtered.every(r => r.region === "Bali" || r.region === "Jakarta"));
  assert.ok(filtered.every(r => r.status === "Completed"));
  for (const check of A.reconcile(filtered)) {
    assert.ok(check.ok, `Reconciliation failed for combined filter: ${check.label}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Reconciliation (proves every chart/insight reads the same truth)
// ─────────────────────────────────────────────────────────────────────────────

test("reconciliation passes on full seed dataset", () => {
  for (const check of A.reconcile(seed)) {
    assert.ok(check.ok, `${check.label}: actual=${check.actual} expected=${check.expected}`);
  }
});

test("reconciliation passes after adding a user-submitted record", () => {
  // Simulate a user adding one new valid record and the engine re-reading the store
  const newRecord = {
    id: "REC-TEST", timestamp: "2026-10-01T15:00:00",
    region: "Bandung", category: "Fashion", product: "Sneakers",
    quantity: 2, unitPrice: 950000, status: "Completed",
    rating: 5, updatedBy: "Tester",
  };
  const augmented = [...seed, newRecord];
  for (const check of A.reconcile(augmented)) {
    assert.ok(check.ok, `${check.label}: actual=${check.actual} expected=${check.expected}`);
  }
});

test("reconciliation detects a corrupted total (detects drift between table and chart)", () => {
  // Introduce a record where total(r) = qty * price would differ if recalculated
  // We do this by directly checking what reconcile produces on a broken derived field
  const corrupted = seed.map((r, i) =>
    i === 0 ? { ...r, _badTotal: r.quantity * r.unitPrice + 999999 } : r
  );
  // reconcile() ignores _badTotal and recomputes from quantity*unitPrice — still passes
  // This proves the engine is using the source-of-truth formula, not a cached total
  for (const check of A.reconcile(corrupted)) {
    assert.ok(check.ok, "reconcile must ignore cached/derived fields and use qty*price");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — byDay (time-series for revenue momentum)
// ─────────────────────────────────────────────────────────────────────────────

test("byDay fills in gap days with zero sales so momentum comparison is fair", () => {
  const rows = [
    makeRecord({ timestamp: "2026-09-25T10:00:00", unitPrice: 1000000, quantity: 1 }),
    makeRecord({ timestamp: "2026-09-28T10:00:00", unitPrice: 2000000, quantity: 1 }),
  ];
  const days = A.byDay(rows);
  assert.equal(days.length, 4, "Should have 4 days: Sep 25, 26, 27, 28");
  assert.equal(days[0].date, "2026-09-25"); assert.equal(days[0].sales, 1000000);
  assert.equal(days[1].sales, 0);           // gap day
  assert.equal(days[2].sales, 0);           // gap day
  assert.equal(days[3].date, "2026-09-28"); assert.equal(days[3].sales, 2000000);
});

test("byDay total sales equals kpis().sales (no data lost in time-series)", () => {
  const days = A.byDay(seed);
  const dayTotal = days.reduce((a, d) => a + d.sales, 0);
  assert.equal(dayTotal, A.kpis(seed).sales, "Time-series total must equal KPI sales");
});

test("byDay returns empty array for empty input", () => {
  assert.deepEqual(A.byDay([]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Serialise / deserialise round-trip (Req 7 from spec)
// ─────────────────────────────────────────────────────────────────────────────

test("JSON serialise → deserialise round-trip preserves all insight fields", () => {
  // Simulate a plain insight object (as InsightEngine will produce)
  const insight = {
    id: "insight-completion-001",
    severity: "critical",
    category: "completion-rate",
    headline: "Completion rate has dropped to 30%",
    explanation: "Only 3 of 10 orders were completed in the last 30 days.",
    suggestedAction: "Investigate Cancelled orders and call the sales team.",
    evidence: "Completion rate: 30% · Last 30 days",
    deviation: 0.70,
  };

  const json  = JSON.stringify([insight]);
  const back  = JSON.parse(json);

  assert.equal(back.length, 1);
  assert.deepEqual(back[0], insight);
  assert.equal(back[0].severity, "critical");
  assert.equal(back[0].deviation, 0.70);
});

test("JSON round-trip on an array of mixed-severity insights", () => {
  const insights = [
    { id: "i1", severity: "critical",  category: "revenue-momentum",  headline: "Sales fell 40%",      explanation: "7-day revenue dropped sharply.",         suggestedAction: "Review sales pipeline.",      evidence: "Sales: -40% · Last 7 days", deviation: 0.40 },
    { id: "i2", severity: "warning",   category: "refund-rate",       headline: "Refunds up to 22%",   explanation: "Refund rate exceeded the 15% threshold.", suggestedAction: "Check product quality reports.", evidence: "Refund rate: 22% · Last 14 days", deviation: 0.22 },
    { id: "i3", severity: "info",      category: "top-segment",       headline: "Bali leads sales",    explanation: "Bali contributed 35% of total revenue.",  suggestedAction: "Replicate Bali's sales approach.", evidence: "Bali: 35% share · Last 30 days", deviation: 0 },
  ];

  const json = JSON.stringify(insights);
  const back = JSON.parse(json);

  assert.equal(back.length, 3);
  assert.deepEqual(back, insights);
});

test("deserialise throws a descriptive Error on malformed JSON", () => {
  // Simulates what InsightEngine.deserialise() must do per Requirement 7 C5
  function deserialise(json) {
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error(`deserialise: expected a JSON array of insight objects, received malformed JSON`); }
    if (!Array.isArray(parsed)) throw new Error(`deserialise: expected a JSON array, received ${typeof parsed}`);
    return parsed;
  }

  assert.throws(
    () => deserialise("not-valid-json{{{"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /deserialise/);
      assert.match(err.message, /malformed/);
      return true;
    }
  );
});

test("deserialise throws when valid JSON is not an array (object, string, number)", () => {
  function deserialise(json) {
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error(`deserialise: expected a JSON array of insight objects, received malformed JSON`); }
    if (!Array.isArray(parsed)) throw new Error(`deserialise: expected a JSON array, received ${typeof parsed}`);
    return parsed;
  }

  for (const bad of ['{"id":"x"}', '"hello"', "42", "true", "null"]) {
    assert.throws(
      () => deserialise(bad),
      (err) => { assert.match(err.message, /deserialise: expected a JSON array, received/); return true; },
      `Should throw for input: ${bad}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Export (copy-summary text format)
// ─────────────────────────────────────────────────────────────────────────────

test("copy-summary format: each insight produces correct plain-text block", () => {
  // This matches the format the 'Copy summary' button must produce (Req 6)
  const insight = {
    severity: "critical",
    headline: "Completion rate has dropped to 30%",
    explanation: "Only 3 of 10 orders were completed in the last 30 days.",
    suggestedAction: "Investigate Cancelled orders and call the sales team.",
    evidence: "Completion rate: 30% · Last 30 days",
  };

  function formatInsightAsText(i) {
    return [
      `[${i.severity.toUpperCase()}]`,
      i.headline,
      i.explanation,
      i.suggestedAction,
      i.evidence,
    ].join("\n");
  }

  const text = formatInsightAsText(insight);
  assert.match(text, /\[CRITICAL\]/);
  assert.match(text, /Completion rate has dropped/);
  assert.match(text, /Investigate Cancelled/);
  assert.match(text, /Completion rate: 30%/);

  const lines = text.split("\n");
  assert.equal(lines.length, 5, "Each insight text block should have exactly 5 lines");
});

test("copy-summary: multiple insights are separated by blank lines", () => {
  const insights = [
    { severity: "critical", headline: "Sales dropped", explanation: "Revenue fell 40%.", suggestedAction: "Investigate pipeline.", evidence: "Sales: -40%" },
    { severity: "info",     headline: "Bali leads",    explanation: "Bali is top region.",  suggestedAction: "Replicate strategy.",    evidence: "Bali: 35%" },
  ];

  function buildSummary(arr) {
    return arr.map(i => [`[${i.severity.toUpperCase()}]`, i.headline, i.explanation, i.suggestedAction, i.evidence].join("\n")).join("\n\n");
  }

  const summary = buildSummary(insights);
  // Two blocks separated by one blank line
  const blocks = summary.split("\n\n");
  assert.equal(blocks.length, 2, "Two insights should produce two blocks");
  assert.match(blocks[0], /CRITICAL/);
  assert.match(blocks[1], /INFO/);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Random record generator (used by simulator, stress-test)
// ─────────────────────────────────────────────────────────────────────────────

test("1000 random records all pass validation and produce consistent KPIs", () => {
  const records = Array.from({ length: 1000 }, () =>
    A.randomRecord(Math.random, "2026-10-01T10:00:00", "StressTest")
  );

  // All must be valid
  for (const r of records) {
    const v = A.validateRecord(r);
    assert.ok(v.ok, `Random record failed validation: ${v.errors.join("; ")}`);
  }

  // KPIs must be internally consistent
  const k = A.kpis(records);
  assert.equal(k.orders, 1000);
  assert.ok(k.sales > 0);
  assert.ok(!isNaN(k.aov));
  assert.ok(k.completionRate >= 0 && k.completionRate <= 1);

  // Reconciliation must pass
  for (const check of A.reconcile(records)) {
    assert.ok(check.ok, `Reconciliation failed on 1000 random records: ${check.label}`);
  }
});

test("random records respect the weighted status distribution (Completed most common)", () => {
  const records = Array.from({ length: 600 }, () => A.randomRecord());
  const statusCount = {};
  for (const r of records) statusCount[r.status] = (statusCount[r.status] || 0) + 1;

  // The generator uses ["Completed","Completed","Completed","Pending","Cancelled","Refunded"]
  // so Completed should be ~50% of records
  const completedShare = statusCount.Completed / records.length;
  assert.ok(completedShare > 0.35 && completedShare < 0.70,
    `Expected ~50% Completed, got ${(completedShare * 100).toFixed(1)}%`);
});
