"""
End-to-end browser tests (Playwright for Python).  Run:  python test/e2e_playwright.py
Needs: pip install playwright && playwright install chromium
Starts its own server on a temp data copy, so your real data is never touched.
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(os.environ.get("SHOTS", ROOT / "test" / "screenshots")); SHOTS.mkdir(parents=True, exist_ok=True)
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def start_server(port, key="", extra=None):
    tmp = tempfile.mkdtemp()
    shutil.copy(ROOT / "data" / "records.seed.json", Path(tmp) / "records.json")
    env = {**os.environ, "PORT": str(port), "DATA_FILE": str(Path(tmp) / "records.json"), "EDIT_KEY": key, **(extra or {})}
    p = subprocess.Popen(["node", str(ROOT / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try: urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health"); return p, tmp
        except Exception: time.sleep(0.1)
    raise RuntimeError("server did not start")

def api(port, path): return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}{path}"))
def txt(page, sel): return page.locator(sel).inner_text().strip()
def ev(fn, timeout=3.0):
    """poll until fn() is truthy (KPIs count up over ~0.7s, so exact reads need a short wait)"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.1)
    return bool(fn())
def num(s): return float("".join(c for c in s if c.isdigit() or c == "."))

PORT = 3111
srv, tmp = start_server(PORT)
URL = f"http://127.0.0.1:{PORT}"
errors = []

