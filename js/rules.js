/* Quy tắc cảnh báo lợi nhuận / lỗ đột biến. Hàm thuần, test trong Node.
 *
 * Đầu vào là 1 kỳ đã chuẩn hoá từ Metrics.series (có yoy, qoq, avg4, sd4, non_core...).
 * Mỗi cảnh báo có khoá `sym|rt|fd|rule` — đây là chốt chống trùng khi đồng bộ nhiều lần.
 */
(function (root) {
  "use strict";

  const RULES = {
    loss:          {name: "Lỗ",                 sev: "high", desc: "LNST công ty mẹ âm"},
    sign_flip:     {name: "Đổi dấu",            sev: "high", desc: "Lãi → lỗ hoặc lỗ → lãi so với cùng kỳ năm trước"},
    restated:      {name: "BCTC bị điều chỉnh", sev: "high", desc: "LNST của một kỳ đã lưu thay đổi > 5% (sau kiểm toán / soát xét)"},
    yoy_spike:     {name: "YoY đột biến",       sev: "med",  desc: "|YoY LNST| vượt ngưỡng"},
    qoq_spike:     {name: "QoQ đột biến",       sev: "med",  desc: "|QoQ LNST| vượt ngưỡng (chỉ kỳ quý)"},
    vs_avg4:       {name: "Lệch TB 4 quý",      sev: "low",  desc: "Lệch ≥ 2σ và ≥ 20% so với trung bình 4 quý liền trước"},
    non_core:      {name: "Ngoài cốt lõi",      sev: "low",  desc: "Phần LNTT không đến từ hoạt động kinh doanh chính vượt ngưỡng (không áp dụng ngân hàng)"},
    revenue_spike: {name: "Doanh thu đột biến", sev: "low",  desc: "|YoY doanh thu| vượt ngưỡng"},
  };
  const SEV_RANK = {high: 0, med: 1, low: 2};

  const DEFAULTS = {
    yoy: 70, qoq: 70, rev: 40, nc: 30, restated: 5,
    enabled: Object.fromEntries(Object.keys(RULES).map((r) => [r, true])),
  };

  function fmtB(v) { // tỷ đồng, dùng trong câu chữ cảnh báo
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    const b = v / 1e9;
    return (Math.abs(b) >= 100 ? Math.round(b) : Math.round(b * 10) / 10).toLocaleString("vi-VN");
  }
  const pct = (p) => Math.round(Math.abs(p) * 10) / 10 + "%";

  /** Đánh giá 1 kỳ. Trả về mảng cảnh báo (có thể rỗng). */
  function evalPeriod(sym, form, p, th, revLabel) {
    th = Object.assign({}, DEFAULTS, th || {});
    const en = Object.assign({}, DEFAULTS.enabled, th.enabled || {});
    const out = [];
    const add = (rule, text, value, base, pctv) => out.push({
      key: `${sym}|${p.rt}|${p.fd}|${rule}`, sym, rule, sev: RULES[rule].sev, rt: p.rt, fd: p.fd,
      label: p.label, long: p.long, text, value, base, pct: pctv, created: p.created,
    });

    if (en.loss && p.npat !== null && p.npat < 0)
      add("loss", `LNST công ty mẹ âm ${fmtB(p.npat)} tỷ`, p.npat, null, null);

    const flipped = p.yoy_base !== null && p.npat !== null && p.yoy_base !== 0 && p.npat !== 0 && Math.sign(p.npat) !== Math.sign(p.yoy_base);
    if (flipped) {
      if (en.sign_flip) add("sign_flip", p.npat > 0
        ? `Cùng kỳ năm trước lỗ ${fmtB(p.yoy_base)} tỷ, kỳ này lãi ${fmtB(p.npat)} tỷ`
        : `Cùng kỳ năm trước lãi ${fmtB(p.yoy_base)} tỷ, kỳ này lỗ ${fmtB(p.npat)} tỷ`, p.npat, p.yoy_base, p.yoy);
    } else if (en.yoy_spike && p.yoy !== null && Math.abs(p.yoy) >= th.yoy) {
      add("yoy_spike", `LNST ${p.yoy > 0 ? "tăng" : "giảm"} ${pct(p.yoy)} so cùng kỳ (${fmtB(p.yoy_base)} tỷ → ${fmtB(p.npat)} tỷ)`, p.npat, p.yoy_base, p.yoy);
    }

    if (en.qoq_spike && p.qoq !== null && Math.abs(p.qoq) >= th.qoq && !(p.npat < 0))
      add("qoq_spike", `LNST ${p.qoq > 0 ? "tăng" : "giảm"} ${pct(p.qoq)} so quý liền trước`, p.npat, null, p.qoq);

    if (en.vs_avg4 && p.sd4 !== null && p.sd4 > 0 && p.npat !== null
        && Math.abs(p.npat - p.avg4) >= 2 * p.sd4 && Math.abs(p.npat - p.avg4) >= 0.2 * Math.abs(p.avg4))
      add("vs_avg4", `Lệch ${p.npat - p.avg4 > 0 ? "+" : "−"}${fmtB(Math.abs(p.npat - p.avg4))} tỷ so với TB 4 quý trước (${fmtB(p.avg4)} tỷ)`, p.npat, p.avg4, (p.npat - p.avg4) / Math.abs(p.avg4) * 100);

    if (en.non_core && form !== "BANK" && p.non_core !== null && p.pbt > 0 && p.non_core >= th.nc)
      add("non_core", `${pct(p.non_core)} LNTT đến từ ngoài hoạt động kinh doanh chính`, p.pbt - p.op, p.pbt, p.non_core);

    if (en.revenue_spike && p.rev_yoy !== null && Math.abs(p.rev_yoy) >= th.rev)
      add("revenue_spike", `${revLabel || "Doanh thu"} ${p.rev_yoy > 0 ? "tăng" : "giảm"} ${pct(p.rev_yoy)} so cùng kỳ`, p.rev, null, p.rev_yoy);

    return out;
  }

  /** So bản đã lưu với bản vừa tải của CÙNG một kỳ. Trả về cảnh báo hoặc null. */
  function restated(sym, rt, fd, oldV, newV, th) {
    th = Object.assign({}, DEFAULTS, th || {});
    if (th.enabled && th.enabled.restated === false) return null;
    const a = oldV && oldV["23000"], b = newV && newV["23000"];
    if (a === null || a === undefined || b === null || b === undefined || a === b) return null;
    const d = (b - a) / Math.abs(a || 1) * 100;
    if (a !== 0 && Math.abs(d) < th.restated) return null;
    const M = root.Metrics || (typeof require === "function" ? require("./metrics.js") : null);
    return {
      key: `${sym}|${rt}|${fd}|restated`, sym, rule: "restated", sev: "high", rt, fd,
      label: M ? M.perLabel(fd, rt) : fd, long: M ? M.perLong(fd, rt) : fd,
      text: `LNST công ty mẹ đổi từ ${fmtB(a)} tỷ thành ${fmtB(b)} tỷ (${d > 0 ? "+" : ""}${Math.round(d * 10) / 10}%)`,
      value: b, base: a, pct: d, created: null,
    };
  }

  function topSev(list) { return list.length ? list.reduce((m, x) => (SEV_RANK[x.sev] < SEV_RANK[m] ? x.sev : m), "low") : null; }

  const api = {RULES, SEV_RANK, DEFAULTS, evalPeriod, restated, topSev};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Rules = api;
})(typeof window !== "undefined" ? window : globalThis);
