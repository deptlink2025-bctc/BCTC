/* Biểu đồ SVG thuần — 1 trục, tỷ đồng, tooltip khi rê chuột. Không thư viện. */
(function (root) {
  "use strict";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const nfVN = new Intl.NumberFormat("vi-VN", {maximumFractionDigits: 0});
  const nf1 = new Intl.NumberFormat("vi-VN", {minimumFractionDigits: 1, maximumFractionDigits: 1});
  function fmtB(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    const b = v / 1e9;
    return Math.abs(b) >= 100 ? nfVN.format(b) : nf1.format(b);
  }
  function fmtPct(p, sign = true) {
    if (p === null || p === undefined || !Number.isFinite(p)) return "—";
    return (sign && p > 0 ? "+" : "") + nf1.format(p) + "%";
  }
  function niceTicks(min, max, count) {
    const span = max - min || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const t = []; for (let v = lo; v <= hi + step / 2; v += step) t.push(v); return t;
  }
  function hover(host, periods, html) {
    const tip = host.querySelector(".tip"), svg = host.querySelector("svg");
    const show = (e, i) => {
      tip.innerHTML = html(periods[i]); tip.style.opacity = 1;
      const hb = host.getBoundingClientRect();
      let x = e.clientX - hb.left + 12, y = e.clientY - hb.top - 10;
      if (x + tip.offsetWidth > hb.width) x = Math.max(0, e.clientX - hb.left - tip.offsetWidth - 12);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    svg.addEventListener("mousemove", (e) => { const r = e.target.closest("rect[data-i]"); if (!r) { tip.style.opacity = 0; return; } show(e, +r.dataset.i); });
    svg.addEventListener("click", (e) => { const r = e.target.closest("rect[data-i]"); if (r) show(e, +r.dataset.i); });
    svg.addEventListener("mouseleave", () => { tip.style.opacity = 0; });
  }

  /** Cột đôi: doanh thu + LNST công ty mẹ theo kỳ. */
  function barChart(host, periods, opts) {
    const W = 760, H = 260, padL = 58, padR = 12, padT = 14, padB = 30;
    const n = Math.max(1, periods.length);
    const vals = periods.flatMap((p) => [p.rev, p.npat]).filter((v) => v !== null);
    let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
    if (max === min) max = min + 1;
    const ticks = niceTicks(min, max, 5); min = ticks[0]; max = ticks[ticks.length - 1];
    const y = (v) => padT + (max - v) / (max - min) * (H - padT - padB);
    const slot = (W - padL - padR) / n, gap = 2, bw = Math.max(3, (slot - 10) / 2 - gap / 2);
    let g = "";
    ticks.forEach((t) => { g += `<line class="gridl" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 3.5}" text-anchor="end">${fmtB(t)}</text>`; });
    g += `<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>`;
    const every = n > 14 ? 2 : 1;
    periods.forEach((p, i) => {
      const x0 = padL + i * slot + 5;
      const bar = (v, x, col) => {
        if (v === null) return "";
        const top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)));
        return `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="${Math.min(4, h)}" fill="${v < 0 ? "var(--down)" : col}"/>`;
      };
      g += bar(p.rev, x0, "var(--s-rev)") + bar(p.npat, x0 + bw + gap, "var(--s-npat)");
      if (i % every === 0 || i === n - 1) g += `<text x="${x0 + bw + gap / 2}" y="${H - 10}" text-anchor="middle">${p.label}</text>`;
      g += `<rect data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="axis" role="img" aria-label="${esc(opts.aria || "")}">${g}</svg><div class="tip"></div>`;
    hover(host, periods, (p) => `<b>${p.long}</b><br>${esc(opts.revLabel)}: <b>${fmtB(p.rev)} tỷ</b>${p.rev_yoy !== null ? ` (${fmtPct(p.rev_yoy)} YoY)` : ""}<br>LNST công ty mẹ: <b>${fmtB(p.npat)} tỷ</b>${p.yoy !== null ? ` (${fmtPct(p.yoy)} YoY)` : ""}<br>Biên ròng: ${p.margin === null ? "—" : fmtPct(p.margin, false)}`);
  }

  /** LNST của cùng một quý qua các năm — 1 chuỗi, nhãn trực tiếp. */
  function sameQuarterChart(host, periods, qn) {
    const W = 760, H = 220, padL = 58, padR = 12, padT = 22, padB = 30;
    const n = Math.max(1, periods.length);
    const vals = periods.map((p) => p.npat).filter((v) => v !== null);
    let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
    if (max === min) max = min + 1;
    const ticks = niceTicks(min, max, 4); min = ticks[0]; max = ticks[ticks.length - 1];
    const y = (v) => padT + (max - v) / (max - min) * (H - padT - padB);
    const slot = (W - padL - padR) / n, bw = Math.min(64, slot * 0.55);
    let g = "";
    ticks.forEach((t) => { g += `<line class="gridl" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 3.5}" text-anchor="end">${fmtB(t)}</text>`; });
    g += `<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>`;
    periods.forEach((p, i) => {
      if (p.npat === null) return;
      const x = padL + i * slot + (slot - bw) / 2;
      const top = Math.min(y(p.npat), y(0)), h = Math.max(1, Math.abs(y(p.npat) - y(0)));
      g += `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="4" fill="${p.npat < 0 ? "var(--down)" : "var(--s-npat)"}" opacity="${i === n - 1 ? 1 : 0.72}"/>`;
      g += `<text class="lbl" x="${x + bw / 2}" y="${p.npat < 0 ? y(p.npat) + 12 : top - 5}" text-anchor="middle">${fmtB(p.npat)}${p.yoy !== null ? ` · ${fmtPct(p.yoy)}` : ""}</text>`;
      g += `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${p.fd.slice(0, 4)}</text>`;
      g += `<rect data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="axis" role="img" aria-label="LNST quý ${qn} qua các năm">${g}</svg><div class="tip"></div>`;
    hover(host, periods, (p) => `<b>${p.long}</b><br>LNST công ty mẹ: <b>${fmtB(p.npat)} tỷ</b><br>YoY: ${fmtPct(p.yoy)} · Biên ròng: ${p.margin === null ? "—" : fmtPct(p.margin, false)}`);
  }

  root.Charts = {barChart, sameQuarterChart, niceTicks, fmtB, fmtPct, esc};
})(window);
