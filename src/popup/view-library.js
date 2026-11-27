/* 岗位雷达 · popup 视图：岗位库
 *
 * 三件事：
 *   1. 列表 + 筛选 + 统计（沿用 v0.1.5）
 *   2. 导出 CSV / MD / JSON——字段口径统一交给 export.js，这里只负责下载
 *   3. 数据检查器：点开一条记录，把「原始字段 + 每项来源 + 完整正文 + 判定证据」
 *      摆在同一屏。它要回答的问题不是「这岗怎么样」，而是「这条结论凭什么可信」
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var R = window.JR_RULES;
  var DB = window.JR_DB;
  var X = window.JR_EXPORT;
  var H = window.JR_HISTORY;

  var all = [];
  var view = [];
  var inited = false;

  var verdictList = [];
  var verdictMap = {};      // key → 最近一次判定

  /* key → 轨迹条目数组（时间正序）；undefined = 还没拉，null = 拉取失败。
     这两种"空"必须区分：前者显示"读取中"，后者显示错误，
     而真正的空数组才说明"这个岗位还没判过"。 */
  var logCache = {};

  var inspectKey = '';
  var judgePort = null;
  var judging = false;

  var elQ, elGroup, elGrade, elTbody, elEmpty, elTbl, elStats;
  var elInsp, elInspTitle, elInspBody, elInspBack, elInspRejudge;

  var EMPTY_NONE =
    '<b>还没有记录。</b><br>打开 BOSS 直聘 / 猎聘 / 脉脉 / 国聘 的岗位详情页，<br>' +
    '在右侧面板点「保存到本地库」<code>即可入库</code>。';
  var EMPTY_FILTER = '<b>没有符合筛选条件的记录。</b><br>换个关键词或把筛选条件重置。';
  var EMPTY_ERR = '<b>读取本地库失败。</b><br>请关闭并重新打开扩展面板。';

  function esc(s) {
    return U.escapeHtml(s == null ? '' : String(s));
  }

  function days(rec) {
    return U.daysBetween(rec.firstSeen);
  }

  function gradeLabel(g) {
    return (R.GRADE_INFO[g] && R.GRADE_INFO[g].label) || g || '—';
  }

  function send(msg) {
    return new Promise(function (resolve) {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    });
  }

  function initGroupOptions() {
    R.GROUPS.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.short;
      elGroup.appendChild(o);
    });
    var other = document.createElement('option');
    other.value = 'OTHER';
    other.textContent = '未归类';
    elGroup.appendChild(other);
  }

  function renderStats() {
    var total = all.length;
    var strongCount = 0;
    var risky = 0;
    var stale = 0;
    var groups = {};

    all.forEach(function (r) {
      if (r.grade === 'strong') strongCount++;
      if (r.grade === 'poor' || r.grade === 'weak') risky++;
      if (days(r) >= 30) stale++;
      if (r.group) groups[r.group] = 1;
    });

    elStats.innerHTML =
      statCard('总记录', total, '') +
      statCard('强信号', strongCount, 'g') +
      statCard('需谨慎', risky, 'b') +
      statCard('挂牌 ≥30 天', stale, 'w') +
      statCard('覆盖族群', Object.keys(groups).length, 'n');
  }

  function statCard(k, v, cls) {
    return '<div class="stat ' + cls + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  function matchQuery(r, q) {
    if (!q) return true;
    var v = verdictMap[r.key] || {};
    var hay = [
      r.jobTitle, r.company, r.city, r.groupLabel, r.salaryText,
      r.oneLine, v.oneLine,
      (r.strong || []).join(' '),
      (r.weak || []).join(' '),
      (r.actions || []).join(' '),
      (r.metrics || []).join(' '),
      ((v.evidence || []).map(function (e) { return e.claim + ' ' + (e.quote || ''); }).join(' '))
    ].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function applyFilter() {
    var q = U.clean(elQ.value).toLowerCase();
    var g = elGroup.value;
    var gr = elGrade.value;

    view = all.filter(function (r) {
      if (g && r.group !== g) return false;
      if (gr && r.grade !== gr) return false;
      if (!matchQuery(r, q)) return false;
      return true;
    });
    renderTable();
  }

  function renderTable() {
    if (!all.length) {
      elTbl.style.display = 'none';
      elEmpty.style.display = 'block';
      elEmpty.innerHTML = EMPTY_NONE;
      elTbody.innerHTML = '';
      return;
    }
    elTbl.style.display = 'table';

    if (!view.length) {
      elEmpty.style.display = 'block';
      elEmpty.innerHTML = EMPTY_FILTER;
      elTbody.innerHTML = '';
      return;
    }

    elEmpty.style.display = 'none';
    elTbody.innerHTML = view.map(function (r) {
      var d = days(r);
      var staleCls = d >= 30 ? ' stale' : '';
      var title = '首次 ' + U.fmtDate(r.firstSeen) + ' · 末次 ' + U.fmtDate(r.lastSeen) +
        ' · 见到 ' + (r.seenCount || 1) + ' 次 · 点开看检查器';
      var v = verdictMap[r.key];
      var mark = v ? ' <span class="src ok" title="有模型判定">模型</span>' : '';
      return (
        '<tr>' +
        '<td><span class="sc ' + (r.grade || '') + '" title="' + esc(gradeLabel(r.grade)) + '">' + (r.score || 0) + '</span></td>' +
        '<td class="jt"><a href="#" data-insp="' + esc(r.key) + '" title="' + esc(title) + '">' +
          esc(r.jobTitle || '未命名') + '</a>' + mark + '</td>' +
        '<td class="co" title="' + esc(r.company || '') + '">' + esc(r.company || '—') + '</td>' +
        '<td class="sal">' + esc(r.salaryText || '—') + '</td>' +
        '<td>' + esc(r.city || '—') + '</td>' +
        '<td><span class="grp">' + esc(r.groupShort || '未归类') + '</span></td>' +
        '<td class="days' + staleCls + '" title="' + esc(title) + '">' + d + ' 天</td>' +
        '<td class="acts">' +
          '<button class="open" data-url="' + esc(r.url || '') + '" title="在浏览器中打开">↗</button>' +
          '<button class="del" data-del="' + esc(r.key) + '" title="删除该记录">×</button>' +
        '</td>' +
        '</tr>'
      );
    }).join('');
  }

  /* ---------- 检查器 ---------- */
  function byKey(key) {
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }

  function srcBadge(label) {
    if (!label) return '<span class="src">未记录</span>';
    var bad = label === '未取到' || label === '字形混淆' || label === '列表匹配';
    return '<span class="src' + (bad ? ' bad' : '') + '">' + esc(label) + '</span>';
  }

  function fieldRow(dt, dd) {
    return '<dt>' + dt + '</dt><dd>' + dd + '</dd>';
  }

  function renderJudgeSection(job) {
    var v = verdictMap[job.key];
    if (!v) {
      return '<div class="insp-sec"><h5>判定</h5>' +
        '<div class="insp-note">这条记录没有模型判定，表里的分数来自本地词库。' +
        (job.jdText ? '可以点右上角「重新判定」补一次。' : '（旧记录没存正文，无法在弹窗里重判）') +
        '</div></div>';
    }

    var info = (R.GRADE_INFO && R.GRADE_INFO[v.grade]) || { label: v.grade || '—' };
    var u = v.usage || {};
    var meta = [];
    if (v.model) meta.push(esc(v.model));
    if (v.confidence != null) meta.push('置信度 ' + v.confidence);
    if (u.total) meta.push((u.total >= 1000 ? (u.total / 1000).toFixed(1) + 'k' : u.total) + ' tokens');
    if (v.cost) meta.push('¥' + (v.cost < 0.01 ? v.cost.toFixed(4) : v.cost.toFixed(3)));
    if (v.ms) meta.push((v.ms / 1000).toFixed(1) + 's');

    var evHtml = '';
    if (v.evidence && v.evidence.length) {
      evHtml = '<div class="dry-ev">' + v.evidence.map(function (e) {
        var type = e.type || 'must';
        var label = type === 'red' ? '减分' : (type === 'nice' ? '加分' : '要求');
        var cls = type + (e.verified === false ? ' unv' : '');
        return '<div class="row ' + cls + '"><span class="tag">' + label + '</span>' + esc(e.claim) +
          (e.quote ? ' <span class="q">「' + esc(e.quote) + '」</span>' : '') +
          (e.verified === false ? ' <span class="q">（未能核实）</span>' : '') +
          '</div>';
      }).join('') + '</div>';
    } else {
      evHtml = '<div class="insp-note">模型没给出证据条目。</div>';
    }

    var warn = '';
    if (v.evidenceFlag === 'E_BAD_EVIDENCE') {
      warn = '<div class="dry-warn">过半引用在正文里找不到，置信度已打折。档位可以参考，但别据此做决定。</div>';
    }

    return '<div class="insp-sec"><h5>判定</h5>' +
      '<div class="dry-top" style="margin-bottom:8px">' +
        '<span class="dry-grade ' + esc(v.grade || '') + '">' + esc(info.label) + '</span>' +
        '<span class="dry-score">' + (v.score == null ? '—' : v.score) + '</span>' +
        '<span class="dry-meta">' + meta.join(' · ') + '</span>' +
      '</div>' +
      '<div class="dry-one">' + esc(v.oneLine || '（没有一句话结论）') + '</div>' +
      '<dl class="kvline">' +
        fieldRow('标准', esc(v.profileName || job.profileName || '—') +
          (v.profileVersion ? ' <span class="src">v' + v.profileVersion + '</span>' : '')) +
        fieldRow('判定时间', v.createdAt ? esc(U.fmtDateTime(v.createdAt)) : '—') +
        fieldRow('证据核对', v.evidenceCheck
          ? (v.evidenceCheck.passed + ' / ' + v.evidenceCheck.checked + ' 条引用能在正文里找到')
          : '未核对') +
      '</dl>' +
      evHtml +
      ((v.missing && v.missing.length)
        ? '<div class="dry-line"><b>标准要求但原文没提</b>：' + v.missing.map(esc).join('、') + '</div>' : '') +
      ((v.risks && v.risks.length)
        ? '<div class="dry-line"><b>风险</b>：' + v.risks.map(esc).join('、') + '</div>' : '') +
      warn +
      '</div>';
  }

  /* ---------- 判定历史（S5） ---------- */

  /* 轨迹条 + 逐条列表。
     顺序上刻意的相反：轨迹条从左到右是时间正序（像心电图），
     逐条列表最新在上（找"刚才那次"不用往下滚）。 */
  function historyHtml(entries) {
    var tl = H.buildTimeline(entries);
    var sum = H.describe(tl.stats);

    var track = tl.rows.map(function (r) {
      var e = r.entry;
      var tip = U.fmtDateTime(e.createdAt) + ' · ' +
        (e.profileName || '未命名标准') + ' v' + (e.profileVersion || 0) + ' · ' +
        (e.score == null ? '无分数' : e.score + ' 分');
      return '<span class="hpt ' + esc(e.grade || '') + '" title="' + esc(tip) + '">' +
        '<i></i><b>' + (e.score == null ? '—' : e.score) + '</b></span>';
    }).join('<span class="hline"></span>');

    var rows = tl.rows.slice().reverse().map(function (r) {
      var e = r.entry;
      var delta = H.deltaText(r);
      var dcls = delta.charAt(0) === '↑' ? ' up' : (delta.charAt(0) === '↓' ? ' down' : '');
      var marks = [];
      if (r.jdChanged === true) marks.push('<span class="hmark">正文有改动</span>');
      if (r.profileChanged) marks.push('<span class="hmark info">换了标准</span>');
      if (e.evidenceFlag === 'E_BAD_EVIDENCE') marks.push('<span class="hmark bad">引用多半查不到</span>');

      return '<div class="hrow">' +
        '<span class="hwhen">' + esc(U.fmtDateTime(e.createdAt)) + '</span>' +
        '<span class="dry-grade ' + esc(e.grade || '') + '">' + esc(H.gradeLabel(e.grade)) + '</span>' +
        '<span class="hscore">' + (e.score == null ? '—' : e.score) + '</span>' +
        '<span class="hdelta' + dcls + '" title="与上一次判定比">' +
          esc(delta || (r.profileChanged ? '不可比' : '')) + '</span>' +
        '<span class="hprof">' + esc(e.profileName || '未命名标准') +
          (e.profileVersion ? ' v' + e.profileVersion : '') + '</span>' +
        marks.join('') +
        '</div>';
    }).join('');

    return '<div class="hsum">' + esc(sum.main) + '</div>' +
      (sum.detail ? '<div class="hdet">' + esc(sum.detail) + '</div>' : '') +
      '<div class="htrack">' + track + '</div>' +
      '<div class="hlist">' + rows + '</div>' +
      '<div class="insp-note">跨标准的两条不比较分数——不同标准在回答不同的问题。' +
      '「正文有改动」是按指纹（前 800 字哈希 + 总字数）判断的。</div>';
  }

  function historySection(job) {
    var entries = logCache[job.key];
    if (entries === undefined) {
      return '<div class="insp-note">读取中…</div>';
    }
    if (entries === null) {
      return '<div class="insp-note bad">读取判定历史失败，关掉扩展面板重开再试。</div>';
    }
    if (!entries.length) {
      var judged = !!(verdictMap[job.key] || job.judgedAt);
      return '<div class="insp-note">' + (judged
        ? '这条结论是升级到 0.3.0 之前判的，那时还没有轨迹记录。之后再判一次就会开始积累。'
        : '还没有用模型判过。判一次之后这里会显示档位怎么变。') + '</div>';
    }
    return historyHtml(entries);
  }

  function loadLog(key) {
    return send({ type: 'VERDICT_LOG', key: key }).then(function (res) {
      logCache[key] = (res && res.ok && res.list) ? res.list : null;
      return logCache[key];
    }).catch(function () {
      logCache[key] = null;
      return null;
    });
  }

  function renderHistorySection(job) {
    var box = elInspBody.querySelector ? elInspBody.querySelector('.insp-hist') : null;
    if (!box) return;
    box.innerHTML = historySection(job);
  }

  function renderInspector(job) {
    var src = job.sources || {};
    var dirty = job.dirty || {};
    var jd = job.jdText || '';
    var jdHtml;

    if (jd) {
      jdHtml = '<pre class="jdbox">' + esc(jd) + '</pre>' +
        '<div class="insp-note">共 ' + jd.length + ' 字' +
        (dirty.ui ? ' · 抽取时剔除了 ' + dirty.ui + ' 处页面控件文字' : '') + '</div>';
    } else if (job.jdExcerpt) {
      jdHtml = '<pre class="jdbox">' + esc(job.jdExcerpt) + '</pre>' +
        '<div class="insp-note bad">这条是旧版本记录的摘要（600 字），没有完整正文。' +
        '回到页面点一次「保存到本地库」即可补全。</div>';
    } else {
      jdHtml = '<div class="insp-note bad">没有存到正文。</div>';
    }

    elInspTitle.textContent = (job.jobTitle || '未命名') + ' · ' + (job.company || '—');
    elInspBody.innerHTML =
      '<div class="insp-sec"><h5>原始字段</h5><dl class="kvline">' +
        fieldRow('职位', esc(job.jobTitle || '—') + srcBadge(src.jobTitle)) +
        fieldRow('公司', esc(job.company || '—') + srcBadge(src.company)) +
        fieldRow('薪资', esc(job.salaryText || '—') + srcBadge(src.salary)) +
        fieldRow('城市', esc(job.city || '—') + srcBadge(src.city)) +
        fieldRow('经验', esc(job.experienceText || '—') + srcBadge(src.experience)) +
        fieldRow('平台', esc(job.siteName || '—')) +
        fieldRow('挂牌', U.fmtDate(job.firstSeen) + ' 起 · 见到 ' + (job.seenCount || 1) + ' 次 · ' +
          days(job) + ' 天') +
        fieldRow('族群', esc(job.groupLabel || '未归类')) +
        fieldRow('链接', job.url
          ? '<a href="#" data-url="' + esc(job.url) + '">' + esc(U.ellipsis(job.url, 90)) + '</a>'
          : '—') +
      '</dl>' +
      (src.company === '列表匹配'
        ? '<div class="insp-note bad">公司名来自左侧列表卡片，可能不是本岗位所属公司——' +
          '涉及公司性质的判断请忽略这条结论。</div>' : '') +
      (src.salary === '字形混淆'
        ? '<div class="insp-note bad">薪资被站点字形混淆且未能还原，模型看到的是空值。</div>' : '') +
      '</div>' +
      renderJudgeSection(job) +
      '<div class="insp-sec"><h5>判定历史</h5><div class="insp-hist">' +
        historySection(job) + '</div></div>' +
      '<div class="insp-sec"><h5>岗位正文</h5>' + jdHtml + '</div>' +
      '<div class="insp-sec"><h5>重新判定</h5>' +
        '<div class="insp-note">' +
          (jd ? '用同一个标准、同一段正文重跑一次。会计入今日调用与花费，并覆盖这条记录的结论。'
              : '没有正文，无法在弹窗里重新判定。') +
        '</div>' +
        '<div class="st-result insp-judge-result"></div>' +
      '</div>';

    elInspRejudge.disabled = !jd || judging;
    elInspRejudge.textContent = judging ? '判定中…' : '重新判定';
  }

  function openInspector(key) {
    var job = byKey(key);
    if (!job) return;
    inspectKey = key;
    judging = false;
    /* 每次打开都重取一遍：上一次打开之后可能又在面板外判过（另一个窗口 /
       页面上的面板），缓存直接复用会显示过期轨迹。 */
    delete logCache[key];
    elInsp.style.display = 'flex';
    renderInspector(job);

    var opening = key;
    loadLog(key).then(function () {
      /* 期间可能已经切到别的岗位：那就别往当前屏上糊上一个岗位的轨迹 */
      if (inspectKey !== opening) return;
      var fresh = byKey(opening);
      if (fresh) renderHistorySection(fresh);
    });
  }

  function closeInspector() {
    if (judgePort) {
      try { judgePort.disconnect(); } catch (e) { /* 已断开 */ }
      judgePort = null;
    }
    judging = false;
    inspectKey = '';
    elInsp.style.display = 'none';
  }

  /* 重新判定：走和内容脚本同一条端口与同一套旗标（force 跳过缓存）。
     结论回来后用 JOB_PATCH 写回记录——不能走 SAVE，那会涨 seenCount。 */
  function onRejudge() {
    var job = byKey(inspectKey);
    if (!job) return;
    if (!job.jdText) return;
    if (judging) return;

    if (!window.chrome || !chrome.runtime || !chrome.runtime.connect) {
      setJudgeResult('当前环境不支持重新判定', true);
      return;
    }

    var port;
    try {
      port = chrome.runtime.connect({ name: 'jr-judge' });
    } catch (e) {
      setJudgeResult('无法连接后台：' + (e.message || e), true);
      return;
    }

    judging = true;
    judgePort = port;
    elInspRejudge.disabled = true;
    elInspRejudge.textContent = '判定中…';
    setJudgeResult('请求已发出…', false);

    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'DELTA') {
        setJudgeResult('模型输出中… 已收 ' + (msg.chars || 0) + ' 字', false);
        return;
      }
      if (msg.type === 'DONE') {
        finishRejudge();
        var v = msg.verdict || {};
        send({
          type: 'JOB_PATCH',
          key: job.key,
          patch: {
            grade: v.grade,
            score: v.score,
            gradeLabel: gradeLabel(v.grade),
            modelGrade: v.grade,
            modelScore: v.score,
            oneLine: v.oneLine || '',
            profileName: v.profileName || '',
            judgeSource: 'model',
            judgedAt: v.createdAt || Date.now()
          }
        }).then(function (res) {
          if (!res.ok) {
            setJudgeResult('结论已拿到，但写回记录失败：' + (res.error || ''), true);
            return;
          }
          /* 先刷轨迹再重绘：后台已经写完（含 appendLog），但本地缓存还是旧的，
             直接 load() 会画出一段"少了刚才这次"的轨迹。 */
          return loadLog(job.key).then(load).then(function () {
            var fresh = byKey(job.key);
            if (fresh) renderInspector(fresh);
            setJudgeResult('已更新结论：' + gradeLabel(v.grade) + ' ' + (v.score || 0) + ' 分', false);
          });
        });
        return;
      }
      if (msg.type === 'FAIL') {
        finishRejudge();
        setJudgeResult('失败：' + (msg.error || msg.code || '未知错误'), true);
      }
    });

    port.onDisconnect.addListener(function () {
      if (!judging) return;
      finishRejudge();
      setJudgeResult('连接中断（后台可能已休眠），请重试', true);
    });

    port.postMessage({
      type: 'START',
      jobKey: job.key,
      jdText: job.jdText,
      fields: {
        jobTitle: job.jobTitle,
        company: job.company,
        salaryText: job.salaryText,
        city: job.city,
        experienceText: job.experienceText,
        sources: job.sources || {}
      },
      sources: job.sources || {},
      force: true
    });
  }

  function finishRejudge() {
    judging = false;
    judgePort = null;
    elInspRejudge.disabled = false;
    elInspRejudge.textContent = '重新判定';
  }

  function setJudgeResult(text, bad) {
    /* 这块是检查器重绘时新建的，不能缓存引用，也不能用 getElementById 扫描
       （它是运行时才存在的节点，静态 id 完整性检查会误报）。 */
    var box = elInspBody.querySelector ? elInspBody.querySelector('.insp-judge-result') : null;
    if (!box) return;
    box.innerHTML = text
      ? '<div class="res ' + (bad ? 'bad' : 'ok') + '">' + esc(text) + '</div>'
      : '';
  }

  /* ---------- 导出 ---------- */
  function meta() {
    return {
      version: (window.chrome && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version : ''
    };
  }

  function exportCSV() {
    if (!view.length) return;
    download('岗位雷达-' + X.stamp() + '.csv',
      X.BOM + X.toCSV(view, verdictMap), 'text/csv;charset=utf-8');
  }

  function exportMarkdown() {
    if (!view.length) return;
    download('岗位雷达-' + X.stamp() + '.md',
      X.toMarkdown(view, verdictMap, meta()), 'text/markdown;charset=utf-8');
  }

  function exportJSON() {
    if (!view.length) return;
    download('岗位雷达-' + X.stamp() + '.json',
      X.toJSON(view, verdictMap, meta()), 'application/json;charset=utf-8');
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 800);
  }

  /* ---------- 事件 ---------- */
  function bind() {
    elQ.addEventListener('input', applyFilter);
    elGroup.addEventListener('change', applyFilter);
    elGrade.addEventListener('change', applyFilter);

    document.getElementById('exportCsv').addEventListener('click', exportCSV);
    document.getElementById('exportMd').addEventListener('click', exportMarkdown);
    document.getElementById('exportJson').addEventListener('click', exportJSON);

    elTbody.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;

      var inspKey = t.getAttribute && t.getAttribute('data-insp');
      if (inspKey) {
        e.preventDefault();
        openInspector(inspKey);
        return;
      }

      var delKey = t.getAttribute && t.getAttribute('data-del');
      if (delKey) {
        DB.remove(delKey).then(load);
        return;
      }

      var url = t.getAttribute && t.getAttribute('data-url');
      if (url) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) chrome.tabs.create({ url: url });
      }
    });

    elInspBody.addEventListener('click', function (e) {
      var url = e.target && e.target.getAttribute && e.target.getAttribute('data-url');
      if (url && /^https?:\/\//i.test(url)) {
        e.preventDefault();
        chrome.tabs.create({ url: url });
      }
    });

    elInspBack.addEventListener('click', closeInspector);
    elInspRejudge.addEventListener('click', onRejudge);

    document.getElementById('clearAll').addEventListener('click', function () {
      if (!all.length) return;
      if (!confirm('确认清空本地库？共 ' + all.length + ' 条记录，清空后不可恢复。')) return;
      DB.clearAll().then(load);
    });
  }

  /* ---------- 加载 ---------- */
  function loadVerdicts() {
    return send({ type: 'VERDICTS_ALL' }).then(function (res) {
      verdictList = (res && res.ok && res.list) || [];
      verdictMap = X.indexVerdicts(verdictList);
    }).catch(function () {
      verdictList = [];
      verdictMap = {};
    });
  }

  function load() {
    return Promise.all([DB.getAll(), loadVerdicts()]).then(function (r) {
      all = r[0] || [];
      renderStats();
      applyFilter();
      if (inspectKey) {
        var job = byKey(inspectKey);
        if (job) renderInspector(job);
        else closeInspector();
      }
    }).catch(function (err) {
      console.error('[岗位雷达] 读取本地库失败：', err);
      elEmpty.style.display = 'block';
      elEmpty.innerHTML = EMPTY_ERR;
    });
  }

  function init() {
    if (inited) return;
    inited = true;

    elQ = document.getElementById('q');
    elGroup = document.getElementById('group');
    elGrade = document.getElementById('grade');
    elTbody = document.getElementById('tbody');
    elEmpty = document.getElementById('empty');
    elTbl = document.getElementById('tbl');
    elStats = document.getElementById('stats');

    elInsp = document.getElementById('inspector');
    elInspTitle = document.getElementById('inspTitle');
    elInspBody = document.getElementById('inspBody');
    elInspBack = document.getElementById('inspBack');
    elInspRejudge = document.getElementById('inspRejudge');

    initGroupOptions();
    bind();
  }

  /* 内容脚本保存新岗位后 popup 不会自动知道，
     所以每次切回本视图都重读一次（数据量小，代价可忽略）。 */
  function onShow() {
    load();
  }

  window.JR_VIEW_LIBRARY = {
    init: init,
    onShow: onShow,
    reload: load,
    openInspector: openInspector
  };
})();
