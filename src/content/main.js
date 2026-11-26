/* 岗位雷达 · 内容脚本主流程
 * 只做三件事：抽取当前页 JD、按其内容打分、把结果渲染到侧栏并允许手动入库。
 * 不自动翻页、不批量请求、不绕过任何验证码或访问控制。
 */
(function () {
  'use strict';

  var TAG = '[岗位雷达]';
  var HOST_ID = 'jr-radar-host';

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
  var RETRY_MAX = 6;
  var emptyStreak = 0;      // 连续抽不到有效岗位的次数
  var MAX_EMPTY = 4;        // 超过才允许隐藏面板
  var hasRendered = false;  // 是否曾成功渲染过岗位面板
  var runTimer = null;
  var observer = null;

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

  /* 指纹带上 JD 前 120 字与 URL：切换左侧岗位时职位名 / 薪资可能相近，
     只靠长度无法区分，指纹必须随内容本身变化。 */
  function fingerprint(f) {
    return [
      f.jobTitle, f.company, f.salaryText, f.jdText.length,
      f.jdText.slice(0, 120), f.url
    ].join('|');
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
        console.warn(TAG + ' 保存失败：', chrome.runtime.lastError.message);
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
      var b = document.body;
      // innerText 更贴近可见文本；部分环境（如 jsdom）只有 textContent
      var txt = (b && (b.innerText || b.textContent)) || '';
      return JD_HINT.test(txt.slice(0, 6000));
    } catch (e) {
      return false;
    }
  }

  /* 统一调度：URL / 标题变化、DOM 变化、重试全部共用一个防抖定时器，
     避免多个 setTimeout 叠加导致重复渲染，或互相 clearTimeout 顶掉。 */
  function scheduleRun(delay) {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(function () {
      runTimer = null;
      run(false);
    }, typeof delay === 'number' ? delay : 500);
  }

  function shouldRetry(f, looksLikeJob) {
    if (retry >= RETRY_MAX) return false;
    if (!f) return looksLikeJob;
    return f.jdText.length < 120 || !f.jobTitle;
  }

  function run(force) {
    if (!adapter) return;
    var f = E.extract(adapter);
    var isDetail = A.isDetailPage(adapter, location.href);
    var looksLikeJob = pageHasJobHint() || isDetail;
    var minJd = isDetail ? 120 : 250;

    /* SPA 详情面板常延迟渲染：抽不到时先重试，不要立刻判死 */
    if (shouldRetry(f, looksLikeJob)) {
      retry++;
      if (hasRendered) P.setBusy('正在读取岗位…');
      scheduleRun(700);
      return;
    }
    retry = 0;

    /* 关键分支：BOSS 搜索页切换左侧岗位时，右侧详情是异步替换的，
       存在「旧详情已清空、新详情还没到」的空窗，此时抽不到是暂时的。
       旧逻辑在这里直接 P.hide()，而 hide 之后既没有清空指纹、也没有任何
       触发源会再跑 run —— 面板于是永久消失。
       现在改为：只要曾成功渲染过，就保留面板并显示等待态，等 DOM 稳定后
       由监听或下一次调度自动更新；只有连续多次抽不到才允许隐藏。 */
    if (!f || !f.jobTitle || f.jdText.length < minJd) {
      emptyStreak++;
      if (hasRendered && emptyStreak < MAX_EMPTY) {
        P.setBusy('正在读取新岗位…');
        scheduleRun(700);
        return;
      }
      lastFingerprint = '';
      if (looksLikeJob) {
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

    emptyStreak = 0;
    var fp = fingerprint(f);
    if (!force && fp === lastFingerprint) {
      P.setBusy('');
      return;
    }
    lastFingerprint = fp;
    hasRendered = true;

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

  /* 判断变更是否只由插件自身节点引起。面板内容在 Shadow DOM 内部，
     不会冒泡到 document 的监听；但插入 / 移除 host 会。 */
  function isOwnTarget(node) {
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    if (el.id === HOST_ID) return true;
    try {
      return !!(el.closest && el.closest('#' + HOST_ID));
    } catch (e) {
      return false;
    }
  }

  /* DOM 驱动重跑：BOSS / 脉脉 切换左侧岗位是同一 URL 内的详情替换，
     URL 与 document.title 都可能完全不变，只靠轮询永远发现不了。
     只监听 childList + subtree（不监听 characterData），避开倒计时、
     骨架动画等高频文本变化；300ms 防抖等详情 DOM 稳定后再抽。
     fingerprint 比对会拦下内容未变的重复渲染，因此多跑几次成本很低。 */
  function startObserver() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    try {
      observer = new MutationObserver(function (records) {
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
          if (!isOwnTarget(records[i].target)) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        scheduleRun(300);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      console.log(TAG + ' DOM 监听已启动');
    } catch (e) {
      console.warn(TAG + ' DOM 监听不可用，退化为 URL/标题轮询：' + e.message);
    }
  }

  function tick() {
    var changed = false;
    if (location.href !== lastHref) {
      lastHref = location.href;
      changed = true;
    }
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      changed = true;
    }
    if (!changed) return;
    lastFingerprint = '';
    retry = 0;
    scheduleRun(600);
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
    P.bind();          // 先建宿主，避免它的插入触发下面的 DOM 监听
    startObserver();
    setInterval(tick, 1300);
    scheduleRun(900);
  }

  init();
})();
