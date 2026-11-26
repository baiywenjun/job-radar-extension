/* 岗位雷达 · 本地库（IndexedDB）
 * service worker 与 popup 共用。库放在扩展自身的 origin 下，
 * 内容脚本不做持久化，一律通过消息交给 service worker 写入，
 * 避免把数据写进招聘网站的 origin。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'jr-radar';
  var DB_VER = 1;
  var STORE = 'jobs';
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

  global.JR_DB = {
    open: open,
    save: save,
    getOne: getOne,
    getAll: getAll,
    remove: remove,
    clearAll: clearAll,
    count: count,
    DB_NAME: DB_NAME,
    STORE: STORE
  };
})(typeof window !== 'undefined' ? window : globalThis);
