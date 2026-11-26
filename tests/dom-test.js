/* DOM 抽取端到端测试：node tests/dom-test.js
 * 用 jsdom 构造三种页面结构，验证「选择器 → 标题解析 → 文本启发」三级管线是否按预期降级。
 * 注意：这验证的是抽取逻辑本身，不能替代在真实站点上的选择器校准。
 */
const { JSDOM } = require('jsdom');

require('../src/common/util.js');
require('../src/common/rules.js');
require('../src/content/adapters.js');
require('../src/content/extract.js');

const U = globalThis.JR_UTIL;
const R = globalThis.JR_RULES;
const E = globalThis.JR_EXTRACT;
const A = globalThis.JR_ADAPTERS;

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

function setup(html, url, title) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  if (title) dom.window.document.title = title;
  global.document = dom.window.document;
  global.location = dom.window.location;
  return dom;
}

/* ---------- 用例 1：BOSS 完整结构 ---------- */
const bossHtml = `
<div class="job-banner">
  <div class="name"><h1>AI Infra 工程师-推理加速方向</h1></div>
  <div class="salary">40-70K·15薪</div>
  <div class="info-primary"><p>深圳·南山区 5-10年 本科</p></div>
  <div class="company-info"><a class="company-name">某智能科技股份有限公司</a></div>
</div>
<div class="job-boss-info"><span class="boss-active-time">今日活跃</span></div>
<div class="job-sec-text">岗位职责：负责大模型推理引擎的性能优化，基于 vLLM 与 SGLang 做源码级二次开发，
改造 PD 分离架构，优化 KV Cache 与 Prefix Caching 命中率。需要围绕 TTFT 与 P99 延迟做系统性优化，
把单位 Token 成本降低 30%，并建立回归评测体系与监控告警。要求熟悉 CUDA 与 FlashAttention，
具备 NCCL 多机多卡调试经验，本科及以上，5 年以上相关经验。</div>
`;

setup(bossHtml, 'https://www.zhipin.com/job_detail/abc123.html', 'AI Infra工程师_深圳_40-70K-某智能科技股份有限公司-BOSS直聘');
let f1 = E.extract(A.SITE_ADAPTERS[0]);

check('BOSS：职位名走选择器', f1 && f1.jobTitle === 'AI Infra 工程师-推理加速方向', f1 && ('实际 ' + f1.jobTitle));
check('BOSS：公司名走选择器', f1 && /某智能科技/.test(f1.company), f1 && ('实际 ' + f1.company));
check('BOSS：薪资走选择器', f1 && /40-70K/.test(f1.salaryText), f1 && ('实际 ' + f1.salaryText));
check('BOSS：城市解析', f1 && f1.city === '深圳', f1 && ('实际 ' + f1.city));
check('BOSS：经验解析', f1 && /5-10年/.test(f1.experienceText), f1 && ('实际 ' + f1.experienceText));
check('BOSS：JD 走选择器', f1 && f1.sources.jd === '选择器', f1 && ('实际 ' + f1.sources.jd));
check('BOSS：JD 长度足够', f1 && f1.jdText.length > 150, f1 && ('实际 ' + f1.jdText.length));

let ev1 = R.evaluate({ jobTitle: f1.jobTitle, jdText: f1.jdText, salaryText: f1.salaryText, experienceText: f1.experienceText });
check('BOSS：判为强信号', ev1.grade === 'strong', '实际 ' + ev1.grade + ' / ' + ev1.score + ' 分');
check('BOSS：族群为 AI Infra', ev1.group === 'C', '实际 ' + ev1.group + ' ' + ev1.groupShort);
check('BOSS：命中 vLLM 与 PD 分离', ev1.strong.some(x => x.term === 'vLLM') && ev1.strong.some(x => /PD/.test(x.term)));

