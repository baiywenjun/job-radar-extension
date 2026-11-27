/* 判定链路端到端测试：node tests/judge-flow-test.js
 *
 * 用 jsdom + 假端口跑完整 main.js：
 *   1. 打开岗位 → 规则结果先出 → 自动建端口发起判定
 *   2. 模型结论回来 → 面板换成 oneLine，底部写明来源
 *   3. 切换岗位 → 旧端口必须断开（否则并发烧钱）
 *   4. 旧端口的迟到结论必须被丢弃（否则旧结论盖到新岗位上）
 *
 * 第 3、4 条是这次改造里最容易出、也最贵的问题：一次连切三个岗位就是三个请求，
 * 而且先返回的那个会覆盖面板。
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

const JD_A =
  '一、岗位定位：作为深入客户一线的复合型技术交付角色，承担大模型应用与智能体项目的端到端落地交付。' +
  '二、主要工作职责：负责需求调研与方案转化，梳理客户业务场景与数据边界，输出可验收的实施方案；' +
  '基于 vLLM 搭建私有化推理服务，完成 PD 分离与量化优化，持续压降单位 Token 成本与 TTFT 指标；' +
  '使用 LangGraph 编排多智能体流程，接入 MCP 工具调用与 RAG 检索链路，建设评测回归体系与监控告警；' +
  '三、任职要求：具备 3-5 年以上相关经验，有从 0 到 1 上线并稳定运行的完整项目经历，能适应短期出差与驻场交付。';
const JD_B =
  '一、岗位定位：负责自动驾驶感知模型的车端部署与工程化落地，支撑量产项目的算法上车。' +
  '二、主要工作职责：负责模型量化压缩与算子融合，熟悉 CUDA 算子开发与 TensorRT 推理优化，' +
  '搭建数据闭环与仿真评测体系，建设车端推理服务的监控告警与故障降级机制，' +
  '与感知算法团队协作完成模型迭代与版本发布；' +
  '三、任职要求：具备 5 年以上相关经验，精通 C++ 与推理引擎二次开发，有量产项目落地经历，能适应出差。';

function detailInner(title, salary, jd) {
  return `
    <div class="detail-header">
      <h1>${title}</h1>
      <span class="pay-text">${salary}</span>
      <div class="req-tags"><span>广州</span><span>3-5年</span><span>本科</span></div>
      <div class="comp"><a class="company-link">广东保伦电子</a></div>
    </div>
    <div class="detail-body"><h3>职位描述</h3><p>${jd}</p></div>`;
}

function pageHtml(title, salary, jd) {
  return `
<div class="page">
  <div class="job-list">
    <div class="job-card"><div class="job-title"><span class="name">岗位甲</span></div><div class="salary">8-13K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位乙</span></div><div class="salary">9-14K</div></div>
    <div class="job-card"><div class="job-title"><span class="name">岗位丙</span></div><div class="salary">10-15K</div></div>
  </div>
  <div class="detail-panel" id="detail">${detailInner(title, salary, jd)}</div>
</div>`;
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.error('[jsdomError] ' + e.message));

const dom = new JSDOM(pageHtml('AI部署工程师（FDE）', '12-15K', JD_A), {
  url: 'https://www.zhipin.com/web/geek/job?query=FDE',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const w = dom.window;
w.document.title = 'FDE招聘 - BOSS直聘';

/* ---------- 假端口 ---------- */
const ports = [];

function makePort() {
  const onMsg = [];
  const onDis = [];
  const port = {
    name: 'jr-judge',
    sent: [],
    disconnected: false,
    onMessage: { addListener: (fn) => onMsg.push(fn) },
    onDisconnect: { addListener: (fn) => onDis.push(fn) },
    postMessage(msg) { port.sent.push(msg); },
    disconnect() {
      if (port.disconnected) return;
      port.disconnected = true;
      onDis.slice().forEach((f) => f());
    },
    emit(msg) { onMsg.slice().forEach((f) => f(msg)); }
  };
  ports.push(port);
  return port;
}

