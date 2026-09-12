/* Test nhanh cho metrics.js và rules.js — chạy: node tests/run.js
 * Không cần thư viện. Fixture là JSON thật tải từ VNDirect ngày 12/09/2026. */
"use strict";
const path = require("path");
const fs = require("fs");
const M = require("../js/metrics.js");
const R = require("../js/rules.js");

const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message); }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || ""} expected ${b}, got ${a}`); };
const near = (a, b, tol, msg) => { if (Math.abs(a - b) > tol) throw new Error(`${msg || ""} expected ≈${b}, got ${a}`); };

console.log("metrics.js");
const fpt = M.groupPeriods(fx("finfo_fpt_q.json").data);
const vcb = M.groupPeriods(fx("finfo_vcb_q.json").data);
const ssi = M.groupPeriods(fx("finfo_ssi_q.json").data);

t("nhận diện loại công ty từ modelType", () => {
  eq(M.detectForm(fpt["2026-06-30"].mts), "NON_FINANCE");
  eq(M.detectForm(vcb["2026-06-30"].mts), "BANK");
  eq(M.detectForm([89, 90, 91]), "SECURITIES");
  eq(M.detectForm([411]), "INSURANCE");
});
t("FPT Q2/2026: LNST công ty mẹ 2.568 tỷ, DTT 13.789 tỷ", () => {
  const s = M.series(fpt, "NON_FINANCE", "Q");
  const last = s[s.length - 1];
  eq(last.fd, "2026-06-30"); eq(last.label, "Q2/26");
  near(last.npat / 1e9, 2568, 1); near(last.rev / 1e9, 13789, 1);
});
t("YoY / QoQ / biên tính đúng trên FPT", () => {
  const s = M.series(fpt, "NON_FINANCE", "Q");
  const last = s[s.length - 1], prev = s[s.length - 2], yago = s[s.length - 5];
  near(last.yoy, (last.npat - yago.npat) / Math.abs(yago.npat) * 100, 1e-9);
  near(last.qoq, (last.npat - prev.npat) / Math.abs(prev.npat) * 100, 1e-9);
  near(last.margin, last.npat / last.rev * 100, 1e-9);
  eq(s[0].yoy, null, "kỳ đầu không có cùng kỳ →");
});
t("Ngân hàng dùng Thu nhập lãi thuần làm doanh thu (VCB Q2/2026 = 19.142 tỷ)", () => {
  const s = M.series(vcb, "BANK", "Q");
  near(s[s.length - 1].rev / 1e9, 19142, 1);
  eq(s[s.length - 1].op, null, "ngân hàng không có LN thuần HĐKD →");
});
t("Chứng khoán dùng Tổng doanh thu HĐKD (21000)", () => {
  const s = M.series(ssi, "SECURITIES", "Q");
  const last = s[s.length - 1];
  eq(last.rev, ssi[last.fd].v["21000"]);
});
t("TB 4 quý & σ chỉ có từ kỳ thứ 5", () => {
  const s = M.series(fpt, "NON_FINANCE", "Q");
  eq(s[3].avg4, null); if (s.length > 4) { if (s[4].avg4 === null) throw new Error("kỳ 5 phải có avg4"); }
});
t("nhãn kỳ và lùi tháng", () => {
  eq(M.perLabel("2025-12-31", "Q"), "Q4/25"); eq(M.perLabel("2025-12-31", "A"), "2025");
  eq(M.perLong("2026-03-31", "Q"), "Quý 1/2026");
  eq(M.shiftMonths("2026-06-30", -12), "2025-06-30"); eq(M.shiftMonths("2026-03-31", -3), "2025-12-31");
});

console.log("rules.js");
// Chuỗi giả: 8 quý, LNST (tỷ) 100,110,105,120 | 130, -20, 400, 125
const mk = (vals, revs) => {
  const per = {};
  vals.forEach((v, i) => {
    const y = 2024 + Math.floor(i / 4), q = (i % 4) + 1;
    const fd = `${y}-${String(q * 3).padStart(2, "0")}-${q === 1 || q === 4 ? "31" : "30"}`;
    per[fd] = {created: "2026-01-01", modified: "2026-01-01", mts: [1, 2, 3],
      v: {"23000": v * 1e9, "23800": v * 1e9 * 1.25, "23110": v * 1e9 * 1.25 * 0.6, "21001": (revs ? revs[i] : 1000) * 1e9}};
  });
  return M.series(per, "NON_FINANCE", "Q");
};
const S = mk([100, 110, 105, 120, 130, -20, 400, 125], [1000, 1000, 1000, 1000, 1000, 1000, 1600, 1000]);
const th = {yoy: 70, qoq: 70, rev: 40, nc: 30};
const rulesOf = (p) => R.evalPeriod("ABC", "NON_FINANCE", p, th, "Doanh thu thuần").map((a) => a.rule).sort();

t("kỳ bình thường (Q1/25: +30% YoY) → chỉ 'ngoài cốt lõi' vì fixture cho 40% LNTT ngoài HĐKD", () => {
  eq(rulesOf(S[4]).join(","), "non_core");
});
t("Q2/25 lỗ −20 sau khi lãi 110 → lỗ + đổi dấu (không kèm yoy_spike)", () => {
  const r = rulesOf(S[5]); eq(r.includes("loss"), true); eq(r.includes("sign_flip"), true); eq(r.includes("yoy_spike"), false);
});
t("Q3/25 lãi 400 → YoY +281%, QoQ, lệch TB 4 quý, doanh thu +60%", () => {
  const r = rulesOf(S[6]);
  ["yoy_spike", "qoq_spike", "vs_avg4", "revenue_spike"].forEach((x) => eq(r.includes(x), true, x));
});
t("khoá cảnh báo là sym|rt|fd|rule", () => {
  const a = R.evalPeriod("ABC", "NON_FINANCE", S[5], th)[0];
  eq(a.key.startsWith("ABC|Q|2025-06-30|"), true);
});
t("tắt quy tắc bằng enabled", () => {
  const r = R.evalPeriod("ABC", "NON_FINANCE", S[6], Object.assign({enabled: {yoy_spike: false, revenue_spike: false}}, th)).map((a) => a.rule);
  eq(r.includes("yoy_spike"), false); eq(r.includes("revenue_spike"), false); eq(r.includes("qoq_spike"), true);
});
t("ngân hàng không bao giờ ra 'ngoài cốt lõi'", () => {
  const s = M.series(vcb, "BANK", "Q");
  s.forEach((p) => eq(R.evalPeriod("VCB", "BANK", p, th).some((a) => a.rule === "non_core"), false));
});
t("BCTC bị điều chỉnh: đổi 5% trở lên mới báo", () => {
  eq(R.restated("ABC", "Q", "2025-06-30", {"23000": 100e9}, {"23000": 103e9}), null);
  const a = R.restated("ABC", "Q", "2025-06-30", {"23000": 100e9}, {"23000": 90e9});
  eq(a.rule, "restated"); eq(a.sev, "high"); near(a.pct, -10, 1e-9);
  eq(R.restated("ABC", "Q", "2025-06-30", {"23000": 100e9}, {"23000": 100e9}), null);
});
t("dữ liệu thật FPT 2025–2026 với ngưỡng 70% không ra cảnh báo mức cao", () => {
  const s = M.series(fpt, "NON_FINANCE", "Q");
  const all = s.flatMap((p) => R.evalPeriod("FPT", "NON_FINANCE", p, th));
  eq(all.some((a) => a.sev === "high"), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
