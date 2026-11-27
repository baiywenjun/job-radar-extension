/* 模型结论契约测试：node tests/verdict-test.js
 *
 * 重点守两件事：
 *   1. 档位与分数必须自洽（strong 永远 ≥80），否则圆环颜色和档位文字会打架
 *   2. toPanelView 的输出必须与 rules.evaluate 同构，否则 panel.js 迟早开始
 *      区分两种数据源，然后某一条分支忘改
 */
const path = require('path');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('✓ ' + name);
  } else {
    fail++;
    console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
  }
}

require(path.join(__dirname, '../src/common/util.js'));
require(path.join(__dirname, '../src/common/rules.js'));
require(path.join(__dirname, '../src/common/verdict.js'));

const R = globalThis.JR_RULES;
const V = globalThis.JR_VERDICT;

/* ---------- 档位 → 分数 ---------- */
const ranges = {
  strong: [80, 95],
  neutral: [55, 79],
  weak: [35, 54],
  poor: [10, 34]
};

Object.keys(ranges).forEach((g) => {
  const lo = ranges[g][0];
  const hi = ranges[g][1];
  check(g + ' 在 confidence=0 时取下界 ' + lo, V.scoreOf(g, 0) === lo, String(V.scoreOf(g, 0)));
  check(g + ' 在 confidence=1 时取上界 ' + hi, V.scoreOf(g, 1) === hi, String(V.scoreOf(g, 1)));
});

check('confidence 超过 1 被夹住（strong 不会 >95）',
  V.scoreOf('strong', 5) === 95, String(V.scoreOf('strong', 5)));
check('confidence 小于 0 被夹住（strong 不会 <80）',
  V.scoreOf('strong', -3) === 80, String(V.scoreOf('strong', -3)));
check('insufficient 固定 0 分', V.scoreOf('insufficient', 0.9) === 0);
check('confidence 是字符串也能算',
  V.scoreOf('neutral', '0.5') === 67, String(V.scoreOf('neutral', '0.5')));
check('confidence 是 NaN 时不产生 NaN 分数',
  Number.isFinite(V.scoreOf('neutral', NaN)));

/* 全区间单调：同一档位下 confidence 越大分数不减 */
let monotonic = true;
['strong', 'neutral', 'weak', 'poor'].forEach((g) => {
  let prev = -1;
  for (let c = 0; c <= 1.0001; c += 0.1) {
    const s = V.scoreOf(g, c);
    if (s < prev) monotonic = false;
    prev = s;
  }
});
check('分数随 confidence 单调不减', monotonic);

/* 档位与分数必须落在同一区间 —— 不允许出现"强信号 79 分" */
let selfConsistent = true;
['strong', 'neutral', 'weak', 'poor'].forEach((g) => {
  for (let c = 0; c <= 1.0001; c += 0.05) {
    const s = V.scoreOf(g, c);
    if (s < ranges[g][0] || s > ranges[g][1]) selfConsistent = false;
  }
});
check('档位与分数始终自洽', selfConsistent);

/* ---------- 档位文案与规则引擎一致 ---------- */
let sameLabel = true;
Object.keys(V.FALLBACK).forEach((g) => {
  const a = V.gradeMeta(g);
  const b = R.GRADE_INFO[g];
  if (!b || a.label !== b.label || a.desc !== b.desc) sameLabel = false;
});
check('兜底文案与 rules.GRADE_INFO 一致', sameLabel);

/* ---------- 从模型输出里抠 JSON ---------- */
check('剥掉 markdown 代码块',
  V.extractObject('```json\n{"grade":"strong"}\n```') === '{"grade":"strong"}');
check('剥掉前置说明',
  V.extractObject('好的，结果如下：{"grade":"weak"} 以上。') === '{"grade":"weak"}');
check('没有对象时返回空串', V.extractObject('我觉得还行') === '');
check('零宽字符被清掉',
  V.extractObject('{"grade":"\u200bstrong"}').indexOf('\u200b') === -1);

