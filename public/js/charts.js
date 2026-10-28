/*
 * charts.js — small dependency-free chart kit (SVG + HTML) with animation,
 * mouse + touch tooltips, click-to-filter and reduced-motion support.
 */
(function (root) {
  "use strict";
  const A = root.Analytics;
  const NS = "http://www.w3.org/2000/svg";
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const h = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const colorOf = (i) => `var(--c${(i % 6) + 1})`;

  /* ---------- tooltip (shared) ---------- */
  const Tip = {
    node: null, hideTimer: null,
    init() { if (!this.node) { this.node = h("div", "tooltip"); this.node.setAttribute("role", "status"); document.body.appendChild(this.node); } },
    show(html, x, y) {
      this.init(); clearTimeout(this.hideTimer);
      const n = this.node; n.innerHTML = html; n.classList.add("on");
      const w = n.offsetWidth, hh = n.offsetHeight;
      let left = x + 14, top = y - hh - 14;
      if (left + w > window.innerWidth - 8) left = x - w - 14;
      if (left < 8) left = 8;
      if (top < 8) top = y + 18;
      n.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    },
    hide(delay) { if (!this.node) return; clearTimeout(this.hideTimer); this.hideTimer = setTimeout(() => this.node.classList.remove("on"), delay || 0); },
  };

  /* ---------- animated number ---------- */
  function countUp(node, to, fmt, ms) {
    const from = node._v == null ? 0 : node._v;
    node._v = to;
    cancelAnimationFrame(node._raf);
    if (reduceMotion() || from === to) { node.textContent = fmt(to); return; }
    const t0 = performance.now(); ms = ms || 700;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      node.textContent = fmt(from + (to - from) * ease(p));
      if (p < 1) node._raf = requestAnimationFrame(step); else node.textContent = fmt(to);
    };
    node._raf = requestAnimationFrame(step);
  }

  /* ---------- nice axis ---------- */
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const fmtDay = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); };
  const fmtDayLong = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

  /* =========================================================
   * AreaChart — daily sales trend. Straight segments only, so the line
   * passes exactly through each day's true total (no smoothing overshoot).
   * ========================================================= */
  function AreaChart(container) {
    container.classList.add("area-chart");
    const svg = el("svg", { role: "img", "aria-label": "Daily sales trend", preserveAspectRatio: "none" });
    container.appendChild(svg);
    const empty = h("div", "empty", "No records match the current filters.");
    container.appendChild(empty);
    let data = [], cur = [], W = 600, H = 260, raf = 0, hoverIdx = -1, drawn = false;
    const P = { l: 54, r: 14, t: 14, b: 30 };

    function render(vals) {
      svg.innerHTML = "";
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const n = vals.length; if (!n) return;
      const ymax = niceMax(Math.max(...vals, 1));
      const iw = W - P.l - P.r, ih = H - P.t - P.b;
      const X = (i) => P.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      const Y = (v) => P.t + ih - (v / ymax) * ih;

      const defs = el("defs", {}, svg);
      const g = el("linearGradient", { id: "areaGrad", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el("stop", { offset: "0%", "stop-color": "var(--c1)", "stop-opacity": ".45" }, g);
      el("stop", { offset: "100%", "stop-color": "var(--c1)", "stop-opacity": "0" }, g);

      for (let i = 0; i <= 4; i++) {
        const v = (ymax / 4) * i, y = Y(v);
        el("line", { x1: P.l, x2: W - P.r, y1: y, y2: y, class: "gl" }, svg);
        const t = el("text", { x: P.l - 8, y: y + 4, class: "tick", "text-anchor": "end" }, svg); t.textContent = A.fmtIDR(v, true).replace("Rp ", "");
      }
      const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
      for (let i = 0; i < n; i += step) {
        const t = el("text", { x: X(i), y: H - 8, class: "tick", "text-anchor": i === 0 ? "start" : "middle" }, svg); t.textContent = fmtDay(data[i].date);
      }
      const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
      if (n > 1) el("path", { d: `M${X(0)},${Y(0)} L${pts.join(" L")} L${X(n - 1)},${Y(0)} Z`, fill: "url(#areaGrad)", class: "area" }, svg);
      const line = el("polyline", { points: pts.join(" "), class: "line", fill: "none" }, svg);
      if (n <= 45) vals.forEach((v, i) => el("circle", { cx: X(i), cy: Y(v), r: n <= 20 ? 3.2 : 2.2, class: "dot" }, svg));
      // draw-in animation, only once the chart is actually visible (hidden tabs cannot measure the path)
      if (!drawn && container.offsetParent !== null) {
        drawn = true;
        if (!reduceMotion() && n > 1) {
          try {
            const len = line.getTotalLength();
            line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
            requestAnimationFrame(() => { line.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1)"; line.style.strokeDashoffset = 0; });
          } catch (e) { /* not measurable: simply show the line */ }
        }
      }

      // hover layer
      const cross = el("line", { y1: P.t, y2: P.t + ih, class: "cross", opacity: 0 }, svg);
      const hd = el("circle", { r: 5.5, class: "hover-dot", opacity: 0 }, svg);
      render.X = X; render.Y = Y; render.cross = cross; render.hd = hd; render.n = n;
      if (hoverIdx >= 0 && hoverIdx < n) place(hoverIdx, vals[hoverIdx], false);
    }

    function place(i, v, tip, ev) {
      const x = render.X(i), y = render.Y(v);
      render.cross.setAttribute("x1", x); render.cross.setAttribute("x2", x); render.cross.setAttribute("opacity", 1);
      render.hd.setAttribute("cx", x); render.hd.setAttribute("cy", y); render.hd.setAttribute("opacity", 1);
      if (tip && ev) {
        const d = data[i];
        Tip.show(`<b>${fmtDayLong(d.date)}</b><div>Sales <strong>${A.fmtIDR(d.sales)}</strong></div><div>Orders <strong>${d.orders}</strong></div>`, ev.clientX, ev.clientY);
      }
    }
    function onMove(ev) {
      if (!data.length || !render.X) return;
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W;
      const n = data.length, iw = W - P.l - P.r;
      let i = n === 1 ? 0 : Math.round(((x - P.l) / iw) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i)); hoverIdx = i;
      place(i, data[i].sales, true, ev);
    }
    function onLeave(ev) { hoverIdx = -1; if (render.cross) { render.cross.setAttribute("opacity", 0); render.hd.setAttribute("opacity", 0); } Tip.hide(ev && ev.pointerType === "touch" ? 1400 : 0); }
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerdown", onMove);
    svg.addEventListener("pointerleave", onLeave);
    svg.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") onLeave(e); });

    function resize() {
      const w = Math.max(280, Math.round(container.clientWidth));
      if (w === W && svg.childNodes.length) return;
      W = w; H = w < 460 ? 220 : 260; svg.style.height = H + "px"; render(cur);
    }
    if (window.ResizeObserver) new ResizeObserver(resize).observe(container); else window.addEventListener("resize", resize);

    return {
      update(next) {
        const target = next.map((d) => d.sales);
        const prevCur = cur.slice();
        const prevLen = data.length;
        data = next; empty.style.display = next.length ? "none" : "flex"; svg.style.visibility = next.length ? "visible" : "hidden";
        W = Math.max(280, Math.round(container.clientWidth) || W); H = W < 460 ? 220 : 260; svg.style.height = H + "px";
        cancelAnimationFrame(raf);
        if (reduceMotion() || prevLen !== next.length || !prevLen) { cur = target; render(cur); return; }
        const t0 = performance.now();
        const tick = (t) => {
          const p = Math.min(1, (t - t0) / 550), e = ease(p);
          cur = target.map((v, i) => prevCur[i] + (v - prevCur[i]) * e);
          render(cur);
          if (p < 1) raf = requestAnimationFrame(tick); else cur = target;
        };
        raf = requestAnimationFrame(tick);
      },
    };
  }

  /* =========================================================
   * BarList — horizontal bars as real HTML buttons (keyboard + touch friendly)
   * opts: { valueKey:'sales'|'orders', fmt:fn, selected:Set, onToggle:fn|null, colorFn:fn }
   * ========================================================= */
  function BarList(container, baseOpts) {
    container.classList.add("barlist");
    const rows = new Map();
    return {
      update(items, opts) {
        const o = { ...baseOpts, ...opts };
        const vk = o.valueKey || "sales";
        const sorted = o.keepOrder ? items.slice() : items.slice().sort((a, b) => b[vk] - a[vk] || String(a.key).localeCompare(b.key));
        const max = Math.max(...sorted.map((i) => i[vk]), 1);
        const sum = sorted.reduce((a, i) => a + i[vk], 0);
        const seen = new Set();
        sorted.forEach((it, idx) => {
          seen.add(it.key);
          let r = rows.get(it.key);
          if (!r) {
            const node = h(o.onToggle ? "button" : "div", "bar-row");
            if (o.onToggle) node.type = "button";
            node.innerHTML = '<span class="bar-label"></span><span class="bar-track"><span class="bar-fill"></span></span><span class="bar-val"></span>';
            r = { node, label: node.children[0], fill: node.children[1].firstChild, val: node.children[2], v: 0 };
            rows.set(it.key, r);
            container.appendChild(node);
            if (o.onToggle) node.addEventListener("click", () => o.onToggle(it.key));
            node.addEventListener("pointerenter", (e) => r.tip && e.pointerType === "mouse" && Tip.show(r.tip, e.clientX, e.clientY));
            node.addEventListener("pointermove", (e) => r.tip && e.pointerType === "mouse" && Tip.show(r.tip, e.clientX, e.clientY));
            node.addEventListener("pointerleave", () => Tip.hide());
          }
          r.label.textContent = it.key;
          r.fill.style.background = (o.colorFn || colorOf)(idx, it.key);
          r.fill.style.width = (it[vk] / max) * 100 + "%";
          const share = sum ? Math.round((it[vk] / sum) * 100) : 0;
          countUp(r.val, it[vk], (v) => (o.fmt || ((x) => x))(v), 600);
          r.tip = `<b>${esc(it.key)}</b><div>Sales <strong>${A.fmtIDR(it.sales)}</strong></div><div>Orders <strong>${it.orders}</strong></div><div>Share <strong>${share}%</strong></div>`;
          r.node.setAttribute("aria-label", `${it.key}: ${(o.fmt || String)(it[vk])}, ${share}% of total`);
          if (o.onToggle) {
            const active = o.selected && o.selected.has(it.key), any = o.selected && o.selected.size;
            r.node.classList.toggle("selected", !!active); r.node.classList.toggle("dim", !!any && !active);
            r.node.setAttribute("aria-pressed", active ? "true" : "false");
          }
          container.appendChild(r.node); // keeps DOM order == sorted order
        });
        for (const [k, r] of rows) if (!seen.has(k)) { r.node.remove(); rows.delete(k); }
      },
    };
  }

  /* =========================================================
   * Donut — animated stroke segments + legend buttons
   * ========================================================= */
  function Donut(container, onToggle) {
    container.classList.add("donut-wrap");
    const holder = h("div", "donut"); const legend = h("div", "legend");
    container.append(holder, legend);
    const svg = el("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": "Sales share by category" }, holder);
    const R = 74, C = 2 * Math.PI * R;
    el("circle", { cx: 100, cy: 100, r: R, class: "donut-bg" }, svg);
    const g = el("g", { transform: "rotate(-90 100 100)" }, svg);
    const cT = el("text", { x: 100, y: 96, class: "donut-top", "text-anchor": "middle" }, svg);
    const cB = el("text", { x: 100, y: 118, class: "donut-sub", "text-anchor": "middle" }, svg);
    const segs = new Map(), leg = new Map();
    return {
      update(items, selected, centerTop, centerSub) {
        const sum = items.reduce((a, i) => a + i.sales, 0);
        const order = items.slice().sort((a, b) => b.sales - a.sales);
        const GAP = order.length > 1 && sum ? 3 : 0;
        let acc = 0; const seen = new Set();
        order.forEach((it, idx) => {
          seen.add(it.key);
          let s = segs.get(it.key);
          if (!s) {
            const c = el("circle", { cx: 100, cy: 100, r: R, fill: "none", class: "slice", tabindex: 0, role: "button" }, g);
            c.style.strokeDasharray = `0 ${C}`; c.style.strokeDashoffset = 0;
            c.addEventListener("click", () => onToggle && onToggle(it.key));
            c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle && onToggle(it.key); } });
            const tipMove = (e) => s.tip && Tip.show(s.tip, e.clientX, e.clientY);
            c.addEventListener("pointerenter", tipMove); c.addEventListener("pointermove", tipMove);
            c.addEventListener("pointerleave", (e) => Tip.hide(e.pointerType === "touch" ? 1400 : 0));
            s = { c }; segs.set(it.key, s);
          }
          const frac = sum ? it.sales / sum : 0;
          const len = Math.max(0, frac * C - GAP);
          s.c.style.stroke = colorOf(idx);
          s.c.style.strokeDasharray = `${len} ${C - len}`;
          s.c.style.strokeDashoffset = -acc * C;
          acc += frac;
          const pct = Math.round(frac * 100);
          s.tip = `<b>${esc(it.key)}</b><div>Sales <strong>${A.fmtIDR(it.sales)}</strong></div><div>Orders <strong>${it.orders}</strong></div><div>Share <strong>${pct}%</strong></div>`;
          const on = selected.has(it.key), any = selected.size > 0;
          s.c.classList.toggle("selected", on); s.c.classList.toggle("dim", any && !on);
          s.c.setAttribute("aria-label", `${it.key} ${pct}% of sales`); s.c.setAttribute("aria-pressed", on);

          let l = leg.get(it.key);
          if (!l) {
            const b = h("button", "legend-item"); b.type = "button";
            b.innerHTML = '<i class="sw"></i><span class="nm"></span><span class="pc"></span>';
            b.addEventListener("click", () => onToggle && onToggle(it.key));
            legend.appendChild(b); l = { b, sw: b.children[0], nm: b.children[1], pc: b.children[2] }; leg.set(it.key, l);
          }
          l.sw.style.background = colorOf(idx); l.nm.textContent = it.key; l.pc.textContent = pct + "%";
          l.b.classList.toggle("selected", on); l.b.classList.toggle("dim", any && !on); l.b.setAttribute("aria-pressed", on);
          legend.appendChild(l.b);
        });
        for (const [k, s] of segs) if (!seen.has(k)) { s.c.remove(); segs.delete(k); }
        for (const [k, l] of leg) if (!seen.has(k)) { l.b.remove(); leg.delete(k); }
        cT.textContent = centerTop; cB.textContent = centerSub;
      },
    };
  }

  root.Charts = { AreaChart, BarList, Donut, countUp, Tip, esc, reduceMotion };
})(typeof self !== "undefined" ? self : this);
