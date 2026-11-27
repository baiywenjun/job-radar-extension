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

check('空页：不抛异常且无有效字段', f3 === null || (!f3.jobTitle && !f3.company && !f3.jdText),
  f3 && ('实际 ' + JSON.stringify({ t: f3.jobTitle, c: f3.company, jd: f3.jdText.length })));

// 空页应返回 null 交给上层显示诊断卡，而不是伪造字段；
// 规则引擎对空文本的判定单独验证，保证这条断言恒定执行。
let ev3 = R.evaluate({ jobTitle: '', jdText: '', salaryText: '', experienceText: '' });
check('空页：无内容时判为信息不足', ev3.grade === 'insufficient', '实际 ' + ev3.grade);

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

/* ---------- 用例 4.5：BOSS 搜索列表 + 右侧滑出详情（现场截图结构） ----------
   现场问题：左侧卡片与右侧详情类名重复，全文档 querySelector 抓到了左侧
   卡片里的「FDE交付」当职位名；公司从页面标题解析成「2026年人才招聘信息」；
   薪资与经验因新版侧滑面板类名与旧详情页不同而抽不到。
   修复思路：以 JD 容器为锚点向上圈定详情区，所有字段只在区内抽取。 */
const bossSplitHtml = `
<div class="page">
  <div class="job-list">
    <div class="job-card">
      <div class="job-title"><span class="name">AI部署工程师（FDE）</span></div>
      <div class="salary">11-12K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">飞书 FDE交付工程师</span></div>
      <div class="salary">8-13K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">FDE（前线部署工程师）</span></div>
      <div class="salary">6-7K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">AI交付工程师</span></div>
      <div class="salary">10-18K</div>
    </div>
  </div>
  <div class="detail-panel">
    <div class="detail-header">
      <h1>AI前沿部署工程师（FDE）</h1>
      <span class="pay-text">13-25K</span>
      <div class="req-tags"><span>广州</span><span>3-5年</span><span>本科</span></div>
      <div class="comp"><a class="company-link">广东保伦电子</a></div>
    </div>
    <div class="detail-body">
      <h3>职位描述</h3>
      <p>一、岗位定位：作为深入一线的复合型技术交付角色，承担两类项目的落地交付。</p>
      <p>二、主要工作职责：需求调研与方案转化，梳理业务场景与系统集成需求。</p>
      <p>三、智能体项目交付：负责客户本地或云端环境的部署、配置、调试与上线。</p>
      <p>要求具备 3-5 年相关经验，本科及以上学历，能适应出差。</p>
    </div>
  </div>
</div>
`;

setup(bossSplitHtml, 'https://www.zhipin.com/web/geek/job?query=FDE&city=101280100',
  'FDE招聘 - 2026年人才招聘信息 - BOSS直聘');
const fSplit = E.extract(A.SITE_ADAPTERS[0]);

check('BOSS分栏：职位名不取左侧列表', fSplit && fSplit.jobTitle === 'AI前沿部署工程师（FDE）',
  fSplit && ('实际 ' + fSplit.jobTitle));
check('BOSS分栏：薪资不取左侧卡片', fSplit && /13-25K/.test(fSplit.salaryText),
  fSplit && ('实际 ' + fSplit.salaryText));
check('BOSS分栏：经验解析', fSplit && /3-5年/.test(fSplit.experienceText),
  fSplit && ('实际 ' + fSplit.experienceText));
check('BOSS分栏：城市解析', fSplit && fSplit.city === '广州', fSplit && ('实际 ' + fSplit.city));
check('BOSS分栏：公司不用站点头衔', fSplit && /保伦电子/.test(fSplit.company),
  fSplit && ('实际 ' + fSplit.company));
check('BOSS分栏：JD 走启发式兜底', fSplit && fSplit.sources.jd === '启发式',
  fSplit && ('实际 ' + fSplit.sources.jd));

const parsedSplit = E.parseDocTitle('FDE招聘 - 2026年人才招聘信息 - BOSS直聘');
check('标题解析：不把站点头衔当公司', parsedSplit.company === '', '实际 ' + parsedSplit.company);

