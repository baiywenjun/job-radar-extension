/* 岗位雷达 · 判定标准（Profile）
 * 一条标准 = 用户自己写的岗位要求。模型只按标准判断，不按"通用职业偏好"判断。
 * 设计要点：
 *   - 不做关键词自动预筛（D3 选 A），所以没有 keywords 字段；
 *     靠 settings.lastProfileId 记住上次选择，失效则回退第一条。
 *   - version 每次编辑 +1。判定结果会记下它，这样"改了标准之后结论变了"是可解释的。
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'profiles';
  var MAX_NAME = 40;
  var MIN_REQUIREMENT = 10;

  function err(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function storage() {
    return global.chrome && global.chrome.storage && global.chrome.storage.local;
  }

  function read() {
    return new Promise(function (resolve, reject) {
      var st = storage();
      if (!st) {
        reject(err('E_NO_STORAGE', '当前环境不支持 chrome.storage'));
        return;
      }
      st.get(STORE_KEY, function (items) {
        if (global.chrome.runtime && global.chrome.runtime.lastError) {
          reject(new Error(global.chrome.runtime.lastError.message));
          return;
        }
        resolve((items && items[STORE_KEY]) || []);
      });
    });
  }

  function write(list) {
    return new Promise(function (resolve, reject) {
      var o = {};
      o[STORE_KEY] = list;
      storage().set(o, function () {
        if (global.chrome.runtime && global.chrome.runtime.lastError) {
          reject(new Error(global.chrome.runtime.lastError.message));
          return;
        }
        resolve(list);
      });
    });
  }

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function cleanText(v, max) {
    var s = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  /* 稳定排序：按创建时间升序。不用 updatedAt，否则编辑一条就跳位置 */
  function sortList(list) {
    return list.slice().sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  function list() {
    return read().then(function (arr) {
      return sortList(Array.isArray(arr) ? arr : []);
    });
  }

  function get(id) {
    return list().then(function (arr) {
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
      return null;
    });
  }

  /* 校验放在写入前，返回带 code 的错误供 UI 直接展示 */
  function validate(input) {
    var name = cleanText(input.name, MAX_NAME);
    var requirement = cleanText(input.requirement);
    if (!name) throw err('E_NAME_EMPTY', '岗位名不能为空');
    if (requirement.length < MIN_REQUIREMENT) {
      throw err('E_REQ_SHORT', '岗位分析要求至少 ' + MIN_REQUIREMENT + ' 个字');
    }
    return {
      name: name,
      requirement: requirement,
      mustHave: cleanText(input.mustHave),
      redFlags: cleanText(input.redFlags)
    };
  }

  function save(input) {
    input = input || {};
    var v;
    try {
      v = validate(input);
    } catch (e) {
      return Promise.reject(e);
    }

    return list().then(function (arr) {
      var now = Date.now();
      var idx = -1;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === input.id) { idx = i; break; }
      }

      var rec;
      if (idx >= 0) {
        rec = {
          id: arr[idx].id,
          name: v.name,
          requirement: v.requirement,
          mustHave: v.mustHave,
          redFlags: v.redFlags,
          version: (arr[idx].version || 1) + 1,
          createdAt: arr[idx].createdAt || now,
          updatedAt: now
        };
        arr[idx] = rec;
      } else {
        rec = {
          id: newId(),
          name: v.name,
          requirement: v.requirement,
          mustHave: v.mustHave,
          redFlags: v.redFlags,
          version: 1,
          createdAt: now,
          updatedAt: now
        };
        arr.push(rec);
      }

      return write(sortList(arr)).then(function () {
        return rec;
      });
    });
  }

  function remove(id) {
    return list().then(function (arr) {
      var next = arr.filter(function (p) { return p.id !== id; });
      if (next.length === arr.length) return { removed: false, list: arr };
      return write(next).then(function () {
        return { removed: true, list: next };
      });
    });
  }

  function count() {
    return list().then(function (arr) { return arr.length; });
  }

  /* 当前生效标准：上次选择 → 第一条 → null。
     fellBack 为 true 表示上次选择已失效，调用方可选择回写 lastProfileId。 */
  function getActive() {
    var S = global.JR_SETTINGS;
    return Promise.all([list(), S ? S.get() : Promise.resolve({ lastProfileId: '' })])
      .then(function (r) {
        var arr = r[0];
        var lastId = (r[1] && r[1].lastProfileId) || '';
        var hit = null;
        for (var i = 0; i < arr.length; i++) if (arr[i].id === lastId) { hit = arr[i]; break; }

        var fellBack = false;
        if (!hit && arr.length) {
          hit = arr[0];
          fellBack = !!lastId;
        }
        return { profile: hit, list: arr, fellBack: fellBack, lastProfileId: lastId };
      });
  }

  global.JR_PROFILES = {
    list: list,
    get: get,
    save: save,
    remove: remove,
    count: count,
    getActive: getActive,
    validate: validate,
    STORE_KEY: STORE_KEY,
    MIN_REQUIREMENT: MIN_REQUIREMENT
  };
})(typeof window !== 'undefined' ? window : globalThis);