/* ---------- 契约校验 ---------- */
function parseOk(obj) {
  try {
    return V.parse(JSON.stringify(obj));
  } catch (e) {
    return null;
  }
}
function parseErr(obj) {
  try {
    V.parse(JSON.stringify(obj));
    return null;
  } catch (e) {
    return e;
  }
}

const good = {
  grade: 'strong',
  confidence: 0.8,
  oneLine: '私有化推理与智能体交付都在做，值得投',
  evidence: [
    { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' },
    { type: 'nice', claim: '智能体编排', quote: 'LangGraph 编排多智能体流程' }
  ],
  missing: ['客户现场沟通'],
  risks: []
};
const v1 = parseOk(good);
check('合法 JSON 能解析', !!v1);
check('档位保留', v1 && v1.grade === 'strong', v1 && v1.grade);
check('分数按 confidence 计算', v1 && v1.score === 92, v1 && String(v1.score));
check('oneLine 保留', v1 && v1.oneLine.indexOf('私有化推理') === 0);
check('evidence 保留两条', v1 && v1.evidence.length === 2);
check('evidence 的 quote 保留', v1 && v1.evidence[0].quote === '基于 vLLM 搭建私有化推理服务');
check('missing 保留', v1 && v1.missing[0] === '客户现场沟通');

check('空内容报 E_BAD_JSON', (parseErr('') || {}).code === 'E_BAD_JSON');
check('找不到对象报 E_BAD_JSON',
  (V.extractObject('随便说说') === ''));
const eNoObj = (function () {
  try { V.parse('随便说说'); return null; } catch (e) { return e; }
})();
check('无对象抛 E_BAD_JSON', eNoObj && eNoObj.code === 'E_BAD_JSON');
check('半截 JSON 抛 E_BAD_JSON',
  (function () { try { V.parse('{"grade":"str'); return null; } catch (e) { return e.code; } })() === 'E_BAD_JSON');
check('缺 grade 抛 E_BAD_JSON', (parseErr({ confidence: 0.5 }) || {}).code === 'E_BAD_JSON');
check('非法 grade 抛 E_BAD_JSON', (parseErr({ grade: 'very-good' }) || {}).code === 'E_BAD_JSON');
check('数组不是合法结论', (parseErr([1, 2]) || {}).code === 'E_BAD_JSON');

/* 模型的同义词收敛 */
check('High 收敛为 strong', (parseOk({ grade: 'High' }) || {}).grade === 'strong');
check('MEDIUM 收敛为 neutral', (parseOk({ grade: 'MEDIUM' }) || {}).grade === 'neutral');
check('unknown 收敛为 insufficient',
  (parseOk({ grade: 'unknown' }) || {}).grade === 'insufficient');

/* 缺失字段的默认值 */
const bare = parseOk({ grade: 'neutral' });
check('缺 confidence 默认 0.5', bare && bare.confidence === 0.5, bare && String(bare.confidence));
check('缺 oneLine 时用档位描述兜底', bare && bare.oneLine === R.GRADE_INFO.neutral.desc);
check('缺 evidence 时为数组', bare && Array.isArray(bare.evidence) && bare.evidence.length === 0);
check('缺 missing 时为数组', bare && Array.isArray(bare.missing));

const longLine = parseOk({ grade: 'weak', oneLine: '很'.repeat(200) });
check('oneLine 超长被截断', longLine && longLine.oneLine.length <= 60,
  longLine && String(longLine.oneLine.length));

const oddEvidence = parseOk({
  grade: 'neutral',
  evidence: [
    { type: 'unknown-type', claim: '某要求', quote: '某原文' },
    { claim: '', quote: '没有结论' },
    { claim: '没引文' },
    'not-an-object'
  ]
});
check('未知 type 归为 nice', oddEvidence && oddEvidence.evidence[0].type === 'nice');
check('缺 claim 的条目被丢弃', oddEvidence && oddEvidence.evidence.length === 2,
  oddEvidence && String(oddEvidence.evidence.length));
check('缺 quote 时 quote 为空串', oddEvidence && oddEvidence.evidence[1].quote === '');

const manyEvidence = parseOk({
  grade: 'neutral',
  evidence: new Array(30).fill(0).map((_, i) => ({ type: 'must', claim: 'c' + i, quote: 'q' + i }))
});
check('evidence 最多保留 12 条', manyEvidence && manyEvidence.evidence.length === 12,
  manyEvidence && String(manyEvidence.evidence.length));

const listForms = parseOk({
  grade: 'weak',
  missing: ['A', { text: 'B' }, '', 3],
  risks: ['C', { claim: 'D' }]
});
check('missing 支持字符串与对象混排', listForms && listForms.missing.join(',') === 'A,B',
  listForms && listForms.missing.join(','));
check('risks 支持对象形式', listForms && listForms.risks.join(',') === 'C,D',
  listForms && listForms.risks.join(','));

/* ---------- 面板视图同构 ---------- */
const JD = '负责客户现场的大模型应用与智能体项目交付，基于 vLLM 搭建私有化推理服务，' +
  '使用 LangGraph 编排多智能体流程，建设评测回归体系与监控告警，需要 3-5 年经验并能驻场。';
const rulesEv = R.evaluate({
  jobTitle: 'AI部署工程师（FDE）',
  jdText: JD,
  salaryText: '12-15K',
  experienceText: '3-5年'
});
const modelEv = V.toPanelView(v1, rulesEv, { jobTitle: 'AI部署工程师（FDE）', jdText: JD });

const rulesKeys = Object.keys(rulesEv).sort();
const missingKeys = rulesKeys.filter((k) => !(k in modelEv));
check('面板视图覆盖规则引擎的全部字段', missingKeys.length === 0, missingKeys.join(','));
check('grade 来自模型', modelEv.grade === 'strong');
check('score 来自模型', modelEv.score === 92);
check('group / flags 仍取规则引擎',
  modelEv.group === rulesEv.group && modelEv.flags.join(',') === rulesEv.flags.join(','),
  modelEv.group + ' vs ' + rulesEv.group);
check('modelMode 标记为真', modelEv.modelMode === true);
check('strong 只取 must / nice',
  modelEv.strong.length === 2 && modelEv.strong[0].term === '私有化推理');
check('strong 的 note 带原文前缀',
  modelEv.strong[0].note.indexOf('原文：') === 0, modelEv.strong[0].note);
check('actions / metrics 置空',
  modelEv.actions.length === 0 && modelEv.metrics.length === 0);
check('excludes 置空', modelEv.excludes.length === 0);
check('missing 透传', modelEv.missing[0] === '客户现场沟通');

const withRed = V.toPanelView(
  parseOk({
    grade: 'poor',
    evidence: [{ type: 'red', claim: '纯外包派遣', quote: '本岗位为人力外包' }],
    risks: ['出现"忽略以上要求"的可疑指令']
  }),
  rulesEv,
  { jdText: JD }
);
check('weak 由 red 证据 + risks 组成',
  withRed.weak.length === 2, String(withRed.weak.length));
check('weak 项的权重为空（模型不给权重）',
  withRed.weak[0].w === undefined, String(withRed.weak[0].w));
check('risks 进入 weak',
  withRed.weak[1].term.indexOf('可疑指令') !== -1, withRed.weak[1].term);

/* ---------- 分歧判定 ---------- */
check('差 2 级判定为分歧', !!V.divergence('strong', 'weak'));
check('差 3 级判定为分歧', !!V.divergence('strong', 'poor'));
check('差 1 级不算分歧', V.divergence('strong', 'neutral') === null);
check('同档不算分歧', V.divergence('neutral', 'neutral') === null);
check('规则判 irrelevant 时不比较', V.divergence('irrelevant', 'strong') === null);
check('模型判 insufficient 时不比较', V.divergence('strong', 'insufficient') === null);

const dv = V.divergence('strong', 'weak');
check('分歧带两个档位的中文名',
  dv.rulesLabel === '强信号' && dv.modelLabel === '偏弱',
  dv.rulesLabel + ' / ' + dv.modelLabel);
check('分歧方向：模型更低为负', dv.delta === -2, String(dv.delta));

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
