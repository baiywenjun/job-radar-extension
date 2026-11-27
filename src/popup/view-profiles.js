/* 岗位雷达 · popup 视图：判定标准
 * 左列表 + 右编辑器。编辑态改动未保存时切走会提示，避免"改一半丢了但版本号没动"。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;

  var profiles = [];
  var activeId = '';
  var editingId = null;   // null = 新建
  var dirty = false;
  var busy = false;
  var inited = false;

  var dryPort = null;
  var dryBusy = false;
  var dryResult = null;   // 最近一次试跑结论，切来切去时能原样还原

  var el = {};

  function send(msg) {
    return window.JR_POPUP.send(msg);
  }

  function pick(id) {
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i];
    return null;
  }

  function setMsg(text, tone) {
    el.msg.textContent = text || '';
    el.msg.className = 'msg' + (tone ? ' ' + tone : '');
  }

  function renderList() {
    if (!profiles.length) {
      el.items.innerHTML = '';
      el.listHint.textContent = '还没有标准。点「新建」写第一条。';
      return;
    }
    el.items.innerHTML = profiles.map(function (p) {
      var on = p.id === activeId;
      var cls = 'pf-item' + (p.id === editingId ? ' active' : '');
      return '<div class="' + cls + '" data-id="' + U.escapeHtml(p.id) + '">' +
        '<div class="pf-item-name">' + U.escapeHtml(p.name) + '</div>' +
        '<div class="pf-item-meta">v' + (p.version || 1) +
        (on ? ' · <span class="on">当前生效</span>' : '') + '</div>' +
        '</div>';
    }).join('');
    el.listHint.textContent = profiles.length + ' 条标准';
  }

  function showEmpty() {
    el.empty.style.display = 'block';
    el.form.style.display = 'none';
    el.dry.style.display = 'none';
    el.items.innerHTML = '';
    el.listHint.textContent = '还没有标准。点「新建」写第一条。';
  }

  function fillForm(p) {
    el.empty.style.display = 'none';
    el.form.style.display = 'block';
    /* 试跑区跟着表单走：没有标准就没有可比对的对象。
       已保存过标准时把上一次的试跑结果还原出来，避免切一下列表就要重跑。 */
    el.dry.style.display = 'block';
    if (dryResult) renderDry(dryResult);
    el.name.value = p ? p.name : '';
    el.req.value = p ? p.requirement : '';
    el.must.value = p ? (p.mustHave || '') : '';
    el.red.value = p ? (p.redFlags || '') : '';
    el.title.textContent = p ? '编辑标准' : '新建标准';
    el.ver.textContent = p ? 'v' + (p.version || 1) : '未保存';
    el.del.style.display = p ? 'inline-block' : 'none';
    dirty = false;
    setMsg('');
  }

  function select(id, checkDirty) {
    if (checkDirty !== false && dirty && !busy) {
      if (!confirm('当前修改还没保存，确定切走？')) return;
    }
    if (!id) {
      editingId = null;
      renderList();
      fillForm(null);
      el.name.focus();
      return;
    }
    var p = pick(id);
    if (!p) return;
    editingId = p.id;
    renderList();
    fillForm(p);
  }

  function load(keepEditing) {
    return send({ type: 'PROFILE_ACTIVE' }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '读取标准失败');
      profiles = res.list || [];
      activeId = res.profile ? res.profile.id : '';

      if (!profiles.length) {
        editingId = null;
        showEmpty();
        return;
      }

      var want = keepEditing && editingId ? editingId : (activeId || profiles[0].id);
      if (!pick(want)) want = profiles[0].id;
      editingId = want;
      renderList();
      fillForm(pick(want));
    }).catch(function (e) {
      setMsg(e.message || String(e), 'bad');
      el.empty.style.display = 'block';
      el.empty.innerHTML = '<b>读取判定标准失败</b>' + U.escapeHtml(e.message || '');
    });
  }

  function readForm() {
    return {
      id: editingId || undefined,
      name: el.name.value,
      requirement: el.req.value,
      mustHave: el.must.value,
      redFlags: el.red.value
    };
  }

  function onSave(e) {
    e.preventDefault();
    if (busy) return;

    var payload = readForm();
    busy = true;
    el.save.disabled = true;
    setMsg('保存中…');

    send({ type: 'PROFILES_SAVE', profile: payload }).then(function (res) {
      busy = false;
      el.save.disabled = false;
      if (!res.ok) {
        setMsg(res.error || '保存失败', 'bad');
        return;
      }
      editingId = res.record.id;
      dirty = false;
      return load(true).then(function () {
        /* load 里的 fillForm 会清空提示，所以成功文案要放在它之后 */
        setMsg('已保存（v' + res.record.version + '），下次判定生效', 'ok');
      });
    }).catch(function (err) {
      busy = false;
      el.save.disabled = false;
      setMsg(err.message || '保存失败', 'bad');
    });
  }

  function onDelete() {
    if (!editingId || busy) return;
    var p = pick(editingId);
    if (!p) return;
    if (!confirm('删除判定标准「' + p.name + '」？\n\n已产生的判定结果会保留，但无法再用这条标准重跑。')) return;

    busy = true;
    send({ type: 'PROFILES_DELETE', id: editingId }).then(function (res) {
      busy = false;
      if (!res.ok) {
        setMsg(res.error || '删除失败', 'bad');
        return;
      }
      editingId = null;
      dirty = false;
      return load(false);
    }).catch(function (err) {
      busy = false;
      setMsg(err.message || '删除失败', 'bad');
    });
  }

  function markDirty() {
    dirty = true;
    setMsg('有未保存的修改', 'warn');
  }

  /* ---------- 试跑 ----------
   * 目的只有一个：改提示词不用去网站上碰运气。
   * 因此它必须满足两条：
   *   1. 用的是屏幕上这份标准（含未保存改动），不是库里那份
   *   2. 不写库、不计费、不读缓存——否则「改一版 → 试跑 → 对比」会被旧结论污染
   */
  function esc(s) {
    return U.escapeHtml(s == null ? '' : String(s));
  }

  function setDryMsg(text, tone) {
    el.dryMsg.textContent = text || '';
    el.dryMsg.className = 'msg' + (tone ? ' ' + tone : '');
  }

  function fmtTokens(n) {
    var v = Number(n) || 0;
    return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
  }

  function fmtCost(c) {
    var v = Number(c) || 0;
    if (!v) return '';
    return '¥' + (v < 0.01 ? v.toFixed(4) : v.toFixed(3));
  }

  function dryProfile() {
    var f = readForm();
    var saved = editingId ? pick(editingId) : null;
    return {
      id: f.id || '',
      name: f.name,
      requirement: f.requirement,
      mustHave: f.mustHave,
      redFlags: f.redFlags,
      version: saved ? (saved.version || 0) : 0
    };
  }

  function dryFinish() {
    dryBusy = false;
    el.dryRun.disabled = false;
    el.dryRun.textContent = '开始试跑';
    dryPort = null;
  }

  function dryStop() {
    var p = dryPort;
    dryPort = null;
    if (p) {
      try { p.disconnect(); } catch (e) { /* 已断开 */ }
    }
  }

  function renderDry(v) {
    dryResult = v;
    var R = window.JR_RULES || {};
    var info = (R.GRADE_INFO && R.GRADE_INFO[v.grade]) || { label: v.grade || '—' };
    var u = v.usage || {};

    var meta = [];
    if (v.model) meta.push(esc(v.model));
    if (u.total) meta.push(fmtTokens(u.total) + ' tokens');
    if (v.ms) meta.push((v.ms / 1000).toFixed(1) + 's');
    if (v.cost) meta.push(fmtCost(v.cost));
    meta.push(v.profileVersion ? '标准 v' + v.profileVersion : '标准未保存');
    meta.push('试跑 · 不写库');

    var evHtml = '';
    if (v.evidence && v.evidence.length) {
      evHtml = '<div class="dry-ev">' + v.evidence.map(function (e) {
        var type = e.type || 'must';
        var label = type === 'red' ? '减分' : (type === 'nice' ? '加分' : '要求');
        var cls = type + (e.verified === false ? ' unv' : '');
        return '<div class="row ' + cls + '"><span class="tag">' + label + '</span>' + esc(e.claim) +
          (e.quote ? ' <span class="q">「' + esc(e.quote) + '」</span>' : '') +
          (e.verified === false
            ? ' <span class="q">（' + (e.noQuote ? '没附原文，无法核对' : '原文里找不到这句，未能核实') + '）</span>'
            : '') +
          '</div>';
      }).join('') + '</div>';
    }

    var warn = '';
    if (v.evidenceFlag === 'E_BAD_EVIDENCE') {
      warn = '<div class="dry-warn">过半证据的引用在正文里找不到，置信度已打折。' +
        '这条结论的档位可以看，但别按它做决定。</div>';
    }

    var missing = (v.missing && v.missing.length)
      ? '<div class="dry-line"><b>标准要求但原文没提</b>：' + v.missing.map(esc).join('、') + '</div>' : '';
    var risks = (v.risks && v.risks.length)
      ? '<div class="dry-line"><b>风险</b>：' + v.risks.map(esc).join('、') + '</div>' : '';

    el.dryResult.innerHTML =
      '<div class="dry-card">' +
        '<div class="dry-top">' +
          '<span class="dry-grade ' + esc(v.grade || '') + '">' + esc(info.label) + '</span>' +
          '<span class="dry-score">' + (v.score == null ? '—' : v.score) + '</span>' +
          '<span class="dry-meta">' + meta.join(' · ') + '</span>' +
        '</div>' +
        '<div class="dry-one">' + esc(v.oneLine || '（模型没给一句话结论）') + '</div>' +
        evHtml +
        missing +
        risks +
        warn +
      '</div>';
    el.dryClear.style.display = 'inline-block';
  }

  function renderDryFail(msg) {
    var why = String((msg && (msg.error || msg.code)) || '未知错误');
    var extra = '';
    if (msg && msg.code === 'E_LIMIT_DAY') {
      extra = '<div class="insp-note">试跑本不该被限额拦住——若看到这条，说明后台的放行逻辑没生效，请反馈。</div>';
    }
    el.dryResult.innerHTML =
      '<div class="dry-card"><div class="res bad">试跑失败：' + esc(why) + '</div>' + extra + '</div>';
  }

  function onDryRun() {
    if (dryBusy) {
      dryStop();
      dryFinish();
      setDryMsg('已取消');
      return;
    }

    var jd = String(el.dryJd.value || '').trim();
    if (jd.length < 60) {
      setDryMsg(jd ? '正文只有 ' + jd.length + ' 字，结论多半是「信息不足」' : '先把岗位正文粘进来', 'warn');
      if (!jd) return;
    }

    var override = dryProfile();
    /* 标准是空的就别花钱了：没有要求，模型只能按自己的偏好瞎猜，
       而这种结论最容易被误当成「标准写得不错」。 */
    if (!String(override.requirement || '').trim() && !String(override.mustHave || '').trim()) {
      setDryMsg('先在「岗位分析要求」里写点内容，模型才有判断依据', 'warn');
      return;
    }

    if (!window.chrome || !chrome.runtime || !chrome.runtime.connect) {
      setDryMsg('当前环境不支持试跑', 'bad');
      return;
    }

    var port;
    try {
      port = chrome.runtime.connect({ name: 'jr-judge' });
    } catch (e) {
      setDryMsg('无法连接后台：' + (e.message || e), 'bad');
      return;
    }

    dryPort = port;
    dryBusy = true;
    el.dryRun.textContent = '取消';
    el.dryResult.innerHTML = '';
    el.dryClear.style.display = 'none';
    setDryMsg('正在请求模型…');

    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'DELTA') {
        setDryMsg('模型输出中… 已收 ' + (msg.chars || 0) + ' 字');
        return;
      }
      if (msg.type === 'DONE') {
        dryFinish();
        setDryMsg('');
        renderDry(msg.verdict || {});
        return;
      }
      if (msg.type === 'FAIL') {
        dryFinish();
        setDryMsg(msg.error || msg.code || '试跑失败', 'bad');
        renderDryFail(msg);
      }
    });

    port.onDisconnect.addListener(function () {
      if (!dryBusy || dryPort !== port) return;
      /* 后台被 MV3 回收，或连接异常断掉：必须复位，否则按钮永远停在「取消」 */
      dryFinish();
      setDryMsg('连接中断（后台可能已休眠），请重试', 'bad');
    });

    port.postMessage({
      type: 'START',
      dryRun: true,
      jdText: jd,
      fields: {},
      sources: {},
      jobKey: '',
      profileId: editingId || '',
      profileOverride: override
    });
  }

  function onDryClear() {
    dryResult = null;
    el.dryResult.innerHTML = '';
    el.dryClear.style.display = 'none';
    setDryMsg('');
  }

  function bind() {
    el.items.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('.pf-item') : null;
      if (!node) return;
      var id = node.getAttribute('data-id');
      if (id && id !== editingId) select(id, true);
    });

    el.newBtn.addEventListener('click', function () { select(null, true); });
    el.form.addEventListener('submit', onSave);
    el.del.addEventListener('click', onDelete);

    el.dryRun.addEventListener('click', onDryRun);
    el.dryClear.addEventListener('click', onDryClear);

    [el.name, el.req, el.must, el.red].forEach(function (node) {
      node.addEventListener('input', markDirty);
    });
  }

  function init() {
    if (inited) return;
    inited = true;

    el = {
      items: document.getElementById('pfItems'),
      listHint: document.getElementById('pfListHint'),
      empty: document.getElementById('pfEmpty'),
      form: document.getElementById('pfForm'),
      title: document.getElementById('pfTitle'),
      ver: document.getElementById('pfVer'),
      name: document.getElementById('pfName'),
      req: document.getElementById('pfReq'),
      must: document.getElementById('pfMust'),
      red: document.getElementById('pfRed'),
      save: document.getElementById('pfSave'),
      del: document.getElementById('pfDelete'),
      msg: document.getElementById('pfMsg'),
      newBtn: document.getElementById('pfNew'),
      dry: document.getElementById('pfDry'),
      dryJd: document.getElementById('pfDryJd'),
      dryRun: document.getElementById('pfDryRun'),
      dryClear: document.getElementById('pfDryClear'),
      dryMsg: document.getElementById('pfDryMsg'),
      dryResult: document.getElementById('pfDryResult')
    };

    bind();
    load(false);
  }

  function onShow() {
    if (!profiles.length) load(false);
  }

  window.JR_VIEW_PROFILES = {
    init: init,
    onShow: onShow,
    reload: function () { return load(true); }
  };
})();
