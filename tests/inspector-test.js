/* 数据检查器测试：node tests/inspector-test.js
 *
 * 检查器要回答的不是「这岗值不值得投」，而是「这条结论凭什么可信」。
 * 所以断言围着三件事：
 *   1. 原始字段旁边必须带来源标签（公司名来自列表卡片 = 结论要打折）
 *   2. 完整正文必须在，且能看出抽取时清掉了多少页面噪声
 *   3. 「重新判定」发的是同一段正文、force 跳过缓存，回写不能涨 seenCount
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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

const root = path.join(__dirname, '..');
const popupDir = path.join(root, 'src/popup');
const html = fs.readFileSync(path.join(popupDir, 'popup.html'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'chrome-extension://test/src/popup/popup.html'
});
const win = dom.window;

const JD_FULL =
  '岗位职责：\n负责客户现场的大模型应用与智能体项目交付。\n' +
  '基于 vLLM 搭建私有化推理服务，完成 PD 分离与量化优化。\n' +
  '任职要求：3-5 年经验，能适应短期驻场。';

const jobs = [
  {
    key: 'k1',
    jobTitle: 'FDE',
    company: '百蕴启辰',
    salaryText: '10-11K',
    city: '北京',
    experienceText: '3-5年',
    siteName: 'BOSS直聘',
    groupLabel: 'AI 交付',
    groupShort: '交付',
    grade: 'strong',
    score: 86,
    strong: ['vLLM'],
    weak: [],
    jdLength: JD_FULL.length,
    jdText: JD_FULL,
    jdExcerpt: JD_FULL.slice(0, 60),
    sources: { jobTitle: '结构推断', company: '列表匹配', salary: '字形混淆', jd: '启发式' },
    dirty: { ui: 3, glued: 1, rawJd: JD_FULL.length + 30 },
    firstSeen: Date.now() - 3 * 86400000,
    lastSeen: Date.now(),
    seenCount: 2,
    url: 'https://www.zhipin.com/job_detail/1.html'
  },
  {
    /* 旧版本记录：只有 600 字摘要，没有完整正文 → 不能重判 */
    key: 'k2',
    jobTitle: 'AI 应用工程师',
    company: '某某科技',
    city: '上海',
    grade: 'weak',
    score: 41,
    strong: [],
    weak: [],
    jdExcerpt: '旧摘要',
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    seenCount: 1,
    url: 'https://www.liepin.com/job/2'
  }
];