/* ---------- 用例 4.6：详情区退化到含列表的容器 ----------
   有些站点薪资区块与 JD 区块是并列的，两者的公共祖先就是整页，
   这时「详情区」无法收窄，会连左侧列表一起圈进来。
   靠列表项识别（同 class 兄弟 ≥3）作为最后一道防线。 */
const bossFlattenHtml = `
<div class="layout">
  <div class="job-list">
    <div class="job-card">
      <div class="job-title"><span class="name">AI部署工程师</span></div>
      <div class="salary">11-12K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">飞书 FDE交付工程师</span></div>
      <div class="salary">8-13K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">AI交付工程师</span></div>
      <div class="salary">10-18K</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">实施工程师</span></div>
      <div class="salary">6-9K</div>
    </div>
  </div>
  <div class="main-col">
    <div class="head-block"><h1>目标岗位：FDE 交付专家</h1></div>
    <div class="pay-block"><span>30-50K</span><span>4-6年</span></div>
  </div>
  <div class="jd-block">
    <h3>岗位职责</h3>
    <p>负责客户现场的大模型应用交付，梳理业务场景并完成方案设计与部署上线。</p>
    <p>需要对接客户现有系统与 API，完成权限认证、数据治理与私有化部署调试。</p>
    <p>要求具备 4-6 年相关经验，本科及以上学历，能独立排查运行期故障。</p>
  </div>
</div>
`;

setup(bossFlattenHtml, 'https://www.zhipin.com/web/geek/job?query=FDE',
  'FDE招聘 - 2026年人才招聘信息 - BOSS直聘');
const fFlat = E.extract(A.SITE_ADAPTERS[0]);

check('列表防线：职位名不取列表项', fFlat && fFlat.jobTitle === '目标岗位：FDE 交付专家',
  fFlat && ('实际 ' + fFlat.jobTitle));
check('列表防线：薪资不取列表项', fFlat && /30-50K/.test(fFlat.salaryText),
  fFlat && ('实际 ' + fFlat.salaryText));
check('列表防线：经验取详情块', fFlat && /4-6年/.test(fFlat.experienceText),
  fFlat && ('实际 ' + fFlat.experienceText));

/* ---------- 用例 4.7：JD 正文里的数字噪声不得覆盖头部字段 ----------
   现场（BOSS 新版搜索页）：面板把薪资抽成「3-5K」、经验抽成「在校」、
   职位抽成招聘者「李润葳 刚刚活跃」，而头部真实值是 8-13K / 1-3年。
   根因是详情区判定只看整段 textContent，JD 里的「3-5年 / 8K-15K」
   让 scope 停在 JD 容器内部，头部字段反被排除；宽泛的 .name 选择器
   又命中了招聘者信息。 */
const bossHeaderNoiseHtml = `
<div class="page">
  <div class="job-list">
    <div class="job-card">
      <div class="job-title"><span class="name">FDE（前线部署工程师）</span></div>
      <div class="salary">6-7K</div>
      <div class="company-name">某知名基金公司</div>
    </div>
    <div class="job-card selected">
      <div class="job-title"><span class="name">飞书 FDE交付工程师</span></div>
      <div class="salary">8-13K</div>
      <div class="company-name">秉希网络</div>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">数智工程师（JAVA/FDE）</span></div>
      <div class="salary">11-17K</div>
      <div class="company-name">拓臣企业</div>
    </div>
  </div>
  <div class="job-detail-box">
    <div class="detail-header">
      <h1>飞书 FDE交付工程师</h1>
      <span class="pay-text">8-13K</span>
      <div class="info-primary"><span>广州</span><span>1-3年</span><span>大专</span></div>
      <div class="boss-info"><span class="name">李润葳 刚刚活跃</span></div>
      <span>电子商务</span>
      <div class="comp-name">秉希网络</div>
    </div>
    <div class="job-detail-section">
      <div class="job-sec-text">
        <h3>职位描述</h3>
        <p>工作地点：【广州，需接受客户现场出差】</p>
        <p>薪资范围：【8K-15K】 岗位类型：全职</p>
        <p>补充说明：实习期补贴 3-5K，在校 / 应届均可，转正后按岗位定级。</p>
        <p>一、岗位定位：聚焦飞书全系产品（IM、多维表格、妙搭、AIAgent、Aily、开放平台等）在客户侧的落地，深入打通售前交付使用一站式全链路，以技术手段为客户搭建数字化协同、业务流程与智能决策能力。</p>
        <p>二、岗位职责：配合销售完成中大型企业客户的 POC 验证、系统集成、效果调优到上线护航的全流程交付；独立输出可落地的实施方案，组织方案宣讲、需求梳理、竞品对比、价值呈现。</p>
        <p>三、任职要求：具备 1-3 年相关经验，大专及以上学历，能接受客户现场出差，有私有化部署与 RAG 知识库建设经验者优先。</p>
      </div>
    </div>
  </div>
</div>
`;

