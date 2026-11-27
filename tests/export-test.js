/* 导出测试：node tests/export-test.js
 *
 * 导出最容易出的错不是格式，而是「把模型结论弄丢了」：
 * 只导岗位字段的话，oneLine、证据原文、用的是哪一版标准全都不见了，
 * 这份 CSV 拿去做对比就只剩下词库分数。
 * 所以这里的断言集中在三件事：
 *   1. 判定与岗位正确关联（同岗位多条判定取最新）
 *   2. 证据原文、未核实标记、标准版本都进了文件
 *   3. 含逗号/引号/换行的文本不会把 CSV 拆坏
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
require(path.join(__dirname, '../src/popup/export.js'));

const X = globalThis.JR_EXPORT;
const U = globalThis.JR_UTIL;

const T1 = new Date('2026-11-20T10:00:00+08:00').getTime();
const T2 = new Date('2026-11-27T09:30:00+08:00').getTime();

const jobs = [
  {
    key: 'k1',
    jobTitle: 'FDE（交付工程师）',
    company: '百蕴启辰',
    salaryText: '10-11K',
    city: '北京',
    experienceText: '3-5年',
    siteName: 'BOSS直聘',
    groupLabel: 'AI 交付',
    grade: 'strong',
    score: 86,
    strong: ['vLLM', 'LangGraph'],
    weak: ['驻场'],
    jdLength: 1800,
    jdText: '负责客户现场的大模型应用交付。基于 vLLM 搭建私有化推理服务。',
    firstSeen: T1,
    lastSeen: T2,
    seenCount: 3,
    url: 'https://www.zhipin.com/job_detail/1.html',
    oneLine: '规则引擎写的旧一句话',
    profileName: 'FDE'
  },
  {
    key: 'k2',
    jobTitle: 'AI 应用工程师',
    company: '某某科技',
    salaryText: '',
    city: '上海',
    experienceText: '不限',
    siteName: '猎聘',
    groupLabel: 'AI 应用',
    grade: 'weak',
    score: 41,
    strong: [],
    weak: ['电话销售'],
    jdLength: 0,
    firstSeen: T1,
    lastSeen: T1,
    seenCount: 1,
    url: 'https://www.liepin.com/job/2',
    oneLine: '',
    profileName: ''
  }
];

const verdicts = [
  {
    /* 旧判定放在前面：真实库里顺序不保证，取最新必须靠比较而不是靠顺序 */
    key: 'k1',
    grade: 'strong',
    score: 88,
    oneLine: '旧结论',
    profileVersion: 1,
    model: 'deepseek-chat',
    createdAt: T1
  },
  {
    key: 'k1',
    grade: 'neutral',
    score: 63,
    confidence: 0.7,
    oneLine: '方向对，但项目偏集成, 不是"从零建"',
    evidence: [
      { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务', verified: true },
      { type: 'red', claim: '驻场交付', quote: '能适应长期驻场', verified: false }
    ],
    missing: ['Kubernetes'],
    risks: ['外包性质存疑'],
    profileName: 'FDE',
    profileVersion: 3,
    model: 'deepseek-chat',
    createdAt: T2,
    evidenceCheck: { checked: 2, passed: 1, rate: 0.5 },
    evidenceFlag: 'E_BAD_EVIDENCE'
  }
];

/* ---------- 1. 关联 ---------- */
console.log('=== 判定关联 ===');
const map = X.indexVerdicts(verdicts);
check('同岗位多条判定取最新一条', map.k1.createdAt === T2 && map.k1.score === 63, String(map.k1.score));
check('没有判定的岗位留空', X.verdictOf(jobs[1], map) === null);

const rows = X.rows(jobs, map);
check('有判定的行标为模型', rows[0].judgeSource === '模型', rows[0].judgeSource);
check('有判定时分数取模型的', rows[0].score === 63 && rows[0].grade === 'neutral', String(rows[0].score));
check('无判定的行标为本地规则', rows[1].judgeSource === '本地规则', rows[1].judgeSource);
check('无判定时分数取岗位记录的', rows[1].score === 41, String(rows[1].score));
check('一句话结论取模型的', rows[0].oneLine === verdicts[1].oneLine, rows[0].oneLine);
check('证据保留原文与核实标记',
  rows[0].evidence[1].quote === '能适应长期驻场' && rows[0].evidence[1].verified === false);

