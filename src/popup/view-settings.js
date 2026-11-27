/* 岗位雷达 · popup 视图：设置
 * 只做模型 API 与数据概览。判定行为（自动判定 / 每日上限）在 S2 接入判定链路时再加，
 * 避免出现"能勾但没效果"的控件。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var S = window.JR_SETTINGS;

  var inited = false;
  var busy = false;
  var el = {};

  function send(msg) {
    return window.JR_POPUP.send(msg);
  }

  function setMsg(text, tone) {
    el.msg.textContent = text || '';
    el.msg.className = 'msg' + (tone ? ' ' + tone : '');
  }

  function fill(s) {
    el.base.value = s.baseURL || '';
    el.key.value = s.apiKey || '';
    el.model.value = s.model || '';
    el.keyMode.value = s.keyMode || 'local';
    el.temp.value = s.temperature;
    el.timeout.value = s.timeoutMs;
    el.maxOut.value = s.maxOutputTokens;
    el.priceIn.value = s.priceInPerM;
    el.priceOut.value = s.priceOutPerM;

    if (!S.hasSession()) {
      var opt = el.keyMode.querySelector('option[value=session]');
      if (opt) {
        opt.disabled = true;
        opt.textContent = '仅本次会话（当前浏览器不支持）';
      }
    }
  }

  function readForm() {
    return {
      baseURL: el.base.value,
      apiKey: el.key.value,
      model: el.model.value,
      keyMode: el.keyMode.value,
      temperature: Number(el.temp.value),
      timeoutMs: Number(el.timeout.value),
      maxOutputTokens: Number(el.maxOut.value),
      priceInPerM: Number(el.priceIn.value),
      priceOutPerM: Number(el.priceOut.value)
    };
  }

  function renderStats(st) {
    if (!st) return;
    var u = st.usageToday || {};
    el.stats.innerHTML =
      cell(st.jobs || 0, '岗位记录') +
      cell(st.profiles || 0, '判定标准') +
      cell(st.verdicts || 0, '判定缓存') +
      cell(u.calls || 0, '今日调用');
  }

  function cell(n, label) {
    return '<div class="cell"><div class="n">' + n + '</div><div class="l">' + U.escapeHtml(label) + '</div></div>';
  }

  function loadStats() {
    return send({ type: 'STATS' }).then(function (res) {
      if (res.ok) renderStats(res);
    }).catch(function () { /* 统计失败不影响主流程 */ });
  }

  function load() {
    return send({ type: 'SETTINGS_GET' }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '读取设置失败');
      fill(res.settings);
      if (!res.settings.apiKey) {
        setMsg('还没有配置 API Key，当前无法调用模型', 'warn');
      }
      return loadStats();
    }).catch(function (e) {
      setMsg(e.message || String(e), 'bad');
    });
  }

  /* 域名授权：先查后请。
     必须先 contains —— DeepSeek 域名已写在 host_permissions 里，
     对已授予的权限直接 request 可能被 Chrome 判为「未在 optional 中声明」而报错。
     只有真正未授予（自定义网关）才走 request，且此时用户手势还在。 */
  function ensureOrigin(baseURL) {
    var origin = S.originOf(baseURL);
    if (!origin) {
      return Promise.resolve({ ok: false, message: 'baseURL 格式不对，应形如 https://api.deepseek.com/v1' });
    }
    if (!chrome.permissions || !chrome.permissions.contains) return Promise.resolve({ ok: true });

    var pattern = origin + '/*';
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: [pattern] }, function (has) {
        if (has) {
          resolve({ ok: true });
          return;
        }
        chrome.permissions.request({ origins: [pattern] }, function (granted) {
          var le = chrome.runtime.lastError;
          if (le) {
            resolve({ ok: false, message: le.message });
            return;
          }
          resolve(granted ? { ok: true } : { ok: false, message: '未授权访问 ' + origin + '，已取消' });
        });
      });
    });
  }

  function showOk(r) {
    el.result.innerHTML =
      '<div class="res ok">' +
      '<b>连接正常</b> · 模型 <code>' + U.escapeHtml(r.model) + '</code> · 耗时 ' + r.ms + ' ms<br>' +
      '输入 ' + (r.usage ? r.usage.in : 0) + ' tokens / 输出 ' + (r.usage ? r.usage.out : 0) + ' tokens' +
      (r.reply ? '<br>模型回复：<code>' + U.escapeHtml(r.reply) + '</code>' : '') +
      '</div>';
  }

  function showErr(res) {
    var title = res.code === 'E_AUTH' ? 'API Key 无效或权限不足'
      : res.code === 'E_NOT_FOUND' ? '模型名或 baseURL 不对'
      : res.code === 'E_NO_PERM' ? '域名未授权'
      : res.code === 'E_TIMEOUT' ? '请求超时'
      : res.code === 'E_NETWORK' ? '网络不可达'
      : res.error || '连接失败';

    el.result.innerHTML =
      '<div class="res bad">' +
      '<b>' + U.escapeHtml(title) + '</b>' +
      (res.code ? ' · <code>' + U.escapeHtml(res.code) + '</code>' : '') +
      (res.error && res.error !== title ? '<br>' + U.escapeHtml(res.error) : '') +
      (res.detail ? '<br><span style="opacity:.75">' + U.escapeHtml(res.detail) + '</span>' : '') +
      '</div>';
  }

  function onSave() {
    if (busy) return;
    busy = true;
    el.save.disabled = true;
    setMsg('保存中…');

    send({ type: 'SETTINGS_SAVE', patch: readForm() }).then(function (res) {
      busy = false;
      el.save.disabled = false;
      if (!res.ok) {
        setMsg(res.error || '保存失败', 'bad');
        return;
      }
      fill(res.settings);
      setMsg('已保存', 'ok');
      loadStats();
    }).catch(function (e) {
      busy = false;
      el.save.disabled = false;
      setMsg(e.message || '保存失败', 'bad');
    });
  }

  function onTest() {
    if (busy) return;
    var form = readForm();

    busy = true;
    el.test.disabled = true;
    setMsg('测试中…');
    el.result.innerHTML = '<div class="res">正在连接 ' + U.escapeHtml(S.originOf(form.baseURL) || '(未填 baseURL)') + ' …</div>';

    ensureOrigin(form.baseURL).then(function (g) {
      if (!g.ok) {
        var e = new Error(g.message);
        e.code = 'E_NO_PERM';
        throw e;
      }
      return send({ type: 'SETTINGS_TEST', override: form });
    }).then(function (res) {
      busy = false;
      el.test.disabled = false;
      if (!res.ok) {
        setMsg('连接失败', 'bad');
        showErr(res);
        return;
      }
      setMsg('连接正常', 'ok');
      showOk(res);
    }).catch(function (err) {
      busy = false;
      el.test.disabled = false;
      setMsg('连接失败', 'bad');
      showErr({ code: err.code || '', error: err.message || String(err) });
    });
  }

  function onClearVerdicts() {
    if (!confirm('清空所有模型判定缓存？\n\n岗位记录与判定标准不受影响，下次打开岗位会重新调用模型。')) return;
    send({ type: 'CLEAR_VERDICTS' }).then(function (res) {
      el.dataMsg.textContent = res.ok ? '已清空' : (res.error || '清空失败');
      el.dataMsg.className = 'msg ' + (res.ok ? 'ok' : 'bad');
      loadStats();
    });
  }

  function bind() {
    el.save.addEventListener('click', onSave);
    el.test.addEventListener('click', onTest);

    el.eye.addEventListener('click', function () {
      var show = el.key.type === 'password';
      el.key.type = show ? 'text' : 'password';
      el.eye.textContent = show ? '隐藏' : '显示';
    });

    document.getElementById('stClearVerdicts').addEventListener('click', onClearVerdicts);
  }

  function init() {
    if (inited) return;
    inited = true;

    el = {
      base: document.getElementById('stBase'),
      key: document.getElementById('stKey'),
      eye: document.getElementById('stEye'),
      model: document.getElementById('stModel'),
      keyMode: document.getElementById('stKeyMode'),
      temp: document.getElementById('stTemp'),
      timeout: document.getElementById('stTimeout'),
      maxOut: document.getElementById('stMaxOut'),
      priceIn: document.getElementById('stPriceIn'),
      priceOut: document.getElementById('stPriceOut'),
      save: document.getElementById('stSave'),
      test: document.getElementById('stTest'),
      msg: document.getElementById('stMsg'),
      result: document.getElementById('stResult'),
      stats: document.getElementById('stStats'),
      dataMsg: document.getElementById('stDataMsg')
    };

    bind();
  }

  function onShow() {
    load();
  }

  window.JR_VIEW_SETTINGS = {
    init: init,
    onShow: onShow,
    reload: load
  };
})();
