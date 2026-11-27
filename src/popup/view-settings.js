/* 岗位雷达 · popup 视图：设置
 * 三块：模型 API（Key / 单价）、判定行为（自动判定 / 每日上限 / 花费提醒 / 外发确认）、
 * 我的数据（统计与清空）。判定行为的控件在 S3 接入限额链路时才允许出现——
 * 能勾但没效果的控件比没有更糟。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var S = window.JR_SETTINGS;

  var inited = false;
  var busy = false;
  var lastPayload = null;
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
    el.auto.checked = s.autoJudge !== false;
    el.daily.value = s.dailyLimit;
    el.monthWarn.value = s.monthlyBudgetWarn;

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
      priceOutPerM: Number(el.priceOut.value),
      autoJudge: el.auto.checked,
      dailyLimit: Number(el.daily.value),
      monthlyBudgetWarn: Number(el.monthWarn.value)
    };
  }

  function money(n) {
    var v = Number(n) || 0;
    if (v <= 0) return '0';
    return v < 0.01 ? v.toFixed(4) : v.toFixed(2);
  }

  function renderStats(st) {
    if (!st) return;
    var u = st.usageToday || {};
    var m = st.usageMonth || {};
    el.stats.innerHTML =
      cell(st.jobs || 0, '岗位记录') +
      cell(st.profiles || 0, '判定标准') +
      cell(st.verdicts || 0, '判定缓存',
        '按「岗位 × 标准」去重，同一岗位重判不会增加这个数。到目前共判过 ' +
        (st.logged || 0) + ' 次，轨迹在岗位库的检查器里看。') +
      cell(u.calls || 0, '今日调用') +
      cell('¥' + money(u.cost), '今日花费') +
      cell('¥' + money(m.cost), '本月花费');

    /* 超阈值只在设置页提示一次，不弹窗：提醒的目的是让人知道，
       不是打断他正在做的事。 */
    var warn = Number(st.budgetWarn) || 0;
    var cost = Number(m.cost) || 0;
    if (warn > 0 && cost >= warn) {
      setMsg('本月模型花费 ¥' + money(cost) + '，已达提醒阈值 ¥' + money(warn), 'warn');
    }
  }

  function cell(n, label, hint) {
    return '<div class="cell"' + (hint ? ' title="' + U.escapeHtml(hint) + '"' : '') +
      '><div class="n">' + n + '</div><div class="l">' + U.escapeHtml(label) + '</div></div>';
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
      if (window.JR_POPUP && window.JR_POPUP.refreshCost) window.JR_POPUP.refreshCost();
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

  /* ---------- 发给模型的内容 ----------
   * 判得不对时，第一件要排除的事是「模型看到的到底是哪几个字」。
   * 这里给的是逐字原文，不是摘要：摘要会掩盖掉真正的问题
   * （比如某行控件文案混进正文、公司名串了别的卡）。
   */
  function payloadCell(k, v) {
    return '<div class="cell"><div class="n">' + v + '</div><div class="l">' + U.escapeHtml(k) + '</div></div>';
  }

  function pickRole(messages, role) {
    var list = messages || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].role === role) return String(list[i].content || '');
    }
    return '';
  }

  function payloadText(p) {
    if (!p) return '';
    var m = p.meta || {};
    var head = [
      '=== 岗位雷达 · 发给模型的内容 ===',
      '模型：' + (p.model || ''),
      '域名：' + (p.baseOrigin || ''),
      'Key：' + (p.keyMasked || ''),
      '提示词版本：v' + (p.promptVersion || ''),
      '正文：' + (m.jdChars || 0) + ' 字' + (m.jdTruncated ? '（已截断）' : ''),
      '缓存键：' + (m.cacheKey || ''),
      ''
    ].join('\n');
    return head +
      '\n=== system ===\n' + pickRole(p.messages, 'system') +
      '\n\n=== user ===\n' + pickRole(p.messages, 'user') + '\n';
  }

  function renderPayload(p) {
    lastPayload = p || null;
    if (!p) {
      el.payloadMeta.innerHTML = '';
      el.payloadSystem.textContent = '';
      el.payloadUser.textContent = '';
      el.payloadMsg.textContent = '还没有发送过请求。打开一个岗位，或在判定标准里试跑一次，再回来查看。';
      el.payloadMsg.className = 'msg';
      return;
    }
    el.payloadMsg.textContent = '';

    var m = p.meta || {};
    var when = p.at ? U.fmtDateTime(p.at) : '';
    el.payloadMeta.innerHTML =
      payloadCell('模型', U.escapeHtml(p.model || '—')) +
      payloadCell('域名', U.escapeHtml(p.baseOrigin || '—')) +
      payloadCell('Key', U.escapeHtml(p.keyMasked || '—')) +
      payloadCell('提示词版本', 'v' + (p.promptVersion || '?')) +
      payloadCell('正文', (m.jdChars || 0) + ' 字' + (m.jdTruncated ? ' · 已截断' : '')) +
      payloadCell('来源', (p.dryRun ? '试跑' : '岗位判定') + (when ? '<br>' + U.escapeHtml(when) : ''));

    var sys = pickRole(p.messages, 'system');
    var user = pickRole(p.messages, 'user');
    el.payloadSystem.textContent = sys || '（没有 system 段）';
    el.payloadUser.textContent = user || '（没有 user 段）';
  }

  function loadPayload() {
    return send({ type: 'PAYLOAD_GET' }).then(function (res) {
      renderPayload(res.ok ? res.payload : null);
    }).catch(function () {
      renderPayload(null);
    });
  }

  function onCopyPayload() {
    if (!lastPayload) {
      el.payloadMsg.textContent = '没有可复制的内容';
      el.payloadMsg.className = 'msg bad';
      return;
    }
    var text = payloadText(lastPayload);
    function done(ok) {
      el.payloadMsg.textContent = ok ? '已复制（含 system / user 全文）' : '复制失败，请手动选中复制';
      el.payloadMsg.className = 'msg ' + (ok ? 'ok' : 'bad');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* 外发确认只在首次判定前问一次。要能重新触发，
     否则用户想改主意（比如换了网关想再确认一次发什么）就没入口了。 */
  function onResetDisclosure() {
    send({ type: 'SETTINGS_SAVE', patch: { disclosureAccepted: false } }).then(function (res) {
      el.disclosureMsg.textContent = res.ok
        ? '已重置，下次判定前会再确认一次'
        : (res.error || '重置失败');
      el.disclosureMsg.className = 'msg ' + (res.ok ? 'ok' : 'bad');
    }).catch(function (e) {
      el.disclosureMsg.textContent = e.message || '重置失败';
      el.disclosureMsg.className = 'msg bad';
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
    el.disclosureBtn.addEventListener('click', onResetDisclosure);
    el.payloadCopy.addEventListener('click', onCopyPayload);
    el.payloadRefresh.addEventListener('click', function () {
      el.payloadMsg.textContent = '刷新中…';
      loadPayload();
    });
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
      auto: document.getElementById('stAuto'),
      daily: document.getElementById('stDaily'),
      monthWarn: document.getElementById('stMonthWarn'),
      disclosureBtn: document.getElementById('stResetDisclosure'),
      disclosureMsg: document.getElementById('stDisclosureMsg'),
      save: document.getElementById('stSave'),
      test: document.getElementById('stTest'),
      msg: document.getElementById('stMsg'),
      result: document.getElementById('stResult'),
      stats: document.getElementById('stStats'),
      dataMsg: document.getElementById('stDataMsg'),
      payloadMeta: document.getElementById('stPayloadMeta'),
      payloadSystem: document.getElementById('stPayloadSystem'),
      payloadUser: document.getElementById('stPayloadUser'),
      payloadCopy: document.getElementById('stPayloadCopy'),
      payloadRefresh: document.getElementById('stPayloadRefresh'),
      payloadMsg: document.getElementById('stPayloadMsg')
    };

    bind();
  }

  function onShow() {
    load();
    /* 每次进来都重取：可能刚在岗位上判过一次，
       也可能刚在标准页试跑过——两种都会写同一份 payload。 */
    loadPayload();
  }

  window.JR_VIEW_SETTINGS = {
    init: init,
    onShow: onShow,
    reload: load
  };
})();