/* ---------- 2. CSV ---------- */
console.log('\n=== CSV ===');
const csv = X.toCSV(jobs, map);
const lines = csv.split('\r\n');
check('行数 = 表头 + 岗位数', lines.length === 3, String(lines.length));
check('列数与表头一致', X.CSV_HEADERS.length === 26, String(X.CSV_HEADERS.length));
check('表头含「一句话结论」', lines[0].indexOf('一句话结论') !== -1);
check('表头含「证据与原文」', lines[0].indexOf('证据与原文') !== -1);
check('表头含「标准版本」', lines[0].indexOf('标准版本') !== -1);
check('证据原文进了 CSV', csv.indexOf('「基于 vLLM 搭建私有化推理服务」') !== -1);
check('未核实的证据被标出来', csv.indexOf('（未核实）') !== -1);
check('标准版本写成 v3', csv.indexOf('v3') !== -1);
check('含逗号与引号的结论被正确包裹',
  csv.indexOf('"方向对，但项目偏集成, 不是""从零建"""') !== -1, lines[1]);
check('缺失项与风险项进 CSV',
  csv.indexOf('Kubernetes') !== -1 && csv.indexOf('外包性质存疑') !== -1);

/* 每一行拆出来的字段数必须等于表头列数（简单状态机，够用） */
function countCells(line) {
  let n = 1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (c === ',' && !quoted) n++;
  }
  return n;
}
check('第一行数据字段数 = 26', countCells(lines[1]) === 26, String(countCells(lines[1])));
check('第二行数据字段数 = 26', countCells(lines[2]) === 26, String(countCells(lines[2])));

check('csvCell 处理换行', X.csvCell('a\nb') === '"a\nb"', X.csvCell('a\nb'));
check('csvCell 原样返回普通文本', X.csvCell('abc') === 'abc');
check('BOM 是单字符 \\ufeff', X.BOM === '\ufeff' && X.BOM.length === 1);
check('空列表只输出表头', X.toCSV([], {}).split('\r\n').length === 1);

/* ---------- 3. Markdown ---------- */
console.log('\n=== Markdown ===');
const md = X.toMarkdown(jobs, map, { profileName: 'FDE' });
check('MD 有导出时间与条数', md.indexOf('共 2 条') !== -1);
check('MD 明细里列出判定来源',
  md.indexOf('判定来源：模型 · deepseek-chat · 标准 FDE v3') !== -1,
  (md.match(/- 判定来源：.*/) || [''])[0]);
check('MD 里未核实的证据带警告',
  md.indexOf('**未能核实**') !== -1);
check('MD 里引用了原文', md.indexOf('原文「基于 vLLM 搭建私有化推理服务」') !== -1);
check('MD 里标出 E_BAD_EVIDENCE', md.indexOf('引用大面积对不上原文') !== -1);
check('MD 第二条记录标为本地规则', md.indexOf('判定来源：本地规则') !== -1);

/* ---------- 4. JSON ---------- */
console.log('\n=== JSON ===');
const raw = X.toJSON(jobs, map, { version: '0.2.6' });
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch (e) { /* 下面会报 */ }
check('JSON 可解析', !!parsed);
check('JSON 带生成器与版本', parsed && parsed.generator === 'job-radar' && parsed.version === '0.2.6',
  parsed && String(parsed.version));
check('JSON 带免责声明', parsed && parsed.disclaimer.indexOf('样本有偏') !== -1);
check('JSON 里模型判定单独一层',
  parsed && parsed.jobs[0].verdict && parsed.jobs[0].verdict.grade === 'neutral');
check('JSON 保留证据原文',
  parsed && parsed.jobs[0].verdict.evidence[0].quote === '基于 vLLM 搭建私有化推理服务');
check('JSON 保留 profileVersion',
  parsed && parsed.jobs[0].verdict.profileVersion === 3);
check('无判定的岗位 verdict 为 null', parsed && parsed.jobs[1].verdict === null);
check('JSON 保留正文', parsed && parsed.jobs[0].jdText.indexOf('vLLM') !== -1);
check('JSON 里规则分数与模型分数分开',
  parsed && parsed.jobs[0].ruleScore === 86 && parsed.jobs[0].verdict.score === 63);

/* ---------- 5. 文件名戳 ---------- */
console.log('\n=== 文件名 ===');
const stamp = X.stamp(T2);
check('文件名戳形如 2026-11-27-0930', /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(stamp), stamp);
check('文件名戳用的是本地时间', stamp === '2026-11-27-0930', stamp);

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
