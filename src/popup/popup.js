/* 岗位雷达 · popup 入口
 * 只做三件事：视图切换、消息封装、把各视图的 init 串起来。
 * 业务逻辑在 view-*.js 里，避免又长成一个大文件。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var current = 'profiles';
  var lastNonSettings = 'profiles';

  var elTabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var elCost = document.getElementById('costBar');
  var views = {
    profiles: document.getElementById('view-profiles'),
    library: document.getElementById('view-library'),
    settings: document.getElementById('view-settings')
  };

  /* 统一消息封装：把 lastError 和"后台没响应"都变成可捕获的 reject，
     否则失败会静默变成一个 undefined，UI 上表现为按钮点了没反应。 */
  function send(msg) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res) {
            reject(new Error('扩展后台无响应，请到 chrome://extensions 重新加载本扩展'));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function activate(name) {
    if (!views[name]) return;
    current = name;
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === name);
    });
    elTabs.forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === name);
      t.style.visibility = (name === 'settings') ? 'hidden' : 'visible';
    });
    if (name !== 'settings') lastNonSettings = name;
    if (name === 'library' && window.JR_VIEW_LIBRARY) window.JR_VIEW_LIBRARY.onShow();
    if (name === 'profiles' && window.JR_VIEW_PROFILES) window.JR_VIEW_PROFILES.onShow();
    if (name === 'settings' && window.JR_VIEW_SETTINGS) window.JR_VIEW_SETTINGS.onShow();
    refreshCost();
  }

  function money(n) {
    var v = Number(n) || 0;
    if (v <= 0) return '¥0';
    return v < 0.01 ? '¥' + v.toFixed(4) : '¥' + v.toFixed(2);
  }

  /* 费用条：单价没填时金额恒为 0，此时只显示次数——
     显示「¥0.00」会让人以为真的不花钱，比不显示更误导。 */
  function refreshCost() {
    if (!elCost) return;
    send({ type: 'STATS' }).then(function (res) {
      if (!res || !res.ok) return;
      var u = res.usageToday || {};
      var m = res.usageMonth || {};
      var warn = Number(res.budgetWarn) || 0;
      var monthCost = Number(m.cost) || 0;
      var over = warn > 0 && monthCost >= warn;

      elCost.className = 'costbar on' + (over ? ' warn' : '');
      elCost.innerHTML =
        '今日 <b>' + (u.calls || 0) + '</b> 次' +
        (monthCost > 0 || Number(u.cost) > 0 ? ' · <b>' + money(u.cost) + '</b>' : '') +
        '<span class="sp"></span>' +
        '本月 <b>' + (m.calls || 0) + '</b> 次' +
        (monthCost > 0 ? ' · <b>' + money(monthCost) + '</b>' : '') +
        (over ? ' · 已达提醒阈值 ' + money(warn) : '');
    }).catch(function () {
      // 费用条是附加信息，取不到就不显示，不打断主流程
    });
  }

  elTabs.forEach(function (t) {
    t.addEventListener('click', function () {
      activate(t.getAttribute('data-view'));
    });
  });

  document.getElementById('btnSettings').addEventListener('click', function () {
    activate('settings');
  });

  document.getElementById('stBack').addEventListener('click', function () {
    activate(lastNonSettings);
  });

  window.JR_POPUP = {
    send: send,
    activate: activate,
    refreshCost: refreshCost,
    current: function () { return current; },
    esc: function (s) { return U.escapeHtml(s); }
  };

  if (window.JR_VIEW_LIBRARY) window.JR_VIEW_LIBRARY.init();
  if (window.JR_VIEW_PROFILES) window.JR_VIEW_PROFILES.init();
  if (window.JR_VIEW_SETTINGS) window.JR_VIEW_SETTINGS.init();
  refreshCost();
})();
