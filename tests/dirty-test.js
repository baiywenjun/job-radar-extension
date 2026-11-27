/* 脏输入回归测试：node tests/dirty-test.js
 *
 * 现场两类脏输入都被当成「岗位内容」发给了模型：
 *   1. 详情区容器把页头一起圈进来，JD 里混着「取消收藏」「微信扫一扫」「投递简历」
 *      —— 模型于是在 risks 里写「页面混入招聘平台噪声文字」。
 *   2. BOSS 用私有区字符 + kanzhun-mix 字体替换数字，薪资抽成「-K」这种残缺文本，
 *      —— 模型会把它当真实区间推理。
 * 这里逐条锁住清理规则，避免以后再退化。
 */
const { JSDOM } = require('jsdom');

require('../src/common/util.js');
require('../src/common/rules.js');
require('../src/content/adapters.js');
require('../src/content/extract.js');
require('../src/common/prompt.js');

const U = globalThis.JR_UTIL;
const E = globalThis.JR_EXTRACT;
const A = globalThis.JR_ADAPTERS;
const PR = globalThis.JR_PROMPT;

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

/* 私有区数字：编码时用 c.charCodeAt(0) - 0xE031 = 数字 */
function encodeDigits(s) {
  return String(s).replace(/\d/g, (c) => String.fromCharCode(0xE031 + Number(c)));
}

const JD_LINES = [
  '岗位职责：',
  '1. 负责客户现场的大模型应用交付，梳理业务流程并输出可验收的实施方案，独立完成需求调研与拆解。',
  '2. 基于 vLLM 与 SGLang 搭建私有化推理服务，完成 PD 分离与 KV Cache 优化，持续压降单位 Token 成本。',
  '3. 使用 LangGraph 编排多智能体流程，接入 MCP 工具调用与 RAG 检索链路，建设评测回归体系。',
  '任职要求：',
  '1. 具备 3-5 年相关经验，熟悉 CUDA 算子开发与推理引擎二次开发，有从 0 到 1 上线经历。',
  '2. 能接受驻场交付，具备客户沟通与方案汇报能力，可适应短期出差。'
];

function pageHtml() {
  const cards = ['前沿部署工程师（FDE）', '飞书 FDE 交付工程师', '实施工程师']
    .map((t, i) => `
      <li class="job-card-box"${i === 0 ? ' aria-selected="true"' : ''}>
        <div class="job-title"><span class="name">${t}</span></div>
        <span class="job-salary">${encodeDigits('20-30K')}</span>
        <div class="company-name">别家科技${i}有限公司</div>
      </li>`).join('');

  return `
<div class="wrap">
  <ul class="job-list">${cards}</ul>
  <div class="detail">
    <div class="job-detail-header">
      <span class="job-name" style="font-size:20px">前沿部署工程师（FDE）</span>
      <span class="job-salary" style="font-size:24px">${encodeDigits('20-30K')}</span>
      <div class="tag-list"><span>广州</span><span>3-5年</span><span>本科</span></div>
      <button class="btn-collect">取消收藏</button>
      <a href="/web/geek/jobs?tab=share">微信扫一扫</a>
    </div>
    <div class="job-boss-info"><span class="boss-info-attr">海量科技有限公司 · HR</span></div>
    <div class="job-sec-text">
      <p>${JD_LINES[0]}</p>
      <p>${JD_LINES[1]}</p>
      <p>${JD_LINES[2]}</p>
      <div class="toolbar">
        <button>立即沟通</button>
        <span class="btn">投递简历</span>
        <button class="more-review">查看全部 12 条职位评价，包含面试经验与薪资爆料</button>
      </div>
      <p>${JD_LINES[3]}取消收藏微信扫一扫</p>
      <div class="ops"><span>✅ 取消收藏</span></div>
      <p>${JD_LINES[4]}</p>
      <p>${JD_LINES[5]}</p>
      <p>${JD_LINES[6]}</p>
    </div>
  </div>
</div>`;
}

