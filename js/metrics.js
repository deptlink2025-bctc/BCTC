/* Chuẩn hoá chỉ tiêu BCTC theo loại công ty và tính tăng trưởng.
 *
 * Hàm thuần, không đụng DOM/IndexedDB — tests/run.js nạp file này trong Node.
 *
 * Dữ liệu vào: periods = { "2026-06-30": {created, modified, v:{ "23000": số, ... }}, ... }
 * (giá trị là VND, số riêng từng quý — VNDirect không trả luỹ kế).
 */
(function (root) {
  "use strict";

  // Mã chỉ tiêu VNDirect dùng chung cho cả 4 mẫu BCTC (đã kiểm chứng 12/09/2026)
  const CODE = {
    rev_nonfin: "21001",   // Doanh thu thuần (DN thường, bảo hiểm)
    rev_sec: "21000",      // Tổng doanh thu hoạt động kinh doanh (chứng khoán)
    rev_bank: "421900",    // Thu nhập lãi thuần (ngân hàng)
    gross: "23100",
    op: "23110",           // LN thuần từ hoạt động kinh doanh
    pbt: "23800",
    npat_all: "23003",
    npat: "23000",         // LNST của công ty mẹ — chỉ tiêu cảnh báo chính
    eq: "14000",
    cfo: "32000",
  };
  const REV_CODE = {NON_FINANCE: CODE.rev_nonfin, INSURANCE: CODE.rev_nonfin, SECURITIES: CODE.rev_sec, BANK: CODE.rev_bank};
  const REV_LABEL = {NON_FINANCE: "Doanh thu thuần", INSURANCE: "Doanh thu thuần", SECURITIES: "Tổng doanh thu HĐKD", BANK: "Thu nhập lãi thuần"};
  const FORM_VI = {NON_FINANCE: "Doanh nghiệp", BANK: "Ngân hàng", SECURITIES: "Chứng khoán", INSURANCE: "Bảo hiểm"};
  // modelType của 3 báo cáo (CĐKT, KQKD, LCTT) theo loại công ty
  const MODEL_TYPES = {
    NON_FINANCE: {balance: 1, income: 2, cashflow: 3},
    SECURITIES: {balance: 89, income: 90, cashflow: 91},
    BANK: {balance: 101, income: 102, cashflow: 103},
    INSURANCE: {balance: 411, income: 412, cashflow: 413},
  };

  function detectForm(modelTypes) {
    const s = new Set(Array.from(modelTypes, Number));
    if (s.has(101) || s.has(102) || s.has(103)) return "BANK";
    if (s.has(89) || s.has(90) || s.has(91)) return "SECURITIES";
    if (s.has(411) || s.has(412) || s.has(413)) return "INSURANCE";
    return "NON_FINANCE";
  }

  function quarterOf(fd) { return Math.ceil(+fd.slice(5, 7) / 3); }
  function perLabel(fd, rt) { return rt === "Q" ? `Q${quarterOf(fd)}/${fd.slice(2, 4)}` : fd.slice(0, 4); }
  function perLong(fd, rt) { return rt === "Q" ? `Quý ${quarterOf(fd)}/${fd.slice(0, 4)}` : `Năm ${fd.slice(0, 4)}`; }
  function growth(v, b) {
    if (v === null || v === undefined || b === null || b === undefined || b === 0) return null;
    return (v - b) / Math.abs(b) * 100;
  }

  /** Chuỗi kỳ đã chuẩn hoá, sắp xếp tăng dần theo ngày, kèm YoY/QoQ/biên/TB 4 quý. */
  function series(periods, form, rt) {
    const dates = Object.keys(periods).sort();
    const rc = REV_CODE[form] || CODE.rev_nonfin;
    const out = dates.map((fd) => {
      const r = periods[fd], v = r.v || {};
      const g = (c) => (v[c] === undefined || v[c] === null ? null : v[c]);
      return {
        fd, rt, label: perLabel(fd, rt), long: perLong(fd, rt), created: r.created || null, modified: r.modified || null,
        rev: g(rc), gross: g(CODE.gross), op: g(CODE.op), pbt: g(CODE.pbt),
        npat_all: g(CODE.npat_all), npat: g(CODE.npat), eq: g(CODE.eq), cfo: g(CODE.cfo),
      };
    });
    const back = rt === "Q" ? 4 : 1;
    out.forEach((p, i) => {
      const y = out[i - back], q = out[i - 1];
      p.yoy = y ? growth(p.npat, y.npat) : null;
      p.yoy_base = y ? y.npat : null;
      p.qoq = rt === "Q" && q ? growth(p.npat, q.npat) : null;
      p.rev_yoy = y ? growth(p.rev, y.rev) : null;
      p.margin = p.rev ? p.npat / p.rev * 100 : null;
      p.non_core = p.pbt && p.op !== null ? (p.pbt - p.op) / Math.abs(p.pbt) * 100 : null;
      p.avg4 = null; p.sd4 = null;
      if (rt === "Q" && i >= 4) {
        const w = out.slice(i - 4, i).map((x) => x.npat);
        if (w.every((x) => x !== null)) {
          const m = w.reduce((a, b) => a + b, 0) / 4;
          p.avg4 = m; p.sd4 = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 4);
        }
      }
    });
    return out;
  }

  /** Gom các dòng thô của VNDirect thành {fd: {created, modified, mts:Set, v:{code: value}}}. */
  function groupPeriods(rows) {
    const out = {};
    for (const x of rows) {
      const fd = String(x.fiscalDate).slice(0, 10);
      const p = out[fd] || (out[fd] = {created: String(x.createdDate || "").slice(0, 10), modified: String(x.modifiedDate || "").slice(0, 10), mts: [], v: {}});
      const mt = Number(x.modelType);
      if (!p.mts.includes(mt)) p.mts.push(mt);
      p.v[String(Math.trunc(Number(x.itemCode)))] = x.numericValue === null || x.numericValue === undefined ? null : Number(x.numericValue);
    }
    return out;
  }

  // Ngày lùi n tháng, giữ cuối quý (dùng để hỏi lại 4 quý gần khi đồng bộ)
  function shiftMonths(fd, n) {
    const d = new Date(fd + "T00:00:00Z");
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n + 1); d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  }

  const api = {CODE, REV_CODE, REV_LABEL, FORM_VI, MODEL_TYPES, detectForm, series, groupPeriods, growth, perLabel, perLong, quarterOf, shiftMonths};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Metrics = api;
})(typeof window !== "undefined" ? window : globalThis);
