/* 岗位雷达 · 侧栏面板（Shadow DOM 隔离，不受站点样式影响） */
(function (global) {
  'use strict';

  var U = global.JR_UTIL;

  var HOST_ID = 'jr-radar-host';

  var CSS = `
:host{all:initial}
*{box-sizing:border-box}
.jr-panel{
  --ink:#38291e;--ink2:#68503b;--ink3:#8b755f;--line:#f1dac1;--soft:#faecdc;
  --good:#1c7a4c;--goodbg:#eaf6ee;--goodline:#c6e6d2;
  --bad:#a3362f;--badbg:#fcecea;--badline:#f0cdc8;
  --accent:#e86b0a;--accentbg:#fff0df;--accentline:#ffc88c;
  --warn:#8a5a12;--warnbg:#fdf3e2;--warnline:#eeddb8;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-size:13px;line-height:1.55;color:var(--ink);
  width:344px;max-height:calc(100vh - 96px);
  display:flex;flex-direction:column;
  background:#fff;border:1px solid #edb36f;border-top:4px solid var(--accent);border-radius:12px;
  box-shadow:0 8px 32px rgba(112,55,9,.18),0 2px 6px rgba(112,55,9,.08);
  overflow:hidden;
}
.jr-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:linear-gradient(90deg,#fff2e3,#fffaf5);border-bottom:1px solid var(--line);flex:0 0 auto}
.jr-brand{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13px;letter-spacing:.2px;color:#ab4600;white-space:nowrap}
.jr-version{font-size:10px;font-weight:700;letter-spacing:0;color:#a34400;background:#ffe2bd;border:1px solid #f9b56d;border-radius:999px;padding:1px 6px}
.jr-busy{font-size:10.5px;color:var(--accent);background:var(--accentbg);border:1px solid var(--accentline);
  padding:1px 6px;border-radius:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px}
.jr-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accentbg)}
.jr-head .jr-spacer{flex:1}
.jr-icon{border:1px solid var(--line);background:#fff;color:var(--ink3);width:24px;height:24px;
  border-radius:6px;cursor:pointer;font-size:13px;line-height:1;display:grid;place-items:center;padding:0}
.jr-icon:hover{border-color:var(--accent);color:var(--accent)}
.jr-body{overflow-y:auto;padding:13px;flex:1 1 auto;background:#fffdfb}
.jr-body::-webkit-scrollbar{width:7px}
.jr-body::-webkit-scrollbar-thumb{background:#edc79f;border-radius:4px}

.jr-score{display:flex;align-items:center;gap:13px;margin-bottom:11px}
.jr-ring{position:relative;width:64px;height:64px;border-radius:50%;flex:0 0 64px;
  background:conic-gradient(var(--c) calc(var(--p)*1%),#f6e7d6 0);display:grid;place-items:center}
.jr-ring::before{content:"";position:absolute;inset:6px;background:#fff;border-radius:50%}
.jr-ring b{position:relative;font-size:19px;font-weight:700;color:var(--c);font-variant-numeric:tabular-nums}
.jr-grade{font-size:15px;font-weight:700;margin-bottom:2px}
.jr-gdesc{font-size:11.5px;color:var(--ink3);line-height:1.45}

.jr-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}
.jr-tag{font-size:11px;padding:2px 7px;border-radius:5px;border:1px solid var(--line);
  background:#fff8ef;color:var(--ink2);white-space:nowrap}
.jr-tag.g{background:var(--goodbg);border-color:var(--goodline);color:var(--good)}
.jr-tag.b{background:var(--badbg);border-color:var(--badline);color:var(--bad)}
.jr-tag.w{background:var(--warnbg);border-color:var(--warnline);color:var(--warn)}
.jr-tag.n{background:var(--accentbg);border-color:var(--accentline);color:var(--accent)}

.jr-fields{border:1px solid var(--soft);border-radius:8px;overflow:hidden;margin-bottom:12px}
.jr-f{display:flex;gap:8px;padding:6px 9px;border-bottom:1px solid var(--soft);align-items:baseline}
.jr-f:nth-child(even){background:#fffaf4}
.jr-f:last-child{border-bottom:none}
.jr-f .k{flex:0 0 46px;color:var(--ink3);font-size:11px}
.jr-f .v{flex:1;min-width:0;font-size:12px;word-break:break-word}
.jr-f .s{flex:0 0 auto;font-size:10px;color:#9aa5b6;border:1px solid var(--soft);
  padding:0 4px;border-radius:3px;white-space:nowrap}
.jr-f .s.miss{color:var(--bad);border-color:var(--badline);background:var(--badbg)}
.jr-f .v.miss{color:#aab3c2}

.jr-sec{margin-bottom:11px}
.jr-sec h4{margin:0 0 5px;font-size:11.5px;color:var(--ink3);font-weight:600;letter-spacing:.2px}
.jr-chips{display:flex;flex-wrap:wrap;gap:4px}
.jr-chip{font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--line);
  background:#fff8ef;color:var(--ink2);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jr-chip.g{background:var(--goodbg);border-color:var(--goodline);color:var(--good)}
.jr-chip.n{background:var(--accentbg);border-color:var(--accentline);color:var(--accent)}
.jr-chip.b{background:var(--badbg);border-color:var(--badline);color:var(--bad)}
.jr-empty{font-size:11.5px;color:#aab3c2}

.jr-note{font-size:11px;color:var(--ink3);background:#fff8ef;border:1px solid var(--soft);
  border-radius:6px;padding:7px 9px;margin-bottom:11px;line-height:1.5}
.jr-note b{color:var(--ink2)}
.jr-note.warn{background:var(--warnbg);border-color:var(--warnline);color:var(--warn)}
.jr-note.bad{background:var(--badbg);border-color:var(--badline);color:var(--bad)}

.jr-foot{display:flex;gap:7px;padding:11px 13px;border-top:1px solid var(--soft);background:#fff6eb;flex:0 0 auto}
.jr-btn{flex:1;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:#fff;
  color:var(--ink2);font-size:12.5px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:.12s}
.jr-btn:hover{border-color:var(--accent);color:var(--accent)}
.jr-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.jr-btn.primary:hover{background:#bb5200;color:#fff}
.jr-btn:disabled{opacity:.65;cursor:default}
.jr-btn.done{background:var(--goodbg);border-color:var(--goodline);color:var(--good);font-weight:600}
.jr-mini{font-size:11px;color:var(--ink3);padding:0 13px 10px;background:#fff6eb}

.jr-panel.collapsed{max-height:none}
.jr-panel.collapsed .jr-body,.jr-panel.collapsed .jr-foot,.jr-panel.collapsed .jr-mini{display:none}
`;

  var host = null;
  var shadow = null;
  var root = null;
  var collapsed = false;
  var lastData = null;
  var handlers = {};
  var bound = false;
  var busyText = '';
  var noticeKey = '';   // 提示内容指纹：内容未变则不重绘，避免 DOM 监听抖动导致闪烁

  function mount() {
    if (host && document.documentElement.contains(host)) return;
    // 宿主可能被页面 SPA 整体重绘移除。重建后 shadow 是新对象，
    // 必须重新绑定事件，否则所有按钮点击都会失效。
    if (host) bound = false;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all:initial;position:fixed;top:88px;right:16px;z-index:2147483600;pointer-events:auto;display:none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    root = document.createElement('div');
    shadow.appendChild(root);
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  function show(data, h) {
    mount();
    handlers = h || handlers;
    lastData = data;
    busyText = '';
    noticeKey = '';
    host.style.display = 'block';
    render();
  }

  /* 切换岗位时的等待态：保留旧面板内容、只加一个小标签。
     SPA 详情替换存在「旧详情已清空、新详情未到」的空窗，
     此时隐藏面板会让用户以为插件失效。 */
  function setBusy(text) {
    busyText = text || '';
    if (!lastData) return;
    render();
  }

  /* 非岗位面板的两种状态：
     - tone = 'bad'：已展开详情但字段全部抽不到，多半是站点改版，需要诊断信息；
     - tone = 'info'：列表页 / 未选中岗位，属正常状态，只做轻提示，不摆出报错语气。
     内容未变时直接返回：列表页的 DOM 抖动很频繁，反复重绘会闪烁且清掉用户的折叠状态。 */
  function notice(title, lines, opts) {
    mount();
    opts = opts || {};
    if (opts.handlers) handlers = opts.handlers;
    var tone = opts.tone === 'info' ? 'info' : 'bad';
    var key = tone + '|' + title + '|' + (lines || []).join('|') + '|' + (opts.foot || '');
    if (key === noticeKey && lastData === null && host.style.display === 'block') return;
    noticeKey = key;

    host.style.display = 'block';
    lastData = null;
    busyText = '';
    var body = (lines || []).map(function (l) {
      return '<div class="jr-f"><span class="v">' + esc(l) + '</span></div>';
    }).join('');
    var head = tone === 'bad'
      ? '<div class="jr-note bad"><b>' + esc(title) + '</b></div>'
      : '<div class="jr-note"><b>' + esc(title) + '</b></div>';
    var foot = opts.foot
      ? '<div class="jr-note">' + esc(opts.foot) + '</div>'
      : '';

    /* 站点会拦截 F12，用户拿不到 class。所以把诊断做成一个按钮：
       点一下就把「插件看到了什么」复制到剪贴板，直接粘给维护者即可。 */
    var acts = tone === 'bad'
      ? '<button class="jr-btn primary" data-act="diag">复制诊断信息</button>' +
        '<button class="jr-btn" data-act="re-extract">重新抽取</button>'
      : '<button class="jr-btn" data-act="re-extract">重新抽取</button>' +
        '<button class="jr-btn" data-act="diag">复制诊断</button>';

    root.innerHTML =
      '<div class="jr-panel">' +
      '<div class="jr-head">' +
      '<div class="jr-brand"><span class="jr-dot"></span>岗位雷达<span class="jr-version">白橙版 v0.1.5</span></div>' +
      '<div class="jr-spacer"></div>' +
      '<button class="jr-icon" data-act="re-extract" title="重新抽取">↻</button>' +
      '<button class="jr-icon" data-act="dismiss" title="关闭">×</button>' +
      '</div>' +
      '<div class="jr-body">' +
      head +
      '<div class="jr-sec"><h4>' + (tone === 'bad' ? '诊断信息' : '当前状态') +
      '</h4><div class="jr-fields">' + body + '</div></div>' +
      foot +
      '</div>' +
      '<div class="jr-foot">' + acts + '</div>' +
      '</div>';
  }

  function gradeColor(grade) {
    switch (grade) {
      case 'strong': return '#1c7a4c';
      case 'neutral': return '#e86b0a';
      case 'weak': return '#8a5a12';
      case 'poor': return '#a3362f';
      default: return '#77839a';
    }
  }

  function esc(s) {
    return U.escapeHtml(s);
  }

  function fieldRow(label, value, source, mono) {
    var miss = !value;
    var srcBadge = source
      ? '<span class="s' + (source === '未取到' ? ' miss' : '') + '">' + esc(source) + '</span>'
      : '';
    return (
      '<div class="jr-f">' +
      '<span class="k">' + esc(label) + '</span>' +
      '<span class="v' + (miss ? ' miss' : '') + '">' + (miss ? '未取到' : esc(value)) + '</span>' +
      srcBadge +
      '</div>'
    );
  }

  function render() {
    if (!lastData) return;
    var d = lastData;
    var f = d.fields;
    var ev = d.ev;
    var src = f.sources || {};
    var color = gradeColor(ev.grade);

    var tags = [];

    tags.push('<span class="jr-tag n">' + esc(ev.groupShort || '未归类') + '</span>');
    if (ev.flags.indexOf('outsourcing') >= 0) tags.push('<span class="jr-tag b">外包 / 派遣</span>');
    if (ev.flags.indexOf('training') >= 0) tags.push('<span class="jr-tag b">培训招生</span>');
    if (ev.flags.indexOf('shrinking') >= 0) tags.push('<span class="jr-tag b">收缩岗位</span>');
    if (ev.flags.indexOf('salaryMismatch') >= 0) tags.push('<span class="jr-tag w">薪资倒挂</span>');
    if (ev.flags.indexOf('modelPile') >= 0) tags.push('<span class="jr-tag w">模型名堆砌</span>');
    if (ev.flags.indexOf('participateOnly') >= 0) tags.push('<span class="jr-tag w">职责模糊</span>');
    if (d.staleDays >= 30) tags.push('<span class="jr-tag w">已挂牌 ' + d.staleDays + ' 天</span>');

    var strongChips = ev.strong.length
      ? ev.strong.map(function (x) { return '<span class="jr-chip g">' + esc(x.term) + '</span>'; }).join('')
      : '<span class="jr-empty">未命中具体技术栈词</span>';

    var actionChips = ''
      .concat(ev.actions.length ? ev.actions.map(function (x) { return '<span class="jr-chip n">' + esc(x.term) + '</span>'; }).join('') : '')
      .concat(ev.metrics.length ? ev.metrics.map(function (x) { return '<span class="jr-chip n">' + esc(x.term) + '</span>'; }).join('') : '');
    if (!actionChips) actionChips = '<span class="jr-empty">未命中建设动作或工程指标</span>';

    var weakChips = ev.weak.length
      ? ev.weak.map(function (x) {
          return '<span class="jr-chip b" title="' + esc(x.note || '') + '">' + esc(x.term) + ' ' + x.w + '</span>';
        }).join('')
      : '<span class="jr-empty">无减分项</span>';

    if (ev.excludes.length) {
      weakChips += ev.excludes.map(function (x) {
        return '<span class="jr-chip b">' + esc(x.term) + '（排除词）</span>';
      }).join('');
    }

    var notes = '';
    if (ev.grade === 'insufficient') {
      notes += '<div class="jr-note warn"><b>JD 仅 ' + ev.jdLength + ' 字</b>，抽取可能失败或岗位描述过短。证据不足不下结论，请确认页面是否加载完整，或点「重新抽取」。</div>';
    }
    if (ev.grade === 'irrelevant') {
      notes += '<div class="jr-note"><b>未命中任何目标族群词。</b>这可能是别类岗位（如通用后端、销售），本工具只对五类热门/紧缺岗位打分。</div>';
    }
    if (d.staleDays >= 30) {
      notes += '<div class="jr-note warn"><b>已连续挂牌 ' + d.staleDays + ' 天。</b>可能是高流动岗位持续招聘，也可能是僵尸岗；本项不扣分，仅供参考。</div>';
    }

    var savedLabel = d.saved
      ? '更新记录 · 第 ' + d.seenCount + ' 次'
      : '保存到本地库';

    root.innerHTML =
      '<div class="jr-panel' + (collapsed ? ' collapsed' : '') + '">' +
      '<div class="jr-head">' +
      '<div class="jr-brand"><span class="jr-dot"></span>岗位雷达<span class="jr-version">白橙版 v0.1.5</span></div>' +
      (busyText ? '<span class="jr-busy">' + esc(busyText) + '</span>' : '') +
      '<div class="jr-spacer"></div>' +
      '<button class="jr-icon" data-act="re-extract" title="重新抽取">↻</button>' +
      '<button class="jr-icon" data-act="toggle" title="折叠 / 展开">' + (collapsed ? '＋' : '－') + '</button>' +
      '</div>' +
      '<div class="jr-body">' +
      '<div class="jr-score">' +
      '<div class="jr-ring" style="--p:' + ev.score + ';--c:' + color + '"><b>' + ev.score + '</b></div>' +
      '<div><div class="jr-grade" style="color:' + color + '">' + esc(ev.gradeLabel) + '</div>' +
      '<div class="jr-gdesc">' + esc(ev.gradeDesc) + '</div></div>' +
      '</div>' +
      '<div class="jr-tags">' + tags.join('') + '</div>' +
      '<div class="jr-fields">' +
      fieldRow('职位', f.jobTitle, src.jobTitle) +
      fieldRow('公司', f.company, src.company) +
      fieldRow('薪资', f.salaryText, src.salary) +
      fieldRow('城市', f.city, src.city) +
      fieldRow('经验', f.experienceText,
        f.experienceText ? (src.experience && src.experience !== '未取到' ? src.experience : '页面') : '未取到') +
      fieldRow('活跃', f.activeText, f.activeText ? '页面' : '未取到') +
      '</div>' +
      notes +
      '<div class="jr-sec"><h4>强信号 · 有预算的建设项目（' + ev.strong.length + '）</h4><div class="jr-chips">' + strongChips + '</div></div>' +
      '<div class="jr-sec"><h4>建设动作 / 工程指标</h4><div class="jr-chips">' + actionChips + '</div></div>' +
      '<div class="jr-sec"><h4>减分项</h4><div class="jr-chips">' + weakChips + '</div></div>' +
      '</div>' +
      '<div class="jr-foot">' +
      '<button class="jr-btn ' + (d.saved ? 'done' : 'primary') + '" data-act="save">' + esc(savedLabel) + '</button>' +
      '<button class="jr-btn" data-act="copy">复制摘要</button>' +
      '<button class="jr-btn" data-act="diag">复制诊断</button>' +
      '</div>' +
      '<div class="jr-mini">JD 来源：' + esc(src.jd || '未取到') + ' · 共 ' + ev.jdLength + ' 字 · 仅个人使用，不采集他人信息</div>' +
      '</div>';
  }

  function bind() {
    // shadow 指向旧节点时（宿主被移除过）也要重建，不能只判断 !shadow
    if (!shadow || !host || !document.documentElement.contains(host)) mount();
    if (bound) return;
    bound = true;
    shadow.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'toggle') {
        collapsed = !collapsed;
        render();
      } else if (act === 'dismiss') {
        hide();
      } else if (act === 'save' && handlers.onSave) {
        handlers.onSave(lastData);
      } else if (act === 'copy' && handlers.onCopy) {
        handlers.onCopy(lastData, btn);
      } else if (act === 're-extract' && handlers.onReextract) {
        handlers.onReextract();
      } else if (act === 'diag' && handlers.onDiag) {
        handlers.onDiag(btn);
      }
    });
  }

  function markSaved(record) {
    if (!lastData) return;
    lastData.saved = true;
    lastData.seenCount = record.seenCount || 1;
    lastData.staleDays = record.staleDays || 0;
    render();
  }

  global.JR_PANEL = {
    show: show,
    notice: notice,
    hide: hide,
    setBusy: setBusy,
    markSaved: markSaved,
    bind: bind,
    getData: function () { return lastData; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
