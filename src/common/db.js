/* 岗位雷达 · 本地库（IndexedDB）
 * service worker 与 popup 共用。库放在扩展自身的 origin 下，
 * 内容脚本不做持久化，一律通过消息交给 service worker 写入，
 * 避免把数据写进招聘网站的 origin。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'jr-radar';
  var DB_VER = 2;
  var STORE = 'jobs';
  var VERDICTS = 'verdicts';
  var USAGE = 'usage';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('firstSeen', 'firstSeen');
          store.createIndex('lastSeen', 'lastSeen');
          store.createIndex('score', 'score');
          store.createIndex('platform', 'platform');
          store.createIndex('group', 'group');
        }

        /* v2：判定结果。复合主键（岗位 key + 标准 id），
           同一岗位在不同判定标准下各存一份，互不覆盖。 */
        if (!db.objectStoreNames.contains(VERDICTS)) {
          var vs = db.createObjectStore(VERDICTS, { keyPath: ['key', 'profileId'] });
          vs.createIndex('createdAt', 'createdAt');
        }

        /* v2：按天累计的调用量与 token，用于每日限额与成本展示 */
        if (!db.objectStoreNames.contains(USAGE)) {
          db.createObjectStore(USAGE, { keyPath: 'date' });
        }
      };
      req.onsuccess = function (e) {
        resolve(e.target.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
    return dbPromise;
  }

  /* 保存或更新：同一 key 视为同一岗位，只累加见到次数与最后时间 */
  function save(rec) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var getReq = store.get(rec.key);

        getReq.onsuccess = function () {
          var existing = getReq.result;
          var now = Date.now();
          var out;

          if (existing) {
            out = Object.assign({}, existing, rec, {
              firstSeen: existing.firstSeen,
              lastSeen: now,
              seenCount: (existing.seenCount || 1) + 1
            });
          } else {
            out = Object.assign({}, rec, {
              firstSeen: now,
              lastSeen: now,
              seenCount: 1
            });
          }

          store.put(out);
          tx.oncomplete = function () {
            resolve(out);
          };
          tx.onerror = function () {
            reject(tx.error);
          };
          tx.onabort = function () {
            reject(tx.error || new Error('transaction aborted'));
          };
        };

        getReq.onerror = function () {
          reject(getReq.error);
        };
      });
    });
  }

  function getOne(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function getAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          var list = req.result || [];
          list.sort(function (a, b) {
            return (b.lastSeen || 0) - (a.lastSeen || 0);
          });
          resolve(list);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  /* 局部更新，不涨 seenCount、不动 lastSeen。
     用途：popup 的「重新判定」把新结论写回记录——它没有真的再看到这个岗位，
     走 save() 会把「见到次数 +1」也算进去，挂牌天数与重复次数就被污染了。 */
  function update(key, patch) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var getReq = store.get(key);

        getReq.onsuccess = function () {
          var existing = getReq.result;
          if (!existing) {
            reject(new Error('记录不存在：' + key));
            return;
          }
          var out = Object.assign({}, existing, patch || {});
          out.key = key;
          out.firstSeen = existing.firstSeen;
          out.lastSeen = existing.lastSeen;
          out.seenCount = existing.seenCount;
          store.put(out);
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
        };
        getReq.onerror = function () { reject(getReq.error); };
      });
    });
  }

  function remove(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () {
          resolve(true);
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function clearAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () {
          resolve(true);
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function count() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).count();
        req.onsuccess = function () {
          resolve(req.result || 0);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  /* ---------- 以下为 v2 新增：判定结果与用量 ---------- */

  /* 统一的事务包装：fn 里只负责发请求，返回值通过 setResult 交给 resolve */
  function withStore(name, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var result;
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
        try {
          fn(tx.objectStore(name), function (v) { result = v; });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /* 判定结果：主键是 [key, profileId] 复合键 */
  function putVerdict(v) {
    return withStore(VERDICTS, 'readwrite', function (store) {
      store.put(v);
    }).then(function () { return v; });
  }

  function getVerdict(key, profileId) {
    return withStore(VERDICTS, 'readonly', function (store, set) {
      var req = store.get([key, profileId]);
      req.onsuccess = function () { set(req.result || null); };
    });
  }

  /* 同一岗位的全部判定（跨标准、跨时间），用于历史对比 */
  function listVerdicts(key) {
    return withStore(VERDICTS, 'readonly', function (store, set) {
      var req = store.getAll();
      req.onsuccess = function () {
        var list = (req.result || []).filter(function (v) { return v.key === key; });
        list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        set(list);
      };
    });
  }

  function countVerdicts() {
    return withStore(VERDICTS, 'readonly', function (store, set) {
      var req = store.count();
      req.onsuccess = function () { set(req.result || 0); };
    });
  }

  /* 全量判定结果，供导出与检查器按 key 关联。
     量级是「岗位数 × 标准数」，个人使用不会大到需要分页。 */
  function listAllVerdicts() {
    return withStore(VERDICTS, 'readonly', function (store, set) {
      var req = store.getAll();
      req.onsuccess = function () {
        var list = req.result || [];
        list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        set(list);
      };
    });
  }

  function clearVerdicts() {
    return withStore(VERDICTS, 'readwrite', function (store, set) {
      store.clear();
      set(true);
    });
  }

  var EMPTY_USAGE = { calls: 0, inTokens: 0, outTokens: 0, cost: 0 };

  /* 当日用量累加。读改写放在同一个 readwrite 事务里，避免并发覆盖。 */
  function bumpUsage(date, delta) {
    delta = delta || {};
    return withStore(USAGE, 'readwrite', function (store, set) {
      var getReq = store.get(date);
      getReq.onsuccess = function () {
        var cur = getReq.result || { date: date };
        var next = {
          date: date,
          calls: (cur.calls || 0) + (Number(delta.calls) || 0),
          inTokens: (cur.inTokens || 0) + (Number(delta.inTokens) || 0),
          outTokens: (cur.outTokens || 0) + (Number(delta.outTokens) || 0),
          cost: (cur.cost || 0) + (Number(delta.cost) || 0),
          updatedAt: Date.now()
        };
        store.put(next);
        set(next);
      };
    });
  }

  function getUsage(date) {
    return withStore(USAGE, 'readonly', function (store, set) {
      var req = store.get(date);
      req.onsuccess = function () {
        var r = req.result;
        set(r || { date: date, calls: 0, inTokens: 0, outTokens: 0, cost: 0 });
      };
    });
  }

  /* prefix 形如 '2026-11'，用于月度成本统计 */
  function listUsage(prefix) {
    return withStore(USAGE, 'readonly', function (store, set) {
      var req = store.getAll();
      req.onsuccess = function () {
        var list = (req.result || []).filter(function (u) {
          return !prefix || String(u.date || '').indexOf(prefix) === 0;
        });
        list.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        set(list);
      };
    });
  }

  function clearUsage() {
    return withStore(USAGE, 'readwrite', function (store, set) {
      store.clear();
      set(true);
    });
  }

  global.JR_DB = {
    open: open,
    save: save,
    getOne: getOne,
    getAll: getAll,
    update: update,
    remove: remove,
    clearAll: clearAll,
    count: count,
    putVerdict: putVerdict,
    getVerdict: getVerdict,
    listVerdicts: listVerdicts,
    listAllVerdicts: listAllVerdicts,
    countVerdicts: countVerdicts,
    clearVerdicts: clearVerdicts,
    bumpUsage: bumpUsage,
    getUsage: getUsage,
    listUsage: listUsage,
    clearUsage: clearUsage,
    DB_NAME: DB_NAME,
    DB_VER: DB_VER,
    STORE: STORE,
    VERDICTS: VERDICTS,
    USAGE: USAGE,
    EMPTY_USAGE: EMPTY_USAGE
  };
})(typeof window !== 'undefined' ? window : globalThis);
