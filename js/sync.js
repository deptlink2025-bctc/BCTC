/* Đồng bộ dữ liệu: VNDirect → IndexedDB, sinh cảnh báo khi có kỳ mới hoặc kỳ cũ bị sửa.
 *
 * - Mã chưa có gì: nạp 5 năm quý + 10 năm năm (backfill). Cảnh báo chỉ tính cho kỳ mới nhất
 *   và đánh dấu "đã xem" — mở lần đầu không bị dội mấy chục cảnh báo cũ.
 * - Mã đã có: hỏi lại từ (quý cuối − 12 tháng) để vừa bắt kỳ mới vừa bắt BCTC bị điều chỉnh.
 * - Tự sync tối đa 1 lần/giờ; nút "Làm mới" bỏ qua khoá này.
 */
(function (root) {
  "use strict";
  const {Store, Finfo, Metrics, Rules} = root;
  const HOUR = 3600 * 1000;

  const state = {running: false, done: 0, total: 0, current: "", errors: [], newAlerts: [], lastRun: null, changed: false};
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(state); } catch (e) { /* UI lỗi không chặn sync */ } });

  const DEFAULT_APP = {badge: {high: true, med: true, low: false}, autoRefreshHours: 6, notify: false, lastSyncAll: 0, yearsQ: 5, yearsA: 10};
  let settings = {th: Object.assign({}, Rules.DEFAULTS), app: Object.assign({}, DEFAULT_APP)};

  async function loadSettings() {
    const th = await Store.get("settings", "th"), app = await Store.get("settings", "app");
    settings.th = Object.assign({}, Rules.DEFAULTS, th || {}, {enabled: Object.assign({}, Rules.DEFAULTS.enabled, (th && th.enabled) || {})});
    settings.app = Object.assign({}, DEFAULT_APP, app || {}, {badge: Object.assign({}, DEFAULT_APP.badge, (app && app.badge) || {})});
    return settings;
  }
  async function saveSettings(part, val) {
    settings[part] = Object.assign({}, settings[part], val);
    await Store.put("settings", part, settings[part]);
    mirrorLite();
  }
  async function mirrorLite() {
    const wl = await Store.keys("watchlist");
    Store.mirror({watchlist: wl, th: settings.th, app: settings.app});
  }

  /** Lần đầu: danh mục trống → nạp seed (39 mã) hoặc bản sao localStorage nếu có. */
  async function init() {
    await loadSettings();
    const wl = await Store.keys("watchlist");
    if (wl.length) return;
    const m = Store.readMirror();
    let syms = m && Array.isArray(m.watchlist) && m.watchlist.length ? m.watchlist : null;
    if (!syms) {
      try { const r = await fetch("data/seed.json"); syms = (await r.json()).symbols; }
      catch (e) { syms = []; }
    }
    if (m && m.th) await saveSettings("th", m.th);
    if (m && m.app) await saveSettings("app", Object.assign({}, m.app, {lastSyncAll: 0}));
    const now = Date.now();
    await Store.bulkPut("watchlist", syms.map((s) => [s, {added: now}]));
    mirrorLite();
  }

  const yearsAgo = (n) => `${new Date().getFullYear() - n}-01-01`;

  /** Ghi các kỳ vừa tải; trả về {newFds, restatedAlerts}. */
  async function storePeriods(sym, rt, grouped) {
    const existing = await Store.periods(sym, rt);
    const entries = [], newFds = [], restatedAlerts = [];
    for (const fd of Object.keys(grouped)) {
      const rec = grouped[fd];
      const old = existing[fd];
      if (!old) newFds.push(fd);
      else {
        const a = Rules.restated(sym, rt, fd, old.v, rec.v, settings.th);
        if (a) restatedAlerts.push(a);
      }
      entries.push([`${sym}|${rt}|${fd}`, {created: rec.created, modified: rec.modified, mts: rec.mts, v: rec.v}]);
    }
    if (entries.length) await Store.bulkPut("statements", entries);
    return {newFds, restatedAlerts};
  }

  async function evalNew(sym, form, rt, fds) {
    if (!fds.length) return [];
    const per = await Store.periods(sym, rt);
    const ser = Metrics.series(per, form, rt);
    const revLabel = Metrics.REV_LABEL[form];
    return ser.filter((p) => fds.includes(p.fd)).flatMap((p) => Rules.evalPeriod(sym, form, p, settings.th, revLabel));
  }

  async function writeAlerts(list, seen) {
    if (!list.length) return [];
    const fresh = [];
    for (const a of list) {
      const old = await Store.get("alerts", a.key);
      if (old) continue;                       // chống trùng: đã có thì không ghi lại
      const rec = Object.assign({}, a, {seen: !!seen, at: Date.now()});
      await Store.put("alerts", a.key, rec);
      fresh.push(rec);
    }
    return fresh;
  }

  async function syncSymbol(sym, {backfillOnly = false} = {}) {
    const meta = (await Store.get("meta", sym)) || {};
    const isNew = !meta.lastQ;
    const sinceQ = isNew ? yearsAgo(settings.app.yearsQ) : Metrics.shiftMonths(meta.lastQ, -12);
    const sinceA = isNew ? yearsAgo(settings.app.yearsA) : `${+meta.lastA.slice(0, 4) - 1}-01-01`;

    const rowsQ = await Finfo.fetchStatements(sym, "Q", sinceQ);
    const gQ = Metrics.groupPeriods(rowsQ);
    const qDates = Object.keys(gQ).sort();
    if (!qDates.length && isNew) {
      await Store.put("meta", sym, Object.assign(meta, {error: "VNDirect không có BCTC cho mã này", lastSync: Date.now()}));
      return {sym, alerts: [], error: meta.error};
    }
    const form = meta.form || Metrics.detectForm(qDates.length ? gQ[qDates[qDates.length - 1]].mts : []);
    const rowsA = await Finfo.fetchStatements(sym, "A", sinceA);
    const gA = Metrics.groupPeriods(rowsA);

    const rq = await storePeriods(sym, "Q", gQ);
    const ra = await storePeriods(sym, "A", gA);
    const allQ = await Store.keys("statements", Store.prefixRange(`${sym}|Q|`));
    const allA = await Store.keys("statements", Store.prefixRange(`${sym}|A|`));
    const lastQ = allQ.length ? allQ[allQ.length - 1].split("|")[2] : null;
    const lastA = allA.length ? allA[allA.length - 1].split("|")[2] : null;

    let alerts = [];
    if (isNew || backfillOnly) {
      // chỉ kỳ mới nhất, đã xem — tránh dội cảnh báo cũ
      const a = [...(lastQ ? await evalNew(sym, form, "Q", [lastQ]) : []), ...(lastA ? await evalNew(sym, form, "A", [lastA]) : [])];
      await writeAlerts(a, true);
    } else {
      const a = [...(await evalNew(sym, form, "Q", rq.newFds)), ...(await evalNew(sym, form, "A", ra.newFds)), ...rq.restatedAlerts, ...ra.restatedAlerts];
      alerts = await writeAlerts(a, false);
    }
    await Store.put("meta", sym, Object.assign(meta, {form, lastQ, lastA, lastSync: Date.now(), error: null}));
    return {sym, alerts, isNew, newFds: [...rq.newFds, ...ra.newFds]};
  }

  async function ensureNames(syms) {
    const missing = [];
    for (const s of syms) { const m = await Store.get("meta", s); if (!m || !m.name) missing.push(s); }
    if (!missing.length) return;
    const info = await Finfo.fetchStocks(missing);
    for (const s of missing) {
      if (!info[s]) continue;
      const m = (await Store.get("meta", s)) || {};
      await Store.put("meta", s, Object.assign(m, {name: info[s].name, short: info[s].short, floor: info[s].floor}));
    }
  }

  /** Tên chỉ tiêu cho 3 báo cáo của 1 loại công ty (tải 1 lần, cache). */
  async function ensureItems(form) {
    const mts = Metrics.MODEL_TYPES[form];
    const out = {};
    for (const [kind, mt] of Object.entries(mts)) {
      let items = await Store.get("items", String(mt));
      if (!items) { items = await Finfo.fetchModels(mt); await Store.put("items", String(mt), items); }
      out[kind] = items;
    }
    return out;
  }

  async function syncAll({force = false} = {}) {
    if (state.running) return state;
    const wl = (await Store.keys("watchlist")).sort();
    if (!force && Date.now() - (settings.app.lastSyncAll || 0) < HOUR) {
      // vẫn nạp mã mới thêm (chưa có meta) dù chưa tới giờ
      const pending = [];
      for (const s of wl) { const m = await Store.get("meta", s); if (!m || !m.lastQ) pending.push(s); }
      if (!pending.length) return state;
      return run(pending);
    }
    return run(wl, true);
  }

  async function run(syms, full) {
    Object.assign(state, {running: true, done: 0, total: syms.length, current: "", errors: [], newAlerts: [], changed: false});
    emit();
    const queue = syms.slice();
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        state.current = s; emit();
        try {
          const r = await syncSymbol(s);
          if (r.alerts.length) state.newAlerts.push(...r.alerts);
          if (r.isNew || (r.newFds && r.newFds.length) || r.alerts.length) state.changed = true;
        } catch (e) {
          state.errors.push({sym: s, message: e.message});
          const m = (await Store.get("meta", s)) || {};
          await Store.put("meta", s, Object.assign(m, {error: e.message, lastSync: Date.now()}));
        }
        state.done++; emit();
      }
    };
    await Promise.all([worker(), worker()]);
    try { await ensureNames(syms); } catch (e) { /* tên thiếu không chặn */ }
    if (full) await saveSettings("app", {lastSyncAll: Date.now()});
    state.running = false; state.current = ""; state.lastRun = Date.now();
    emit();
    if (state.newAlerts.length) notify(state.newAlerts);
    return state;
  }

  function notify(list) {
    if (!settings.app.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const hi = list.filter((a) => a.sev !== "low");
    if (!hi.length) return;
    try {
      new Notification(`BCTC Radar: ${hi.length} cảnh báo mới`, {body: hi.slice(0, 4).map((a) => `${a.sym} ${a.label}: ${Rules.RULES[a.rule].name}`).join("\n"), icon: "icons/icon-192.png"});
    } catch (e) { /* trình duyệt không cho */ }
  }

  async function addSymbol(sym) {
    sym = sym.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(sym)) throw new Error("Mã không hợp lệ");
    if (await Store.get("watchlist", sym)) return {sym, existed: true};
    const info = await Finfo.lookup(sym);
    if (!info) throw new Error(`VNDirect không có mã ${sym}`);
    await Store.put("watchlist", sym, {added: Date.now()});
    await Store.put("meta", sym, {name: info.name, short: info.short, floor: info.floor});
    mirrorLite();
    return {sym, existed: false};
  }
  async function removeSymbol(sym) { await Store.deleteSymbol(sym); mirrorLite(); }

  root.Sync = {state, settings: () => settings, loadSettings, saveSettings, init, syncAll, syncSymbol, ensureItems, ensureNames, addSymbol, removeSymbol,
    on: (f) => listeners.add(f), off: (f) => listeners.delete(f), DEFAULT_APP};
})(window);