setup(bossHeaderNoiseHtml, 'https://www.zhipin.com/web/geek/job?query=FDE',
  'FDE招聘 - 2026年人才招聘信息 - BOSS直聘');
const fNoise = E.extract(A.SITE_ADAPTERS[0]);

check('JD 噪声：职位取头部标题，不取招聘者', fNoise && fNoise.jobTitle === '飞书 FDE交付工程师',
  fNoise && ('实际 ' + fNoise.jobTitle));
check('JD 噪声：薪资取 8-13K，不取 3-5K / 8K-15K', fNoise && fNoise.salaryText === '8-13K',
  fNoise && ('实际 ' + fNoise.salaryText));
check('JD 噪声：经验取 1-3年，不取 在校', fNoise && fNoise.experienceText === '1-3年',
  fNoise && ('实际 ' + fNoise.experienceText));
check('JD 噪声：经验来源可诊断', fNoise && fNoise.sources.experience === '结构推断',
  fNoise && ('实际 ' + fNoise.sources.experience));
check('JD 噪声：公司不取行业词「电子商务」', fNoise && fNoise.company === '秉希网络',
  fNoise && ('实际 ' + fNoise.company));
check('JD 噪声：JD 正文完整抽取', fNoise && fNoise.jdText.length > 250,
  fNoise && ('实际 ' + fNoise.jdText.length + ' 字'));

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
let diagCalled = 0;

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
  onDiag: function () { diagCalled++; },
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
check('面板：显示白橙版标记', panelText.indexOf('白橙版 v0.1.5') !== -1);
check('面板：使用橙色主题', host.shadowRoot.querySelector('style').textContent.indexOf('--accent:#e86b0a') !== -1);

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
check('面板：找到复制诊断按钮', !!host.shadowRoot.querySelector('[data-act="diag"]'));
fireClick('[data-act="diag"]');
check('面板：点击诊断触发回调', diagCalled === 1, '实际调用 ' + diagCalled + ' 次');

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

// 诊断态：已识别站点、页面像详情、但字段全抽不到时，必须给出可见提示。
// 否则用户无法区分「插件没生效」和「站点改版导致选择器失效」。
P.notice('未能识别本页岗位', [
  '已识别站点：BOSS 直聘',
  '页面像岗位详情，但职位名、公司、JD 均抽取失败。'
]);
const text3 = host.shadowRoot.textContent;
check('诊断态：显示标题', text3.indexOf('未能识别本页岗位') !== -1);
check('诊断态：仍显示白橙版标记', text3.indexOf('白橙版 v0.1.5') !== -1);
check('诊断态：显示诊断信息', text3.indexOf('BOSS 直聘') !== -1);
check('诊断态：面板保持可见', host.style.display !== 'none');
check('诊断态：不再渲染打分环', !host.shadowRoot.querySelector('.jr-ring'));
check('诊断态：提供关闭按钮', !!host.shadowRoot.querySelector('[data-act="dismiss"]'));
fireClick('[data-act="dismiss"]');
check('诊断态：点击关闭后面板隐藏', host.style.display === 'none');

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
