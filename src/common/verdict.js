/* 岗位雷达 · 模型结论的结构与映射
 *
 * 三件事：
 *   1. 把模型返回的自由文本收成受控对象（契约校验）——模型会夹带代码块、前后缀说明、
 *      有时把档位写成 "High"；
 *   2. 把「档位 + 置信度」映射成分数——**模型不给分数**。同一份 JD 调两次，
 *      模型给的分数会抖十几分，历史记录就失去可比性；档位比分数稳得多。
 *   3. 把结论映射成面板认识的 ev 结构——面板不认识模型，只认识 ev。
 *
 * 分数区间与 rules.js 的档位阈值严格对齐（80/55/35），所以面板的圆环、配色、
 * 阈值判定一行都不用改。
 */
(function (global) {
  'use strict';

  var GRADES = ['insufficient', 'poor', 'weak', 'neutral', 'strong'];

  /* 用于"分歧判定"。insufficient / irrelevant 不参与比较：
     它们不是强度判断，而是"没法判断"。 */
  var LEVEL = { poor: 1, weak: 2, neutral: 3, strong: 4 };

  /* 与 rules.js 的 GRADE_INFO 保持一致。这里留一份兜底，
     因为 service worker 不加载词库（387 行的 rules.js 只为拿几个标签不值得）。 */
  var FALLBACK = {
    strong: { label: '强信号', desc: '有具体技术栈与建设项目，值得优先投' },
    neutral: { label: '中性', desc: '方向对得上，但证据不足以判断真假' },
    weak: { label: '偏弱', desc: '信号偏弱或存在减分项，需人工核验' },
    poor: { label: '高概率伪岗', desc: '命中多项减分项，建议直接跳过' },
    insufficient: { label: '信息不足', desc: 'JD 太短或抽取失败，不下结论' }
  };

  /* 模型偶尔会输出同义词。宽容接受，但统一收敛成语义最接近的档位。 */
  var SYNONYM = {
    high: 'strong', good: 'strong', excellent: 'strong', strong_signal: 'strong',
    medium: 'neutral', mid: 'neutral', moderate: 'neutral', uncertain: 'neutral',
    low: 'weak', weak_signal: 'weak', marginal: 'weak',
    bad: 'poor', reject: 'poor', fake: 'poor', suspicious: 'poor',
    unknown: 'insufficient', none: 'insufficient', insufficient_data: 'insufficient'
  };

  var MAX_ONE_LINE = 60;
  var MAX_EVIDENCE = 12;
  var MAX_CLAIM = 40;
  var MAX_QUOTE = 300;
  var MAX_LIST = 8;

  function jerr(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      }
    }
    return e;
  }

  function clamp(n, lo, hi) {
    if (!isFinite(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function clamp01(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function text(v, max) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  function gradeMeta(grade) {
    var R = global.JR_RULES;
    if (R && R.GRADE_INFO && R.GRADE_INFO[grade] && R.GRADE_INFO[grade].label) {
      return R.GRADE_INFO[grade];
    }
    return FALLBACK[grade] || FALLBACK.insufficient;
  }

  /* 档位 → 分数。confidence 先 clamp(0,1)，结果再按区间 clamp。
     二次 clamp 是必需的：否则浮点误差会让 strong 落到 79，
     出现"档位写强信号、圆环却是中性色"的自相矛盾。 */
  function scoreOf(grade, confidence) {
    var c = clamp01(confidence);
    switch (grade) {
      case 'strong': return clamp(Math.round(80 + c * 15), 80, 95);
      case 'neutral': return clamp(Math.round(55 + c * 24), 55, 79);
      case 'weak': return clamp(Math.round(35 + c * 19), 35, 54);
      case 'poor': return clamp(Math.round(10 + c * 24), 10, 34);
      default: return 0;
    }
  }

  function normalizeGrade(raw) {
    var g = String(raw == null ? '' : raw).trim().toLowerCase();
    if (GRADES.indexOf(g) >= 0) return g;
    if (SYNONYM[g]) return SYNONYM[g];
    return '';
  }

  /* 模型常见的包装：```json ... ```、前置一句"好的，以下是结果："
     只取最外层 {} 之间的内容，比正则剥代码块更稳。 */
  function extractObject(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/^\uFEFF/, '').replace(/[\u200b-\u200d\uFEFF]/g, '');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return '';
    return s.slice(start, end + 1);
  }

  function normalizeEvidence(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length && out.length < MAX_EVIDENCE; i++) {
      var it = arr[i];
      if (!it || typeof it !== 'object') continue;
      var claim = text(it.claim || it.term || it.point, MAX_CLAIM);
      if (!claim) continue;
      var type = String(it.type == null ? '' : it.type).toLowerCase();
      if (type !== 'must' && type !== 'nice' && type !== 'red') {
        type = 'nice';
      }
      out.push({
        type: type,
        claim: claim,
        quote: text(it.quote || it.evidence || it.source, MAX_QUOTE)
      });
    }
    return out;
  }

  function normalizeList(arr) {
    var out = [];
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length && out.length < MAX_LIST; i++) {
      var it = arr[i];
      var s = '';
      if (typeof it === 'string') s = text(it, MAX_CLAIM);
      else if (it && typeof it === 'object') s = text(it.text || it.claim || it.risk, MAX_CLAIM);
      if (s) out.push(s);
    }
    return out;
  }

  /* 契约校验：任何一项不合格都抛 E_BAD_JSON，由调用方决定重试还是降级。
     不在这里"尽量修补"，否则错误数据会静默流进面板。 */
  function normalize(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw jerr('E_BAD_JSON', '模型返回的不是对象', { reason: 'not-object' });
    }
    var grade = normalizeGrade(obj.grade);
    if (!grade) {
      throw jerr('E_BAD_JSON', '档位取值不合法：' + text(obj.grade, 20), { reason: 'bad-grade' });
    }
    var confidence = clamp01(obj.confidence == null ? 0.5 : obj.confidence);
    var oneLine = text(obj.oneLine || obj.summary || obj.conclusion, MAX_ONE_LINE);
    if (!oneLine) oneLine = gradeMeta(grade).desc;

    return {
      grade: grade,
      confidence: confidence,
      score: scoreOf(grade, confidence),
      gradeLabel: gradeMeta(grade).label,
      gradeDesc: gradeMeta(grade).desc,
      oneLine: oneLine,
      evidence: normalizeEvidence(obj.evidence),
      missing: normalizeList(obj.missing),
      risks: normalizeList(obj.risks)
    };
  }

  function parse(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) throw jerr('E_BAD_JSON', '模型返回空内容', { reason: 'empty' });
    var body = extractObject(s);
    if (!body) throw jerr('E_BAD_JSON', '模型返回内容里找不到 json 对象', { reason: 'no-object' });
    var obj;
    try {
      obj = JSON.parse(body);
    } catch (e) {
      throw jerr('E_BAD_JSON', '模型返回的 json 无法解析', { reason: 'parse' });
    }
    return normalize(obj);
  }

  /* ---------- 证据逐字校验 ----------
   * 模型编造原文比"判错"危害大得多：用户会把它当权威。
   * 做法是把 JD 与 quote 都归一化后做子串比对，任何一处对不上就标灰。
   *
   * 归一化要处理的真实差异：
   *   - 抽取的 JD 里有换行、连续空格、全角空格、零宽字符（BOSS 的私用区字形也会带）
   *   - 模型复制时把全角标点换成半角，或把弯引号换成直引号
   *   - 模型把长句中间省略成 "…"，这是可接受的，按段比对
   */
  var MIN_QUOTE = 4;
  var EVIDENCE_RATE_MIN = 0.5;

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u00ad\u200b-\u200d\uFEFF]/g, '')
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\s\u3000]+/g, '')
      .toLowerCase();
  }

  function quoteMatches(quote, hay) {
    var q = normalizeText(quote);
    if (!q || q.length < MIN_QUOTE) return false;
    if (hay.indexOf(q) >= 0) return true;
    /* 省略式引用：两段以上、每段都不短于 MIN_QUOTE，则逐段核对 */
    var parts = q.split(/\.{2,}|\u2026+/).filter(function (x) {
      return x.length >= MIN_QUOTE;
    });
    if (parts.length >= 2) {
      for (var i = 0; i < parts.length; i++) {
        if (hay.indexOf(parts[i]) < 0) return false;
      }
      return true;
    }
    return false;
  }

  /* 就地写入 verified。没有 quote 或 quote 过短的条目不算"编造"，
     算"没给出可核对的依据"，用 noQuote 区分——两者的处理不该一样。 */
  function verifyEvidence(v, jdText) {
    var list = (v && v.evidence) || [];
    var hay = normalizeText(jdText);
    var checked = 0;
    var passed = 0;

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var q = String((e && e.quote) || '');
      if (!q || normalizeText(q).length < MIN_QUOTE) {
        e.verified = false;
        e.noQuote = true;
        continue;
      }
      checked++;
      var ok = quoteMatches(q, hay);
      e.verified = ok;
      e.noQuote = false;
      if (ok) passed++;
    }

    return {
      checked: checked,
      passed: passed,
      rate: checked ? passed / checked : 0
    };
  }

  function chipNote(e) {
    if (e.verified === false) {
      return e.noQuote ? '未附原文引用，无法核对' : '未能核实：JD 原文里找不到这段引用';
    }
    return e.quote ? '原文：' + e.quote : '';
  }

  /* 面板适配层：输出必须与 rules.evaluate() 的返回值同构，
     否则 panel.js 要开始区分两种数据源，迟早出错。
     族群 / flags 仍取规则引擎的结果——模型的契约里没有词库概念。 */
  function toPanelView(verdict, rulesEval, fields) {
    var r = rulesEval || {};
    var f = fields || {};
    var v = verdict || {};

    var strong = (v.evidence || [])
      .filter(function (e) { return e.type === 'must' || e.type === 'nice'; })
      .map(function (e) {
        return {
          term: e.claim,
          note: chipNote(e),
          type: e.type,
          unverified: e.verified === false
        };
      });

    var weak = (v.evidence || [])
      .filter(function (e) { return e.type === 'red'; })
      .map(function (e) {
        return {
          term: e.claim,
          note: chipNote(e),
          type: 'red',
          unverified: e.verified === false
        };
      })
      .concat((v.risks || []).map(function (x) {
        return { term: x, note: '', type: 'risk' };
      }));

    return {
      group: r.group || 'OTHER',
      groupLabel: r.groupLabel || '未归类',
      groupShort: r.groupShort || '未归类',
      score: typeof v.score === 'number' ? v.score : scoreOf(v.grade, v.confidence),
      grade: v.grade || 'insufficient',
      gradeLabel: v.gradeLabel || gradeMeta(v.grade).label,
      gradeDesc: v.gradeDesc || gradeMeta(v.grade).desc,
      strong: strong,
      /* 模型不产出这两类，置空。面板在模型模式下会换成对应空态文案。 */
      actions: [],
      metrics: [],
      weak: weak,
      excludes: [],
      flags: Array.isArray(r.flags) ? r.flags : [],
      evidenceCount: strong.length,
      jdLength: typeof r.jdLength === 'number' ? r.jdLength : String(f.jdText || '').length,
      experience: r.experience,
      salary: r.salary,
      missing: v.missing || [],
      /* 证据核验统计随面板数据一起走：面板只负责显示，不重新比一遍 */
      evidenceCheck: v.evidenceCheck || null,
      modelMode: true
    };
  }

  /* 分歧判定：档位差 ≥2 才提示。差 1 级属于"模型和词库各有侧重"，
     提示太频繁会让黄条失去意义。 */
  function divergence(rulesGrade, modelGrade) {
    if (!LEVEL[rulesGrade] || !LEVEL[modelGrade]) return null;
    var delta = LEVEL[modelGrade] - LEVEL[rulesGrade];
    if (Math.abs(delta) < 2) return null;
    return {
      delta: delta,
      rulesGrade: rulesGrade,
      modelGrade: modelGrade,
      rulesLabel: gradeMeta(rulesGrade).label,
      modelLabel: gradeMeta(modelGrade).label
    };
  }

  global.JR_VERDICT = {
    parse: parse,
    normalize: normalize,
    normalizeGrade: normalizeGrade,
    toPanelView: toPanelView,
    divergence: divergence,
    scoreOf: scoreOf,
    gradeMeta: gradeMeta,
    extractObject: extractObject,
    normalizeText: normalizeText,
    quoteMatches: quoteMatches,
    verifyEvidence: verifyEvidence,
    GRADES: GRADES,
    LEVEL: LEVEL,
    FALLBACK: FALLBACK,
    MIN_QUOTE: MIN_QUOTE,
    EVIDENCE_RATE_MIN: EVIDENCE_RATE_MIN
  };
})(typeof self !== 'undefined' ? self : globalThis);