try:
  with sync_playwright() as p:
    br = p.chromium.launch()

    # ---------- 1. desktop load + data fidelity ----------
    print("\n[1] Load & data fidelity")
    ctxA = br.new_context(viewport={"width": 1366, "height": 900}); A = ctxA.new_page()
    A.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_" not in m.text and not any(c in m.text for c in ("409", "422", "403", "401")) else None)
    A.on("pageerror", lambda e: errors.append(str(e)))
    A.goto(URL); A.wait_for_function("document.documentElement.dataset.ready==='1'")
    A.wait_for_timeout(1500)
    recs = api(PORT, "/api/records")["records"]
    sales = sum(r["quantity"] * r["unitPrice"] for r in recs)
    check("orders KPI == 60 rows", ev(lambda: txt(A, "#k-orders") == "60"), txt(A, "#k-orders"))
    shown = txt(A, "#k-sales"); check("sales KPI matches data (compact)", shown.startswith("Rp"), shown)
    check("sales KPI full value in tooltip == sum(qty*price)", A.locator("#k-sales").get_attribute("title").replace("Rp ", "").replace(",", "") == str(sales), A.locator("#k-sales").get_attribute("title"))
    check("integrity panel: 5/5 pass", A.locator("#integrity").get_attribute("data-pass") == "5")
    check("live pill says Live", "Live" in txt(A, "#liveText"), txt(A, "#liveText"))
    bars = A.locator("#ch-region .bar-row"); check("6 region bars", bars.count() == 6, bars.count())
    check("trend svg has a polyline", A.locator("#ch-trend polyline.line").count() == 1)
    check("donut has 4 slices", A.locator("#ch-category .slice").count() == 4)
    A.screenshot(path=str(SHOTS / "01_overview_dark.png"), full_page=True)

    # chart <-> data: bar widths proportional to the data
    reg = {}
    for r in recs: reg[r["region"]] = reg.get(r["region"], 0) + r["quantity"] * r["unitPrice"]
    top = max(reg, key=reg.get)
    check("top region bar is the true top region", A.locator("#ch-region .bar-row").first.locator(".bar-label").inner_text() == top, top)
    w = A.locator("#ch-region .bar-row").first.locator(".bar-fill").evaluate("e=>e.style.width"); check("top bar is 100% wide", w.startswith("100"), w)

    # ---------- 2. interaction: cross filter ----------
    print("\n[2] Filtering & interaction")
    A.locator("#ch-region .bar-row", has_text="Jakarta").click()
    A.wait_for_timeout(900)
    jk = [r for r in recs if r["region"] == "Jakarta"]
    check("click bar -> chip appears", A.locator(".chip", has_text="Region: Jakarta").count() == 1)
    check("click bar -> orders KPI == Jakarta rows", ev(lambda: txt(A, "#k-orders") == str(len(jk))), f"{txt(A,'#k-orders')} vs {len(jk)}")
    check("integrity still 5/5 while filtered", A.locator("#integrity").get_attribute("data-pass") == "5")
    A.locator("#ch-category .legend-item", has_text="Home").click(); A.wait_for_timeout(900)
    both = [r for r in jk if r["category"] == "Home"]
    check("two filters AND together", ev(lambda: txt(A, "#k-orders") == str(len(both))), f"{txt(A,'#k-orders')} vs {len(both)}")
    A.screenshot(path=str(SHOTS / "02_filtered.png"), full_page=True)
    A.locator(".chip.clear").click(); A.wait_for_timeout(700)
    check("Clear all restores 60", ev(lambda: txt(A, "#k-orders") == "60"))
    A.locator('[data-range="7"]').click(); A.wait_for_timeout(800)
    last = max(r["timestamp"][:10] for r in recs)
    import datetime as dt
    cutoff = (dt.date.fromisoformat(last) - dt.timedelta(days=6)).isoformat()
    n7 = len([r for r in recs if r["timestamp"][:10] >= cutoff])
    check("7D range count correct", ev(lambda: txt(A, "#k-orders") == str(n7)), f"{txt(A,'#k-orders')} vs {n7}")
    A.locator('[data-range="all"]').click(); A.wait_for_timeout(600)

    # hover tooltip on trend
    box = A.locator("#ch-trend svg").bounding_box()
    A.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5); A.wait_for_timeout(250)
    check("trend hover shows tooltip", A.locator(".tooltip.on").count() == 1 and "Sales" in txt(A, ".tooltip.on"))
    A.mouse.move(5, 5)

    # ---------- 3. real-time between two users ----------
    print("\n[3] Real-time multi-user sync")
    ctxB = br.new_context(viewport={"width": 1280, "height": 800}); B = ctxB.new_page()
    B.on("pageerror", lambda e: errors.append("B:" + str(e)))
    B.goto(URL + "#data"); B.wait_for_function("document.documentElement.dataset.ready==='1'")
    A.wait_for_timeout(500)
    check("presence shows 2 online", "2 online" in txt(A, "#liveText"), txt(A, "#liveText"))
    B.locator("#nameBtn").click(); B.fill("#nameInput", "Dewi"); B.locator("#nameForm button[type=submit]").click()
    A.locator("#nameBtn").click(); A.fill("#nameInput", "Andi"); A.locator("#nameForm button[type=submit]").click()

    B.locator("#addBtn").click(); B.fill("#f-quantity", "3"); B.select_option("#f-region", "Bali")
    B.select_option("#f-category", "Electronics"); B.select_option("#f-product", "Laptop")
    check("unit price autofilled on product change", B.input_value("#f-unitPrice") == "9500000", B.input_value("#f-unitPrice"))
    check("total preview live", "28,500,000" in txt(B, "#edTotal"), txt(B, "#edTotal"))
    B.screenshot(path=str(SHOTS / "03_editor.png"))
    B.locator("#edSave").click(); B.wait_for_timeout(700)
    check("B: new row appears in table", B.locator("tr", has_text="REC-0061").count() == 1)
    A.wait_for_timeout(900)
    check("A (other user) KPI orders -> 61 without reload", ev(lambda: txt(A, "#k-orders") == "61"), txt(A, "#k-orders"))
    check("A sees 'Dewi added' toast", A.locator(".toast", has_text="Dewi added REC-0061").count() >= 1)
    A.locator("#tab-data").click(); A.wait_for_timeout(300)
    check("A table has REC-0061 flagged fresh/flash", A.locator("tr[data-id='REC-0061']").count() == 1)

    # edit on A, see on B
    A.locator("[data-edit='REC-0061']").click(); A.fill("#f-quantity", "10"); A.locator("#edSave").click(); A.wait_for_timeout(700)
    B.wait_for_timeout(500)
    check("B sees edited qty=10 and total", "95,000,000" in B.locator("tr[data-id='REC-0061']").inner_text(), B.locator("tr[data-id='REC-0061']").inner_text())
    srv_rec = [r for r in api(PORT, "/api/records")["records"] if r["id"] == "REC-0061"][0]
    check("server holds version 2 & qty 10", srv_rec["version"] == 2 and srv_rec["quantity"] == 10, srv_rec)

    # conflict: both open same record, B saves first, then A
    A.locator("[data-edit='REC-0061']").click(); B.locator("[data-edit='REC-0061']").click()
    B.fill("#f-quantity", "4"); B.locator("#edSave").click(); B.wait_for_timeout(600)
    A.fill("#f-quantity", "7"); A.locator("#edSave").click(); A.wait_for_timeout(600)
    check("version conflict is reported to user", A.locator("#edErr").is_visible() and "changed" in txt(A, "#edErr").lower(), txt(A, "#edErr") if A.locator("#edErr").is_visible() else "no error")
    check("conflict dialog refreshed to latest qty=4", A.input_value("#f-quantity") == "4", A.input_value("#f-quantity"))
    A.locator("#edCancel").click()

    # delete + undo
    A.locator("[data-edit='REC-0061']").click(); A.locator("#edDelete").click(); A.wait_for_timeout(600)
    check("delete removes row (A)", A.locator("tr[data-id='REC-0061']").count() == 0)
    B.wait_for_timeout(500); check("delete propagates to B", B.locator("tr[data-id='REC-0061']").count() == 0)
    A.locator(".toast button", has_text="Undo").click(); A.wait_for_timeout(700)
    check("undo restores row on both", A.locator("tr[data-id='REC-0061']").count() == 1 and B.locator("tr[data-id='REC-0061']").count() == 1)

    # validation shown in UI
    A.locator("#addBtn").click(); A.fill("#f-quantity", "0"); A.locator("#edSave").click(); A.wait_for_timeout(400)
    check("invalid quantity shows error message", A.locator("#edErr").is_visible() and "quantity" in txt(A, "#edErr"), txt(A, "#edErr"))
    A.keyboard.press("Escape")

    # simulator
    A.locator("#tab-overview").click(); before = int(txt(A, "#k-orders"))
    A.locator("#simBtn").click(); A.wait_for_timeout(7500); A.locator("#simBtn").click()
    after = int(txt(A, "#k-orders")); check("simulator adds orders live (>=2 in 7s)", after - before >= 2, f"{before}->{after}")
    B.locator("#tab-overview").click(); B.wait_for_timeout(1200)
    check("both screens agree on orders after live feed", ev(lambda: txt(A, "#k-orders") == txt(B, "#k-orders")), f"{txt(A,'#k-orders')} / {txt(B,'#k-orders')}")
    check("integrity 5/5 after live changes", A.locator("#integrity").get_attribute("data-pass") == "5" and B.locator("#integrity").get_attribute("data-pass") == "5")
    A.screenshot(path=str(SHOTS / "04_after_live.png"), full_page=True)

    # ---------- 4. table features ----------
    print("\n[4] Table")
    A.locator("#tab-data").click(); A.fill("#search", "makassar"); A.wait_for_timeout(400)
    rows = A.locator("#tbody tr").count(); exp = len([r for r in api(PORT, "/api/records")["records"] if "makassar" in json.dumps(r).lower() and r["region"] == "Makassar"])
    check("search filters rows", 0 < rows <= 25 and all("Makassar" in t for t in A.locator("#tbody tr td:nth-child(3)").all_inner_texts()))
    A.fill("#search", ""); A.wait_for_timeout(300)
    A.locator('th[data-sort="total"]').click(); A.wait_for_timeout(200)
    tot = [num(t) for t in A.locator("#tbody tr td:nth-child(8)").all_inner_texts()]
    check("sort by total desc", tot == sorted(tot, reverse=True))
    A.locator('th[data-sort="total"]').click(); tot = [num(t) for t in A.locator("#tbody tr td:nth-child(8)").all_inner_texts()]
    check("sort toggles asc", tot == sorted(tot))
    A.locator("#moreBtn").click(); check("show more adds rows", A.locator("#tbody tr").count() > 25)

    # ---------- 5. power bi tab ----------
    print("\n[5] Power BI tab")
    A.locator("#tab-bi").click(); A.wait_for_timeout(500)
    cfg = "reportId=8f3f2367-7f81-420b-9e4f-dc83acbfa35d"
    check("configured reportEmbed URL is framed automatically", A.locator("#biHost iframe").count() == 1 and cfg in (A.locator("#biHost iframe").get_attribute("src") or ""), A.locator("#biHost iframe").count())
    check("iframe uses the autoAuth embed URL", "autoAuth=true" in A.locator("#biHost iframe").get_attribute("src"))
    check("'Open in Power BI' points at the share link", A.locator("#biOpen").get_attribute("href").startswith("https://app.powerbi.com/links/"))
    A.locator("#biChange").click(); A.wait_for_timeout(200)
    check("setup panel shown after 'Change embed URL'", A.locator("#biSetup").is_visible() and not A.locator("#biHost").is_visible())
    share = "https://app.powerbi.com/links/3iX0gJLKGp?ctid=a7aa76ae-5d17-4127-90b4-f2c1c74b2cee&pbi_source=linkShare"
    A.fill("#biUrl", share); A.locator("#biSave").click(); A.wait_for_timeout(200)
    check("share link is rejected with an explanation", A.locator("#biErr").is_visible() and "share link" in txt(A, "#biErr"), txt(A, "#biErr"))
    A.fill("#biUrl", "https://evil.example.com/view?r=abc"); A.locator("#biSave").click()
    check("non-Microsoft host is rejected (no arbitrary framing)", "powerbi.com" in txt(A, "#biErr"), txt(A, "#biErr"))
    A.fill("#biUrl", "javascript:alert(1)"); A.locator("#biSave").click()
    check("javascript: URL is rejected", A.locator("#biErr").is_visible() and A.locator("#biHost iframe").count() == 0)
    A.fill("#biUrl", "https://app.powerbi.com/view?r=eyJrIjoiVEVTVCJ9"); A.locator("#biSave").click(); A.wait_for_timeout(500)
    check("valid embed URL creates an iframe", A.locator("#biHost iframe").count() == 1 and A.locator("#biHost iframe").get_attribute("src").startswith("https://app.powerbi.com/view?r="))
    check("iframe is sandboxed and titled", "allow-scripts" in A.locator("#biHost iframe").get_attribute("sandbox") and A.locator("#biHost iframe").get_attribute("title") == "Power BI report")
    A.reload(); A.wait_for_function("document.documentElement.dataset.ready==='1'"); A.locator("#tab-bi").click(); A.wait_for_timeout(400)
    check("embed URL remembered after reload", A.locator("#biHost iframe").count() == 1)
    A.locator("#biChange").click(); check("'Change embed URL' returns to setup", A.locator("#biSetup").is_visible() and A.locator("#biHost iframe").count() == 0)
    with A.expect_download() as dl: A.locator("#exportBtn").click()
    csv = Path(dl.value.path()).read_text()
    check("CSV download row count == store", len(csv.strip().split("\n")) - 1 == len(api(PORT, "/api/records")["records"]))
    check("live CSV address shown", "/api/export.csv" in txt(A, "#csvUrl"), txt(A, "#csvUrl"))
    A.screenshot(path=str(SHOTS / "05_powerbi_tab.png"), full_page=True)

    # ---------- 6. a11y / keyboard / theme ----------
    print("\n[6] Accessibility & theme")
    A.locator("#tab-overview").focus(); A.keyboard.press("ArrowRight"); A.wait_for_timeout(200)
    check("ArrowRight moves to next tab", A.locator("#view-bi").is_visible())
    check("tablist aria-selected updated", A.locator("#tab-bi").get_attribute("aria-selected") == "true")
    A.locator("#tab-overview").click(); t0 = A.evaluate("document.documentElement.dataset.theme"); A.locator("#themeBtn").click(); A.wait_for_timeout(300)
    check("theme toggles", A.evaluate("document.documentElement.dataset.theme") != t0)
    if A.evaluate("document.documentElement.dataset.theme") != "light": A.locator("#themeBtn").click(); A.wait_for_timeout(200)
    A.screenshot(path=str(SHOTS / "06_overview_light.png"), full_page=True)
    nolabel = A.evaluate("[...document.querySelectorAll('button')].filter(b=>!(b.innerText||'').trim() && !b.getAttribute('aria-label') && !b.title).length")
    check("every button has an accessible name", nolabel == 0, nolabel)

    # ---------- 7. mobile / touch ----------
    print("\n[7] Mobile & touch (390x844, touch)")
    ctxM = br.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    M = ctxM.new_page(); M.on("pageerror", lambda e: errors.append("M:" + str(e)))
    M.goto(URL); M.wait_for_function("document.documentElement.dataset.ready==='1'"); M.wait_for_timeout(1500)
    check("no horizontal overflow", M.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), M.evaluate("document.documentElement.scrollWidth"))
    tb = M.locator(".tabs").bounding_box(); check("tabs docked at bottom", abs((tb["y"] + tb["height"]) - 844) < 2, tb)
    small = M.evaluate("""[...document.querySelectorAll('button:not([hidden]), .seg button, .bar-row, .legend-item')].filter(b=>b.offsetParent && (b.getBoundingClientRect().height<34 || b.getBoundingClientRect().width<34)).map(b=>b.className||b.id).slice(0,5)""")
    check("tap targets >= 34px", len(small) == 0, small)
    M.locator("#ch-region .bar-row").nth(1).tap(); M.wait_for_timeout(800)
    check("tap on bar applies filter", M.locator(".chip").count() >= 1)
    M.locator(".chip.clear").tap()
    tbx = M.locator("#ch-trend svg").bounding_box()
    M.touchscreen.tap(tbx["x"] + tbx["width"] * 0.6, tbx["y"] + tbx["height"] / 2); M.wait_for_timeout(300)
    check("tap on trend shows tooltip", M.locator(".tooltip.on").count() == 1)
    M.screenshot(path=str(SHOTS / "07_mobile_overview.png"), full_page=True)
    M.locator("#tab-data").tap(); M.wait_for_timeout(500)
    check("mobile table shows card layout (thead hidden)", not M.locator("#tbl thead").is_visible())
    check("mobile no overflow on data tab", M.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    M.screenshot(path=str(SHOTS / "08_mobile_data.png"))
    M.locator("#addBtn").tap(); M.wait_for_timeout(500)
    M.screenshot(path=str(SHOTS / "09_mobile_editor.png"))
    check("mobile editor fits viewport", M.evaluate("document.querySelector('#editor').getBoundingClientRect().right <= window.innerWidth"))
    check("Delete button hidden when adding a new record", not M.locator("#edDelete").is_visible())
    cb = M.locator("#edCancel").bounding_box(); check("Cancel button is not squashed", cb["width"] > 60, cb)
    M.keyboard.press("Escape")
    M.locator("#tab-data").tap()
    rb = M.locator("#randBtn").bounding_box(); check("toolbar buttons readable on mobile", rb["width"] > 70, rb)
    M.locator("#tab-bi").tap(); M.wait_for_timeout(600)
    M.screenshot(path=str(SHOTS / "10_mobile_powerbi.png"), full_page=True)
    check("mobile power bi tab no overflow", M.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))

    # reduced motion
    ctxR = br.new_context(reduced_motion="reduce"); R = ctxR.new_page(); R.goto(URL); R.wait_for_function("document.documentElement.dataset.ready==='1'"); R.wait_for_timeout(300)
    check("reduced-motion: KPIs show final value instantly", txt(R, "#k-orders").isdigit())

    # ---------- 8. offline demo (file://) ----------
    print("\n[8] Local/offline mode (file://) with cross-tab sync")
    ctxL = br.new_context(); L1 = ctxL.new_page(); L2 = ctxL.new_page()
    furl = (ROOT / "public" / "index.html").as_uri()
    L1.goto(furl); L1.wait_for_function("document.documentElement.dataset.ready==='1'"); L2.goto(furl + "#data"); L2.wait_for_function("document.documentElement.dataset.ready==='1'")
    check("local mode label", "Local" in txt(L1, "#liveText"), txt(L1, "#liveText"))
    L1.bring_to_front(); ev(lambda: txt(L1, "#k-orders").isdigit(), 4); n0 = int(txt(L1, "#k-orders"))
    L2.locator("#randBtn").click(); L2.wait_for_timeout(300); L1.bring_to_front(); L1.wait_for_timeout(300)
    check("other tab updates in local mode", ev(lambda: int(txt(L1, "#k-orders")) == n0 + 1, 4), f"{n0} -> {txt(L1,'#k-orders')}")
    L2.reload(); L2.wait_for_function("document.documentElement.dataset.ready==='1'")
    check("local data persists across reload", L2.locator("#rowCount").inner_text().startswith("") and int(L2.evaluate("window.__app.state.store.records.length")) == 61)

    for c in (ctxA, ctxB, ctxM, ctxR, ctxL): c.close()
    br.close()
