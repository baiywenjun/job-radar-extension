/* 搜索列表页误报回归测试：node tests/listpage-test.js
 *
 * 现场：BOSS 搜索结果页 URL 为
 *   /web/geek/jobs?query=FDE&city=101280100&industry=&position=
 * 这个用例的 DOM 没有右侧详情；实际站点选中岗位后 URL 仍可能不变。
 * 旧版 pageHasJobHint() 只扫正文前 6000 字，列表里出现「职位描述」字样
 * 就判为「页面像岗位详情」，于是弹出「未能识别本页岗位」的红色诊断卡，
 * 并用 console.warn 写日志 —— Chrome 会把它计入扩展的「错误」面板，
 * 用户看到的就是「插件直接报错」。
 *
 * 这里验证四件事：
 *   1. 列表页不产生 warn / error（扩展错误面板保持干净）
 *   2. 列表页显示的是「等待选择岗位」轻提示，不是诊断卡
 *   3. 点选岗位后能正常恢复为评分面板，200–249 字的真实 JD 也能评分
 *   4. 真正抽不到字段时仍显示诊断，但不污染扩展「错误」面板
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const JD_BASE =
  '一、岗位定位：作为深入客户一线的复合型技术交付角色，承担大模型应用与智能体项目的端到端落地交付。' +
  '二、主要工作职责：负责需求调研与方案转化，梳理客户业务场景、系统集成需求与数据边界，输出可验收的实施方案；' +
  '基于 vLLM 与 SGLang 搭建私有化推理服务，完成 PD 分离、KV Cache 与量化优化，持续压降单位 Token 成本；' +
  '使用 LangGraph 编排多智能体流程，接入 MCP 工具调用与 RAG 检索链路，建设评测回归体系与监控告警；' +
  '三、任职要求：具备 3-5 年以上相关经验，熟悉 CUDA 算子开发与推理引擎二次开发，有从 0 到 1 上线经历。';

/* 只有左侧列表，右侧没有任何详情。列表卡片刻意带上「职位描述」字样，
   复现旧版 pageHasJobHint 被列表内容骗过的路径。 */
const LIST_ONLY_HTML = `
<div class="page">
  <div class="job-list">
    <div class="job-card">
      <div class="job-title"><span class="name">AI部署工程师（FDE）</span></div>
      <div class="salary">11-12K</div>
      <div class="tags"><span>广州</span><span>3-5年</span></div>
      <p class="snippet">职位描述：负责私有化部署与交付。</p>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">飞书 FDE交付工程师</span></div>
      <div class="salary">8-13K</div>
      <div class="tags"><span>广州</span><span>1-3年</span></div>
      <p class="snippet">职位描述：负责客户现场实施。</p>
    </div>
    <div class="job-card">
      <div class="job-title"><span class="name">大模型应用工程师</span></div>
      <div class="salary">25-40K</div>
      <div class="tags"><span>深圳</span><span>3-5年</span></div>
      <p class="snippet">职位描述：负责 RAG 管道建设。</p>
    </div>
  </div>
</div>`;

function detailHtml() {
  return `
  <div class="detail-panel" id="detail">
    <div class="detail-header">
      <h1>AI前沿部署工程师（FDE）</h1>
      <span class="pay-text">13-25K</span>
      <div class="req-tags"><span>广州</span><span>3-5年</span><span>本科</span></div>
      <div class="comp"><a class="company-link">广东保伦电子</a></div>
    </div>
    <div class="detail-body">
      <h3>职位描述</h3>
      <p>${JD_BASE}</p>
      <p>负责智能体工作流的编排、部署与上线验收。</p>
    </div>
  </div>`;
}

const warnLog = [];
const errorLog = [];
const infoLog = [];

