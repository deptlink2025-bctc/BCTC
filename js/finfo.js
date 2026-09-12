/* Gọi VNDirect finfo từ trình duyệt (server trả Access-Control-Allow-Origin: * — kiểm chứng
 * 12/09/2026). Không tài liệu chính thức, nên mọi thứ về API gom hết ở đây.
 *
 * Nhịp gọi: tối đa 2 request song song, nghỉ 300 ms giữa các request, lỗi 429/5xx/mạng thì
 * chờ 2 s → 4 s → 8 s rồi bỏ. 39 mã nạp lần đầu ≈ 80 request.
 */
(function (root) {
  "use strict";
  const BASE = "https://api-finfo.vndirect.com.vn/v4/";
  const MAX_PARALLEL = 2, GAP_MS = 300, TIMEOUT_MS = 40000;
  let active = 0;
  const waiting = [];
  const status = {calls: 0, errors: 0, lastError: null, lastOk: null};

  function acquire() { return new Promise((res) => { if (active < MAX_PARALLEL) { active++; res(); } else waiting.push(res); }); }
  function release() { setTimeout(() => { active--; const n = waiting.shift(); if (n) { active++; n(); } }, GAP_MS); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJSON(path, params, tries = 3) {
    const url = BASE + path + "?" + params;
    await acquire();
    try {
      for (let i = 0; i < tries; i++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
          status.calls++;
          const r = await fetch(url, {signal: ctl.signal, headers: {Accept: "application/json"}});
          clearTimeout(timer);
          if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
          if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), {fatal: true});
          const j = await r.json();
          status.lastOk = Date.now();
          return j;
        } catch (e) {
          clearTimeout(timer);
          status.errors++; status.lastError = `${path}: ${e.message}`;
          if (e.fatal || i === tries - 1) throw e;
          await sleep(2000 * 2 ** i);
        }
      }
    } finally { release(); }
  }

  /** Mọi dòng BCTC của 1 mã từ ngày `since` (YYYY-MM-DD). rt = "Q" | "A". Tự lật trang. */
  async function fetchStatements(sym, rt, since, itemCodes) {
    const reportType = rt === "Q" ? "QUARTER" : "ANNUAL";
    let q = `code:${sym}~reportType:${reportType}~fiscalDate:gte:${since}`;
    if (itemCodes && itemCodes.length) q += `~itemCode:${itemCodes.join(",")}`;
    const rows = [];
    for (let page = 1; page <= 5; page++) {
      const j = await getJSON("financial_statements", `q=${q}&size=5000&page=${page}&sort=fiscalDate`);
      rows.push(...(j.data || []));
      if (!j.totalPages || page >= j.totalPages) break;
    }
    return rows;
  }

  /** Tên chỉ tiêu của 1 modelType, bỏ codeList (rất nặng). */
  async function fetchModels(modelType) {
    const j = await getJSON("financial_models", `q=modelType:${modelType}&size=500`);
    return (j.data || []).map((x) => ({
      code: String(Math.trunc(Number(x.itemCode))), name: x.itemVnName || x.itemEnName || String(x.itemCode),
      en: x.itemEnName || "", order: Number(x.displayOrder) || 0, level: Number(x.displayLevel) || 0,
    })).sort((a, b) => a.order - b.order);
  }

  /** Tên công ty / sàn. API trả 500 nếu hỏi quá nhiều mã một lần → chia 8. */
  async function fetchStocks(syms) {
    const out = {};
    for (let i = 0; i < syms.length; i += 8) {
      const chunk = syms.slice(i, i + 8);
      try {
        const j = await getJSON("stocks", `q=code:${chunk.join(",")}&size=20`, 2);
        for (const x of j.data || []) out[x.code] = {name: x.companyName || "", short: x.shortName || "", floor: x.floor || "", type: x.type || ""};
      } catch (e) { /* thiếu tên không chặn việc khác */ }
    }
    return out;
  }

  /** Kiểm tra mã có tồn tại (dùng khi thêm vào danh mục). */
  async function lookup(sym) {
    const r = await fetchStocks([sym]);
    return r[sym] || null;
  }

  root.Finfo = {fetchStatements, fetchModels, fetchStocks, lookup, status, BASE};
})(window);
