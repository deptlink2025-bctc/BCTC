/* Giao diện: 3 tab (Danh mục · Cảnh báo · Cài đặt). Mọi số liệu đọc từ IndexedDB qua Store;
 * Sync lo việc tải. Biểu đồ vẽ bằng Charts (SVG thuần). */
(function () {
  "use strict";
  const {Store, Sync, Metrics, Rules, Charts, Finfo} = window;
  const {fmtB, fmtPct, esc} = Charts;
  const {FORM_VI, REV_LABEL} = Metrics;
  const {RULES, SEV_RANK} = Rules;
  const $ = (id) => document.getElementById(id);
  const SEV_VI = {high: "cao", med: "trung bình", low: "thấp"};

  // ---- tiện ích ----
  const pctClass = (p) => (p === null || !Number.isFinite(p) ? "flat" : p > 0 ? "up" : p < 0 ? "down" : "flat");
  const viDate = (iso) => { if (!iso) return "—"; const p = iso.split("-"); return `${p[2]}/${p[1]}/${p[0]}`; };
  const viTime = (ms) => new Date(ms).toLocaleTimeString("vi-VN", {hour: "2-digit", minute: "2-digit"});
  const qOf = Metrics.quarterOf;

  // ---- cache trong bộ nhớ ----
  const SER = {};          // sym → {Q: series, A: series, meta}
  let ALERTS = [];         // toàn bộ cảnh báo
  let WL = [];             // danh mục
  let current = null;
  let autoPick = true;     // còn tự chọn mã mở đầu cho tới khi người dùng bấm chọn
  const UI = {rt: "Q", qn: null, cmpA: null, cmpB: null, stmt: "income"};
  const AUI = {scope: "unseen", rule: null};

  async function loadSymbol(sym) {
    if (SER[sym]) return SER[sym];
    const meta = (await Store.get("meta", sym)) || {};
    const form = meta.form || "NON_FINANCE";
    const [pq, pa] = await Promise.all([Store.periods(sym, "Q"), Store.periods(sym, "A")]);
    SER[sym] = {meta, form, Q: Metrics.series(pq, form, "Q"), A: Metrics.series(pa, form, "A"), rawQ: pq, rawA: pa};
    return SER[sym];
  }
  const invalidate = (sym) => { if (sym) delete SER[sym]; else Object.keys(SER).forEach((k) => delete SER[k]); };
  async function loadAll() {
    WL = (await Store.keys("watchlist")).sort();
    ALERTS = await Store.getAll("alerts");
    await Promise.all(WL.map(loadSymbol));
  }
  function badgeLevels() { const b = Sync.settings().app.badge; return Object.keys(b).filter((k) => b[k]); }
  function unseenCount() { const lv = badgeLevels(); return ALERTS.filter((a) => !a.seen && lv.includes(a.sev)).length; }
  function alertsOf(sym) { return ALERTS.filter((a) => a.sym === sym); }
  function latestAlerts(sym) {
    const s = SER[sym]; if (!s) return [];
    const lq = s.Q[s.Q.length - 1], la = s.A[s.A.length - 1];
    return ALERTS.filter((a) => a.sym === sym && ((lq && a.rt === "Q" && a.fd === lq.fd) || (la && a.rt === "A" && a.fd === la.fd)));
  }

  // ---- danh sách ----
  function renderRows() {
    const f = $("q").value.trim().toUpperCase();
    const sort = $("sort").value;
    let items = WL.map((sym) => {
      const s = SER[sym] || {Q: [], A: [], meta: {}};
      const last = s.Q[s.Q.length - 1] || null;
      const al = latestAlerts(sym);
      return {sym, last, alerts: al, sev: Rules.topSev(al), unseen: al.some((a) => !a.seen), meta: s.meta || {}, form: s.form};
    }).filter((o) => !f || o.sym.includes(f) || (o.meta.short || "").toUpperCase().includes(f) || (o.meta.name || "").toUpperCase().includes(f));
    const cmp = {
      sym: (a, b) => a.sym.localeCompare(b.sym),
      alert: (a, b) => (SEV_RANK[a.sev] ?? 3) - (SEV_RANK[b.sev] ?? 3) || b.alerts.length - a.alerts.length || a.sym.localeCompare(b.sym),
      yoy: (a, b) => ((b.last && b.last.yoy) ?? -1e9) - ((a.last && a.last.yoy) ?? -1e9),
      npat: (a, b) => ((b.last && b.last.npat) ?? -1e18) - ((a.last && a.last.npat) ?? -1e18),
      date: (a, b) => ((b.last && b.last.created) || "").localeCompare((a.last && a.last.created) || "") || a.sym.localeCompare(b.sym),
    }[sort];
    items.sort(cmp);
    if (!items.length) { $("rows").innerHTML = `<div class="empty">${WL.length ? "Không có mã nào khớp." : "Danh mục trống — bấm “+ Thêm mã”."}</div>`; return; }
    $("rows").innerHTML = items.map((o) => `
      <button class="row" data-sym="${o.sym}" aria-current="${o.sym === current}">
        <div><div class="sym mono">${o.sym}</div><div class="per mono">${o.last ? o.last.label : (o.meta.error ? "lỗi" : "…")}</div></div>
        <div><div class="nm" title="${esc(o.meta.name || "")}">${esc(o.meta.short || o.meta.name || (o.meta.error ? o.meta.error : "đang tải…"))}</div>
          <div>${o.sev ? `<span class="dot ${o.sev}">${o.alerts.length} cảnh báo${o.unseen ? " · mới" : ""}</span>` : `<span class="per">${FORM_VI[o.form] || ""}</span>`}</div></div>
        <div class="r">${o.last ? `<div class="v mono ${o.last.npat < 0 ? "down" : ""}">${fmtB(o.last.npat)}<span class="per"> tỷ</span></div><span class="pill ${pctClass(o.last.yoy)}">${fmtPct(o.last.yoy)}</span>` : ""}</div>
      </button>`).join("");
  }

  // ---- chi tiết ----
  async function renderDetail() {
    if (!current || !SER[current]) { $("detail").innerHTML = `<div class="empty">Chọn một mã để xem.</div>`; return; }
    const s = SER[current], form = s.form, meta = s.meta;
    const rt = UI.rt, ser = s[rt];
    if (!ser.length) {
      $("detail").innerHTML = `<button class="back" id="back">‹ Danh mục</button><div class="dhead"><h2 class="mono">${current}</h2><div class="name">${esc(meta.name || "")}</div></div><div class="empty">${meta.error ? esc(meta.error) : "Chưa có dữ liệu — đang tải hoặc bấm Làm mới."}</div>`;
      bindBack(); return;
    }
    const q = s.Q, lq = q[q.length - 1] || ser[ser.length - 1];
    const nShow = rt === "Q" ? 12 : 8, shown = ser.slice(-nShow);
    const qn = UI.qn || qOf(lq.fd);
    const sameQ = q.filter((p) => qOf(p.fd) === qn);
    const alerts = latestAlerts(current);
    const tbl = ser.slice(-8).reverse();
    const cmpOpts = ser.slice().reverse();
    const A = UI.cmpA && ser.find((p) => p.fd === UI.cmpA) ? UI.cmpA : ser[ser.length - 1].fd;
    const B = UI.cmpB && ser.find((p) => p.fd === UI.cmpB) ? UI.cmpB : (ser[ser.length - 1 - (rt === "Q" ? 4 : 1)] || ser[0]).fd;
    const pa = ser.find((p) => p.fd === A), pb = ser.find((p) => p.fd === B);
    const yq = q[q.length - 5];
    const revLabel = REV_LABEL[form];
    const cafef = `https://cafef.vn/du-lieu/BaoCaoTaiChinh_V2.aspx?symbol=${current}&type=IncSta&year=${lq.fd.slice(0, 4)}&quarter=${qOf(lq.fd)}`;
    const vietstock = `https://finance.vietstock.vn/${current}/tai-chinh.htm`;

    $("detail").innerHTML = `
      <button class="back" id="back">‹ Danh mục</button>
      <div class="dhead">
        <h2 class="mono">${current}</h2>
        <div class="name">${esc(meta.name || "")}<div><span class="tag">${FORM_VI[form]}</span> ${meta.floor ? `<span class="tag">${esc(meta.floor)}</span>` : ""}</div></div>
        <div class="meta">Kỳ mới nhất: <b>${lq.long}</b><br>VNDirect đăng ${viDate(lq.created)}${lq.modified && lq.modified !== lq.created ? ` · sửa ${viDate(lq.modified)}` : ""}<br><a href="${cafef}" target="_blank" rel="noopener">CafeF</a> · <a href="${vietstock}" target="_blank" rel="noopener">Vietstock</a></div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="l">${esc(revLabel)}</div><div class="v mono">${fmtB(lq.rev)}<small> tỷ</small></div><div class="d ${pctClass(lq.rev_yoy)}">${fmtPct(lq.rev_yoy)} YoY</div></div>
        <div class="kpi"><div class="l">LNST công ty mẹ</div><div class="v mono ${lq.npat < 0 ? "down" : ""}">${fmtB(lq.npat)}<small> tỷ</small></div><div class="d ${pctClass(lq.yoy)}">${fmtPct(lq.yoy)} YoY · ${fmtPct(lq.qoq)} QoQ</div></div>
        <div class="kpi"><div class="l">Biên LN ròng</div><div class="v mono">${lq.margin === null ? "—" : fmtPct(lq.margin, false)}</div><div class="d">${yq && yq.margin !== null ? `cùng kỳ ${fmtPct(yq.margin, false)}` : ""}</div></div>
        <div class="kpi"><div class="l">Tiền từ HĐKD</div><div class="v mono ${lq.cfo < 0 ? "down" : ""}">${fmtB(lq.cfo)}<small> tỷ</small></div><div class="d">${form === "NON_FINANCE" && lq.cfo !== null && lq.npat > 0 && lq.cfo < 0 ? "<span class=down>lãi nhưng dòng tiền âm</span>" : ""}</div></div>
        <div class="kpi"><div class="l">Cảnh báo kỳ này</div><div class="v mono ${alerts.length && Rules.topSev(alerts) === "high" ? "down" : ""}">${alerts.length}</div><div class="d">${alerts.length ? esc([...new Set(alerts.map((a) => RULES[a.rule].name))].join(" · ")) : "không có gì bất thường"}</div></div>
      </div>

      <div class="sec">
        <div class="sech"><h3>Doanh thu &amp; lợi nhuận theo kỳ</h3>
          <div class="seg sm" id="rtSeg"><button aria-selected="${rt === "Q"}" data-rt="Q">Quý</button><button aria-selected="${rt === "A"}" data-rt="A">Năm</button></div>
          <div class="legend sp"><span><i style="background:var(--s-rev)"></i>${esc(revLabel)}</span><span><i style="background:var(--s-npat)"></i>LNST công ty mẹ</span><span><i style="background:var(--down)"></i>Giá trị âm</span></div>
        </div>
        <div class="chart" id="c1"></div>
      </div>

      ${alerts.length ? `<div class="sec"><div class="sech"><h3>Điểm bất thường kỳ mới nhất</h3></div><div class="alist">${alerts.map(alertHTML).join("")}</div></div>` : ""}

      <div class="sec">
        <div class="sech"><h3>${rt === "Q" ? "8 quý" : "8 năm"} gần nhất</h3><span class="sub">tỷ đồng · YoY = so cùng kỳ năm trước${rt === "Q" ? " · QoQ = so quý liền trước" : ""}</span></div>
        <div class="tblwrap"><table>
          <thead><tr><th>Kỳ</th><th>${esc(revLabel)}</th><th>YoY DT</th><th>LNST cty mẹ</th><th>YoY</th>${rt === "Q" ? "<th>QoQ</th>" : ""}<th>Biên ròng</th><th>Tiền HĐKD</th><th>VCSH</th><th>Đăng</th></tr></thead>
          <tbody>${tbl.map((p, i) => `<tr class="${i === 0 ? "latest" : ""}"><td class="mono">${p.label}</td><td class="num">${fmtB(p.rev)}</td><td><span class="pill ${pctClass(p.rev_yoy)}">${fmtPct(p.rev_yoy)}</span></td><td class="num ${p.npat < 0 ? "down" : ""}">${fmtB(p.npat)}</td><td><span class="pill ${pctClass(p.yoy)}">${fmtPct(p.yoy)}</span></td>${rt === "Q" ? `<td><span class="pill ${pctClass(p.qoq)}">${fmtPct(p.qoq)}</span></td>` : ""}<td class="num">${p.margin === null ? "—" : fmtPct(p.margin, false)}</td><td class="num ${p.cfo < 0 ? "down" : ""}">${fmtB(p.cfo)}</td><td class="num">${fmtB(p.eq)}</td><td class="num muted">${viDate(p.created).slice(0, 5)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>

      ${sameQ.length > 1 ? `<div class="sec">
        <div class="sech"><h3>Cùng quý qua các năm</h3>
          <div class="seg sm" id="qnSeg">${[1, 2, 3, 4].map((n) => `<button aria-selected="${n === qn}" data-qn="${n}">Q${n}</button>`).join("")}</div>
          <span class="sub">LNST công ty mẹ · nhãn: giá trị · YoY</span></div>
        <div class="chart" id="c2"></div>
      </div>` : ""}

      <div class="sec">
        <div class="sech"><h3>So sánh 2 kỳ</h3>
          <div class="cmp"><select class="sel" id="cmpA">${cmpOpts.map((p) => `<option value="${p.fd}" ${p.fd === A ? "selected" : ""}>${p.long}</option>`).join("")}</select> so với <select class="sel" id="cmpB">${cmpOpts.map((p) => `<option value="${p.fd}" ${p.fd === B ? "selected" : ""}>${p.long}</option>`).join("")}</select></div>
          <div class="seg sm sp" id="stmtSeg"><button aria-selected="${UI.stmt === "income"}" data-stmt="income">KQKD</button><button aria-selected="${UI.stmt === "balance"}" data-stmt="balance">CĐKT</button><button aria-selected="${UI.stmt === "cashflow"}" data-stmt="cashflow">LCTT</button></div>
        </div>
        <div id="cmpTable"><div class="empty">Đang tải tên chỉ tiêu…</div></div>
      </div>

      <div class="sec">
        <div class="sech"><h3>Báo cáo đầy đủ — 8 ${rt === "Q" ? "quý" : "năm"} gần nhất</h3><span class="sub">tỷ đồng · dòng bằng 0 ở mọi kỳ được ẩn</span></div>
        <div id="stmtTables"><div class="empty">Đang tải tên chỉ tiêu…</div></div>
      </div>`;

    Charts.barChart($("c1"), shown, {revLabel, aria: `Doanh thu và LNST ${current} theo ${rt === "Q" ? "quý" : "năm"}`});
    if ($("c2")) Charts.sameQuarterChart($("c2"), sameQ, qn);
    $("rtSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { UI.rt = b.dataset.rt; UI.cmpA = UI.cmpB = null; renderDetail(); } });
    if ($("qnSeg")) $("qnSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { UI.qn = +b.dataset.qn; renderDetail(); } });
    $("cmpA").addEventListener("change", (e) => { UI.cmpA = e.target.value; renderDetail(); });
    $("cmpB").addEventListener("change", (e) => { UI.cmpB = e.target.value; renderDetail(); });
    $("stmtSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { UI.stmt = b.dataset.stmt; renderDetail(); } });
    bindBack();

    // bảng đầy đủ: cần tên chỉ tiêu (tải 1 lần / loại công ty)
    const sym = current, rtNow = rt;
    let items;
    try { items = await Sync.ensureItems(form); }
    catch (e) { if ($("cmpTable")) $("cmpTable").innerHTML = `<p class="hint">Không tải được tên chỉ tiêu (${esc(e.message)}). Thử Làm mới.</p>`; if ($("stmtTables")) $("stmtTables").innerHTML = ""; return; }
    if (current !== sym || UI.rt !== rtNow || !$("cmpTable")) return; // người dùng đã chuyển mã
    const raw = rt === "Q" ? s.rawQ : s.rawA;
    renderCompare(items[UI.stmt], raw[A], raw[B], pa, pb);
    renderStatements(items, raw, ser.slice(-8));
  }
  function bindBack() { const b = $("back"); if (b) b.addEventListener("click", () => $("split").classList.remove("showing")); }

  // Dòng có mọi giá trị |v| < 100.000 là EPS / tỷ lệ (đơn vị đồng hoặc %), không phải tỷ đồng
  const isSmallRow = (vals) => vals.some((v) => v) && vals.every((v) => v === null || v === undefined || Math.abs(v) < 1e5);
  const fmtCell = (v, small) => (v === null || v === undefined ? "—" : small ? new Intl.NumberFormat("vi-VN", {maximumFractionDigits: 2}).format(v) : fmtB(v));
  const lvClass = (it) => `lv${Math.min(5, Math.max(1, Math.round(it.level) + 1))}`;

  function renderCompare(items, ra, rb, pa, pb) {
    const va = (ra && ra.v) || {}, vb = (rb && rb.v) || {};
    const rows = items.filter((it) => (va[it.code] || 0) !== 0 || (vb[it.code] || 0) !== 0);
    if (!rows.length) { $("cmpTable").innerHTML = `<p class="hint">Không có số liệu cho 2 kỳ này.</p>`; return; }
    $("cmpTable").innerHTML = `<div class="tblwrap"><table>
      <thead><tr><th>Chỉ tiêu</th><th>${pa.label}</th><th>${pb.label}</th><th>Chênh lệch</th><th>%</th></tr></thead>
      <tbody>${rows.map((it) => {
        const a = va[it.code] ?? null, b = vb[it.code] ?? null, small = isSmallRow([a, b]);
        const d = a !== null && b !== null ? a - b : null, pc = Metrics.growth(a, b);
        return `<tr class="${lvClass(it)}"><td class="name">${esc(it.name)}${small ? ' <span class="muted">(đ)</span>' : ""}</td><td class="num">${fmtCell(a, small)}</td><td class="num">${fmtCell(b, small)}</td><td class="num ${d === null ? "" : d > 0 ? "up" : d < 0 ? "down" : ""}">${d === null ? "—" : (d > 0 ? "+" : "") + fmtCell(d, small)}</td><td><span class="pill ${pctClass(pc)}">${fmtPct(pc)}</span></td></tr>`;
      }).join("")}</tbody></table></div>`;
  }
  function renderStatements(items, raw, periods) {
    const names = {income: "Kết quả kinh doanh", balance: "Cân đối kế toán", cashflow: "Lưu chuyển tiền tệ"};
    const ps = periods.slice().reverse();
    $("stmtTables").innerHTML = ["income", "balance", "cashflow"].map((kind, i) => {
      const rows = items[kind].filter((it) => ps.some((p) => ((raw[p.fd] && raw[p.fd].v[it.code]) || 0) !== 0));
      return `<details class="stmt" ${i === 0 ? "open" : ""}><summary>${names[kind]} <span class="muted" style="font-weight:400">· ${rows.length} dòng</span></summary>
        <div class="tblwrap"><table><thead><tr><th>Chỉ tiêu</th>${ps.map((p) => `<th>${p.label}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((it) => {
          const vals = ps.map((p) => (raw[p.fd] ? raw[p.fd].v[it.code] : undefined)), small = isSmallRow(vals);
          return `<tr class="${lvClass(it)}"><td class="name">${esc(it.name)}${small ? ' <span class="muted">(đ)</span>' : ""}</td>${vals.map((v) => `<td class="num ${v < 0 ? "down" : ""}">${fmtCell(v, small)}</td>`).join("")}</tr>`;
        }).join("")}</tbody></table></div></details>`;
    }).join("");
  }

  function alertHTML(a) {
    return `<button class="al ${a.sev} ${a.seen ? "" : "unseen"}" data-key="${esc(a.key)}" data-sym="${a.sym}" title="Mức ${SEV_VI[a.sev]}${a.seen ? "" : " · chưa xem"}"><span class="bar"></span>
      <span class="s mono">${a.sym}<small>${a.label}</small></span>
      <span class="t">${RULES[a.rule].name}<small>${esc(a.text)}</small></span>
      <span class="r">${a.pct !== null && Number.isFinite(a.pct) ? `<b class="${a.pct > 0 ? "up" : "down"}">${fmtPct(a.pct)}</b>` : `<b class="${a.value < 0 ? "down" : ""}">${fmtB(a.value)} tỷ</b>`}${a.created ? `đăng ${viDate(a.created).slice(0, 5)}` : ""}</span></button>`;
  }

  // ---- tab cảnh báo ----
  function renderAlerts() {
    const all = ALERTS.slice().sort((a, b) => Number(a.seen) - Number(b.seen) || SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.fd.localeCompare(a.fd) || a.sym.localeCompare(b.sym));
    const scoped = AUI.scope === "unseen" ? all.filter((a) => !a.seen) : all;
    const counts = {}; scoped.forEach((a) => { counts[a.rule] = (counts[a.rule] || 0) + 1; });
    $("ruleChips").innerHTML = `<button class="chip" aria-pressed="${AUI.rule === null}" data-rule="">Tất cả · ${scoped.length}</button>` +
      Object.keys(RULES).map((r) => `<button class="chip" aria-pressed="${AUI.rule === r}" data-rule="${r}">${RULES[r].name} · ${counts[r] || 0}</button>`).join("");
    const list = AUI.rule ? scoped.filter((a) => a.rule === AUI.rule) : scoped;
    $("alist").innerHTML = list.length ? list.slice(0, 300).map(alertHTML).join("") + (list.length > 300 ? `<p class="hint">… và ${list.length - 300} cảnh báo nữa</p>` : "")
      : `<div class="empty">${AUI.scope === "unseen" ? "Không có cảnh báo mới. Khi có kỳ BCTC mới, app sẽ liệt kê ở đây." : "Chưa có cảnh báo nào."}</div>`;
    const unseen = all.filter((a) => !a.seen).length, high = all.filter((a) => a.sev === "high").length;
    $("alertSub").textContent = `${all.length} cảnh báo · ${new Set(all.map((a) => a.sym)).size} mã`;
    $("alertStat").innerHTML = `<div><b>${unseen}</b><span>chưa xem</span></div><div><b class="${high ? "down" : ""}">${high}</b><span>mức cao</span></div><div><b>${all.length}</b><span>tổng</span></div>`;
    $("btnSeenAll").disabled = !unseen;
    updateBadge();
  }
  function updateBadge() { const n = unseenCount(); const el = $("alertCount"); el.textContent = n; el.dataset.zero = n ? "0" : "1"; }
  async function markSeen(keys) {
    const now = Date.now();
    for (const k of keys) { const a = ALERTS.find((x) => x.key === k); if (a && !a.seen) { a.seen = true; a.seenAt = now; await Store.put("alerts", k, a); } }
  }

  // ---- cài đặt ----
  function renderSettings() {
    const {th, app} = Sync.settings();
    const set = (id, v, out, suffix) => { $(id).value = v; $(out).textContent = v + (suffix || "%"); };
    set("yoyT", th.yoy, "yoyV"); set("qoqT", th.qoq, "qoqV"); set("revT", th.rev, "revV"); set("ncT", th.nc, "ncV"); set("rsT", th.restated, "rsV");
    set("arT", app.autoRefreshHours, "arV", " giờ");
    $("optNotify").checked = !!app.notify;
    $("ruleToggles").innerHTML = Object.entries(RULES).map(([r, d]) => `<label class="sw"><input type="checkbox" data-rule="${r}" ${th.enabled[r] ? "checked" : ""}><span>${d.name} <span class="tag">${SEV_VI[d.sev]}</span><small>${d.desc}</small></span></label>`).join("");
    $("badgeToggles").innerHTML = ["high", "med", "low"].map((s) => `<label class="sw"><input type="checkbox" data-badge="${s}" ${app.badge[s] ? "checked" : ""}><span>Mức ${SEV_VI[s]}</span></label>`).join("");
    renderWatchlistTags();
    Store.keys("statements").then((ks) => { $("dataInfo").textContent = `Đang lưu ${ks.length.toLocaleString("vi-VN")} kỳ báo cáo của ${WL.length} mã trong trình duyệt này.`; });
  }
  function renderWatchlistTags() {
    $("wlCount").textContent = `· ${WL.length} mã`;
    $("wlTags").innerHTML = WL.map((s) => `<span class="tagx">${s}<button data-del="${s}" title="Xoá ${s}" aria-label="Xoá ${s}">×</button></span>`).join("");
  }
  function bindSettings() {
    [["yoyT", "yoy", "yoyV"], ["qoqT", "qoq", "qoqV"], ["revT", "rev", "revV"], ["ncT", "nc", "ncV"], ["rsT", "restated", "rsV"]].forEach(([id, key, out]) => {
      $(id).addEventListener("input", (e) => { $(out).textContent = e.target.value + "%"; });
      $(id).addEventListener("change", (e) => Sync.saveSettings("th", {[key]: +e.target.value}));
    });
    $("arT").addEventListener("input", (e) => { $("arV").textContent = e.target.value + " giờ"; });
    $("arT").addEventListener("change", (e) => { Sync.saveSettings("app", {autoRefreshHours: +e.target.value}); scheduleAuto(); });
    $("ruleToggles").addEventListener("change", (e) => { const r = e.target.dataset.rule; if (r) Sync.saveSettings("th", {enabled: Object.assign({}, Sync.settings().th.enabled, {[r]: e.target.checked})}); });
    $("badgeToggles").addEventListener("change", async (e) => { const s = e.target.dataset.badge; if (s) { await Sync.saveSettings("app", {badge: Object.assign({}, Sync.settings().app.badge, {[s]: e.target.checked})}); updateBadge(); } });
    $("optNotify").addEventListener("change", async (e) => {
      if (e.target.checked && typeof Notification !== "undefined" && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { e.target.checked = false; return; }
      }
      Sync.saveSettings("app", {notify: e.target.checked});
    });
    $("wlTags").addEventListener("click", async (e) => {
      const s = e.target.dataset.del; if (!s) return;
      if (!confirm(`Xoá ${s} khỏi danh mục và xoá dữ liệu đã tải của mã này?`)) return;
      await Sync.removeSymbol(s); invalidate(s); if (current === s) current = null;
      await refreshViews();
    });
    $("btnPasteAdd").addEventListener("click", () => addMany($("wlPaste").value, $("wlMsg")).then((ok) => { if (ok) $("wlPaste").value = ""; }));
    $("btnExport").addEventListener("click", () => {
      const {th, app} = Sync.settings();
      const blob = new Blob([JSON.stringify({app: "bctc-radar", version: 1, exported: new Date().toISOString(), watchlist: WL, th, app: {badge: app.badge, autoRefreshHours: app.autoRefreshHours, notify: app.notify}}, null, 1)], {type: "application/json"});
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `bctc-radar-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $("fileImport").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!Array.isArray(j.watchlist)) throw new Error("File không đúng định dạng");
        if (j.th) await Sync.saveSettings("th", j.th);
        if (j.app) await Sync.saveSettings("app", j.app);
        await addMany(j.watchlist.join(" "), $("wlMsg"));
        renderSettings();
      } catch (err) { $("wlMsg").className = "msg err"; $("wlMsg").textContent = err.message; }
      e.target.value = "";
    });
    $("btnWipe").addEventListener("click", async () => {
      if (!confirm("Xoá toàn bộ dữ liệu BCTC, cảnh báo và cài đặt đã lưu trong trình duyệt? Danh mục sẽ nạp lại từ đầu.")) return;
      await Store.wipe(); location.reload();
    });
  }
  async function addMany(text, msgEl) {
    const syms = [...new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter((s) => s.length >= 3))];
    if (!syms.length) { msgEl.className = "msg err"; msgEl.textContent = "Không thấy mã nào."; return false; }
    msgEl.className = "msg"; msgEl.textContent = `Đang kiểm tra ${syms.length} mã…`;
    const added = [], bad = [];
    for (const s of syms) { try { const r = await Sync.addSymbol(s); if (!r.existed) added.push(s); } catch (e) { bad.push(s); } }
    msgEl.className = bad.length ? "msg err" : "msg ok";
    msgEl.textContent = `${added.length ? "Đã thêm " + added.join(", ") : "Không có mã mới"}${bad.length ? " · không tìm thấy: " + bad.join(", ") : ""}`;
    if (added.length) { await refreshViews(); Sync.syncAll(); }
    return added.length > 0;
  }

  // ---- điều hướng & sự kiện chung ----
  function goView(name) {
    [...$("mainTabs").children].forEach((b) => b.setAttribute("aria-selected", b.dataset.view === name));
    ["list", "alerts", "settings"].forEach((v) => $("v-" + v).classList.toggle("on", v === name));
    if (name === "settings") renderSettings();
  }
  function bindGlobal() {
    $("mainTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) goView(b.dataset.view); });
    $("rows").addEventListener("click", (e) => {
      const b = e.target.closest(".row"); if (!b) return;
      current = b.dataset.sym; autoPick = false; UI.cmpA = UI.cmpB = null; UI.qn = null;
      renderRows(); renderDetail();
      $("split").classList.add("showing");
      if (window.innerWidth <= 860) window.scrollTo({top: 0});
    });
    $("q").addEventListener("input", renderRows);
    $("sort").addEventListener("change", renderRows);
    $("btnRefresh").addEventListener("click", () => Sync.syncAll({force: true}));
    $("ruleChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) { AUI.rule = b.dataset.rule || null; renderAlerts(); } });
    $("alertScope").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { AUI.scope = b.dataset.scope; [...$("alertScope").children].forEach((x) => x.setAttribute("aria-selected", x === b)); renderAlerts(); } });
    $("alist").addEventListener("click", async (e) => {
      const b = e.target.closest(".al"); if (!b) return;
      await markSeen([b.dataset.key]);
      current = b.dataset.sym; UI.cmpA = UI.cmpB = null; UI.qn = null;
      goView("list"); renderRows(); renderDetail(); renderAlerts();
      $("split").classList.add("showing"); window.scrollTo({top: 0});
    });
    $("detail").addEventListener("click", async (e) => { const b = e.target.closest(".al"); if (b) { await markSeen([b.dataset.key]); renderAlerts(); renderDetail(); } });
    $("btnSeenAll").addEventListener("click", async () => { await markSeen(ALERTS.filter((a) => !a.seen).map((a) => a.key)); renderAlerts(); renderRows(); });
    $("btnAdd").addEventListener("click", () => { $("addSym").value = ""; $("addMsg").textContent = ""; $("dlgAdd").showModal(); $("addSym").focus(); });
    $("dlgAdd").querySelector("form").addEventListener("submit", (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      addMany($("addSym").value, $("addMsg")).then((ok) => { if (ok) $("dlgAdd").close(); });
    });
    Sync.on(onSync);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Sync.syncAll(); });
  }

  // ---- đồng bộ → giao diện ----
  function onSync(st) {
    const led = $("led"), txt = $("statusText"), pr = $("progress");
    if (st.running) {
      led.className = "led busy";
      txt.textContent = `Đang tải ${st.current}…`;
      pr.hidden = false; $("progressText").textContent = `Đồng bộ ${st.done}/${st.total} mã`;
      $("progressBar").style.width = (st.total ? st.done / st.total * 100 : 0) + "%";
      if (st.done && st.done % 5 === 0) refreshViews(true);
      return;
    }
    pr.hidden = true;
    const err = st.errors.length;
    led.className = err ? "led bad" : "led";
    txt.textContent = st.lastRun ? `Cập nhật ${viTime(st.lastRun)}${err ? ` · ${err} mã lỗi` : ""}${st.newAlerts.length ? ` · ${st.newAlerts.length} cảnh báo mới` : ""}` : "Sẵn sàng";
    const wb = $("warnBanner");
    if (err && err === st.total) { wb.hidden = false; $("warnText").textContent = `Không tải được dữ liệu mới từ VNDirect (${st.errors[0].message}). Đang hiển thị số đã lưu.`; }
    else if (err) { wb.hidden = false; $("warnText").textContent = `Không tải được: ${st.errors.map((e) => e.sym).join(", ")} — ${st.errors[0].message}`; }
    else wb.hidden = true;
    refreshViews();
    if (st.newAlerts.length) { AUI.scope = "unseen"; [...$("alertScope").children].forEach((x) => x.setAttribute("aria-selected", x.dataset.scope === "unseen")); }
  }
  function pickTop() {
    const ranked = WL.map((s) => ({s, sev: Rules.topSev(latestAlerts(s))})).sort((a, b) => (SEV_RANK[a.sev] ?? 3) - (SEV_RANK[b.sev] ?? 3) || a.s.localeCompare(b.s));
    return ranked.length ? ranked[0].s : null;
  }
  async function refreshViews(partial) {
    invalidate();
    await loadAll();
    if (!current || !WL.includes(current)) current = null;
    if (autoPick && !partial) { const top = pickTop(); if (top !== current) { current = top; partial = false; } }
    renderRows();
    if (!partial || !current) renderDetail();
    renderAlerts();
    if ($("v-settings").classList.contains("on")) renderSettings();
  }
  let autoTimer = null;
  function scheduleAuto() {
    if (autoTimer) clearInterval(autoTimer);
    const h = Sync.settings().app.autoRefreshHours || 6;
    autoTimer = setInterval(() => Sync.syncAll({force: true}), h * 3600 * 1000);
  }

  async function boot() {
    try {
      await Sync.init();
    } catch (e) {
      $("warnBanner").hidden = false; $("warnText").textContent = `Trình duyệt không cho lưu dữ liệu (${e.message}). Hãy tắt chế độ ẩn danh hoặc cho phép lưu trữ.`;
    }
    bindGlobal(); bindSettings();
    await loadAll();
    if (!current) current = pickTop();   // mở sẵn mã có cảnh báo cao nhất, không thì mã đầu
    renderRows(); renderDetail(); renderAlerts();
    $("statusText").textContent = "Sẵn sàng";
    Sync.syncAll();
    scheduleAuto();
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
