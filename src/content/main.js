/* 岗位雷达 · 内容脚本主流程
 * 只做三件事：抽取当前页 JD、按其内容打分、把结果渲染到侧栏并允许手动入库。
 * 不自动翻页、不批量请求、不绕过任何验证码或访问控制。
 */
(function () {
  'use strict';

  var TAG = '[岗位雷达]';

  var U = window.JR_UTIL;
  var R = window.JR_RULES;
  var E = window.JR_EXTRACT;
  var A = window.JR_ADAPTERS;
  var P = window.JR_PANEL;

  var adapter = null;
  var lastFingerprint = '';
  var lastHref = location.href;
  var lastTitle = document.title;
  var retry = 0;
  var RETRY_MAX = 8;

  /* 依赖缺失不能静默 return，否则用户只看到「插件没反应」，无从排查 */
  var missing = [];
  if (!U) missing.push('util.js');
  if (!R) missing.push('rules.js');
  if (!E) missing.push('extract.js');
  if (!A) missing.push('adapters.js');
  if (!P) missing.push('panel.js');
  if (missing.length) {
    console.error(TAG + ' 依赖脚本未加载：' + missing.join('、') +
      '。请到 chrome://extensions 查看该扩展的错误信息并重新加载。');
    return;
  }

  /* 页面上的 JD 关键词，用于判断「这页是否像岗位详情」而不只依赖 URL 形态 */
  var JD_HINT = /岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|工作内容|你将负责/;

  function fingerprint(f) {
    return [f.jobTitle, f.company, f.salaryText, f.jdText.length].join('|');
  }

  function buildPayload(d) {
    var f = d.fields;
    var ev = d.ev;
    return {
      key: d.key,
      platform: f.platform,
      siteName: f.siteName,
      jobTitle: f.jobTitle,
      company: f.company,
      salaryText: f.salaryText,
      city: f.city,
      experienceText: f.experienceText,
      educationText: f.educationText,
      group: ev.group,
      groupLabel: ev.groupLabel,
      groupShort: ev.groupShort,
      score: ev.score,
      grade: ev.grade,
      gradeLabel: ev.gradeLabel,
      strong: ev.strong.map(function (x) { return x.term; }),
      actions: ev.actions.map(function (x) { return x.term; }),
      metrics: ev.metrics.map(function (x) { return x.term; }),
      weak: ev.weak.map(function (x) { return x.term; }),
      excludes: ev.excludes.map(function (x) { return x.term; }),
      flags: ev.flags,
      jdLength: ev.jdLength,
      jdExcerpt: U.ellipsis(f.jdText, 600),
      url: f.url,
      savedAt: Date.now()
    };
    // 刻意不写入招聘者姓名 / 联系方式等个人信息
  }

  function buildMarkdown(d) {
    var f = d.fields;
    var ev = d.ev;
    var lines = [];
    lines.push('## ' + (f.jobTitle || '未取到职位名') + ' · ' + (f.company || '未取到公司'));
    lines.push('');
    lines.push('| 项 | 值 |');
    lines.push('|---|---|');
    lines.push('| 平台 | ' + (f.siteName || '—') + ' |');
    lines.push('| 薪资 | ' + (f.salaryText || '—') + ' |');
    lines.push('| 城市 | ' + (f.city || '—') + ' |');
    lines.push('| 经验 | ' + (f.experienceText || '—') + ' |');
    lines.push('| 族群 | ' + (ev.groupLabel || '—') + ' |');
    lines.push('| 评分 | ' + ev.score + ' / ' + ev.gradeLabel + ' |');
    lines.push('');
    lines.push('**强信号**：' + (ev.strong.map(function (x) { return x.term; }).join('、') || '无'));
    lines.push('');
    lines.push('**减分项**：' + (ev.weak.map(function (x) { return x.term; }).join('、') || '无'));
    lines.push('');
    lines.push('链接：' + f.url);
    return lines.join('\n');
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { resolve(true); },
          function () { resolve(fallbackCopy(text)); }
        );
      } else {
        resolve(fallbackCopy(text));
      }
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function onSave(data) {
    var payload = buildPayload(data);
    chrome.runtime.sendMessage({ type: 'SAVE', payload: payload }, function (res) {
      if (chrome.runtime.lastError) {
        console.warn('[岗位雷达] 保存失败：', chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok) {
        var days = U.daysBetween(res.record.firstSeen);
        P.markSaved({ seenCount: res.record.seenCount, staleDays: days });
      }
    });
  }

  function onCopy(data, btn) {
    var text = buildMarkdown(data);
    copyText(text).then(function (ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () {
        btn.textContent = old;
      }, 1200);
    });
  }

  function pageHasJobHint() {
    try {
      return JD_HINT.test(document.body ? document.body.innerText.slice(0, 6000) : '');
    } catch (e) {
      return false;
    }
  }

  /* 页面看起来是岗位页，但这次没抽到：可能是 SPA 还在渲染，重试几次再下结论 */
  function shouldRetry(f) {
    if (retry >= RETRY_MAX) return false;
    if (!f) return pageHasJobHint() || A.isDetailPage(adapter, location.href);
    return f.jdText.length < 120 || !f.jobTitle;
  }

  function run(force) {
    if (!adapter) return;
    var f = E.extract(adapter);

    /* SPA 详情面板常延迟渲染：抽不到时先重试，不要立刻判死 */
    if (shouldRetry(f)) {
      retry++;
      setTimeout(function () { run(force); }, 700);
      return;
    }
    retry = 0;

    if (!f) {
      if (A.isDetailPage(adapter, location.href) || pageHasJobHint()) {
        P.notice('未能识别本页岗位', [
          '已识别站点：' + adapter.name,
          '页面像岗位详情，但职位名、公司、JD 均抽取失败。',
          '多半是该站改版后类名变化，需更新 src/content/adapters.js 中的选择器。',
          '当前 URL：' + location.href
        ]);
        console.warn(TAG + ' 抽取失败：' + adapter.name + ' / ' + location.href);
      } else {
        P.hide();
      }
      return;
    }

    var isDetail = A.isDetailPage(adapter, location.href);
    /* 不再强依赖 detailPattern：BOSS 新版是列表页右侧滑出详情，URL 不变成
       /job_detail/，若只认标准详情路径会导致面板永不出现。
       改以「是否抽到足够的 JD + 有职位名」为准。 */
    if (!isDetail && (f.jdText.length < 250 || !f.jobTitle)) {
      P.hide();
      return;
    }

    var fp = fingerprint(f);
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;

    var ev = R.evaluate({
      jobTitle: f.jobTitle,
      jdText: f.jdText,
      salaryText: f.salaryText,
      experienceText: f.experienceText
    });

    var key = R.makeKey(f.platform, f.company, f.jobTitle, f.salaryText);

    var data = {
      key: key,
      fields: f,
      ev: ev,
      saved: false,
      seenCount: 0,
      staleDays: 0
    };

    console.log(TAG + ' 已渲染 · ' + adapter.name + ' · ' + (f.jobTitle || '未取到职位名') +
      ' · JD ' + f.jdText.length + ' 字 · ' + ev.score + ' 分（' + ev.gradeLabel + '）');

    P.bind();
    P.show(data, {
      onSave: onSave,
      onCopy: onCopy,
      onReextract: function () {
        lastFingerprint = '';
        retry = 0;
        run(true);
      }
    });

    // 查本地库里是否已有记录，有则显示见到次数与挂牌天数
    chrome.runtime.sendMessage({ type: 'QUERY_ONE', key: key }, function (res) {
      if (chrome.runtime.lastError) return;
      if (res && res.record) {
        var days = U.daysBetween(res.record.firstSeen);
        P.markSaved({
          seenCount: res.record.seenCount || 1,
          staleDays: days
        });
      }
    });
  }

  /* 只在 URL 或标题变化时重跑；BOSS 等站点在同一 URL 内切换岗位，
     因此额外比对页面标题。 */
  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastFingerprint = '';
      retry = 0;
      setTimeout(function () { run(false); }, 900);
      return;
    }
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      lastFingerprint = '';
      retry = 0;
      setTimeout(function () { run(false); }, 900);
    }
  }

  function init() {
    adapter = A.getAdapter(location.hostname);
    if (!adapter) {
      console.log(TAG + ' 当前域名不在支持列表：' + location.hostname);
      return;
    }

    console.log(TAG + ' 已注入 · ' + adapter.name + ' · ' + location.href);

    /* 监控必须无条件启动。此前若判定为「列表页」就提前 return，
       而 BOSS / 脉脉 是 SPA，从列表点进详情不会重新注入内容脚本，
       导致面板永远不出现。 */
    setInterval(tick, 1300);
    setTimeout(function () { run(false); }, 1200);
  }

  init();
})();