/* ---------- 用例 2：JD 容器全丢，只剩一个含职责关键词的块 ---------- */
const brokenHtml = `
<div class="job-banner">
  <div class="name"><h1>大模型推理工程师</h1></div>
  <div class="salary">35-60K</div>
  <div class="company-info"><a class="company-name">某计算技术有限公司</a></div>
</div>
<div class="unknown-wrapper">
  <div class="random-class-name">
    <p>岗位职责</p>
    <p>负责推理服务的部署与性能优化，使用 TensorRT-LLM 与 SGLang 完成模型部署，</p>
    <p>针对线上 QPS 波动做压测与调优，优化 KV Cache 命中率，降低单位 Token 成本。</p>
    <p>要求熟悉 CUDA 编程，具备独立的线上故障兜底能力，3 年以上经验。</p>
  </div>
</div>
`;

setup(brokenHtml, 'https://www.zhipin.com/job_detail/def456.html', '大模型推理工程师_北京_35-60K-某计算技术有限公司-BOSS直聘');
let f2 = E.extract(A.SITE_ADAPTERS[0]);

check('降级：JD 容器丢失后走启发式', f2 && f2.sources.jd === '启发式', f2 && ('实际 ' + f2.sources.jd));
check('降级：启发式抽到正文', f2 && f2.jdText.length > 80, f2 && ('实际 ' + f2.jdText.length + ' 字'));

let ev2 = R.evaluate({ jobTitle: f2.jobTitle, jdText: f2.jdText, salaryText: f2.salaryText, experienceText: f2.experienceText });
check('降级：仍能命中技术词', ev2.strong.length >= 2, '实际 ' + ev2.strong.length + ' 个：' + ev2.strong.map(x => x.term).join('、'));

/* ---------- 用例 3：几乎空白的页面 ---------- */
setup('<div class="nothing">加载中…</div>', 'https://www.zhipin.com/job_detail/ghi789.html', 'BOSS直聘');
let f3 = E.extract(A.SITE_ADAPTERS[0]);

check('空页：不抛异常且 JD 为空', !f3 || !f3.jdText, f3 && ('实际 ' + f3.jdText));

if (f3) {
  let ev3 = R.evaluate({ jobTitle: f3.jobTitle || '', jdText: f3.jdText || '', salaryText: '', experienceText: '' });
  check('空页：判为信息不足', ev3.grade === 'insufficient', '实际 ' + ev3.grade);
}

/* ---------- 用例 4：猎聘结构 ---------- */
const liepinHtml = `
<div class="job-title-box">
  <div class="name">大模型应用开发工程师</div>
  <div class="salary">25-45K·14薪</div>
</div>
<div class="company-info"><span class="name">某信息技术有限公司</span></div>
<div class="job-qualifications"><span>上海</span><span>3-5年</span><span>本科</span></div>
<div class="job-description">
  <p>负责公司智能客服系统的建设，基于 RAG 搭建知识检索链路，</p>
  <p>使用 LangChain 与向量数据库完成问答能力落地，建立评测体系。</p>
  <p>要求 3 年以上 Python 经验，熟悉 Dify 等平台者优先。</p>
</div>
`;

setup(liepinHtml, 'https://www.liepin.com/job/1234567.shtml', '大模型应用开发工程师-上海-25-45K·14薪-某信息技术有限公司-猎聘');
let f4 = E.extract(A.SITE_ADAPTERS[1]);

check('猎聘：职位名走选择器', f4 && /大模型应用开发/.test(f4.jobTitle), f4 && ('实际 ' + f4.jobTitle));
check('猎聘：公司名走选择器', f4 && /某信息技术/.test(f4.company), f4 && ('实际 ' + f4.company));
check('猎聘：城市解析', f4 && f4.city === '上海', f4 && ('实际 ' + f4.city));
check('猎聘：JD 走选择器', f4 && f4.sources.jd === '选择器', f4 && ('实际 ' + f4.sources.jd));