let publicCalls = 0;
let disclosurePosts = 0;

/* SETTINGS_PUBLIC 的内容会随场景变：外发确认、当日用量都是判定前的门槛，
   测试要能分别构造这几种状态。 */
let publicSettings = {
  model: 'deepseek-chat', hasKey: true, autoJudge: true,
  dailyLimit: 100, dailyUsed: 3,
  baseOrigin: 'https://api.deepseek.com',
  disclosureAccepted: true, coolingUntil: 0
};

w.chrome = {
  runtime: {
    lastError: null,
    sendMessage: function (msg, cb) {
      if (!cb) return;
      if (msg.type === 'SETTINGS_PUBLIC') {
        publicCalls++;
        cb({
          ok: true,
          settings: Object.assign({}, publicSettings),
          active: { id: 'p1', name: 'FDE', version: 3 },
          profiles: [{ id: 'p1', name: 'FDE', version: 3 }, { id: 'p2', name: 'AI应用', version: 1 }]
        });
        return;
      }
      if (msg.type === 'DISCLOSURE_ACCEPT') {
        disclosurePosts++;
        publicSettings.disclosureAccepted = true;
        cb({ ok: true, disclosureAccepted: true });
        return;
      }
      if (msg.type === 'QUERY_ONE') { cb({ record: null }); return; }
      cb({ ok: true });
    },
    connect: function (info) {
      if (info && info.name === 'jr-judge') return makePort();
      throw new Error('未知端口名：' + info.name);
    }
  }
};

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

function shadow() {
  const host = w.document.getElementById('jr-radar-host');
  return host ? host.shadowRoot : null;
}

