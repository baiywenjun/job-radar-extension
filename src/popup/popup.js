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
    current: function () { return current; },
    esc: function (s) { return U.escapeHtml(s); }
  };

  if (window.JR_VIEW_LIBRARY) window.JR_VIEW_LIBRARY.init();
  if (window.JR_VIEW_PROFILES) window.JR_VIEW_PROFILES.init();
  if (window.JR_VIEW_SETTINGS) window.JR_VIEW_SETTINGS.init();
})();
