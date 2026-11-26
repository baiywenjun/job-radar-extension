/* 岗位雷达 · 内容脚本主流程
 * 只做三件事：抽取当前页 JD、按其内容打分、把结果渲染到侧栏并允许手动入库。
 * 不自动翻页、不批量请求、不绕过任何验证码或访问控制。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var R = window.JR_RULES;
  var E = window.JR_EXTRACT;
  var A = window.JR_ADAPTERS;
  var P = window.JR_PANEL;

  var adapter = null;
  var lastFingerprint = '';
  var lastHref = location.href;
  var lastTitle = document.title;

  if (!U || !R || !E || !A || !P) return;

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

  function run(force) {
    if (!adapter) return;
    var f = E.extract(adapter);
    if (!f) {
      P.hide();
      return;
    }

    var isDetail = A.isDetailPage(adapter, location.href);
    // 列表页/首页要求更高的抽取质量才显示，避免在搜索结果页误注入
    if (!isDetail && (f.jdText.length < 400 || !f.jobTitle)) {
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

    P.bind();
    P.show(data, {
      onSave: onSave,
      onCopy: onCopy,
      onReextract: function () {
        lastFingerprint = '';
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

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastFingerprint = '';
      setTimeout(function () { run(false); }, 900);
      return;
    }
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      lastFingerprint = '';
      setTimeout(function () { run(false); }, 900);
    }
  }

  function init() {
    adapter = A.getAdapter(location.hostname);
    if (!adapter) return;
    if (A.looksLikeListPage(location.href) && !A.isDetailPage(adapter, location.href)) {
      // 明确是列表页时先不注入，等用户点进详情
      return;
    }
    setTimeout(function () { run(false); }, 1200);
    setInterval(tick, 1300);
  }

  init();
})();