function baseVerdict(over) {
  return Object.assign({
    grade: 'strong',
    confidence: 0.8,
    score: 92,
    gradeLabel: '强信号',
    gradeDesc: '有具体技术栈与建设项目，值得优先投',
    oneLine: '私有化推理与智能体交付都在做，值得投',
    evidence: [{ type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' }],
    missing: ['客户现场沟通'],
    risks: [],
    model: 'deepseek-chat',
    profileName: 'FDE',
    ms: 4200,
    usage: { in: 1500, out: 200, total: 1700 }
  }, over || {});
}

async function main() {
  /* ---- 1. 首次渲染：规则结果先出，随后自动发起判定 ---- */
  await wait(1600);

  check('面板已渲染岗位', panelText().indexOf('AI部署工程师（FDE）') !== -1,
    panelText().slice(0, 120));
  check('已向后台取过配置', publicCalls > 0, String(publicCalls));
  check('自动建立了一个判定端口', ports.length === 1, String(ports.length));

  const p0 = ports[0];
  check('端口名正确', p0 && p0.name === 'jr-judge');

  const start0 = p0 && p0.sent.filter((m) => m.type === 'START')[0];
  check('发出了 START', !!start0);
  check('START 带岗位 key', !!(start0 && start0.jobKey));
  check('START 带完整 JD', !!(start0 && start0.jdText && start0.jdText.indexOf('vLLM') !== -1));
  check('START 带标准 id', start0 && start0.profileId === 'p1', start0 && start0.profileId);
  check('START 带字段来源', start0 && start0.sources && !!start0.sources.jd);

  check('判定中底部写明"模型判定中"',
    /判定：模型判定中/.test(panelText()), panelText().slice(-120));

  /* ---- 2. 流式进度 ---- */
  p0.emit({ type: 'DELTA', chars: 480 });
  await wait(30);
  check('收到增量后显示已收字数',
    /已收 480 字/.test(panelText()), panelText().slice(-120));
  check('判定中显示进度条', !!(shadow() && shadow().querySelector('.jr-prog')));

  /* ---- 3. 结论回来：面板换成模型结果 ---- */
  p0.emit({ type: 'DONE', verdict: baseVerdict() });
  await wait(60);

  const t1 = panelText();
  check('显示模型的一句话结论',
    t1.indexOf('私有化推理与智能体交付都在做') !== -1, t1.slice(0, 220));
  check('底部写明来源是模型',
    /判定：模型 deepseek-chat/.test(t1), t1.slice(-140));
  check('底部带 token 与耗时',
    /1\.7k tokens/.test(t1) && /4\.2s/.test(t1), t1.slice(-140));
  check('结论到达后端口已断开', p0.disconnected === true);
  check('模型证据进入支持证据区',
    t1.indexOf('私有化推理') !== -1);

  /* ---- 4. 切换岗位：旧端口必须断开，且只开一个新端口 ---- */
  const detail = w.document.getElementById('detail');
  detail.innerHTML = detailInner('自动驾驶部署工程师', '40-60K', JD_B);
  await wait(900);

  check('切换岗位后新建了端口', ports.length === 2, String(ports.length));
  check('旧端口已断开（不会并发烧钱）', ports[0].disconnected === true);

  const p1 = ports[1];
  const start1 = p1.sent.filter((m) => m.type === 'START')[0];
  check('新 START 用的是新岗位 JD',
    !!(start1 && start1.jdText && start1.jdText.indexOf('TensorRT') !== -1),
    start1 ? start1.jdText.slice(0, 40) : '无');
  check('新 START 的 jobKey 与旧的不同',
    !!(start0 && start1 && start0.jobKey !== start1.jobKey));

  /* ---- 5. 判定在途时再次切换：旧端口的迟到结论必须被丢弃 ---- */
  detail.innerHTML = detailInner('推理优化工程师', '40-60K', JD_A + ' 负责 CUDA 算子与推理性能调优。');
  await wait(900);

  const p2 = ports[2];
  check('在途切换后新建了第三个端口', !!p2 && ports.length === 3, String(ports.length));
  check('上一个端口（自动驾驶）已被断开', p1.disconnected === true);

  /* 关键：端口 B 从未收到过结论，此时它再回一条 DONE。
     只有「序号闸」能拦住它——这正是切岗位时最容易出的事故。 */
  p1.emit({ type: 'DONE', verdict: baseVerdict({ oneLine: '这是已被取消的自动驾驶结论' }) });
  await wait(80);

  const t2 = panelText();
  check('被取消端口的迟到结论被丢弃',
    t2.indexOf('这是已被取消的自动驾驶结论') === -1, t2.slice(0, 220));
  check('面板仍显示当前岗位', t2.indexOf('推理优化工程师') !== -1, t2.slice(0, 200));

  /* ---- 6. 当前端口的结论生效 ---- */
  p2.emit({
    type: 'DONE',
    verdict: baseVerdict({
      grade: 'neutral', score: 68, gradeLabel: '中性',
      oneLine: '算子与推理优化方向对，但量产经验要求待核',
      evidence: [{ type: 'nice', claim: 'CUDA 算子调优', quote: 'CUDA 算子与推理性能调优' }]
    })
  });
  await wait(60);

  const t3 = panelText();
  check('当前端口的结论替换了面板',
    t3.indexOf('算子与推理优化方向对') !== -1, t3.slice(0, 240));
  check('档位同步更新为中性', t3.indexOf('中性') !== -1);
  check('新端口结论到达后已断开', p2.disconnected === true);

  /* ---- 7. 失败路径不能让面板空掉 ---- */
  detail.innerHTML = detailInner('大模型平台工程师', '35-50K',
    JD_A + ' 另外负责推理网关的容量规划与成本优化。');
  await wait(900);
  const p3 = ports[3];
  check('第四个岗位又新建了端口', !!p3 && ports.length === 4, String(ports.length));
  if (p3) {
    p3.emit({ type: 'FAIL', code: 'E_AUTH', error: 'API Key 无效或权限不足', retryable: false });
    await wait(60);
    const t4 = panelText();
    check('模型失败时仍显示岗位与规则结果',
      t4.indexOf('大模型平台工程师') !== -1, t4.slice(0, 200));
    check('底部写明失败原因',
      /判定：本地规则（模型失败：API Key 无效或权限不足）/.test(t4), t4.slice(-160));
  }

  /* ---- 8. 缓存结论：底部必须说明这次没花钱 ---- */
  detail.innerHTML = detailInner('Agent 交付工程师', '30-45K',
    JD_B + ' 另外负责客户侧 Agent 上线与效果归因。');
  await wait(900);
  const p4 = ports[ports.length - 1];
  check('第八个岗位开了端口', !!p4 && ports.length === 5, String(ports.length));
  if (p4) {
    p4.emit({
      type: 'DONE',
      verdict: baseVerdict({ cached: true, cacheAgeMs: 3 * 60 * 1000, cost: 0.0021 })
    });
    await wait(60);
    check('缓存结论底部标「缓存」',
      /判定：缓存 · 3 分钟前/.test(panelText()), panelText().slice(-160));
    check('缓存结论不再显示模型耗时',
      !/4\.2s/.test(panelText().slice(-160)), panelText().slice(-160));
  }

  /* ---- 9. 首次外发确认：没同意之前一个请求都不发 ---- */
  publicSettings.disclosureAccepted = false;
  const before9 = ports.length;
  detail.innerHTML = detailInner('知识库工程师', '25-35K',
    JD_A + ' 另外负责知识库内容治理与权限梳理。');
  await wait(900);

  check('未同意外发时不开端口', ports.length === before9, String(ports.length));
  check('面板出现外发确认卡', panelText().indexOf('首次把岗位内容发给模型') !== -1,
    panelText().slice(0, 200));
  check('确认卡写明目标域名', panelText().indexOf('api.deepseek.com') !== -1);
  check('确认卡写明不脱敏', panelText().indexOf('不脱敏') !== -1);
  check('底部写明等待确认',
    /判定：本地规则（等待确认外发）/.test(panelText()), panelText().slice(-160));

  const accept = shadow() && shadow().querySelector('[data-act="accept-disclosure"]');
  check('确认卡上有「同意并开始判定」按钮', !!accept);
  if (accept) {
    accept.click();
    await wait(120);
    check('点同意后写了一次外发标记', disclosurePosts === 1, String(disclosurePosts));
    check('点同意后才建立端口', ports.length === before9 + 1, String(ports.length));
    const pA = ports[ports.length - 1];
    const startA = pA.sent.filter((m) => m.type === 'START')[0];
    check('同意后的 START 不带放行标记', !!(startA && !startA.allowOverLimit));
  }

  /* ---- 10. 每日上限：只停自动判定，且能手動放行 ---- */
  publicSettings.dailyUsed = 100;
  publicSettings.dailyLimit = 100;
  const before10 = ports.length;
  detail.innerHTML = detailInner('推理平台工程师', '35-50K',
    JD_B + ' 另外负责推理网关的容量规划与成本优化。');
  await wait(900);

  check('达上限时不开端口', ports.length === before10, String(ports.length));
  check('底部写明今日已达上限',
    /今日已达上限 100\/100/.test(panelText()), panelText().slice(-170));
  check('超限时仍显示岗位与规则结果',
    panelText().indexOf('推理平台工程师') !== -1, panelText().slice(0, 160));

  const forceBtn = shadow() && shadow().querySelector('[data-act="force-judge"]');
  check('面板出现「手动放行一次」按钮', !!forceBtn);
  if (forceBtn) {
    forceBtn.click();
    await wait(120);
    check('手动放行后建立端口', ports.length === before10 + 1, String(ports.length));
    const pB = ports[ports.length - 1];
    const startB = pB.sent.filter((m) => m.type === 'START')[0];
    check('放行的 START 带 allowOverLimit', !!(startB && startB.allowOverLimit === true));
  }

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  dom.window.close();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
