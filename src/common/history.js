/* 岗位雷达 · 判定历史（纯函数）
 *
 * 为什么需要单独一层：`verdicts` 的主键是 [key, profileId]，同一标准重判会**覆盖**，
 * 那是缓存要的语义（永远只有"最新一份"最省事），但"轨迹"就没了。
 * 所以落库时再往 `verdictlog` 追加一条精简记录，本文件负责两件事：
 *   1. 把完整 verdict 剪成能长期留的日志条目（剔除正文、证据原文这些大字段）
 *   2. 把一堆日志条目整理成可比较的时间线：哪次换了标准、哪次改了正文、分数怎么走
 *
 * 这里不做任何 IO，也不认识 DOM。理由是"轨迹怎么算"是这个功能里最容易出错、
 * 也最值得反复验证的部分（跨标准比分数是无意义的），把它做成纯函数才测得动。
 */
(function (global) {
  'use strict';

  /* 每个岗位保留的日志条数上限。超过就丢最旧的。
     30 次足够看出一个岗位是"改过 JD 重新挂"还是"反复刷新"，
     再多的记录只会让 IndexedDB 变大、检查器变长。 */
  var MAX_PER_JOB = 30;

  /* 每条日志保留的结论摘要长度：只够在列表里认出"是哪次判定" */
  var MAX_ONE_LINE = 80;

  var GRADE_LEVEL = { poor: 1, weak: 2, neutral: 3, strong: 4 };

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

  /* 两条记录的正文是不是同一版。
   * jdHash 只取前 800 字（提示词的指纹口径），所以必须同时比总字数：
   *   - 只看 hash：800 字之后的改动看不出来
   *   - 只看字数：等长替换（"3 人"改成"5 人"）看不出
   * 缺任一字段的老记录返回 null —— "不知道"和"没变"必须区分，
   * 否则升级前的旧记录会和第一条新记录之间凭空出现一个"正文有改动"。
   */
  function sameJd(a, b) {
    if (!a || !b) return null;
    var ha = str(a.jdHash);
    var hb = str(b.jdHash);
    if (!ha || !hb) return null;
    var ca = num(a.jdChars, -1);
    var cb = num(b.jdChars, -1);
    if (ca < 0 || cb < 0) return null;
    return ha === hb && ca === cb;
  }

  /* 完整 verdict → 日志条目。
   * 刻意不存 jdText / evidence 原文：正文按 key 存在 jobs 表里，
   * 证据原文在最新那份 verdict 里；日志只回答"什么时候、按什么标准、判成什么样"。
   * 试跑（dryRun）不进历史：它用的是屏幕上还没保存的标准，
   * 混进来会让"同一岗位的档位轨迹"出现一条无法复现的点。 */
  function toLogEntry(v) {
    if (!v || !v.key || v.dryRun) return null;
    var u = v.usage || {};
    var check = v.evidenceCheck || null;
    return {
      key: str(v.key),
      profileId: str(v.profileId),
      profileName: str(v.profileName),
      profileVersion: num(v.profileVersion, 0),
      grade: str(v.grade),
      score: v.score == null ? null : num(v.score, null),
      confidence: v.confidence == null ? null : num(v.confidence, null),
      model: str(v.model),
      jdHash: str(v.jdHash),
      jdChars: num(v.jdChars, 0),
      evidenceFlag: str(v.evidenceFlag),
      evidenceRate: check ? num(check.rate, null) : null,
      inTokens: num(u.in, 0),
      outTokens: num(u.out, 0),
      totalTokens: num(u.total, 0),
      cost: num(v.cost, 0),
      ms: num(v.ms, 0),
      oneLine: str(v.oneLine).slice(0, MAX_ONE_LINE),
      createdAt: num(v.createdAt, Date.now())
    };
  }

  function asc(a, b) {
    var d = num(a.createdAt, 0) - num(b.createdAt, 0);
    if (d) return d;
    /* 同一毫秒内的两条（重判很快时可能发生）用标准 id 兜底，
       保证同一份数据每次算出来的顺序一致——否则轨迹条会随机抖动。 */
    return str(a.profileId).localeCompare(str(b.profileId));
  }

  /* 时间线：entries 里混着不同标准、不同时间，整理成按时间正序的行。
   * 每一行带三个判断，它们各自回答一个问题：
   *   jdChanged      → 这次看的是不是同一版 JD
   *   profileChanged → 换了标准，分数不可与上一条直接比
   *   scoreDelta     → 只有同标准时才算，否则 null（跨标准比分数没有意义）
   */
  function buildTimeline(entries) {
    var list = (entries || []).filter(function (e) {
      return e && e.key != null;
    }).slice().sort(asc);

    var rows = [];
    var prev = null;
    var hashes = {};

    list.forEach(function (e, i) {
      var same = prev ? sameJd(prev, e) : null;
      var sameProfile = prev ? str(prev.profileId) === str(e.profileId) : false;
      var delta = null;
      if (sameProfile && prev && prev.score != null && e.score != null) {
        delta = num(e.score, 0) - num(prev.score, 0);
      }

      var key = str(e.jdHash) + '|' + num(e.jdChars, 0);
      if (e.jdHash) hashes[key] = 1;

      rows.push({
        index: i,
        entry: e,
        jdChanged: same === null ? null : !same,
        profileChanged: prev ? !sameProfile : false,
        scoreDelta: delta,
        gradeChanged: prev ? str(prev.grade) !== str(e.grade) : false
      });
      prev = e;
    });

    var perProfile = [];
    var byId = {};

    rows.forEach(function (r) {
      var e = r.entry;
      var id = str(e.profileId);
      var bucket = byId[id];
      if (!bucket) {
        bucket = byId[id] = {
          profileId: id,
          profileName: str(e.profileName),
          versions: {},
          count: 0,
          grades: [],
          scores: [],
          first: e,
          last: e,
          cost: 0,
          tokens: 0
        };
        perProfile.push(bucket);
      }
      bucket.count++;
      bucket.versions[num(e.profileVersion, 0)] = 1;
      if (e.grade) bucket.grades.push(str(e.grade));
      if (e.score != null) bucket.scores.push(num(e.score, 0));
      bucket.last = e;             /* 已按时间正序遍历，后写覆盖前写 */
      bucket.cost += num(e.cost, 0);
      bucket.tokens += num(e.totalTokens, 0);
    });

    perProfile.forEach(function (b) {
      var scores = b.scores;
      b.versionCount = Object.keys(b.versions).length;
      b.maxVersion = Math.max.apply(null, Object.keys(b.versions).map(Number));
      b.firstScore = scores.length ? scores[0] : null;
      b.lastScore = scores.length ? scores[scores.length - 1] : null;
      b.delta = (scores.length > 1) ? b.lastScore - b.firstScore : null;
      b.best = scores.length ? Math.max.apply(null, scores) : null;
      b.worst = scores.length ? Math.min.apply(null, scores) : null;
      b.trend = trendOf(b.firstScore, b.lastScore, scores.length);
      b.cost = Math.round(b.cost * 1e6) / 1e6;
    });

    /* 记录次数多的标准排在前面：那是你真正在用的那把尺子 */
    perProfile.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return str(a.profileName).localeCompare(str(b.profileName));
    });

    var first = rows.length ? rows[0].entry : null;
    var last = rows.length ? rows[rows.length - 1].entry : null;
    var jdChanges = rows.filter(function (r) { return r.jdChanged === true; }).length;

    return {
      rows: rows,
      stats: {
        count: rows.length,
        profileCount: perProfile.length,
        jdVersions: Object.keys(hashes).length,
        jdChanges: jdChanges,
        firstAt: first ? first.createdAt : null,
        lastAt: last ? last.createdAt : null,
        spanDays: (first && last)
          ? Math.round((num(last.createdAt, 0) - num(first.createdAt, 0)) / 86400000)
          : 0,
        firstGrade: first ? first.grade : '',
        lastGrade: last ? last.grade : '',
        perProfile: perProfile
      }
    };
  }

  function trendOf(from, to, count) {
    if (from == null || to == null || count < 2) return 'flat';
    if (to - from >= 5) return 'up';
    if (from - to >= 5) return 'down';
    return 'flat';
  }

  function gradeLabel(g) {
    var G = (global.JR_RULES && global.JR_RULES.GRADE_INFO) || null;
    if (G && G[g] && G[g].label) return G[g].label;
    if (global.JR_VERDICT && global.JR_VERDICT.GRADE_INFO && global.JR_VERDICT.GRADE_INFO[g]) {
      return global.JR_VERDICT.GRADE_INFO[g].label;
    }
    var fallback = {
      strong: '强信号', neutral: '中性', weak: '偏弱', poor: '高概率伪岗',
      insufficient: '信息不足', irrelevant: '不相关'
    };
    return fallback[g] || (g || '—');
  }

  /* 给检查器用的一句话汇总。做成纯函数是为了让文案也能被断言：
   * "跨 2 个标准"如果在 UI 里临时拼，测试就只能去正则匹配 HTML。 */
  function describe(stats) {
    if (!stats || !stats.count) return { main: '还没有判定记录', detail: '' };

    var parts = ['判过 ' + stats.count + ' 次'];
    if (stats.profileCount > 1) parts.push('跨 ' + stats.profileCount + ' 个标准');
    if (stats.jdChanges > 0) parts.push('正文改过 ' + stats.jdChanges + ' 次');
    if (stats.spanDays >= 1) parts.push('跨度 ' + stats.spanDays + ' 天');

    var details = stats.perProfile.slice(0, 2).map(function (b) {
      var name = b.profileName || '未命名标准';
      if (b.count < 2) return '「' + name + '」只判过 1 次';
      var head = '「' + name + '」' + b.firstScore + ' → ' + b.lastScore;
      if (b.delta === 0) return head + '（持平）';
      return head + '（' + (b.delta > 0 ? '↑' : '↓') + Math.abs(b.delta) + '）';
    });

    return { main: parts.join(' · '), detail: details.join('；') };
  }

  /* 分数变化的口径：跨标准不比、缺值不比 */
  function deltaText(row) {
    if (!row || row.scoreDelta == null) return '';
    if (row.scoreDelta === 0) return '持平';
    return (row.scoreDelta > 0 ? '↑' : '↓') + Math.abs(row.scoreDelta);
  }

  function levelOf(g) {
    return GRADE_LEVEL[g] || 0;
  }

  global.JR_HISTORY = {
    toLogEntry: toLogEntry,
    sameJd: sameJd,
    buildTimeline: buildTimeline,
    describe: describe,
    deltaText: deltaText,
    gradeLabel: gradeLabel,
    levelOf: levelOf,
    MAX_PER_JOB: MAX_PER_JOB,
    MAX_ONE_LINE: MAX_ONE_LINE
  };
})(typeof window !== 'undefined' ? window : globalThis);