finally:
    srv.terminate()

# ---------- 9. edit-key protection ----------
print("\n[9] Edit-key protection")
srv2, tmp2 = start_server(3112, key="s3cret")
try:
  with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(); pg.goto("http://127.0.0.1:3112#data"); pg.wait_for_function("document.documentElement.dataset.ready==='1'")
    check("viewing works without key", pg.locator("#tbody tr").count() > 0)
    pg.locator("#randBtn").click(); pg.wait_for_timeout(400)
    check("write triggers key dialog", pg.locator("#keyDlg").evaluate("d=>d.open"))
    pg.fill("#keyInput", "wrong"); pg.locator("#keyForm button[type=submit]").click(); pg.wait_for_timeout(600)
    check("wrong key rejected (row count unchanged)", api(3112, "/api/health")["rows"] == 60)
    pg.locator("#keyDlg").evaluate("d=>d.open && d.close()")
    pg.locator("#randBtn").click(); pg.wait_for_timeout(300)
    pg.fill("#keyInput", "s3cret"); pg.locator("#keyForm button[type=submit]").click(); pg.wait_for_timeout(900)
    check("correct key lets the write through", api(3112, "/api/health")["rows"] == 61, api(3112, "/api/health"))
    br.close()
finally:
    srv2.terminate()