let ev4 = R.evaluate({ jobTitle: f4.jobTitle, jdText: f4.jdText, salaryText: f4.salaryText, experienceText: f4.experienceText });
check('猎聘：族群判为 AI 应用', ev4.group === 'A', '实际 ' + ev4.group + ' ' + ev4.groupShort);

/* ---------- 用例 5：详情页判定 ---------- */
check('详情页判定：BOSS 详情页', A.isDetailPage(A.SITE_ADAPTERS[0], 'https://www.zhipin.com/job_detail/abc.html') === true);
check('详情页判定：BOSS 列表页', A.isDetailPage(A.SITE_ADAPTERS[0], 'https://www.zhipin.com/web/geek/jobs?query=ai') === false);
check('列表页识别', A.looksLikeListPage('https://www.zhipin.com/web/geek/jobs?query=ai') === true);
check('适配器：支持 4 个平台', A.SITE_ADAPTERS.length === 4);
check('适配器：未知域名返回 null', A.getAdapter('example.com') === null);

/* ---------- 用例 6：面板渲染 ---------- */
require('../src/content/panel.js');
const P = globalThis.JR_PANEL;

const dom6 = setup('<div></div>', 'https://www.zhipin.com/job_detail/abc123.html');

let saveCalled = 0;
let copyCalled = 0;

P.bind();
P.show({
  key: 'demo-key-1',
  fields: f1,
  ev: ev1,
  saved: false,
  seenCount: 0,
  staleDays: 0
}, {
  onSave: function () { saveCalled++; },
  onCopy: function () { copyCalled++; },
  onReextract: function () {}
});

const host = document.getElementById('jr-radar-host');
check('面板：宿主节点已挂载', !!host);
check('面板：Shadow DOM 已创建', !!(host && host.shadowRoot));

const panelText = host && host.shadowRoot ? host.shadowRoot.textContent : '';
check('面板：渲染出面板容器', !!(host && host.shadowRoot && host.shadowRoot.querySelector('.jr-panel')));
check('面板：显示分数', panelText.indexOf(String(ev1.score)) !== -1, '面板文本未包含 ' + ev1.score);
check('面板：显示档位文案', panelText.indexOf(ev1.gradeLabel) !== -1);
check('面板：列出强信号词', panelText.indexOf('vLLM') !== -1);
check('面板：显示 JD 来源', panelText.indexOf('JD 来源') !== -1);
check('面板：显示保存按钮', panelText.indexOf('保存到本地库') !== -1);

function fireClick(sel) {
  const btn = host.shadowRoot.querySelector(sel);
  if (!btn) return false;
  btn.dispatchEvent(new dom6.window.MouseEvent('click', { bubbles: true }));
  return true;
}

check('面板：找到保存按钮', !!host.shadowRoot.querySelector('[data-act="save"]'));
fireClick('[data-act="save"]');
check('面板：点击保存触发回调', saveCalled === 1, '实际调用 ' + saveCalled + ' 次');

check('面板：找到复制按钮', !!host.shadowRoot.querySelector('[data-act="copy"]'));
fireClick('[data-act="copy"]');
check('面板：点击复制触发回调', copyCalled === 1, '实际调用 ' + copyCalled + ' 次');

check('面板：找到折叠按钮', !!host.shadowRoot.querySelector('[data-act="toggle"]'));
fireClick('[data-act="toggle"]');
check('面板：折叠生效', host.shadowRoot.querySelector('.jr-panel').classList.contains('collapsed'));
fireClick('[data-act="toggle"]');
check('面板：展开生效', !host.shadowRoot.querySelector('.jr-panel').classList.contains('collapsed'));

// 状态更新不应破坏渲染
P.markSaved({ seenCount: 3, staleDays: 46 });
const text2 = host.shadowRoot.textContent;
check('面板：保存后切换为更新按钮', text2.indexOf('更新记录') !== -1);
check('面板：挂牌 46 天给出提示', text2.indexOf('46 天') !== -1);

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
