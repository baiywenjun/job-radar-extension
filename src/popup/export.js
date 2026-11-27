/* 岗位雷达 · 导出
 *
 * 独立成纯函数模块，不碰 DOM、不碰 chrome API：
 *   - 三个格式（CSV / MD / JSON）的字段口径必须一致，放在一起才不会各改各的
 *   - 这样测试可以直接喂数组进来比对字符串，不用搭 jsdom 再点按钮
 *
 * 导出的是「岗位记录 + 最近一次判定」，不是两份数据各导一份。
 * 判定里的 oneLine / evidence.quote / profileVersion 才是这份数据真正贵的部分，
 * 只导岗位字段等于把模型结论丢了。
 */
(function (global) {
  'use strict';

  var U = global.JR_UTIL;
  var R = global.JR_RULES;

  var BOM = '\ufeff';

  function gradeLabel(g) {
    return (R && R.GRADE_INFO && R.GRADE_INFO[g] && R.GRADE_INFO[g].label) || g || '';
  }

  /* 同一岗位可能有多个标准的判定，且标准会改版。
     关联用「最近一次」：导出要回答的是「现在这条记录值不值得投」，
     不是考古。想考古用检查器里的完整历史。 */
  function indexVerdicts(list) {
    var map = {};
    (list || []).forEach(function (v) {
      if (!v || !v.key) return;
      var cur = map[v.key];
      if (!cur || (Number(v.createdAt) || 0) > (Number(cur.createdAt) || 0)) map[v.key] = v;
    });
    return map;
  }

  function verdictOf(job, map) {
    return (map && job && map[job.key]) || null;
  }

  function days(job) {
    return U && U.daysBetween ? U.daysBetween(job.firstSeen) : 0;
  }

  function evidenceText(v) {
    if (!v || !v.evidence || !v.evidence.length) return '';
    return v.evidence.map(function (e) {
      var q = e.quote ? '「' + String(e.quote).replace(/\s+/g, ' ') + '」' : '';
      var mark = e.verified === false ? '（未核实）' : '';
      return (e.claim || '') + mark + (q ? ' ' + q : '');
    }).join(' ‖ ');
  }

  function evidenceList(v, type) {
    return (v && v.evidence || [])
      .filter(function (e) { return !type || e.type === type; })
      .map(function (e) {
        return {
          claim: e.claim || '',
          quote: e.quote || '',
          verified: e.verified !== false,
          type: e.type || ''
        };
      });
  }

  /* 一条记录 = 一个扁平对象。CSV / MD / JSON 都从它取，
     字段名改动只改这一处，三个格式不会漂。 */
  function shape(job, v) {
    var judged = !!(v && v.grade);
    return {
      key: job.key || '',
      score: judged ? (v.score || 0) : (job.score || 0),
      grade: judged ? v.grade : (job.grade || ''),
      gradeLabel: gradeLabel(judged ? v.grade : job.grade),
      oneLine: (v && v.oneLine) || job.oneLine || '',
      judgeSource: judged ? '模型' : '本地规则',
      model: (v && v.model) || '',
      profileName: (v && v.profileName) || job.profileName || '',
      profileVersion: (v && v.profileVersion) || null,
      confidence: (v && typeof v.confidence === 'number') ? v.confidence : null,
      judgedAt: (v && v.createdAt) || 0,
      evidence: evidenceList(v),
      evidenceCheck: (v && v.evidenceCheck) || null,
      evidenceFlag: (v && v.evidenceFlag) || '',
      missing: (v && v.missing) || [],
      risks: (v && v.risks) || [],
      groupLabel: job.groupLabel || '',
      jobTitle: job.jobTitle || '',
      company: job.company || '',
      salaryText: job.salaryText || '',
      city: job.city || '',
      experienceText: job.experienceText || '',
      siteName: job.siteName || '',
      firstSeen: job.firstSeen || 0,
      lastSeen: job.lastSeen || 0,
      seenCount: job.seenCount || 1,
      days: days(job),
      strong: job.strong || [],
      weak: job.weak || [],
      jdLength: job.jdLength || (job.jdText ? String(job.jdText).length : 0),
      url: job.url || ''
    };
  }

  function rows(jobs, map) {
    return (jobs || []).map(function (j) { return shape(j, verdictOf(j, map)); });
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  var CSV_HEADERS = [
    '评分', '档位', '一句话结论', '判定来源', '模型', '标准', '标准版本', '置信度',
    '判定时间', '族群', '职位', '公司', '薪资', '城市', '经验', '平台',
    '首次记录', '最后见到', '见到次数', '挂牌天数',
    '强信号', '减分项', '证据与原文', '缺失项', '风险项', '链接'
  ];

  function toCSV(jobs, map) {
    var list = rows(jobs, map);
    var out = [CSV_HEADERS.map(csvCell).join(',')];
    list.forEach(function (r) {
      out.push([
        r.score,
        r.gradeLabel,
        r.oneLine,
        r.judgeSource,
        r.model,
        r.profileName,
        r.profileVersion == null ? '' : 'v' + r.profileVersion,
        r.confidence == null ? '' : r.confidence,
        r.judgedAt ? U.fmtDateTime(r.judgedAt) : '',
        r.groupLabel,
        r.jobTitle,
        r.company,
        r.salaryText,
        r.city,
        r.experienceText,
        r.siteName,
        U.fmtDate(r.firstSeen),
        U.fmtDate(r.lastSeen),
        r.seenCount,
        r.days,
        (r.strong || []).join(' / '),
        (r.weak || []).join(' / '),
        r.evidence.map(function (e) {
          return e.claim + (e.quote ? ' 「' + String(e.quote).replace(/\s+/g, ' ') + '」' : '') +
            (e.verified ? '' : '（未核实）');
        }).join(' ‖ '),
        (r.missing || []).join(' / '),
        (r.risks || []).join(' / '),
        r.url
      ].map(csvCell).join(','));
    });
    return out.join('\r\n');
  }

  function md(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  }

  function toMarkdown(jobs, map, meta) {
    meta = meta || {};
    var list = rows(jobs, map);
    var lines = [];
    lines.push('# 岗位雷达 · 本地岗位库');
    lines.push('');
    lines.push('导出时间：' + U.fmtDateTime(Date.now()) + ' · 共 ' + list.length + ' 条' +
      (meta.profileName ? ' · 当前标准 ' + meta.profileName : ''));
    lines.push('');
    lines.push('> 仅包含本人浏览并保存的公开挂牌岗位，样本有偏，不代表全市场缺口。');
    lines.push('> 判定为「模型」的记录带一句话结论与原文证据；「本地规则」为词库打分，仅供参考。');
    lines.push('');

    lines.push('| 评分 | 档位 | 职位 | 公司 | 薪资 | 城市 | 判定 |');
    lines.push('|---|---|---|---|---|---|---|');
    list.forEach(function (r) {
      lines.push('| ' + [
        r.score, md(r.gradeLabel), md(r.jobTitle), md(r.company),
        md(r.salaryText), md(r.city), r.judgeSource
      ].join(' | ') + ' |');
    });
    lines.push('');

    lines.push('## 判定明细');
    lines.push('');
    list.forEach(function (r) {
      lines.push('### ' + (r.jobTitle || '未命名') + ' · ' + (r.company || '—'));
      lines.push('');
      lines.push('- 评分：' + r.score + ' / ' + (r.gradeLabel || '—') +
        (r.confidence != null ? '（置信度 ' + r.confidence + '）' : ''));
      lines.push('- 判定来源：' + r.judgeSource +
        (r.model ? ' · ' + r.model : '') +
        (r.profileName ? ' · 标准 ' + r.profileName + (r.profileVersion ? ' v' + r.profileVersion : '') : '') +
        (r.judgedAt ? ' · ' + U.fmtDateTime(r.judgedAt) : ''));
      if (r.oneLine) lines.push('- 结论：' + r.oneLine);
      if (r.evidence.length) {
        lines.push('- 证据：');
        r.evidence.forEach(function (e) {
          var tag = e.type === 'red' ? '减分' : (e.type === 'nice' ? '加分' : '要求');
          lines.push('  - [' + tag + '] ' + e.claim +
            (e.quote ? ' — 原文「' + e.quote + '」' : '') +
            (e.verified ? '' : '（**未能核实**：原文里找不到这段引用）'));
        });
      }
      if (r.missing.length) lines.push('- 缺失项：' + r.missing.join('、'));
      if (r.risks.length) lines.push('- 风险：' + r.risks.join('、'));
      if (r.evidenceFlag === 'E_BAD_EVIDENCE') {
        lines.push('- ⚠ 引用大面积对不上原文，置信度已打折，请回原文核对。');
      }
      lines.push('- 挂牌：首次 ' + U.fmtDate(r.firstSeen) + ' · 见到 ' + r.seenCount + ' 次 · ' + r.days + ' 天');
      lines.push('- 链接：' + (r.url || '—'));
      lines.push('');
    });
    return lines.join('\n');
  }

  function toJSON(jobs, map, meta) {
    meta = meta || {};
    var list = rows(jobs, map);
    var payload = {
      generator: 'job-radar',
      version: meta.version || '',
      exportedAt: new Date().toISOString(),
      activeProfile: meta.profileName
        ? { name: meta.profileName, version: meta.profileVersion || null }
        : null,
      count: list.length,
      disclaimer: '仅包含本人浏览并保存的公开挂牌岗位，样本有偏，不代表全市场缺口。',
      jobs: (jobs || []).map(function (j, i) {
        var r = list[i];
        return {
          key: r.key,
          url: r.url,
          platform: r.siteName,
          jobTitle: r.jobTitle,
          company: r.company,
          salaryText: r.salaryText,
          city: r.city,
          experienceText: r.experienceText,
          group: r.groupLabel,
          firstSeen: r.firstSeen ? new Date(r.firstSeen).toISOString() : '',
          lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : '',
          seenCount: r.seenCount,
          listedDays: r.days,
          ruleScore: j.score || 0,
          ruleGrade: gradeLabel(j.grade),
          /* 判定与岗位字段分开一层：导出后能一眼看出哪个是模型给的、
             哪个是词库算的，也能看出用的是哪一版标准。 */
          verdict: r.judgeSource === '模型' ? {
            grade: r.grade,
            gradeLabel: r.gradeLabel,
            score: r.score,
            confidence: r.confidence,
            oneLine: r.oneLine,
            evidence: r.evidence,
            evidenceCheck: r.evidenceCheck,
            evidenceFlag: r.evidenceFlag,
            missing: r.missing,
            risks: r.risks,
            model: r.model,
            profileName: r.profileName,
            profileVersion: r.profileVersion,
            judgedAt: r.judgedAt ? new Date(r.judgedAt).toISOString() : ''
          } : null,
          jdText: j.jdText || ''
        };
      })
    };
    return JSON.stringify(payload, null, 2);
  }

  function stamp(now) {
    var d = new Date(typeof now === 'number' ? now : Date.now());
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return U.fmtDate(d.getTime()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  global.JR_EXPORT = {
    indexVerdicts: indexVerdicts,
    verdictOf: verdictOf,
    rows: rows,
    shape: shape,
    csvCell: csvCell,
    toCSV: toCSV,
    toMarkdown: toMarkdown,
    toJSON: toJSON,
    evidenceText: evidenceText,
    stamp: stamp,
    CSV_HEADERS: CSV_HEADERS,
    BOM: BOM
  };
})(typeof window !== 'undefined' ? window : globalThis);