# ---------- 10. tunnel without SSE (Cloudflare quick tunnel) + live push to Power BI ----------
print("\n[10] No-SSE tunnel fallback and Power BI live push")
pbi_rows = []
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); pbi_rows.extend(json.loads(self.rfile.read(n))["rows"])
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
mock = HTTPServer(("127.0.0.1", 3190), H); threading.Thread(target=mock.serve_forever, daemon=True).start()
srv3, tmp3 = start_server(3113, extra={"POWERBI_PUSH_URL": "http://127.0.0.1:3190/rows?key=k", "POWERBI_FLUSH_MS": "100"})
def post(port, body):
    rq = urllib.request.Request(f"http://127.0.0.1:{port}/api/records", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}); return json.load(urllib.request.urlopen(rq))
try:
  with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 1280, "height": 800})
    ctx.route("**/api/stream", lambda r: r.abort())          # simulate a tunnel that cannot carry SSE
    C = ctx.new_page(); C.goto("http://127.0.0.1:3113"); C.wait_for_function("document.documentElement.dataset.ready==='1'"); C.wait_for_timeout(1200)
    check("SSE blocked: app still loads with 60 orders", ev(lambda: txt(C, "#k-orders") == "60"))
    check("pill says it is using polling", "polling" in (C.locator("#livePill").get_attribute("title") or ""), C.locator("#livePill").get_attribute("title"))
    t0 = time.time(); post(3113, {"timestamp": "2026-10-01T10:00:00", "region": "Bali", "category": "Home", "product": "Desk Lamp", "quantity": 2, "unitPrice": 280000, "status": "Completed", "rating": 5, "updatedBy": "Remote"})
    ok = ev(lambda: txt(C, "#k-orders") == "61", 6); check("change by someone else appears via polling within 6 s", ok, f"{time.time()-t0:.1f}s")
    C.locator("#tab-data").click(); C.locator("#randBtn").click(); check("own write works under polling (62, no duplicate)", ev(lambda: C.locator("#rowCount").inner_text().endswith("of 62 records"), 5))
    C.wait_for_timeout(3500); check("no reload loop: still 62 after idle", C.locator("#rowCount").inner_text().endswith("of 62 records"), C.locator("#rowCount").inner_text())
    C.locator("#tab-bi").click(); C.wait_for_timeout(600)
    ev(lambda: "On" in txt(C, "#pushStatus"), 6)
    check("Power BI card shows push ON", "On" in txt(C, "#pushStatus") and "Sent" in txt(C, "#pushStatus"), txt(C, "#pushStatus"))
    C.screenshot(path=str(SHOTS / "11_powerbi_push_card.png"), full_page=True)
    orders = sum(r["Orders"] for r in pbi_rows); sales = sum(r["TotalSales"] for r in pbi_rows)
    cur = api(3113, "/api/records")["records"]
    check("Power BI received a ledger equal to the site (orders)", orders == len(cur) == 62, f"{orders} vs {len(cur)}")
    check("Power BI ledger equal to the site (sales)", sales == sum(r["quantity"] * r["unitPrice"] for r in cur))
    check("push URL/key not visible in the page", "key=k" not in C.content())
    C.locator("#tab-data").click(); C.locator("#batchBtn").click()
    check("'Add 20' adds a whole set (82 rows)", ev(lambda: C.locator("#rowCount").inner_text().endswith("of 82 records"), 8), C.locator("#rowCount").inner_text())
    ev(lambda: sum(r["Orders"] for r in pbi_rows) == 82, 8)
    check("Power BI ledger followed the whole set (82 orders)", sum(r["Orders"] for r in pbi_rows) == 82, sum(r["Orders"] for r in pbi_rows))
    br.close()
finally:
    srv3.terminate(); mock.shutdown()

check("no JS errors during the whole run", not errors, errors[:5])
fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
