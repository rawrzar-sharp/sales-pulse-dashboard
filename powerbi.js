/*
 * powerbi.js — pushes every data change to a Power BI streaming/push dataset.
 *
 * Why a "ledger"?  Streaming push URLs can only APPEND rows (no update/delete).
 * So every change is sent as signed rows:
 *      create  ->  +1 row
 *      update  ->  -1 row (old values) and +1 row (new values)
 *      delete  ->  -1 row (old values)
 * Every numeric column is multiplied by that sign, so in Power BI
 *      SUM(TotalSales), SUM(Orders), ...   always equal the current state of the site.
 *
 * Config (env):  POWERBI_PUSH_URL  the "Push URL" Power BI shows for your streaming dataset
 *                POWERBI_FLUSH_MS  batch interval (default 1000)
 *                POWERBI_BACKFILL=1  force re-sending all current rows once
 */
const fs = require("fs");
const crypto = require("crypto");
const A = require("./public/js/analytics.js");

const FIELDS = [
  ["EventTime", "DateTime"], ["ChangeType", "Text"], ["RecordId", "Text"], ["OrderTime", "DateTime"],
  ["Region", "Text"], ["Category", "Text"], ["Product", "Text"], ["Status", "Text"], ["UpdatedBy", "Text"],
  ["Orders", "Number"], ["Quantity", "Number"], ["UnitPrice", "Number"], ["TotalSales", "Number"],
  ["Completed", "Number"], ["Rated", "Number"], ["RatingSum", "Number"],
];

const iso = (naive) => naive + ".000Z"; // naive local wall-clock time, kept as-is (same numbers as the site)

function ledgerRows(rec, sign, changeType, nowISO) {
  const total = A.total(rec);
  const rated = rec.rating != null ? 1 : 0;
  return {
    EventTime: nowISO, ChangeType: changeType, RecordId: rec.id, OrderTime: iso(rec.timestamp),
    Region: rec.region, Category: rec.category, Product: rec.product, Status: rec.status, UpdatedBy: rec.updatedBy || "",
    Orders: sign, Quantity: sign * rec.quantity, UnitPrice: rec.unitPrice, TotalSales: sign * total,
    Completed: sign * (rec.status === "Completed" ? 1 : 0), Rated: sign * rated, RatingSum: sign * (rec.rating || 0),
  };
}

function createPusher(opts) {
  opts = opts || {};
  const url = opts.url || "";
  const flushMs = Number(opts.flushMs) || 1000;
  const maxBatch = 500, maxQueue = 20000;
  const st = { enabled: !!url, sent: 0, batches: 0, dropped: 0, lastOkAt: null, lastError: null, fails: 0 };
  let queue = [], timer = null, busy = false, stopped = false;

  const stats = () => ({ ...st, pending: queue.length, inflight: busy });
  function schedule(ms) {
    if (!st.enabled || stopped || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, ms);
    if (timer.unref) timer.unref();
  }
  function enqueue(rows) {
    if (!st.enabled || !rows.length) return;
    queue.push(...rows);
    if (queue.length > maxQueue) { const over = queue.length - maxQueue; queue.splice(0, over); st.dropped += over; }
    schedule(flushMs);
  }

  async function flush() {
    if (!st.enabled || busy || !queue.length) return;
    busy = true;
    const batch = queue.splice(0, maxBatch);
    let retryMs = 0;
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: batch }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        st.sent += batch.length; st.batches++; st.lastOkAt = new Date().toISOString(); st.lastError = null; st.fails = 0;
      } else if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        st.fails++; retryMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** st.fails);
        st.lastError = `Power BI answered ${res.status} — retrying`;
        queue.unshift(...batch);
      } else {
        // 400/401/403/404: retrying cannot help (wrong URL/key or the columns do not match)
        st.dropped += batch.length;
        st.lastError = `Power BI rejected the rows (${res.status}). Check the push URL and that the dataset columns match powerbi-fields.json.`;
      }
    } catch (e) {
      st.fails++; retryMs = Math.min(30000, 1000 * 2 ** st.fails);
      st.lastError = "Cannot reach Power BI (" + (e.name === "TimeoutError" ? "timeout" : e.message) + ") — retrying";
      queue.unshift(...batch);
    } finally {
      busy = false;
      if (queue.length) schedule(retryMs || 50);
    }
  }

  const now = () => new Date().toISOString();
  return {
    enabled: st.enabled, stats, flush,
    stop() { stopped = true; clearTimeout(timer); },
    created(rec) { enqueue([ledgerRows(rec, 1, "create", now())]); },
    updated(oldRec, newRec) { const t = now(); enqueue([ledgerRows(oldRec, -1, "update-reverse", t), ledgerRows(newRec, 1, "update", t)]); },
    deleted(rec) { enqueue([ledgerRows(rec, -1, "delete", now())]); },
    replaced(oldRecs, newRecs) { const t = now(); enqueue([...oldRecs.map((r) => ledgerRows(r, -1, "reset-reverse", t)), ...newRecs.map((r) => ledgerRows(r, 1, "reset", t))]); },
    backfill(recs) { const t = now(); enqueue(recs.map((r) => ledgerRows(r, 1, "backfill", t))); },
  };
}

// remembers (per push URL) that the one-time backfill of existing rows already happened
function backfillOnce(pusher, records, stateFile, url, force) {
  if (!pusher.enabled) return false;
  const id = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  if (!force && state.backfilled === id) return false;
  pusher.backfill(records);
  try { fs.writeFileSync(stateFile, JSON.stringify({ backfilled: id, at: new Date().toISOString() })); } catch {}
  return true;
}

module.exports = { createPusher, ledgerRows, backfillOnce, FIELDS };
