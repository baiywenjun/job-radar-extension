/* SPA 切换岗位回归测试：node tests/switch-test.js
 *
 * 复现现场：BOSS 搜索结果页是「左侧岗位列表 + 右侧滑出详情」，
 * 点击左侧另一个卡片时 URL 与 document.title 都不变，只有右侧详情 DOM
 * 被异步替换。旧版只轮询 URL/标题，且一次抽不到就 hide() 且无恢复路径，
 * 于是面板永久消失。
 *
 * 这里用 jsdom 的真实 MutationObserver 跑完整 main.js 链路：
 * 注入 → 渲染 → 切换详情 → 切换空窗 → 恢复 → 宿主被移除后重建。
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

/* 详情页 URL 不匹配 detailPattern，所以主流程要求 JD >= 200 字才显示。
   这段文本同时含有强信号词，保证打分链路也被真实跑到。 */
const JD_BASE =
  '一、岗位定位：作为深入客户一线的复合型技术交付角色，承担大模型应用与智能体项目的端到端落地交付。' +
  '二、主要工作职责：负责需求调研与方案转化，梳理客户业务场景、系统集成需求与数据边界，输出可验收的实施方案；' +
  '基于 vLLM 与 SGLang 搭建私有化推理服务，完成 PD 分离、KV Cache 与量化优化，持续压降单位 Token 成本与 TTFT 指标；' +
  '使用 LangGraph 编排多智能体流程，接入 MCP 工具调用与 RAG 检索链路，建设评测回归体系、监控告警与故障降级兜底；' +
  '三、任职要求：具备 3-5 年以上相关经验，熟悉 CUDA 算子开发与推理引擎二次开发，' +
  '有从 0 到 1 上线并稳定运行的完整项目经历，能独立排查运行期故障，能适应短期出差与驻场交付。';

function detailInner(title, salary, extra) {
  return `
    <div class="detail-header">
      <h1>${title}</h1>
      <span class="pay-text">${salary}</span>
      <div class="req-tags"><span>广州</span><span>3-5年</span><span>本科</span></div>
      <div class="comp"><a class="company-link">广东保伦电子</a></div>
    </div>
    <div class="detail-body">
      <h3>职位描述</h3>
      <p>${JD_BASE}</p>
      <p>${extra}</p>
    </div>`;
}

function pageHtml() {
  return `
<div class="page">
  <div class="job-list">
    <div class="job-card"><div class="job-title"><span class="name">岗位甲</span></div><div class="salary">8-13K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位乙</span></div><div class="salary">9-14K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位丙</span></div><div class="salary">10-15K</div></div>
  </div>
  <div class="detail-panel" id="detail">
    ${detailInner('AI部署工程师（FDE）', '12-15K', '负责智能体工作流的编排、部署与上线验收。')}
  </div>
</div>`;
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.error('[jsdomError] ' + e.message));