function setup(html, url) {
  const dom = new JSDOM(html, {
    url: url || 'https://www.zhipin.com/web/geek/jobs?query=FDE&city=101280100',
    pretendToBeVisual: true
  });
  global.document = dom.window.document;
  global.location = dom.window.location;
  return dom;
}

const adapter = A.SITE_ADAPTERS[0]; // zhipin

/* ================= 1. 控件文本不能进 JD ================= */
setup(pageHtml());
const f = E.extract(adapter);
const jd = f ? f.jdText : '';

check('抽到了 JD 正文', !!f && jd.length > 200, '实际 ' + jd.length + ' 字');
check('JD 不含按钮「立即沟通」', jd.indexOf('立即沟通') === -1, jd.slice(0, 120));
check('JD 不含按钮「投递简历」', jd.indexOf('投递简历') === -1);
check('JD 不含粘连进来的「取消收藏」', jd.indexOf('取消收藏') === -1);
check('JD 不含「微信扫一扫」', jd.indexOf('微信扫一扫') === -1);
/* 这一条专门锁「结构过滤」：按钮文案长到不像标签，行级规则抓不住它 */
check('JD 不含长文案按钮（只有结构过滤能挡住）',
  jd.indexOf('职位评价') === -1 && jd.indexOf('薪资爆料') === -1, jd.slice(0, 160));
check('JD 保留正文首句', jd.indexOf('负责客户现场的大模型应用交付') !== -1);
check('JD 保留章节标题「任职要求：」', jd.indexOf('任职要求：') !== -1);
check('JD 不以页头职位名开头', jd.indexOf('前沿部署工程师') !== 0, jd.slice(0, 40));
check('清理统计不为零', f && f.dirty && f.dirty.ui >= 3, JSON.stringify(f && f.dirty));
check('诊断能拿到被删样本',
  f && f.dirty && Array.isArray(f.dirty.removed) && f.dirty.removed.length > 0,
  JSON.stringify(f && f.dirty && f.dirty.removed));
check('被删样本里是控件文案，不是正文',
  f && f.dirty.removed.every((s) => !/vLLM|LangGraph|驻场/.test(s)),
  JSON.stringify(f && f.dirty && f.dirty.removed));

/* ================= 2. 薪资字形还原 ================= */
check('薪资字形还原为 20-30K', f && f.salaryText === '20-30K', f && ('实际 ' + f.salaryText));
check('还原成功时不标「字形混淆」', f && f.sources.salary !== '字形混淆', f && f.sources.salary);
check('decodeDigits 逐位还原', E.decodeDigits('a\uE037b') === 'a6b',
  E.decodeDigits('a\uE037b'));

/* ================= 3. 公司名不能被左侧卡片带偏 ================= */
check('公司名取自详情区，不是列表卡片', f && f.company === '海量科技有限公司',
  f && ('实际 ' + f.company));
check('公司名来源标为招聘者信息', f && f.sources.company === '招聘者信息',
  f && f.sources.company);

/* ================= 4. 行级过滤与结构过滤的单元行为 ================= */
const ctx = { jobTitle: '前沿部署工程师（FDE）', salaryText: '20-30K', company: '海量科技' };
check('整行「取消收藏」判为控件', E.isUiLine('取消收藏', ctx) === true);
check('带图标前缀的「✅ 取消收藏」也判为控件', E.isUiLine('✅ 取消收藏', ctx) === true);
check('「投递简历」判为控件', E.isUiLine('投递简历', ctx) === true);
check('章节标题「岗位职责」不当控件删掉', E.isUiLine('岗位职责：', ctx) === false);
check('正文条目（以序号开头）保留', E.isUiLine('1. 负责现场交付与需求拆解', ctx) === false);
check('页头职位名整行丢弃（与字段重复）',
  E.isUiLine('前沿部署工程师（FDE）', ctx) === true);
check('普通短句「需要驻场」不被误删', E.isUiLine('需要驻场', ctx) === true &&
  E.isUiLine('可接受驻场交付。', ctx) === false);

