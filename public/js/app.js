/* app.js — wires store + analytics + charts + UI together */
(function () {
  "use strict";
  const A = window.Analytics, C = window.Charts;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = C.esc;

  /* ---------------- state ---------------- */
  const state = {
    view: "overview",
    filters: { range: "all", regions: [], categories: [], statuses: [] },
    sort: { key: "timestamp", dir: "desc" }, search: "", limit: 25,
    name: "", store: null, sim: null, flashIds: new Set(), freshIds: new Set(), biReady: false,
  };
  try { state.name = localStorage.getItem("dash.name") || ""; } catch {}
  if (!state.name) state.name = "Guest-" + Math.floor(100 + Math.random() * 900);

  /* ---------------- toasts ---------------- */
  function toast(msg, kind, action) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = () => { action.fn(); close(); }; t.appendChild(b); }
    $("#toasts").appendChild(t);
    while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
    const close = () => { t.classList.add("out"); setTimeout(() => t.remove(), 300); };
    setTimeout(close, action ? 7000 : 3800);
    return t;
  }

  /* ---------------- charts ---------------- */
  const trend = C.AreaChart($("#ch-trend"));
  const toggle = (dim) => (key) => {
    const arr = state.filters[dim], i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    renderOverview();
  };
  const regionBars = C.BarList($("#ch-region"), { valueKey: "sales", fmt: (v) => A.fmtIDR(v, true), onToggle: toggle("regions") });
  const statusBars = C.BarList($("#ch-status"), { valueKey: "orders", fmt: (v) => Math.round(v).toLocaleString("en-US"), onToggle: toggle("statuses"), keepOrder: true,
    colorFn: (i, key) => ({ Completed: "var(--c3)", Pending: "var(--c2)", Cancelled: "var(--c4)", Refunded: "var(--c5)" }[key] || "var(--c6)") });
  const productBars = C.BarList($("#ch-product"), { valueKey: "sales", fmt: (v) => A.fmtIDR(v, true), onToggle: null });
  const donut = C.Donut($("#ch-category"), toggle("categories"));

  /* ---------------- overview ---------------- */
  let lastK = {};
  function renderOverview() {
    const all = state.store.records;
    const rows = A.filterRecords(all, state.filters);
    const k = A.kpis(rows);

    const set = (id, v, fmt) => C.countUp($(id), v, fmt);
    set("#k-sales", k.sales, (v) => A.fmtIDR(v, true));
    set("#k-orders", k.orders, (v) => Math.round(v).toLocaleString("en-US"));
    set("#k-aov", k.aov, (v) => A.fmtIDR(v, true));
    set("#k-completion", k.completionRate * 100, (v) => v.toFixed(1) + "%");
    set("#k-rating", k.avgRating, (v) => (k.ratedCount ? "★ " + v.toFixed(2) : "–"));
    $("#k-rating-sub").textContent = k.ratedCount ? `${k.ratedCount} rated orders` : "No rated orders";
    $("#k-sales").title = A.fmtIDR(k.sales); $("#k-aov").title = A.fmtIDR(k.aov);
    for (const key of ["sales", "orders", "aov", "completionRate", "avgRating"]) {
      if (lastK[key] !== undefined && lastK[key] !== k[key]) {
        const card = $(`.kpi[data-k="${key === "completionRate" ? "completion" : key === "avgRating" ? "rating" : key}"]`);
        card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
      }
    }
    lastK = k;

    trend.update(A.byDay(rows));
    const C_ = A.CATALOG;
    regionBars.update(A.groupBy(rows, "region", C_.regions), { selected: new Set(state.filters.regions) });
    statusBars.update(A.groupBy(rows, "status", C_.statuses), { selected: new Set(state.filters.statuses) });
    const prods = A.groupBy(rows, "product").sort((a, b) => b.sales - a.sales).slice(0, 5);
    productBars.update(prods, {});
    donut.update(A.groupBy(rows, "category", C_.categoryNames), new Set(state.filters.categories), A.fmtIDR(k.sales, true), `${k.orders} orders`);

    // integrity
    const checks = A.reconcile(rows);
    $("#integrity").innerHTML = checks.map((c) =>
      `<li class="${c.ok ? "" : "bad"}"><span class="ck">${c.ok ? "✓" : "!"}</span>${esc(c.label)}<span class="v">${c.actual.toLocaleString("en-US")}${c.ok ? "" : " ≠ " + c.expected.toLocaleString("en-US")}</span></li>`).join("");
    const pass = checks.filter((c) => c.ok).length;
    $("#integritySum").textContent = `${pass}/${checks.length} checks passed · ${rows.length} of ${all.length} records in view`;
    $("#integrity").dataset.pass = pass; $("#integrity").dataset.total = checks.length;

    // filters UI
    $$(".seg [data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === String(state.filters.range)));
    const anchor = A.anchorDay(all);
    $("#rangeHint").textContent = state.filters.range === "all" ? "Showing every record" : `Last ${state.filters.range} days up to ${anchor || "–"} (latest record)`;
    renderChips();
  }

  function renderChips() {
    const box = $("#activeFilters"); box.innerHTML = "";
    const f = state.filters; let n = 0;
    [["regions", "Region"], ["categories", "Category"], ["statuses", "Status"]].forEach(([dim, label]) => f[dim].forEach((v) => {
      n++;
      const c = document.createElement("span"); c.className = "chip";
      c.innerHTML = `${label}: ${esc(v)} <button type="button" aria-label="Remove filter ${esc(v)}">×</button>`;
      c.querySelector("button").onclick = () => { f[dim].splice(f[dim].indexOf(v), 1); renderOverview(); };
      box.appendChild(c);
    }));
    if (n) {
      const clr = document.createElement("button"); clr.className = "chip clear"; clr.type = "button"; clr.textContent = "Clear all";
      clr.onclick = () => { f.regions = []; f.categories = []; f.statuses = []; renderOverview(); };
      box.appendChild(clr);
    }
  }
  $$(".seg [data-range]").forEach((b) => b.addEventListener("click", () => { state.filters.range = b.dataset.range === "all" ? "all" : Number(b.dataset.range); renderOverview(); }));

  /* ---------------- data table ---------------- */
  const COLS = [["id", "ID"], ["timestamp", "Timestamp"], ["region", "Region"], ["category", "Category"], ["product", "Product"], ["quantity", "Qty", "r"], ["unitPrice", "Unit price", "r"], ["total", "Total", "r"], ["status", "Status"], ["rating", "Rating", "r"], ["updatedBy", "By"]];
  const val = (r, k) => (k === "total" ? A.total(r) : r[k]);

  function renderTable() {
    const q = state.search.trim().toLowerCase();
    let rows = state.store.records.filter((r) => !q || [r.id, r.region, r.category, r.product, r.status, r.updatedBy, r.timestamp].join(" ").toLowerCase().includes(q));
    const { key, dir } = state.sort, m = dir === "asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const x = val(a, key), y = val(b, key);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; // nulls always last
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * m;
    });
    const shown = rows.slice(0, state.limit);
    $("#tbody").innerHTML = shown.map((r) => {
      const cls = state.freshIds.has(r.id) ? "fresh" : state.flashIds.has(r.id) ? "flash" : "";
      const cells = COLS.map(([k, l, c]) => {
        let v = val(r, k);
        if (k === "timestamp") v = v.replace("T", " ");
        else if (k === "unitPrice" || k === "total") v = A.fmtIDR(v);
        else if (k === "quantity") v = v;
        else if (k === "rating") v = v == null ? "–" : "★".repeat(v) + `<span class="sr"> ${v} of 5</span>`;
        else if (k === "status") return `<td data-l="${l}"><span class="badge ${esc(v)}">${esc(v)}</span></td>`;
        else v = esc(v);
        return `<td data-l="${l}" class="${c || ""}">${v}</td>`;
      }).join("");
      return `<tr data-id="${esc(r.id)}" class="${cls}">${cells}<td class="r actions-td"><button class="row-btn" data-edit="${esc(r.id)}" aria-label="Edit ${esc(r.id)}">Edit</button></td></tr>`;
    }).join("");
    $("#tblEmpty").hidden = rows.length > 0;
    $("#moreBtn").hidden = rows.length <= state.limit;
    $("#moreBtn").textContent = `Show more (${rows.length - state.limit} remaining)`;
    $("#rowCount").textContent = `${rows.length} of ${state.store.records.length} records`;
    $("#exportRows").textContent = state.store.records.length;
    $$("#tbl th[data-sort]").forEach((th) => { th.classList.toggle("sorted", th.dataset.sort === key); th.classList.toggle("desc", th.dataset.sort === key && dir === "desc"); th.setAttribute("aria-sort", th.dataset.sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"); });
  }
  $$("#tbl th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === "desc" ? "asc" : "desc" };
    renderTable();
  }));
  let st = 0; $("#search").addEventListener("input", (e) => { clearTimeout(st); st = setTimeout(() => { state.search = e.target.value; state.limit = 25; renderTable(); }, 120); });
  $("#moreBtn").addEventListener("click", () => { state.limit += 50; renderTable(); });
  $("#tbody").addEventListener("click", (e) => { const b = e.target.closest("[data-edit]"); if (b) openEditor(b.dataset.edit); });

  /* ---------------- editor dialog ---------------- */
  const ed = $("#editor"), F = (id) => $("#f-" + id);
  const fillSel = (sel, opts, blank) => { sel.innerHTML = (blank ? `<option value="">${blank}</option>` : "") + opts.map((o) => `<option>${esc(o)}</option>`).join(""); };
  fillSel(F("region"), A.CATALOG.regions); fillSel(F("category"), A.CATALOG.categoryNames); fillSel(F("status"), A.CATALOG.statuses);
  F("rating").innerHTML = '<option value="">No rating</option>' + [1, 2, 3, 4, 5].map((n) => `<option value="${n}">${"★".repeat(n)} (${n})</option>`).join("");
  let editing = null; // {id, version} or null when creating
  const syncProducts = (keep) => { fillSel(F("product"), A.CATALOG.categories[F("category").value]); if (keep) F("product").value = keep; };
  const syncRating = () => { const ok = F("status").value === "Completed"; F("rating").disabled = !ok; if (!ok) F("rating").value = ""; };
  const syncTotal = () => { $("#edTotal").textContent = A.fmtIDR((+F("quantity").value || 0) * (+F("unitPrice").value || 0)); };
  F("category").addEventListener("change", () => { syncProducts(); F("unitPrice").value = A.CATALOG.basePrice[F("product").value]; syncTotal(); });
  F("product").addEventListener("change", () => { F("unitPrice").value = A.CATALOG.basePrice[F("product").value]; syncTotal(); });
  F("status").addEventListener("change", syncRating);
  ["quantity", "unitPrice"].forEach((k) => F(k).addEventListener("input", syncTotal));

  function openEditor(id) {
    const r = id ? state.store.records.find((x) => x.id === id) : null;
    if (id && !r) return toast("That record no longer exists.", "err");
    editing = r ? { id: r.id, version: r.version } : null;
    $("#edTitle").textContent = r ? `Edit ${r.id}` : "Add record";
    $("#edDelete").hidden = !r; $("#edErr").hidden = true;
    const d = r || A.randomRecord(Math.random, A.nowLocalISO(), state.name);
    F("timestamp").value = d.timestamp.slice(0, 19);
    F("region").value = d.region; F("category").value = d.category; syncProducts(d.product);
    F("quantity").value = r ? d.quantity : 1; F("unitPrice").value = d.unitPrice;
    F("status").value = r ? d.status : "Completed"; syncRating(); F("rating").value = r && d.rating ? d.rating : "";
    syncTotal(); ed.showModal(); F("timestamp").blur(); F("quantity").focus();
  }
  function formData() {
    return { timestamp: F("timestamp").value, region: F("region").value, category: F("category").value, product: F("product").value,
      quantity: F("quantity").value, unitPrice: F("unitPrice").value, status: F("status").value, rating: F("rating").value || null, updatedBy: state.name };
  }
  async function withAuth(fn) {
    try { return await fn(); }
    catch (e) {
      if (e.status === 401) { const ok = await askKey(); if (ok) return fn(); throw Object.assign(e, { silent: true }); }
      throw e;
    }
  }
  function askKey() {
    return new Promise((resolve) => {
      const dlg = $("#keyDlg"); $("#keyInput").value = "";
      const done = (v) => { dlg.close(); $("#keyForm").onsubmit = null; resolve(v); };
      $("#keyForm").onsubmit = (e) => { e.preventDefault(); state.store.setKey($("#keyInput").value); done(true); };
      $("#keyCancel").onclick = () => done(false);
      dlg.showModal();
    });
  }
  function showErr(e) {
    if (e.silent) return;
    const el = $("#edErr"); el.hidden = false;
    el.textContent = e.details && e.details.length ? e.details.join(" · ") : e.message;
  }
  $("#edForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#edSave"); btn.disabled = true;
    try {
      const data = formData();
      if (editing) await withAuth(() => state.store.update(editing.id, data, editing.version));
      else await withAuth(() => state.store.create(data));
      ed.close(); toast(editing ? `${editing.id} updated` : "Record added", "ok");
    } catch (err) {
      if (err.status === 409 && err.current) { editing.version = err.current.version; showErr(Object.assign(err, { message: err.message + " The form was refreshed — review and save again." })); openEditorFromRecord(err.current); }
      else showErr(err);
    } finally { btn.disabled = false; }
  });
  function openEditorFromRecord(r) { // refresh the form values after a version conflict
    F("timestamp").value = r.timestamp.slice(0, 19); F("region").value = r.region; F("category").value = r.category; syncProducts(r.product);
    F("quantity").value = r.quantity; F("unitPrice").value = r.unitPrice; F("status").value = r.status; syncRating(); F("rating").value = r.rating || ""; syncTotal();
  }
  $("#edCancel").addEventListener("click", () => ed.close());
  $("#edDelete").addEventListener("click", async () => {
    if (!editing) return;
    const snap = state.store.records.find((r) => r.id === editing.id);
    try {
      await withAuth(() => state.store.remove(editing.id)); ed.close();
      toast(`${snap.id} deleted`, "", { label: "Undo", fn: () => withAuth(() => state.store.restore(snap)).then(() => toast("Restored", "ok")).catch((e) => toast(e.message, "err")) });
    } catch (err) { showErr(err); }
  });
  $("#addBtn").addEventListener("click", () => openEditor(null));
  $("#randBtn").addEventListener("click", async () => {
    try { const r = await withAuth(() => state.store.create(A.randomRecord(Math.random, A.nowLocalISO(), state.name))); toast(`${r.id} added (${r.region} · ${r.product})`, "ok"); }
    catch (e) { if (!e.silent) toast(e.message, "err"); }
  });
  $("#batchBtn").addEventListener("click", async () => {
    const btn = $("#batchBtn"); btn.disabled = true;
    try {
      const first = await withAuth(() => state.store.create(A.randomRecord(Math.random, A.nowLocalISO(), state.name))); // also handles the edit-key prompt once
      await Promise.all(Array.from({ length: 19 }, () => state.store.create(A.randomRecord(Math.random, A.nowLocalISO(), state.name))));
      toast("20 random orders added (" + first.id + " …)", "ok");
    } catch (e) { if (!e.silent) toast(e.message, "err"); }
    finally { btn.disabled = false; }
  });
  $("#resetBtn").addEventListener("click", async () => {
    if (!confirm("Restore the original 60 demo rows for EVERYONE? Your changes will be lost.")) return;
    try { await withAuth(() => state.store.reset()); toast("Demo data restored", "ok"); } catch (e) { if (!e.silent) toast(e.message, "err"); }
  });

  /* ---------------- simulator ---------------- */
  $("#simBtn").addEventListener("click", () => {
    const on = $("#simBtn").getAttribute("aria-pressed") !== "true";
    $("#simBtn").setAttribute("aria-pressed", on);
    $("#simBtn .ico").textContent = on ? "●" : "▶";
    clearInterval(state.sim);
    if (on) {
      toast("Simulator on — a new random order every 3 s", "ok");
      state.sim = setInterval(() => withAuth(() => state.store.create(A.randomRecord(Math.random, A.nowLocalISO(), "Simulator"))).catch((e) => { if (!e.silent) toast(e.message, "err"); stopSim(); }), 3000);
    }
  });
  function stopSim() { clearInterval(state.sim); $("#simBtn").setAttribute("aria-pressed", "false"); $("#simBtn .ico").textContent = "▶"; }

  /* ---------------- live updates from store ---------------- */
  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return; rafPending = true;
    setTimeout(() => { rafPending = false; renderOverview(); renderTable(); }, 16); // timer, not rAF: data must stay current even in background tabs
  }
  function onStore(evt) {
    if (evt.type === "upsert") {
      const id = evt.record.id;
      (evt.op === "create" ? state.freshIds : state.flashIds).add(id);
      setTimeout(() => { state.freshIds.delete(id); state.flashIds.delete(id); }, 2000);
      if (evt.record.updatedBy !== state.name && evt.record.updatedBy !== "Simulator")
        toast(`${evt.record.updatedBy} ${evt.op === "create" ? "added" : "edited"} ${id}`, "live");
      scheduleRender();
    } else if (evt.type === "delete") {
      if (evt.record.updatedBy !== state.name) toast(`${evt.record.id} was deleted`, "live");
      scheduleRender();
    } else if (evt.type === "snapshot") scheduleRender();
    else if (evt.type === "presence") { state.online = evt.online; setPill(); }
    else if (evt.type === "status") { state.connected = evt.connected; setPill(); if (!evt.connected) toast("Connection lost — retrying…", "err"); else if (state.wasDown) toast("Back online — data re-synced", "ok"); state.wasDown = !evt.connected; }
  }
  function setPill() {
    const pill = $("#livePill"), t = $("#liveText"), s = state.store;
    pill.className = "pill";
    if (s.mode === "local") { pill.classList.add("local"); t.textContent = "Local demo"; }
    else if (state.connected === false) { pill.classList.add("off"); t.textContent = "Reconnecting…"; }
    else { pill.classList.add("live"); t.textContent = `Live · ${state.online || 1} online`; pill.title = s.transport === "push" ? "Instant push (SSE)" : "Live via polling (tunnel without SSE support)"; }
  }

  /* ---------------- tabs ---------------- */
  function show(view, focus) {
    state.view = view;
    $$(".tabs [role=tab]").forEach((b) => { const on = b.dataset.view === view; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; });
    $$(".view").forEach((v) => { const on = v.id === "view-" + view; v.hidden = !on; v.classList.toggle("active", on); });
    watchPushStatus(view === "bi");
    if (view === "bi") renderBI();
    if (view === "overview") renderOverview();
    if (view === "data") renderTable();
    history.replaceState(null, "", "#" + view);
    if (focus) $(`#tab-${view}`).focus();
    window.scrollTo({ top: 0, behavior: C.reduceMotion() ? "auto" : "smooth" });
  }
  $$(".tabs [role=tab]").forEach((b, i, all) => {
    b.addEventListener("click", () => show(b.dataset.view));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
      e.preventDefault(); show(all[(i + d + all.length) % all.length].dataset.view, true);
    });
  });
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => show(b.dataset.goto)));

  /* ---------------- Power BI embed ---------------- */
  const BI_CFG = (window.DASH_CONFIG && window.DASH_CONFIG.powerBi) || {};
  // Returns {ok, url} or {ok:false, msg}. Only https Microsoft hosts may be framed (blocks arbitrary-site injection).
  function checkEmbedUrl(raw) {
    let u; try { u = new URL(String(raw).trim()); } catch { return { ok: false, msg: "That is not a valid web address." }; }
    const hostOk = u.protocol === "https:" && (/(^|\.)powerbi\.com$/.test(u.hostname) || /(^|\.)powerbigov\.us$/.test(u.hostname) || u.hostname === "app.fabric.microsoft.com");
    if (!hostOk) return { ok: false, msg: "Only https://app.powerbi.com/… addresses can be embedded." };
    if (u.pathname.startsWith("/links/")) return { ok: false, msg: "That is a share link (/links/…). Use File → Embed report in Power BI to get an embed link instead." };
    if (!(u.pathname === "/view" || u.pathname.startsWith("/reportEmbed") || u.pathname.startsWith("/dashboardEmbed") || u.pathname.startsWith("/rdlEmbed") || u.pathname.includes("/embed")))
      return { ok: false, msg: "This does not look like an embed link. It should start with …/view?r= or …/reportEmbed?" };
    return { ok: true, url: u.toString() };
  }
  function savedEmbed() { try { return localStorage.getItem("dash.biEmbed") || ""; } catch { return ""; } }
  function renderBI() {
    const raw = savedEmbed() || BI_CFG.embedUrl || "";
    const chk = raw ? checkEmbedUrl(raw) : { ok: false };
    const host = $("#biHost");
    $("#biOpen").href = BI_CFG.shareLink || (chk.ok ? chk.url : "https://app.powerbi.com/");
    $("#biOpen").hidden = !$("#biOpen").href || $("#biOpen").href.endsWith("#");
    if (chk.ok) {
      if (host.dataset.src !== chk.url) {
        host.dataset.src = chk.url; host.innerHTML = "";
        const f = document.createElement("iframe");
        f.title = "Power BI report"; f.src = chk.url; f.allowFullscreen = true; f.loading = "lazy";
        f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation");
        f.referrerPolicy = "origin";
        host.appendChild(f);
      }
      host.hidden = false; $("#biSetup").hidden = true; $("#biFoot").hidden = false;
    } else {
      host.hidden = true; host.innerHTML = ""; host.dataset.src = ""; $("#biSetup").hidden = false; $("#biFoot").hidden = true;
      if (raw) { $("#biErr").hidden = false; $("#biErr").textContent = chk.msg; }
    }
  }
  /* live-push status card */
  let biTimer = null;
  async function refreshPushStatus() {
    const box = $("#pushStatus"), dot = $("#pushDot");
    if (state.store.mode !== "live") { box.textContent = "Needs the server (node server.js)."; dot.className = "dot"; return; }
    try {
      const c = await (await fetch("/api/config", { cache: "no-store" })).json(), p = c.powerBi || {};
      if (!p.enabled) { dot.className = "dot"; box.innerHTML = "<b>Off.</b> Start the server with <code>POWERBI_PUSH_URL</code> to stream every change to Power BI."; return; }
      const ago = p.lastOkAt ? Math.max(0, Math.round((Date.now() - Date.parse(p.lastOkAt)) / 1000)) + " s ago" : "not yet";
      dot.className = "dot " + (p.lastError ? "bad" : "ok");
      box.innerHTML = `<b>${p.lastError ? "Problem" : "On"}.</b> Sent <b>${p.sent.toLocaleString("en-US")}</b> rows · pending ${p.pending} · last push ${ago}` + (p.lastError ? `<br><span class="err">${esc(p.lastError)}</span>` : "") + (p.dropped ? `<br>Dropped: ${p.dropped}` : "");
    } catch { box.textContent = "Status unavailable."; }
  }
  function watchPushStatus(on) { clearInterval(biTimer); if (on) { refreshPushStatus(); biTimer = setInterval(refreshPushStatus, 3000); } }
  $("#biSave").addEventListener("click", () => {
    const chk = checkEmbedUrl($("#biUrl").value);
    if (!chk.ok) { $("#biErr").hidden = false; $("#biErr").textContent = chk.msg; return; }
    $("#biErr").hidden = true;
    try { localStorage.setItem("dash.biEmbed", chk.url); } catch {}
    renderBI(); toast("Power BI report loaded", "ok");
  });
  $("#biUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#biSave").click(); } });
  $("#biChange").addEventListener("click", () => { try { localStorage.removeItem("dash.biEmbed"); } catch {} BI_CFG.embedUrl = ""; renderBI(); $("#biUrl").focus(); });
  window.__checkEmbedUrl = checkEmbedUrl;

  /* ---------------- export, theme, name ---------------- */
  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([A.toCSV(state.store.records)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "dashboard_data.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("CSV downloaded — load it in Power BI or Tableau", "ok");
  });
  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; try { localStorage.setItem("dash.theme", next); } catch {}
  });
  function setName(n) {
    state.name = n; try { localStorage.setItem("dash.name", n); } catch {}
    $("#nameLbl").textContent = n; $("#avatar").textContent = n.trim().charAt(0).toUpperCase() || "?";
  }
  $("#nameBtn").addEventListener("click", () => { $("#nameInput").value = state.name; $("#nameDlg").showModal(); $("#nameInput").select(); });
  $("#nameForm").addEventListener("submit", (e) => { const v = $("#nameInput").value.trim().replace(/[<>]/g, "").slice(0, 24); if (v) setName(v); });

  /* ---------------- boot ---------------- */
  (async function boot() {
    setName(state.name);
    try {
      state.store = await window.createStore();
    } catch (e) {
      $("#main").innerHTML = `<div class="card"><h2>Could not start</h2><p class="muted">${esc(e.message)}</p></div>`; return;
    }
    state.connected = true;
    state.store.on(onStore);
    $("#modeLabel").textContent = state.store.mode === "live" ? "real-time · multi-user" : "demo mode · this browser only";
    if (state.store.mode === "local") { $("#exportBtn").title = "Generated in your browser"; $("#csvUrl").textContent = "(start server.js to get a live address)"; }
    else $("#csvUrl").textContent = location.origin + "/api/export.csv";
    setPill();
    const start = location.hash.replace("#", "");
    show(["overview", "bi", "data"].includes(start) ? start : "overview");
    renderTable();
    window.__app = { state, show, A }; // handy for debugging / tests
    document.documentElement.dataset.ready = "1";
  })();
})();
