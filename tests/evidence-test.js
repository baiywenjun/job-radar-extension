/* 证据逐字校验测试：node tests/evidence-test.js
 *
 * 模型编造原文是本工具最危险的失败模式：用户会把「原文：…」当成 JD 里真的写了。
 * 这里覆盖三类真实差异（空白/全角/零宽）、省略式引用、以及伪造引用的判定。
 */
require('../src/common/util.js');
require('../src/common/rules.js');
require('../src/common/verdict.js');

var V = globalThis.JR_VERDICT;

var JD =
  '负责客户现场的大模型应用与智能体项目交付。\n' +
  '基于 vLLM 搭建私有化推理服务，完成 PD 分离与量化优化；\n' +
  '使用 LangGraph 编排多智能体流程，接入 MCP 工具调用与 RAG 检索链路；\n' +
  '要求 3-5 年经验，能适应短期出差与驻场交付。';

var pass = 0;
var fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('✓ ' + name);
  } else {
    fail++;
    console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
  }
}

function ev(quote, type) {
  return { type: type || 'must', claim: '结论', quote: quote };
}

function run(list, jd) {
  var v = { evidence: list };
  var stat = V.verifyEvidence(v, jd == null ? JD : jd);
  return { v: v, stat: stat };
}

console.log('=== 归一化 ===');
check('去空白后相等',
  V.normalizeText('a b\tc\nd') === 'abcd');
check('全角空格与半角空格等价',
  V.normalizeText('私有化\u3000推理') === V.normalizeText('私有化 推理'));
check('全角标点归一为半角',
  V.normalizeText('经验，能适应') === V.normalizeText('经验,能适应'));
check('零宽字符被去掉',
  V.normalizeText('vLLM\u200b搭建') === 'vllm搭建');
check('弯引号归一为直引号',
  V.normalizeText('“私有化”') === V.normalizeText('"私有化"'));
check('大小写归一',
  V.normalizeText('vLLM') === V.normalizeText('VLLM'));

console.log('\n=== 逐字命中 ===');
var r1 = run([ev('基于 vLLM 搭建私有化推理服务')]);
check('完全一致的引文通过', r1.v.evidence[0].verified === true);
check('统计 checked=1', r1.stat.checked === 1, JSON.stringify(r1.stat));
check('统计 passed=1', r1.stat.passed === 1);
check('通过率 1', r1.stat.rate === 1);

var r2 = run([ev('基于 vLLM 搭建私有化推理服务，完成 PD 分离与量化优化')]);
check('跨行引文（原文有换行）仍通过', r2.v.evidence[0].verified === true);

var r3 = run([ev('使用 LangGraph 编排多智能体流程,接入 MCP 工具调用')]);
check('引文把全角分号改成半角仍通过', r3.v.evidence[0].verified === true);

var r4 = run([ev('经验,能适应短期出差与驻场交付')]);
check('引文把全角逗号改成半角仍通过', r4.v.evidence[0].verified === true);

var r5 = run([ev('基于 VLLM 搭建私有化推理服务')]);
check('大小写不同仍通过', r5.v.evidence[0].verified === true);

console.log('\n=== 省略式引用 ===');
var r6 = run([ev('基于 vLLM 搭建私有化推理服务…接入 MCP 工具调用与 RAG 检索链路')]);
check('省略号分隔且两段都命中 → 通过', r6.v.evidence[0].verified === true);

var r7 = run([ev('基于 vLLM 搭建私有化推理服务...这套方案可以立刻上线')]);
check('省略号后一段在原文里没有 → 不通过', r7.v.evidence[0].verified === false);

var r8 = run([ev('vLLM…MCP')]);
check('省略号某一段过短时不按分段放行', r8.v.evidence[0].verified === false);

console.log('\n=== 伪造与缺失 ===');
var r9 = run([ev('要求具备 Kubernetes 集群运维与 Prometheus 监控搭建经验')]);
check('原文没有的句子被判为未核实', r9.v.evidence[0].verified === false);
check('未核实条目不计入 passed', r9.stat.passed === 0);
check('未核实条目计入 checked', r9.stat.checked === 1);

var r10 = run([ev('')]);
check('没有 quote 的条目 verified=false', r10.v.evidence[0].verified === false);
check('没有 quote 的标记为 noQuote', r10.v.evidence[0].noQuote === true);
check('没有 quote 的不计入 checked', r10.stat.checked === 0);

var r11 = run([ev('RAG')]);
check('过短的 quote 不当作可核对依据', r11.v.evidence[0].noQuote === true);
check('过短的 quote 也不计入 checked', r11.stat.checked === 0);

console.log('\n=== 通过率 ===');
var mixed = run([
  ev('基于 vLLM 搭建私有化推理服务'),
  ev('使用 LangGraph 编排多智能体流程'),
  ev('这一段在原文里根本不存在的内容'),
  ev('要求 3-5 年经验')
]);
check('4 条里 3 条通过时 checked=4', mixed.stat.checked === 4, JSON.stringify(mixed.stat));
check('4 条里 3 条通过时 passed=3', mixed.stat.passed === 3);
check('通过率 0.75', Math.abs(mixed.stat.rate - 0.75) < 1e-6, String(mixed.stat.rate));
check('逐条标记正确（第 3 条未通过）', mixed.v.evidence[0].verified === true &&
  mixed.v.evidence[1].verified === true &&
  mixed.v.evidence[2].verified === false &&
  mixed.v.evidence[3].verified === true);

var half = run([
  ev('基于 vLLM 搭建私有化推理服务'),
  ev('原文里没有这句话')
]);
check('一半通过时通过率 0.5 未低于阈值',
  half.stat.rate >= V.EVIDENCE_RATE_MIN, String(half.stat.rate));
check('阈值为 0.5', V.EVIDENCE_RATE_MIN === 0.5);

var none = run([ev('完全编造的一段话')], '');
check('JD 为空时一律未核实', none.v.evidence[0].verified === false);
check('JD 为空时通过率 0', none.stat.rate === 0);

console.log('\n=== 面板视图 ===');
var rulesEv = { group: 'AI_APP', groupLabel: 'AI 应用', groupShort: 'AI应用', flags: [], jdLength: JD.length };
var vv = {
  grade: 'strong', confidence: 0.8, score: 92,
  evidence: [
    { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务', verified: true },
    { type: 'must', claim: '集群运维', quote: '要求具备 Kubernetes 集群运维经验', verified: false },
    { type: 'must', claim: '无引用', quote: '', verified: false, noQuote: true }
  ],
  missing: [],
  risks: [],
  evidenceCheck: { checked: 2, passed: 1, rate: 0.5 }
};
var view = V.toPanelView(vv, rulesEv, { jdText: JD });

check('已核实的 chip 不带 unverified 标记', view.strong[0].unverified === false);
check('未核实的 chip 带 unverified 标记', view.strong[1].unverified === true);
check('未核实的 chip title 以「未能核实」开头',
  view.strong[1].note.indexOf('未能核实') === 0, view.strong[1].note);
check('已核实的 chip title 是原文引用',
  view.strong[0].note.indexOf('原文：') === 0, view.strong[0].note);
check('没写 quote 的 chip 提示未附引用',
  view.strong[2].note.indexOf('未附原文引用') === 0, view.strong[2].note);
check('面板视图带出 evidenceCheck',
  view.evidenceCheck && view.evidenceCheck.checked === 2, JSON.stringify(view.evidenceCheck));

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