function boot(html, url) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errorLog.push('[jsdomError] ' + e.message));
  vc.on('warn', (m) => warnLog.push(String(m)));
  vc.on('error', (m) => errorLog.push(String(m)));
  vc.on('info', (m) => infoLog.push(String(m)));

  const dom = new JSDOM(html, {
    url: url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  w.chrome = {
    runtime: {
      lastError: null,
      sendMessage: function (msg, cb) {
        if (!cb) return;
        if (msg.type === 'QUERY_ONE') cb({ record: null });
        else cb({ ok: true, record: { firstSeen: Date.now(), seenCount: 1 } });
      }
    }
  };
  [
    'src/common/util.js',
    'src/common/rules.js',
    'src/content/adapters.js',
    'src/content/extract.js',
    'src/content/diagnose.js',
    'src/content/panel.js'
  ].forEach(function (rel) {
    w.eval(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
  });
  return { dom, w };
}

function panelText(w) {
  const host = w.document.getElementById('jr-radar-host');
  return host && host.shadowRoot ? host.shadowRoot.textContent : '';
}

function panelHost(w) {
  return w.document.getElementById('jr-radar-host');
}

async function main() {
  /* ================= 场景一：纯列表页（无详情） ================= */
  const a = boot(LIST_ONLY_HTML,
    'https://www.zhipin.com/web/geek/jobs?query=FDE&city=101280100&industry=&position=');
  a.w.document.title = 'FDE招聘 - 2026年人才招聘信息 - BOSS直聘';

  /* hasDetailPane 单测：列表卡片有 .salary 与 .job-title .name，但没有 JD 级证据 */
  const A = a.w.JR_ADAPTERS;
  const E = a.w.JR_EXTRACT;
  check('列表页：hasDetailPane 为 false', E.hasDetailPane(A.SITE_ADAPTERS[0]) === false,
    '实际 ' + E.hasDetailPane(A.SITE_ADAPTERS[0]));

  a.w.eval(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'));
  await wait(2600);

  const hostA = panelHost(a.w);
  const textA = panelText(a.w);
  check('列表页：面板宿主已挂载', !!hostA);
  check('列表页：没有产生 console.warn', warnLog.length === 0, warnLog.join(' | '));
  check('列表页：没有产生 console.error', errorLog.length === 0, errorLog.join(' | '));
  check('列表页：不显示「未能识别本页岗位」诊断卡',
    textA.indexOf('未能识别本页岗位') === -1, textA.slice(0, 200));
  check('列表页：显示「等待选择岗位」轻提示',
    textA.indexOf('等待选择岗位') !== -1, textA.slice(0, 200));
  check('列表页：提示语气为正常状态而非故障',
    textA.indexOf('不是插件故障') !== -1, textA.slice(0, 200));

  /* 列表页反复 DOM 抖动不应反复重绘（noticeKey 去重） */
  const before = textA.length;
  for (let i = 0; i < 5; i++) {
    const card = a.w.document.querySelector('.job-card');
    card.setAttribute('data-jitter', String(i));
    await wait(120);
  }
  await wait(600);
  check('列表页：DOM 抖动后提示内容不变', panelText(a.w).length === before,
    '前 ' + before + ' / 后 ' + panelText(a.w).length);
  check('列表页：抖动后仍未产生 warn', warnLog.length === 0, warnLog.join(' | '));

  /* 点选岗位：右侧注入详情，应恢复为评分面板 */
  a.w.document.querySelector('.page').insertAdjacentHTML('beforeend', detailHtml());
  await wait(1200);
  const textA2 = panelText(a.w);
  check('选中岗位后：渲染出职位名', textA2.indexOf('AI前沿部署工程师（FDE）') !== -1,
    textA2.slice(0, 200));
  check('选中岗位后：不再显示等待提示', textA2.indexOf('等待选择岗位') === -1,
    textA2.slice(0, 200));
  check('选中岗位后：仍无 warn / error',
    warnLog.length === 0 && errorLog.length === 0,
    (warnLog.join(' | ') + ' || ' + errorLog.join(' | ')));
  a.dom.window.close();

  /* ================= 场景二：已展开的 BOSS 详情，JD 为 236 字 ================= */
  warnLog.length = 0;
  errorLog.length = 0;
  infoLog.length = 0;
  const shortHtml = `
<div class="page-jobs-main">
  <ul class="job-list">
    <li class="job-card-box"><div class="job-info"><div class="job-title"><span class="name">FDE工程师</span><span class="job-salary">10-11K</span></div><div class="company-name">广州羽淼白品牌管理</div></div></li>
  </ul>
  <div class="recommend-result-job">
    <div class="job-detail-container"><div class="job-detail-box">
      <div class="job-detail-header"><div class="job-header-info">
        <div class="job-detail-info"><span class="job-name">FDE工程师</span><span class="job-salary">10-11K</span></div>
        <ul class="tag-list"><li>广州</li><li>经验不限</li><li>学历不限</li></ul>
      </div></div>
      <div class="job-detail-body"><h3 class="title">职位描述</h3><p class="desc">${JD_BASE.slice(0, 236)}</p></div>
    </div></div>
  </div>
</div>`;
  const s = boot(shortHtml, 'https://www.zhipin.com/web/geek/jobs?city=101280100&query=FDE');
  const shortFields = s.w.JR_EXTRACT.extract(s.w.JR_ADAPTERS.SITE_ADAPTERS[0]);
  check('短 JD：实际抽取长度在 200–249 字之间',
    !!shortFields && shortFields.jdText.length >= 200 && shortFields.jdText.length < 250,
    '实际 ' + (shortFields && shortFields.jdText.length));
  check('短 JD：hasDetailPane 为 true',
    s.w.JR_EXTRACT.hasDetailPane(s.w.JR_ADAPTERS.SITE_ADAPTERS[0]) === true);
  s.w.eval(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'));
  await wait(1200);
  const shortText = panelText(s.w);
  check('短 JD：正常显示职位名和薪资',
    shortText.includes('FDE工程师') && shortText.includes('10-11K'), shortText.slice(0, 200));
  check('短 JD：正常显示评分而非诊断卡',
    shortText.includes('保存到本地库') && !shortText.includes('未能识别本页岗位'), shortText.slice(0, 200));
  check('短 JD：没有写入扩展错误',
    warnLog.length === 0 && errorLog.length === 0, warnLog.join(' | ') + ' || ' + errorLog.join(' | '));
  s.dom.window.close();

  /* ================= 场景三：详情已展开但抽不到（真故障） ================= */
  warnLog.length = 0;
  errorLog.length = 0;
  infoLog.length = 0;
  /* JD 容器够长（>200 字）但页面没有任何职位名，模拟站点改版后标题选择器全失效 */
  const brokenHtml = `
<div class="page">
  <div class="job-list">
    <div class="job-card"><div class="job-title"><span class="name">岗位甲</span></div><div class="salary">8-13K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位乙</span></div><div class="salary">9-14K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位丙</span></div><div class="salary">10-15K</div></div>
  </div>
  <div class="detail-panel">
    <div class="detail-body"><h3>职位描述</h3><p>${JD_BASE}</p></div>
  </div>
</div>`;
  const b = boot(brokenHtml,
    'https://www.zhipin.com/web/geek/jobs?query=FDE&city=101280100&industry=&position=');
  b.w.document.title = 'BOSS直聘';
  b.w.eval(fs.readFileSync(path.join(__dirname, '..', 'src/content/main.js'), 'utf8'));
  await wait(2600);

  const textB = panelText(b.w);
  check('真故障：判断为有详情（hasDetailPane 为 true）',
    b.w.JR_EXTRACT.hasDetailPane(b.w.JR_ADAPTERS.SITE_ADAPTERS[0]) === true);
  check('真故障：显示诊断卡', textB.indexOf('未能识别本页岗位') !== -1, textB.slice(0, 200));
  check('真故障：记录且仅记录一次诊断信息',
    infoLog.filter((m) => m.includes('岗位信息待校准')).length === 1,
    '实际 ' + infoLog.join(' | '));
  check('真故障：没有写入扩展错误', warnLog.length === 0 && errorLog.length === 0,
    warnLog.join(' | ') + ' || ' + errorLog.join(' | '));

  /* 连续 DOM 抖动不应重复写日志 */
  for (let i = 0; i < 6; i++) {
    b.w.document.querySelector('.detail-body').setAttribute('data-jitter', String(i));
    await wait(150);
  }
  await wait(500);
  check('真故障：重复触发后诊断日志仍只有 1 条',
    infoLog.filter((m) => m.includes('岗位信息待校准')).length === 1,
    '实际 ' + infoLog.join(' | '));
  b.dom.window.close();

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
