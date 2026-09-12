/* Lưu trữ trong trình duyệt bằng IndexedDB — không thư viện.
 *
 * Store (khoá ngoài, out-of-line key):
 *   statements  "SYM|Q|2026-06-30" → {created, modified, mts:[...], v:{code: value}}
 *   meta        "SYM"              → {form, name, floor, lastSync, lastQ, lastA, error}
 *   items       "2" (modelType)    → [{code, name, order, level}]
 *   alerts      "SYM|Q|fd|rule"    → cảnh báo (+ seen, at)
 *   settings    "th" / "app"       → ngưỡng, tuỳ chọn
 *   watchlist   "SYM"              → {added}
 *
 * Danh mục và cài đặt được chép thêm sang localStorage (Store.mirror) để khi trình duyệt dọn
 * IndexedDB vì thiếu dung lượng thì chỉ mất số liệu (nạp lại được), không mất danh mục.
 */
(function (root) {
  "use strict";
  const DB = "bctc-radar", VER = 1;
  const STORES = ["statements", "meta", "items", "alerts", "settings", "watchlist"];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { const d = r.result; STORES.forEach((s) => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("IndexedDB bị chặn"));
    });
    return dbp;
  }
  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("transaction aborted"));
    });
  }

  const get = (store, key) => open().then((d) => req(d.transaction(store).objectStore(store).get(key)));
  const getAll = (store, range) => open().then((d) => req(d.transaction(store).objectStore(store).getAll(range || null)));
  const keys = (store, range) => open().then((d) => req(d.transaction(store).objectStore(store).getAllKeys(range || null)));
  const put = (store, key, val) => tx(store, "readwrite", (s) => { s.put(val, key); });
  const del = (store, key) => tx(store, "readwrite", (s) => { s.delete(key); });
  const clear = (store) => tx(store, "readwrite", (s) => { s.clear(); });
  const bulkPut = (store, entries) => tx(store, "readwrite", (s) => { for (const [k, v] of entries) s.put(v, k); });
  const bulkDel = (store, ks) => tx(store, "readwrite", (s) => { for (const k of ks) s.delete(k); });

  /** Khoảng khoá có tiền tố, VD prefixRange("FPT|Q|") → mọi kỳ quý của FPT. */
  const prefixRange = (p) => IDBKeyRange.bound(p, p + "￿");
  /** Trả về {fd: record} cho 1 mã + loại kỳ. */
  async function periods(sym, rt) {
    const p = `${sym}|${rt}|`;
    const d = await open();
    const s = d.transaction("statements").objectStore("statements");
    const [ks, vs] = await Promise.all([req(s.getAllKeys(prefixRange(p))), req(s.getAll(prefixRange(p)))]);
    const out = {};
    ks.forEach((k, i) => { out[k.slice(p.length)] = vs[i]; });
    return out;
  }
  async function deleteSymbol(sym) {
    const ks = await keys("statements", prefixRange(sym + "|"));
    await bulkDel("statements", ks);
    const ak = await keys("alerts", prefixRange(sym + "|"));
    await bulkDel("alerts", ak);
    await del("meta", sym);
    await del("watchlist", sym);
  }
  async function wipe() {
    for (const s of STORES) await clear(s);
    try { localStorage.removeItem("bctc.mirror"); } catch (e) { /* bỏ qua */ }
  }

  // ---- bản sao nhẹ ở localStorage ----
  function mirror(obj) { try { localStorage.setItem("bctc.mirror", JSON.stringify(obj)); } catch (e) { /* bỏ qua */ } }
  function readMirror() { try { return JSON.parse(localStorage.getItem("bctc.mirror") || "null"); } catch (e) { return null; } }

  root.Store = {open, get, getAll, keys, put, del, clear, bulkPut, bulkDel, prefixRange, periods, deleteSymbol, wipe, mirror, readMirror};
})(window);
