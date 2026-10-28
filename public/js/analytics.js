/*
 * analytics.js — single source of truth for the data rules.
 * Used by the browser (window.Analytics) AND by server.js / tests (require).
 * Every number shown on the dashboard is computed here, so charts can never
 * drift away from the table data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Analytics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATALOG = {
    regions: ["Jakarta", "Bandung", "Surabaya", "Medan", "Bali", "Makassar"],
    statuses: ["Completed", "Pending", "Cancelled", "Refunded"],
    categories: {
      Electronics: ["Smartphone", "Laptop", "Headphones"],
      Home: ["Air Purifier", "Rice Cooker", "Desk Lamp"],
      Fashion: ["Sneakers", "Jacket", "Backpack"],
      Grocery: ["Coffee Beans", "Olive Oil", "Snack Box"],
    },
    basePrice: {
      Smartphone: 3500000, Laptop: 9500000, Headphones: 750000,
      "Air Purifier": 2100000, "Rice Cooker": 650000, "Desk Lamp": 280000,
      Sneakers: 950000, Jacket: 720000, Backpack: 480000,
      "Coffee Beans": 160000, "Olive Oil": 190000, "Snack Box": 120000,
    },
  };
  CATALOG.categoryNames = Object.keys(CATALOG.categories);

  const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

  /* ---------- helpers (timestamps are "naive local" strings: no timezone drift) ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const dateOf = (ts) => ts.slice(0, 10);
  function nowLocalISO(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function dayToUTC(day) { const [y, m, d] = day.split("-").map(Number); return Date.UTC(y, m - 1, d); }
  function utcToDay(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  const DAY_MS = 86400000;

  const total = (r) => r.quantity * r.unitPrice;

  function fmtIDR(n, compact) {
    n = Math.round(n || 0);
    if (compact) {
      const a = Math.abs(n);
      if (a >= 1e9) return "Rp " + (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
      if (a >= 1e6) return "Rp " + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (a >= 1e3) return "Rp " + (n / 1e3).toFixed(0) + "K";
    }
    return "Rp " + n.toLocaleString("en-US");
  }

  /* ---------- validation (used by server for every write) ---------- */
  function validateRecord(input) {
    const errors = [];
    const r = {};
    const s = (v) => (typeof v === "string" ? v.trim() : v);

    r.timestamp = s(input.timestamp);
    if (typeof r.timestamp !== "string" || !TS_RE.test(r.timestamp)) errors.push("timestamp must look like 2026-10-01T14:30:00");
    else {
      if (r.timestamp.length === 16) r.timestamp += ":00";
      const t = new Date(r.timestamp + "Z");
      if (isNaN(t.getTime()) || utcToDay(t.getTime()) !== r.timestamp.slice(0, 10)) errors.push("timestamp is not a real date");
    }

    r.region = s(input.region);
    if (!CATALOG.regions.includes(r.region)) errors.push("region must be one of: " + CATALOG.regions.join(", "));

    r.category = s(input.category);
    if (!CATALOG.categories[r.category]) errors.push("category must be one of: " + CATALOG.categoryNames.join(", "));

    r.product = s(input.product);
    if (CATALOG.categories[r.category] && !CATALOG.categories[r.category].includes(r.product))
      errors.push("product '" + r.product + "' does not belong to category " + r.category);

    r.quantity = Number(input.quantity);
    if (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 1000) errors.push("quantity must be a whole number 1-1000");

    r.unitPrice = Number(input.unitPrice);
    if (!Number.isInteger(r.unitPrice) || r.unitPrice < 1000 || r.unitPrice > 1e9) errors.push("unitPrice must be a whole number 1,000-1,000,000,000");

    r.status = s(input.status);
    if (!CATALOG.statuses.includes(r.status)) errors.push("status must be one of: " + CATALOG.statuses.join(", "));

    if (input.rating === null || input.rating === undefined || input.rating === "") r.rating = null;
    else {
      r.rating = Number(input.rating);
      if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) errors.push("rating must be 1-5 or empty");
    }
    if (r.status !== "Completed" && r.rating !== null && errors.length === 0) r.rating = null; // ratings only for completed orders

    r.updatedBy = String(s(input.updatedBy) || "Anonymous").replace(/[\u0000-\u001f<>]/g, "").slice(0, 24) || "Anonymous";
    return { ok: errors.length === 0, errors, value: r };
  }

  /* ---------- filtering ---------- */
  function anchorDay(records) {
    let max = "";
    for (const r of records) if (r.timestamp > max) max = r.timestamp;
    return max ? dateOf(max) : null;
  }

  // f = { range: 7|30|60|"all", regions:[], categories:[], statuses:[] } ; empty array = no restriction
  function filterRecords(records, f) {
    f = f || {};
    let minDay = null;
    if (f.range && f.range !== "all") {
      const a = anchorDay(records);
      if (a) minDay = utcToDay(dayToUTC(a) - (Number(f.range) - 1) * DAY_MS);
    }
    const has = (arr, v) => !arr || arr.length === 0 || arr.includes(v);
    return records.filter((r) =>
      (!minDay || dateOf(r.timestamp) >= minDay) &&
      has(f.regions, r.region) && has(f.categories, r.category) && has(f.statuses, r.status));
  }

  /* ---------- aggregations ---------- */
  function kpis(rows) {
    const orders = rows.length;
    const sales = rows.reduce((a, r) => a + total(r), 0);
    const completed = rows.filter((r) => r.status === "Completed").length;
    const rated = rows.filter((r) => r.rating != null);
    return {
      sales, orders,
      aov: orders ? sales / orders : 0,
      completionRate: orders ? completed / orders : 0,
      avgRating: rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : 0,
      ratedCount: rated.length,
    };
  }

  function groupBy(rows, key, fixedKeys) {
    const m = new Map();
    (fixedKeys || []).forEach((k) => m.set(k, { key: k, sales: 0, orders: 0 }));
    for (const r of rows) {
      const k = r[key];
      if (!m.has(k)) m.set(k, { key: k, sales: 0, orders: 0 });
      const g = m.get(k);
      g.sales += total(r); g.orders += 1;
    }
    return [...m.values()];
  }

  // continuous daily series (missing days = 0) so the line never "skips" data
  function byDay(rows) {
    if (!rows.length) return [];
    const m = new Map();
    let min = Infinity, max = -Infinity;
    for (const r of rows) {
      const d = dateOf(r.timestamp), u = dayToUTC(d);
      if (u < min) min = u; if (u > max) max = u;
      const g = m.get(d) || { date: d, sales: 0, orders: 0 };
      g.sales += total(r); g.orders += 1; m.set(d, g);
    }
    const out = [];
    for (let u = min; u <= max; u += DAY_MS) {
      const d = utcToDay(u);
      out.push(m.get(d) || { date: d, sales: 0, orders: 0 });
    }
    return out;
  }

  /* ---------- reconciliation: proves every chart adds up to the same truth ---------- */
  function reconcile(rows) {
    const k = kpis(rows);
    const sum = (arr, f) => arr.reduce((a, x) => a + x[f], 0);
    const checks = [
      ["Table rows = KPI orders", rows.length, k.orders],
      ["Daily trend sums to KPI sales", sum(byDay(rows), "sales"), k.sales],
      ["Region bars sum to KPI sales", sum(groupBy(rows, "region"), "sales"), k.sales],
      ["Category donut sums to KPI sales", sum(groupBy(rows, "category"), "sales"), k.sales],
      ["Status mix sums to KPI orders", sum(groupBy(rows, "status"), "orders"), k.orders],
    ];
    return checks.map(([label, actual, expected]) => ({ label, actual, expected, ok: actual === expected }));
  }

  /* ---------- CSV (Tableau-friendly: flat, one row per record, ISO dates) ---------- */
  const CSV_HEADERS = ["Record ID", "Timestamp", "Date", "Region", "Category", "Product", "Quantity",
    "Unit Price (IDR)", "Total Sales (IDR)", "Status", "Customer Rating", "Updated By", "Last Updated"];
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(records) {
    const lines = [CSV_HEADERS.join(",")];
    const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const r of sorted) {
      lines.push([r.id, r.timestamp.replace("T", " "), dateOf(r.timestamp), r.region, r.category, r.product,
        r.quantity, r.unitPrice, total(r), r.status, r.rating, r.updatedBy, (r.lastUpdated || "").replace("T", " ")]
        .map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
  }

  /* ---------- random record (for the live-feed simulator) ---------- */
  function randomRecord(rng, whenISO, by) {
    rng = rng || Math.random;
    const pick = (a) => a[Math.floor(rng() * a.length)];
    const category = pick(CATALOG.categoryNames);
    const product = pick(CATALOG.categories[category]);
    const status = pick(["Completed", "Completed", "Completed", "Pending", "Cancelled", "Refunded"]);
    return {
      timestamp: whenISO || nowLocalISO(),
      region: pick(CATALOG.regions), category, product,
      quantity: 1 + Math.floor(rng() * 5),
      unitPrice: Math.round((CATALOG.basePrice[product] * (0.9 + rng() * 0.2)) / 1000) * 1000,
      status,
      rating: status === "Completed" ? 1 + Math.floor(rng() * 5) : null,
      updatedBy: by || "Simulator",
    };
  }

  return {
    CATALOG, total, fmtIDR, nowLocalISO, dateOf, validateRecord,
    anchorDay, filterRecords, kpis, groupBy, byDay, reconcile, toCSV, randomRecord, CSV_HEADERS,
  };
});
