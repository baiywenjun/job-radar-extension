/* 岗位雷达 · popup 视图：岗位库
 * 逻辑与 v0.1.5 保持一致，只改成模块形态（init / onShow），
 * 避免每次切回岗位库都读一遍库。
 */
(function () {
  'use strict';

  var U = window.JR_UTIL;
  var R = window.JR_RULES;
  var DB = window.JR_DB;

  var all = [];
  var view = [];
  var inited = false;

  var elQ, elGroup, elGrade, elTbody, elEmpty, elTbl, elStats;

  var EMPTY_NONE =
    '<b>还没有记录。</b><br>打开 BOSS 直聘 / 猎聘 / 脉脉 / 国聘 的岗位详情页，<br>' +
    '在右侧面板点「保存到本地库」<code>即可入库</code>。';
  var EMPTY_FILTER = '<b>没有符合筛选条件的记录。</b><br>换个关键词或把筛选条件重置。';
  var EMPTY_ERR = '<b>读取本地库失败。</b><br>请关闭并重新打开扩展面板。';

  function days(rec) {
    return U.daysBetween(rec.firstSeen);
  }

  function gradeLabel(g) {
    return (R.GRADE_INFO[g] && R.GRADE_INFO[g].label) || g || '—';
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
    var hay = [
      r.jobTitle, r.company, r.city, r.groupLabel, r.salaryText,
      (r.strong || []).join(' '),
      (r.weak || []).join(' '),
      (r.actions || []).join(' '),
      (r.metrics || []).join(' ')
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
      var title = '首次 ' + U.fmtDate(r.firstSeen) + ' · 末次 ' + U.fmtDate(r.lastSeen) + ' · 见到 ' + (r.seenCount || 1) + ' 次';
      return (
        '<tr>' +
        '<td><span class="sc ' + (r.grade || '') + '" title="' + U.escapeHtml(gradeLabel(r.grade)) + '">' + (r.score || 0) + '</span></td>' +
        '<td class="jt"><a href="#" data-url="' + U.escapeHtml(r.url || '') + '" title="' + U.escapeHtml(r.jobTitle || '') + '">' + U.escapeHtml(r.jobTitle || '未命名') + '</a></td>' +
        '<td class="co" title="' + U.escapeHtml(r.company || '') + '">' + U.escapeHtml(r.company || '—') + '</td>' +
        '<td class="sal">' + U.escapeHtml(r.salaryText || '—') + '</td>' +
        '<td>' + U.escapeHtml(r.city || '—') + '</td>' +
        '<td><span class="grp">' + U.escapeHtml(r.groupShort || '未归类') + '</span></td>' +
        '<td class="days' + staleCls + '" title="' + U.escapeHtml(title) + '">' + d + ' 天</td>' +
        '<td><button class="del" data-del="' + U.escapeHtml(r.key) + '" title="删除该记录">×</button></td>' +
        '</tr>'
      );
    }).join('');
  }

  /* ---------- 导出 ---------- */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCSV() {
    var headers = [
      '评分', '档位', '族群', '职位', '公司', '薪资', '城市', '经验', '平台',
      '首次记录', '最后见到', '见到次数', '挂牌天数', '强信号', '减分项', '链接'
    ];
    var rows = [headers.map(csvCell).join(',')];
    view.forEach(function (r) {
      rows.push([
        r.score || 0,
        gradeLabel(r.grade),
        r.groupLabel || '',
        r.jobTitle || '',
        r.company || '',
        r.salaryText || '',
        r.city || '',
        r.experienceText || '',
        r.siteName || '',
        U.fmtDate(r.firstSeen),
        U.fmtDate(r.lastSeen),
        r.seenCount || 1,
        days(r),
        (r.strong || []).join(' / '),
        (r.weak || []).join(' / '),
        r.url || ''
      ].map(csvCell).join(','));
    });
    download('岗位雷达-' + stamp() + '.csv', '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function exportMarkdown() {
    var lines = [];
    lines.push('# 岗位雷达 · 本地岗位库');
    lines.push('');
    lines.push('导出时间：' + U.fmtDateTime(Date.now()) + ' · 共 ' + view.length + ' 条');
    lines.push('');
    lines.push('> 仅包含本人浏览并保存的公开挂牌岗位，样本有偏，不代表全市场缺口。');
    lines.push('');
    lines.push('| 评分 | 档位 | 职位 | 公司 | 薪资 | 城市 | 族群 | 挂牌 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    view.forEach(function (r) {
      lines.push('| ' + [
        r.score || 0,
        gradeLabel(r.grade),
        md(r.jobTitle),
        md(r.company),
        md(r.salaryText),
        md(r.city),
        md(r.groupShort),
        days(r) + ' 天'
      ].join(' | ') + ' |');
    });
    lines.push('');
    lines.push('## 打分明细');
    lines.push('');
    view.forEach(function (r) {
      lines.push('### ' + (r.jobTitle || '未命名') + ' · ' + (r.company || '—'));
      lines.push('');
      lines.push('- 评分：' + (r.score || 0) + ' / ' + gradeLabel(r.grade) + '（' + (r.groupLabel || '未归类') + '）');
      lines.push('- 强信号：' + ((r.strong || []).join('、') || '无'));
      lines.push('- 减分项：' + ((r.weak || []).join('、') || '无'));
      lines.push('- 链接：' + (r.url || '—'));
      lines.push('');
    });
    download('岗位雷达-' + stamp() + '.md', lines.join('\n'), 'text/markdown;charset=utf-8');
  }

  function md(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function stamp() {
    var d = new Date();
    return U.fmtDate(Date.now()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
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

    elTbody.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;

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

    document.getElementById('clearAll').addEventListener('click', function () {
      if (!all.length) return;
      if (!confirm('确认清空本地库？共 ' + all.length + ' 条记录，清空后不可恢复。')) return;
      DB.clearAll().then(load);
    });
  }

  /* ---------- 加载 ---------- */
  function load() {
    return DB.getAll().then(function (list) {
      all = list || [];
      renderStats();
      applyFilter();
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
    reload: load
  };
})();