const dom = new JSDOM(pageHtml(), {
  url: 'https://www.zhipin.com/web/geek/job?query=FDE',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const w = dom.window;
w.document.title = 'FDE招聘 - 2026年人才招聘信息 - BOSS直聘';

let saveMessages = 0;
w.chrome = {
  runtime: {
    lastError: null,
    sendMessage: function (msg, cb) {
      if (msg.type === 'SAVE') saveMessages++;
      if (!cb) return;
      if (msg.type === 'QUERY_ONE') cb({ record: null });
      else if (msg.type === 'SAVE') cb({ ok: true, record: { firstSeen: Date.now(), seenCount: 1 } });
      else cb({});
    }
  }
};

/* 按 manifest.json 的顺序加载，最后加载 main.js 触发 init() */
[
  'src/common/util.js',
  'src/common/rules.js',
  'src/common/verdict.js',
  'src/content/adapters.js',
  'src/content/extract.js',
  'src/content/diagnose.js',
  'src/content/panel.js',
  'src/content/main.js'
].forEach(function (rel) {
  w.eval(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
});

function panelText() {
  const host = w.document.getElementById('jr-radar-host');
  return host && host.shadowRoot ? host.shadowRoot.textContent : '';
}

async function main() {
  /* ---- 1. 初始注入 ---- */
  await wait(1400);
  const host = w.document.getElementById('jr-radar-host');
  check('初始：面板宿主已挂载', !!host);
  check('初始：面板可见', !!host && host.style.display === 'block',
    host ? 'display=' + host.style.display : 'host 不存在');
  check('初始：显示第一个岗位', panelText().indexOf('AI部署工程师（FDE）') !== -1,
    panelText().slice(0, 160));

  const detail = w.document.getElementById('detail');

  /* ---- 2. 同一 URL、同一标题下切换左侧岗位 ---- */
  detail.innerHTML = detailInner('AI前沿部署工程师（FDE）', '20-35K',
    '负责世界模型与 VLA 链路的数据闭环建设、仿真评测与量产部署。');
  await wait(800);

  const host2 = w.document.getElementById('jr-radar-host');
  const text2 = panelText();
  check('切换后：面板没有消失', !!host2 && host2.style.display === 'block',
    host2 ? 'display=' + host2.style.display : 'host 不存在');
  check('切换后：更新为新岗位', text2.indexOf('AI前沿部署工程师（FDE）') !== -1,
    text2.slice(0, 200));
  check('切换后：薪资同步更新', text2.indexOf('20-35K') !== -1,
    text2.slice(0, 200));
  check('切换后：不再显示旧岗位', text2.indexOf('AI部署工程师（FDE）') === -1);

  /* ---- 3. 切换瞬间的空窗：旧详情已清空、新详情未到 ---- */
  detail.innerHTML = '<div class="loading">加载中…</div>';
  await wait(450);
  const host3 = w.document.getElementById('jr-radar-host');
  const text3 = panelText();
  check('空窗：面板仍保留', !!host3 && host3.style.display === 'block',
    host3 ? 'display=' + host3.style.display : 'host 不存在');
  check('空窗：显示等待态', /正在读取/.test(text3), text3.slice(0, 160));

  /* ---- 4. 新详情到达后自动恢复 ---- */
  detail.innerHTML = detailInner('大模型应用工程师', '30-50K',
    '负责金融行业私有化 RAG 管道的迁移、替换与上线验收，建设 eval 回归体系。');
  await wait(900);
  const text4 = panelText();
  check('恢复后：更新为第三个岗位', text4.indexOf('大模型应用工程师') !== -1,
    text4.slice(0, 200));
  check('恢复后：等待态已清除', !/正在读取/.test(text4), text4.slice(0, 160));

  /* ---- 5. 宿主被页面整体重绘移除后，应自动重建且事件仍可用 ---- */
  const oldHost = w.document.getElementById('jr-radar-host');
  oldHost.parentNode.removeChild(oldHost);
  detail.innerHTML = detailInner('推理优化工程师', '40-60K',
    '负责 CUDA 算子开发、投机解码与推理服务的性能调优。');
  await wait(900);

  const newHost = w.document.getElementById('jr-radar-host');
  check('宿主被移除后自动重建', !!newHost && newHost !== oldHost);
  check('重建后面板可见', !!newHost && newHost.style.display === 'block');
  const saveBtn = newHost && newHost.shadowRoot
    ? newHost.shadowRoot.querySelector('[data-act="save"]')
    : null;
  check('重建后保存按钮存在', !!saveBtn);
  if (saveBtn) saveBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('重建后事件绑定恢复', saveMessages === 1, '实际 SAVE 消息 ' + saveMessages + ' 条');

  /* ---- 6. 现场症状：切换岗位时 document.title 也跟着变，
        同时详情还在加载 —— 旧版正是在这次 run 里直接 P.hide() 且再也回不来 ---- */
  w.document.title = 'AI前沿部署工程师（FDE）招聘 - 广东保伦电子 - BOSS直聘';
  detail.innerHTML = '<div class="loading">加载中…</div>';
  await wait(1500);
  const host6 = w.document.getElementById('jr-radar-host');
  const text6 = panelText();
  check('标题变化 + 加载空窗：面板仍保留', !!host6 && host6.style.display === 'block',
    host6 ? 'display=' + host6.style.display : 'host 不存在');
  check('标题变化 + 加载空窗：显示等待态', /正在读取/.test(text6), text6.slice(0, 160));

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  dom.window.close();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