/* 结构层：<button> / <a> / .btn 子树整枝跳过 */
const dom2 = setup(`<div class="job-sec-text">
  <p>负责推理服务交付与性能优化，覆盖上线验收与回归评测。</p>
  <button>立即沟通</button>
  <a href="/x">查看公司主页</a>
  <span class="btn">投递简历</span>
  <p>任职要求：熟悉 vLLM 与 TensorRT-LLM。</p>
</div>`);
const root = dom2.window.document.querySelector('.job-sec-text');
check('isUiNode 认 <button>', E.isUiNode(root.querySelector('button')) === true);
check('isUiNode 认 <a>', E.isUiNode(root.querySelector('a')) === true);
check('isUiNode 认 .btn', E.isUiNode(root.querySelector('.btn')) === true);
const structText = E.jdTextOf(root, {}).text;
check('结构过滤后没有按钮文案',
  structText.indexOf('立即沟通') === -1 && structText.indexOf('查看公司主页') === -1,
  structText);

/* 收窄：页头占三成时不应被剥掉，正文占九成时应剥掉页头 */
const dom3 = setup(`<div class="pane">
  <div class="hd"><span>取消收藏</span></div>
  <div class="body"><p>${'正文内容描述职责与要求。'.repeat(30)}</p></div>
</div>`);
const pane = dom3.window.document.querySelector('.pane');
const narrowed = E.narrowJd(pane);
check('narrowJd 收窄到正文块（剥掉只含控件的页头）',
  narrowed !== pane && narrowed.textContent.indexOf('取消收藏') === -1,
  narrowed.className + ' / ' + narrowed.textContent.slice(0, 20));
check('narrowJd 没有把正文也剥掉',
  narrowed.textContent.indexOf('正文内容描述职责与要求') !== -1);

/* ================= 5. 提示词侧：脏字段要说清楚 ================= */
const notes = PR.sourceNotes({ company: '招聘者信息', salary: '字形混淆', jd: '选择器' },
  { dirty: { ui: 4 } });
check('提示词声明正文已剔除控件', notes.some((n) => n.indexOf('已剔除 4 处') !== -1),
  notes.join(' | '));
check('提示词声明薪资未识别', notes.some((n) => n.indexOf('薪资字段') !== -1), notes.join(' | '));
check('提示词版本已随字段说明递增', PR.PROMPT_VERSION >= 2, String(PR.PROMPT_VERSION));

const msgs = PR.buildMessages({
  profile: { id: 'p1', name: 'FDE', requirement: '要做交付' },
  fields: { jobTitle: 'FDE', company: '海量科技有限公司', salaryText: '20-30K', jdText: jd },
  sources: f.sources,
  jdText: jd
});
const userText = msgs[1].content;
check('发给模型的正文里没有按钮文案',
  userText.indexOf('立即沟通') === -1 && userText.indexOf('取消收藏') === -1,
  userText.slice(0, 200));
check('发给模型的薪资是还原后的数字', userText.indexOf('20-30K') !== -1);

/* ================= 6. 未解码的私有区字符要「置空」而不是瞎猜 ================= */
setup(pageHtml());
check('未知私有区字符不硬解', E.SalClean('\uE100-\uE101K') === '',
  E.SalClean('\uE100-\uE101K'));
const domOther = setup(pageHtml(), 'https://www.liepin.com/job/1234567.shtml');
check('非 BOSS 站点的私有区字符不套用 BOSS 映射',
  E.SalClean(encodeDigits('20-30K')) === '', E.SalClean(encodeDigits('20-30K')));
const fOther = E.extract(A.SITE_ADAPTERS[1]);
check('其他站点拿不到薪资时留空',
  !fOther || fOther.salaryText === '', fOther && fOther.salaryText);
check('其他站点不会误标「字形混淆」（那不是它的机制）',
  !fOther || fOther.sources.salary !== '字形混淆', fOther && fOther.sources.salary);

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
