"use strict";
// IndexedDB keeps full evidence snapshots without the small localStorage quota.
const SearchHistory = (() => {
  let opening;
  function database() {
    if (!opening) opening = new Promise((resolve,reject) => {
      const request = indexedDB.open("ai-search-history",1);
      request.onupgradeneeded = () => request.result.createObjectStore("records",{keyPath:"id"});
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("历史数据库暂时不可用"));
      request.onsuccess = () => resolve(request.result);
    });
    return opening;
  }
  async function operate(mode,action) {
    const db = await database();
    return new Promise((resolve,reject) => {
      const transaction = db.transaction("records",mode);
      const request = action(transaction.objectStore("records"));
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("历史保存失败"));
    });
  }
  function context(records,limit=6000) {
    if (!records.length) return "";
    const budget = Math.floor((limit-100)/records.length);
    return ("以下历史快照只用于理解问题，不能替代本轮重新检索的证据。\n" + records.map(record => {
      const result = record.result;
      return (`版本${record.sequence}；问题：${record.question}\n参考日期：${result.checked_as_of || "未提供"}；目标版本：${result.target_version || "未限定"}\n`
        + result.claims.map(claim => `${claim.status}：${claim.text}`).join("\n")
        + "\n来源线索：\n" + result.sources.map(source => `${source.title} ${source.url}`).join("\n")).slice(0,budget);
    }).join("\n\n")).slice(0,limit);
  }
  return {
    list: () => operate("readonly",store => store.getAll()),
    save: record => operate("readwrite",store => store.put(record)),
    remove: id => operate("readwrite",store => store.delete(id)),
    clear: () => operate("readwrite",store => store.clear()),
    context,
  };
})();