const verdicts = [
  {
    key: 'k1',
    grade: 'neutral',
    score: 63,
    confidence: 0.7,
    oneLine: '方向对但偏集成',
    evidence: [
      { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务', verified: true },
      { type: 'red', claim: '驻场', quote: '能适应长期驻场', verified: false }
    ],
    missing: ['Kubernetes'],
    risks: ['外包性质存疑'],
    profileName: 'FDE',
    profileVersion: 2,
    model: 'deepseek-chat',
    createdAt: Date.now() - 3600000,
    evidenceCheck: { checked: 2, passed: 1, rate: 0.5 }
  }
];

const PROFILE = {
  id: 'p_demo', name: 'FDE',
  requirement: '面向客户的交付岗。', mustHave: '私有化部署', redFlags: '纯外包',
  version: 2, createdAt: 1, updatedAt: 2
};

/* k1 判过一次（只有一条轨迹），k2 是升级前的老记录（没有轨迹） */
const logs = {
  k1: [{
    id: 1, key: 'k1', profileId: 'p_demo', profileName: 'FDE', profileVersion: 2,
    grade: 'neutral', score: 63, jdHash: 'h1', jdChars: JD_FULL.length,
    createdAt: Date.now() - 3600000, evidenceFlag: ''
  }],
  k2: []
};

const sentMessages = [];
let patched = null;

function makeArea(store) {
  return {
    get(keys, cb) {
      const out = {};
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
      list.forEach((k) => { if (k in store) out[k] = store[k]; });
      setImmediate(() => cb(out));
    },
    set(obj, cb) { Object.keys(obj).forEach((k) => { store[k] = obj[k]; }); setImmediate(() => cb && cb()); },
    remove(keys, cb) { (typeof keys === 'string' ? [keys] : keys).forEach((k) => { delete store[k]; }); setImmediate(() => cb && cb()); }
  };
}

function makePort() {
  const listeners = [];
  const disconnects = [];
  const port = {
    sent: [],
    postMessage(m) { port.sent.push(m); },
    onMessage: { addListener(f) { listeners.push(f); } },
    onDisconnect: { addListener(f) { disconnects.push(f); } },
    disconnect() { disconnects.forEach((f) => f()); },
    emit(m) { listeners.forEach((f) => f(m)); }
  };
  win.__lastPort = port;
  return port;
}

win.chrome = {
  runtime: {
    lastError: null,
    getManifest() { return { version: '0.2.6' }; },
    sendMessage(msg, cb) {
      sentMessages.push(msg);
      setImmediate(() => {
        if (msg.type === 'PROFILE_ACTIVE') {
          cb({ ok: true, list: [PROFILE], profile: PROFILE, fellBack: false });
        } else if (msg.type === 'VERDICTS_ALL') {
          cb({ ok: true, list: verdicts.slice() });
        } else if (msg.type === 'VERDICT_LOG') {
          cb({ ok: true, key: msg.key, list: (logs[msg.key] || []).slice() });
        } else if (msg.type === 'JOB_PATCH') {
          patched = msg;
          const job = jobs.filter((j) => j.key === msg.key)[0];
          if (job) Object.assign(job, msg.patch);
          verdicts.push(Object.assign({ key: msg.key }, msg.patch, { createdAt: Date.now() }));
          cb({ ok: true, record: job });
        } else if (msg.type === 'SETTINGS_GET') {
          cb({ ok: true, settings: { apiKey: 'sk-x', autoJudge: true, dailyLimit: 100 } });
        } else if (msg.type === 'STATS') {
          cb({ ok: true, jobs: 2, profiles: 1, verdicts: 1, usageToday: { calls: 2 }, usageMonth: { calls: 2 } });
        } else {
          cb({ ok: true });
        }
      });
    },
    connect() { return makePort(); }
  },
  storage: { local: makeArea({}), session: makeArea({}) },
  permissions: { contains(_q, cb) { setImmediate(() => cb(true)); }, request(_q, cb) { setImmediate(() => cb(true)); } },
  tabs: { create() {} }
};

/* 只桩掉 IndexedDB 这一层：util / rules / export / 各视图都用真代码 */
win.JR_DB = {
  getAll() { return Promise.resolve(jobs.slice()); },
  remove() { return Promise.resolve(true); },
  clearAll() { return Promise.resolve(true); }
};

let evalError = null;
try {
  [
    '../common/util.js',
    '../common/rules.js',
    '../common/history.js',
    '../common/settings.js',
    '../common/profiles.js',
    'export.js',
    'view-library.js',
    'view-profiles.js',
    'view-settings.js',
    'popup.js'
  ].forEach((f) => {
    win.eval(fs.readFileSync(path.join(popupDir, f), 'utf8'));
  });
} catch (e) {
  evalError = e;
}
check('脚本求值不抛错', evalError === null, evalError && evalError.message);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(win.document.querySelectorAll(sel));

(async function () {
  await wait(20);
  win.JR_POPUP.activate('library');
  await wait(40);

  /* ---------- 1. 列表 ---------- */
  console.log('=== 列表 ===');
  check('渲染出两条记录', $$('#tbody tr').length === 2, String($$('#tbody tr').length));
  check('有模型判定的行带「模型」标记',
    !!$('#tbody .src.ok'), $('#tbody tr').innerHTML && '');
  check('操作列同时有「打开」与删除', $$('#tbody .open').length === 2 && $$('#tbody .del').length === 2);

  /* ---------- 2. 打开检查器 ---------- */
  console.log('\n=== 检查器 ===');
  const titleLink = $$('#tbody .jt a')[0];
  titleLink.click();
  await wait(40);

  check('检查器可见', $('#inspector').style.display === 'flex', $('#inspector').style.display);
  check('标题带职位与公司',
    $('#inspTitle').textContent.indexOf('FDE') !== -1 && $('#inspTitle').textContent.indexOf('百蕴启辰') !== -1,
    $('#inspTitle').textContent);

  const bodyText = $('#inspBody').textContent;
  check('原始字段列出薪资', bodyText.indexOf('10-11K') !== -1);
  check('薪资来源标为字形混淆', bodyText.indexOf('字形混淆') !== -1);
  check('公司名来源标为列表匹配', bodyText.indexOf('列表匹配') !== -1);
  check('公司名来自列表卡片时给出打折提示',
    bodyText.indexOf('可能不是本岗位所属公司') !== -1);
  check('提示薪资未能还原', bodyText.indexOf('薪资被站点字形混淆') !== -1);
  check('完整正文进了检查器', bodyText.indexOf('完成 PD 分离与量化优化') !== -1);
  check('显示正文清理数量', bodyText.indexOf('剔除了 3 处页面控件文字') !== -1);

  /* ---------- 3. 判定区 ---------- */
  console.log('\n=== 判定区 ===');
  check('显示档位标签', bodyText.indexOf('中性') !== -1);
  check('显示模型分数 63', !!$('#inspBody .dry-score') && $('#inspBody .dry-score').textContent === '63',
    $('#inspBody .dry-score') && $('#inspBody .dry-score').textContent);
  check('显示一句话结论', bodyText.indexOf('方向对但偏集成') !== -1);
  check('显示标准与版本', bodyText.indexOf('FDE') !== -1 && bodyText.indexOf('v2') !== -1);
  check('显示证据核对统计', bodyText.indexOf('1 / 2 条引用能在正文里找到') !== -1);
  check('未核实的证据有 unv 标记', $$('#inspBody .dry-ev .row.unv').length === 1,
    String($$('#inspBody .dry-ev .row.unv').length));
  check('未核实的证据写明原因',
    $('#inspBody .dry-ev').textContent.indexOf('未能核实') !== -1);
  check('列出缺失项与风险',
    bodyText.indexOf('Kubernetes') !== -1 && bodyText.indexOf('外包性质存疑') !== -1);

  /* ---------- 3.5 判定历史 ---------- */
  console.log('\n=== 判定历史 ===');
  const histText = $('#inspBody .insp-hist') ? $('#inspBody .insp-hist').textContent : '';
  check('检查器里有判定历史段', $$('#inspBody .insp-sec h5').some((h) => h.textContent === '判定历史'));
  check('按岗位拉了轨迹',
    sentMessages.filter((m) => m.type === 'VERDICT_LOG' && m.key === 'k1').length === 1);
  check('只判过一次时写明次数', histText.indexOf('判过 1 次') !== -1, histText);
  check('只判过一次不写"跨 N 个标准"', histText.indexOf('跨 ') === -1, histText);
  check('轨迹条有一个点', $$('#inspBody .htrack .hpt').length === 1,
    String($$('#inspBody .htrack .hpt').length));
  check('轨迹点的悬停说明带分数',
    $$('#inspBody .htrack .hpt')[0].getAttribute('title').indexOf('63 分') !== -1,
    $$('#inspBody .htrack .hpt')[0].getAttribute('title'));
  check('只判过一次没有可比的上一条', $$('#inspBody .hlist .hdelta')[0].textContent === '');

  /* ---------- 4. 重新判定 ---------- */
  console.log('\n=== 重新判定 ===');
  check('重新判定按钮可用', $('#inspRejudge').disabled === false);
  $('#inspRejudge').click();
  await wait(10);

  const port = win.__lastPort;
  check('建立了判定端口', !!port && port.sent.length === 1);
  const start = port && port.sent[0];
  check('发的是 START', !!start && start.type === 'START', start && start.type);
  check('带同一段正文', !!start && start.jdText === JD_FULL);
  check('带岗位 key', !!start && start.jobKey === 'k1');
  check('force 跳过缓存', !!start && start.force === true);
  check('带上来源标签，模型才知道字段可信度',
    !!start && start.sources && start.sources.company === '列表匹配');
  check('不是试跑', !!start && !start.dryRun);

  port.emit({ type: 'DELTA', chars: 120 });
  await wait(5);
  check('流式进度写进检查器',
    $('#inspBody').textContent.indexOf('已收 120 字') !== -1);

  port.emit({
    type: 'DONE',
    verdict: {
      key: 'k1',
      jobKey: 'k1',
      grade: 'weak',
      score: 44,
      gradeLabel: '偏弱',
      oneLine: '偏集成，不是从零建设',
      profileName: 'FDE',
      profileVersion: 2,
      model: 'deepseek-chat',
      createdAt: Date.now(),
      evidence: [{ type: 'red', claim: '驻场', quote: '能适应短期驻场', verified: true }],
      evidenceCheck: { checked: 1, passed: 1, rate: 1 }
    }
  });
  await wait(40);

  check('回写了记录', !!patched && patched.type === 'JOB_PATCH' && patched.key === 'k1');
  check('回写的是模型的档位与分数', patched && patched.patch.grade === 'weak' && patched.patch.score === 44,
    patched && JSON.stringify(patched.patch));
  check('回写标为模型判定', patched && patched.patch.judgeSource === 'model');
  check('回写没有走 SAVE（不涨 seenCount）',
    sentMessages.filter((m) => m.type === 'SAVE').length === 0);
  check('列表里的分数跟着更新', patched !== null && jobs[0].score === 44);
  check('检查器重绘成新结论',
    $('#inspBody').textContent.indexOf('偏集成，不是从零建设') !== -1);
  check('给出更新提示', $('#inspBody').textContent.indexOf('已更新结论') !== -1);
  check('重判之后重新拉了轨迹（否则历史里少了刚判的这次）',
    sentMessages.filter((m) => m.type === 'VERDICT_LOG' && m.key === 'k1').length >= 2,
    String(sentMessages.filter((m) => m.type === 'VERDICT_LOG' && m.key === 'k1').length));

  /* ---------- 5. 旧记录 ---------- */
  console.log('\n=== 旧记录（只有摘要） ===');
  $('#inspBack').click();
  check('返回后检查器关闭', $('#inspector').style.display === 'none');
  $$('#tbody .jt a')[1].click();
  await wait(10);
  check('旧记录提示没有完整正文',
    $('#inspBody').textContent.indexOf('没有完整正文') !== -1 ||
    $('#inspBody').textContent.indexOf('没有存到正文') !== -1);
  check('旧记录的重新判定被禁用', $('#inspRejudge').disabled === true);
  check('旧记录没有判定时说明分数来自词库',
    $('#inspBody').textContent.indexOf('分数来自本地词库') !== -1);
  check('旧记录从没判过时，历史段说"还没判过"（而不是显示一段空轨迹）',
    $('#inspBody').textContent.indexOf('还没有用模型判过') !== -1,
    $('#inspBody .insp-hist') && $('#inspBody .insp-hist').textContent);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
