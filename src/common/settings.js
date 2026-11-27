/* 岗位雷达 · 设置存储
 * 只有扩展页面（service worker / popup）能读，内容脚本不加载本文件。
 * API Key 有两处落点：
 *   - keyMode = 'local'   存 chrome.storage.local，重开浏览器仍在（默认）
 *   - keyMode = 'session' 存 chrome.storage.session，浏览器关闭即失效
 * 两种模式互斥：切换时会把旧位置清空，避免"以为删了其实还在"。
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'settings';
  var SCHEMA = 1;

  var DEFAULTS = {
    schemaVersion: SCHEMA,
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxOutputTokens: 1200,
    timeoutMs: 30000,
    stream: true,
    priceInPerM: 0,
    priceOutPerM: 0,
    autoJudge: true,
    dailyLimit: 100,
    monthlyBudgetWarn: 20,
    keyMode: 'local',
    lastProfileId: '',
    promptVersion: 1,
    jsonModeSupported: true,
    disclosureAccepted: false
  };

  /* 这些字段必须落在 DEFAULTS 里，否则 get() 补不齐 */
  var NUM_RANGE = {
    temperature: [0, 2],
    maxOutputTokens: [64, 8192],
    timeoutMs: [3000, 180000],
    dailyLimit: [1, 10000],
    monthlyBudgetWarn: [0, 100000],
    priceInPerM: [0, 100000],
    priceOutPerM: [0, 100000]
  };

  function hasArea(name) {
    return !!(global.chrome && global.chrome.storage && global.chrome.storage[name]);
  }

  function area(name) {
    return global.chrome.storage[name];
  }

  function hasSession() {
    return hasArea('session');
  }

  function readArea(name, keys) {
    if (!hasArea(name)) return Promise.resolve({});
    return new Promise(function (resolve, reject) {
      try {
        area(name).get(keys, function (items) {
          if (global.chrome.runtime && global.chrome.runtime.lastError) {
            reject(new Error(global.chrome.runtime.lastError.message));
            return;
          }
          resolve(items || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function writeArea(name, obj) {
    if (!hasArea(name)) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      try {
        area(name).set(obj, function () {
          if (global.chrome.runtime && global.chrome.runtime.lastError) {
            reject(new Error(global.chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function removeArea(name, keys) {
    if (!hasArea(name)) return Promise.resolve();
    return new Promise(function (resolve) {
      area(name).remove(keys, function () {
        resolve();
      });
    });
  }

  /* 用户常把 /chat/completions 或结尾斜杠一起粘进来，这里统一裁掉 */
  function normalizeBaseURL(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/chat\/completions$/i, '');
    s = s.replace(/\/+$/, '');
    return s;
  }

  function originOf(raw) {
    var s = normalizeBaseURL(raw);
    var m = /^(https?:\/\/[^/]+)/i.exec(s);
    return m ? m[1] : '';
  }

  function clampNum(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function maskKey(k) {
    var s = String(k || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function merge(base, patch) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    return out;
  }

  /* 把散落的值收敛成合法值。任何越界都拉回区间，不抛错——
     设置页输错一个数字不该让整个扩展用不了。 */
  function normalize(s) {
    var out = merge(DEFAULTS, s);
    var k;

    out.schemaVersion = SCHEMA;
    out.baseURL = normalizeBaseURL(out.baseURL);
    out.model = String(out.model == null ? '' : out.model).trim() || DEFAULTS.model;
    out.keyMode = out.keyMode === 'session' && hasSession() ? 'session' : 'local';
    out.autoJudge = !!out.autoJudge;
    out.stream = !!out.stream;
    out.jsonModeSupported = out.jsonModeSupported !== false;
    out.disclosureAccepted = !!out.disclosureAccepted;
    out.lastProfileId = String(out.lastProfileId || '').trim();
    out.promptVersion = Number(out.promptVersion) || DEFAULTS.promptVersion;

    for (k in NUM_RANGE) {
      if (!Object.prototype.hasOwnProperty.call(NUM_RANGE, k)) continue;
      out[k] = clampNum(out[k], NUM_RANGE[k][0], NUM_RANGE[k][1], DEFAULTS[k]);
    }
    return out;
  }

  function keyOwner(settings) {
    return settings.keyMode === 'session' && hasSession() ? 'session' : 'local';
  }

  function get() {
    return readArea('local', STORE_KEY).then(function (items) {
      var s = normalize(items[STORE_KEY] || {});
      var owner = keyOwner(s);
      return readArea(owner, 'apiKey').then(function (kv) {
        s.apiKey = String((kv && kv.apiKey) || '');
        s.keyFrom = owner;
        return s;
      });
    });
  }

  function save(patch) {
    patch = patch || {};
    return get().then(function (cur) {
      var next = normalize(merge(cur, patch));
      var key = Object.prototype.hasOwnProperty.call(patch, 'apiKey')
        ? String(patch.apiKey == null ? '' : patch.apiKey)
        : cur.apiKey;

      var owner = keyOwner(next);
      var other = owner === 'local' ? 'session' : 'local';

      var stored = merge({}, next);
      delete stored.apiKey;
      delete stored.keyFrom;

      var parsed = {};
      parsed[STORE_KEY] = stored;

      return writeArea('local', parsed)
        .then(function () {
          return writeArea(owner, { apiKey: key });
        })
        .then(function () {
          /* 换过存储位置就把旧位置清掉 */
          if (cur.keyFrom && cur.keyFrom !== owner) return removeArea(other, 'apiKey');
        })
        .then(function () {
          next.apiKey = key;
          next.keyFrom = owner;
          return next;
        });
    });
  }

  function reset() {
    return Promise.all([
      writeArea('local', (function () {
        var o = {};
        o[STORE_KEY] = merge({}, DEFAULTS);
        return o;
      })()),
      removeArea('local', 'apiKey'),
      removeArea('session', 'apiKey')
    ]).then(function () {
      return get();
    });
  }

  global.JR_SETTINGS = {
    get: get,
    save: save,
    reset: reset,
    normalize: normalize,
    normalizeBaseURL: normalizeBaseURL,
    originOf: originOf,
    maskKey: maskKey,
    hasSession: hasSession,
    DEFAULTS: DEFAULTS,
    SCHEMA: SCHEMA,
    STORE_KEY: STORE_KEY
  };
})(typeof window !== 'undefined' ? window : globalThis);
