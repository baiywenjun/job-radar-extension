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
  var D = window.JR_DIAGNOSE;

  var adapter = null;
  var lastFingerprint = '';
  var lastHref = location.href;
  var lastTitle = document.title;
  var retry = 0;
  var RETRY_MAX = 6;
  var emptyStreak = 0;      // 连续抽不到有效岗位的次数
  var MAX_EMPTY = 4;        // 超过才允许隐藏面板
  var noPaneStreak = 0;     // 连续判定「本页无岗位详情」的次数
  var hasRendered = false;  // 是否曾成功渲染过岗位面板
  var lastIssueKey = '';    // 问题日志去重：同一类问题只写一次
  var runTimer = null;
  var observer = null;

  /* 依赖缺失不能静默 return，否则用户只看到「插件没反应」，无从排查 */
  var missing = [];
  if (!U) missing.push('util.js');
  if (!R) missing.push('rules.js');
  if (!E) missing.push('extract.js');
  if (!A) missing.push('adapters.js');
  if (!P) missing.push('panel.js');
  /* diagnose.js 缺失只影响「复制诊断」按钮，不影响抽取与打分，不列入致命依赖 */
  if (missing.length) {
    console.error(TAG + ' 依赖脚本未加载：' + missing.join('、') +
      '。请到 chrome://extensions 查看该扩展的错误信息并重新加载。');
    return;
  }

  /* 页面抽取失败属于可恢复的站点状态，面板会显示诊断信息。内容脚本的
     console.warn 会被 Chrome 计入扩展「错误」，因此这些状态统一用 info。 */
  function logOnce(kind, msg) {
    if (lastIssueKey === kind) return;
    lastIssueKey = kind;
    console.info(TAG + ' ' + msg);
  }

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

  /* 站点拦截 F12 后用户拿不到 class，只能靠「复制诊断」把线索带出来。
     report() 会重新跑一次抽取并附带选择器命中情况与 DOM 骨架，全程只读本页。 */
  function onDiag(btn) {
    var text = '';
    if (!D) {
      text = '诊断模块未加载，请到 chrome://extensions 重新加载扩展后再试。';
    } else {
      try {
        text = D.report(adapter);
      } catch (e) {
        text = '诊断生成失败：' + (e && e.message);
      }
    }
    copyText(text).then(function (ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? '已复制 · 去粘贴给维护者' : '复制失败，请重试';
      setTimeout(function () {
        btn.textContent = old;
      }, 2200);
    });
  }

  /* 提示态也要能响应按钮，所以处理函数不依赖 P.show 先跑一遍 */
  function handlers() {
    return {
      onSave: onSave,
      onCopy: onCopy,
      onDiag: onDiag,
      onReextract: function () {
        lastFingerprint = '';
        retry = 0;
        run(true);
      }
    };
  }

  /* 把「到底哪个字段空了」说清楚：旧版一律说三个全失败，用户无法判断是改版
     还是还没渲染完，也无从决定要不要点诊断。 */
  function diagLine(f) {
    if (!f) return '页面里连 JD 正文都没定位到（可能仍在加载，或详情区尚未渲染）。';
    var miss = [];
    if (!f.jobTitle) miss.push('职位名');
    if (!f.company) miss.push('公司名');
    if (!f.salaryText) miss.push('薪资');
    if (!f.experienceText) miss.push('经验');
    if (!f.jdText || f.jdText.length < 120) miss.push('JD 正文');
    var got = 'JD ' + (f.jdText ? f.jdText.length : 0) + ' 字' +
      (f.salaryText ? ' · 薪资 ' + f.salaryText : '');
    if (!miss.length) return '字段已取到，但 JD 未达判定门槛（' + got + '）';
    return '未取到：' + miss.join('、') + '（已取到 ' + got + '）';
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

  /* 统一调度：URL / 标题变化、DOM 变化、重试全部共用一个防抖定时器，
     避免多个 setTimeout 叠加导致重复渲染，或互相 clearTimeout 顶掉。 */
  function scheduleRun(delay) {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(function () {
      runTimer = null;
      run(false);
    }, typeof delay === 'number' ? delay : 500);
  }

  /* f 为 null 时只在标准详情 URL 下重试：BOSS 的侧滑详情 URL 不变，
     此时「抽不到」多半是还没选中岗位，盲目重试 6 轮只会在列表页空转。
     JD 已抓到时标题缺失只给两次机会：标题可能晚于正文渲染，但不会一直不来。 */
  function shouldRetry(f, isDetail) {
    if (retry >= RETRY_MAX) return false;
    if (!f) return isDetail;
    if (f.jdText.length < 120) return true;
    if (!f.jobTitle) return retry < 2;
    return false;
  }

  function run(force) {
    if (!adapter) return;
    var f = E.extract(adapter);
    var isDetail = A.isDetailPage(adapter, location.href);
    var hasPane = isDetail || E.hasDetailPane(adapter);
    /* 搜索页用同一份 JD 级证据判定「详情已展开」和「可以评分」。
       旧版前者要求 200 字、后者要求 250 字，真实的短 JD 会被误报为失败。 */
    var minJd = isDetail ? 120 : 200;
    var ok = !!f && !!f.jobTitle && hasPane && f.jdText.length >= minJd;

    /* SPA 详情面板常延迟渲染：抽不到时先重试，不要立刻判死 */
    if (!ok && shouldRetry(f, isDetail)) {
      retry++;
      if (hasRendered) P.setBusy('正在读取岗位…');
      scheduleRun(700);
      return;
    }
    retry = 0;

    if (!ok) {
      /* 关键分支：必须区分「本页没有岗位详情」与「详情在但抽不到」。
         BOSS 搜索页选中岗位后 URL 也可能仍是 /web/geek/jobs?query=...；
         列表卡片本身就有 .job-title .name 和 .salary，
         因此不能靠这些选择器判断「是否打开了详情」，只能认 JD 级证据。 */
      if (!hasPane) {
        noPaneStreak++;
        emptyStreak = 0;
        // 给一次缓冲：详情可能还在渲染，避免真实详情页首屏闪一下提示
        if (noPaneStreak < 2) {
          scheduleRun(600);
          return;
        }
        lastFingerprint = '';
        P.notice('等待选择岗位', [
          '已识别站点：' + adapter.name,
          '当前页面没有展开的岗位详情（搜索结果列表页，或尚未选中岗位）。',
          '在列表中点选一个岗位后，会自动抽取并评分。'
        ], {
          tone: 'info',
          foot: '这是正常状态，不是插件故障。若右侧确实已经展示了岗位详情，点「复制诊断」把结果发给维护者。',
          handlers: handlers()
        });
        logOnce('no-pane:' + location.pathname,
          '本页暂无岗位详情（列表页或未选中岗位），已显示等待提示');
        return;
      }
      noPaneStreak = 0;

      /* 详情已展开但抽不到：可能是「旧详情已清空、新详情未到」的空窗。
         只要曾成功渲染过，就保留面板并显示等待态，由 DOM 监听自动恢复；
         旧逻辑在这里直接 P.hide()，hide 后既没清指纹也没有触发源会再跑 run，
         面板于是永久消失。 */
      emptyStreak++;
      if (hasRendered && emptyStreak < MAX_EMPTY) {
        P.setBusy('正在读取新岗位…');
        scheduleRun(700);
        return;
      }

      lastFingerprint = '';
      P.notice('未能识别本页岗位', [
        '已识别站点：' + adapter.name,
        diagLine(f),
        '当前 URL：' + location.href
      ], {
        tone: 'bad',
        foot: '站点改版后类名会整体失效，且 BOSS 会拦截 F12。点下方「复制诊断信息」，把结果粘给维护者即可远程校准，不需要开发者工具。',
        handlers: handlers()
      });
      logOnce('extract-fail:' + location.href,
        '岗位信息待校准（详情已展开但字段不完整）：' + adapter.name + ' / ' + location.href);
      return;
    }

    emptyStreak = 0;
    noPaneStreak = 0;
    lastIssueKey = '';
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
    P.show(data, handlers());

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
