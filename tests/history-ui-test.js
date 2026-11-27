/* 判定历史视图测试：node tests/history-ui-test.js
 *
 * 检查器里这一段要回答的是「这个岗位我判过几次、结论往哪走、中间是不是换了把尺子」
 * ——它比单次结论更容易被误读，所以断言集中在：
 *   1. 跨标准的两次不许并排比分数（比出来的差值全是噪声）
 *   2. "正文有改动"只在指纹真的变了时出现（老记录没指纹 ≠ 没变）
 *   3. 切岗位时迟到的回包不能糊到当前岗位上
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

const DAY = 86400000;
const NOW = 1790000000000;

function job(over) {
  return Object.assign({
    key: 'k1',
    jobTitle: 'AI 交付工程师',
    company: '百蕴启辰',
    salaryText: '20-30K',
    city: '北京',
    experienceText: '3-5年',
    siteName: 'BOSS直聘',
    groupLabel: 'AI 交付',
    groupShort: '交付',
    grade: 'neutral',
    score: 61,
    strong: ['vLLM'],
    weak: [],
    jdText: '负责客户现场的大模型交付。基于 vLLM 做私有化部署。',
    sources: { jobTitle: '结构推断', company: '详情区', salary: '正则', city: '正则', jd: '启发式' },
    firstSeen: NOW - 3 * DAY,
    lastSeen: NOW,
    seenCount: 2,
    url: 'https://www.zhipin.com/job_detail/1.html'
  }, over || {});
}

const jobs = [
  job({ key: 'k1' }),
  job({ key: 'k2', jobTitle: '旧结论岗位', judgedAt: NOW - 10 * DAY, jdText: '' }),
  job({ key: 'k3', jobTitle: '没判过的岗位', jdText: '' }),
  job({ key: 'k4', jobTitle: '轨迹读不出来的岗位', jdText: '' })
];

const verdicts = [
  {
    key: 'k1', profileId: 'p1', profileName: 'FDE', profileVersion: 2,
    grade: 'neutral', score: 61, confidence: 0.7, oneLine: '方向对但偏集成',
    model: 'deepseek-chat', createdAt: NOW - DAY,
    evidence: [{ type: 'must', claim: '私有化', quote: '基于 vLLM 做私有化部署', verified: true }],
    evidenceCheck: { checked: 1, passed: 1, rate: 1 }
  }
];

/* 三条轨迹：同标准降分 → 换标准 → 换标准后正文又变了 */
const LOGS = {
  k1: [
    {
      id: 1, key: 'k1', profileId: 'p1', profileName: 'FDE', profileVersion: 1,
      grade: 'strong', score: 86, jdHash: 'h1', jdChars: 1200,
      createdAt: NOW - 3 * DAY, evidenceFlag: ''
    },
    {
      id: 2, key: 'k1', profileId: 'p1', profileName: 'FDE', profileVersion: 2,
      grade: 'neutral', score: 61, jdHash: 'h2', jdChars: 1240,
      createdAt: NOW - 2 * DAY, evidenceFlag: 'E_BAD_EVIDENCE'
    },
    {
      id: 3, key: 'k1', profileId: 'p2', profileName: 'AI 应用', profileVersion: 1,
      grade: 'weak', score: 40, jdHash: 'h2', jdChars: 1240,
      createdAt: NOW - DAY, evidenceFlag: ''
    }
  ],
  k2: [],
  k3: [],
  k4: null          /* null = 后台回 ok:false */
};

const sentMessages = [];
let patchCount = 0;

win.chrome = {
  runtime: {
    lastError: null,
    getManifest() { return { version: '0.3.0' }; },
    sendMessage(msg, cb) {
      sentMessages.push(msg);
      if (msg.type === 'VERDICT_LOG') {
        /* k1 故意回得慢：用来验证"切岗位后迟到的回包不许糊上屏" */
        const delay = msg.key === 'k1' ? 45 : 5;
        setTimeout(() => {
          if (LOGS[msg.key] === null) {
            cb({ ok: false, error: '读不出来' });
          } else {
            cb({ ok: true, key: msg.key, list: (LOGS[msg.key] || []).slice() });
          }
        }, delay);
        return;
      }
      setImmediate(() => {
        if (msg.type === 'PROFILE_ACTIVE') {
          cb({ ok: true, list: [], profile: null, fellBack: false });
        } else if (msg.type === 'VERDICTS_ALL') {
          cb({ ok: true, list: verdicts.slice() });
        } else if (msg.type === 'JOB_PATCH') {
          patchCount++;
          cb({ ok: true });
        } else if (msg.type === 'SETTINGS_GET') {
          cb({ ok: true, settings: { apiKey: 'sk-x', autoJudge: true, dailyLimit: 100 } });
        } else {
          cb({ ok: true });
        }
      });
    },
    connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }; }
  },
  storage: {
    local: { get(k, cb) { setImmediate(() => cb({})); }, set(o, cb) { setImmediate(() => cb && cb()); }, remove(k, cb) { setImmediate(() => cb && cb()); } },
    session: { get(k, cb) { setImmediate(() => cb({})); }, set(o, cb) { setImmediate(() => cb && cb()); }, remove(k, cb) { setImmediate(() => cb && cb()); } }
  },
  permissions: { contains(q, cb) { setImmediate(() => cb(true)); }, request(q, cb) { setImmediate(() => cb(true)); } },
  tabs: { create() {} }
};

/* 只桩 IndexedDB 这层；视图代码全用真的 */
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
check('history 模块已挂到全局', !!win.JR_HISTORY);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(win.document.querySelectorAll(sel));

(async function () {
  await wait(20);
  win.JR_POPUP.activate('library');
  await wait(60);

  /* ---------- 有轨迹 ---------- */
  console.log('=== 有三次判定 ===');
  win.JR_VIEW_LIBRARY.openInspector('k1');
  await wait(120);

  const body = $('#inspBody').textContent;
  check('检查器里有「判定历史」段', $$('#inspBody .insp-sec h5').some((h) => h.textContent === '判定历史'));
  check('汇总写明次数', body.indexOf('判过 3 次') !== -1, body.slice(0, 160));
  check('汇总写明跨了几个标准', body.indexOf('跨 2 个标准') !== -1);
  check('汇总写明正文改动次数', body.indexOf('正文改过 1 次') !== -1);
  check('明细给出首末与降幅', body.indexOf('86 → 61') !== -1 && body.indexOf('↓25') !== -1,
    $('.hdet') && $('.hdet').textContent);

  check('轨迹条有三个点', $$('.htrack .hpt').length === 3, String($$('.htrack .hpt').length));
  check('点的颜色跟随档位',
    $$('.htrack .hpt')[0].className.indexOf('strong') !== -1 &&
    $$('.htrack .hpt')[1].className.indexOf('neutral') !== -1 &&
    $$('.htrack .hpt')[2].className.indexOf('weak') !== -1,
    $$('.htrack .hpt').map((x) => x.className).join(' | '));
  check('轨迹点的 title 带分数（鼠标悬停能查证）',
    $$('.htrack .hpt')[0].getAttribute('title').indexOf('86 分') !== -1,
    $$('.htrack .hpt')[0].getAttribute('title'));

  check('逐条列表三行', $$('.hlist .hrow').length === 3, String($$('.hlist .hrow').length));
  check('最新的一条排在最上面',
    $$('.hlist .hrow')[0].textContent.indexOf('40') !== -1,
    $$('.hlist .hrow')[0].textContent);
  check('每条都标了标准与版本', $$('.hlist .hprof')[0].textContent.indexOf('AI 应用') !== -1,
    $$('.hlist .hprof')[0].textContent);

  const deltas = $$('.hlist .hdelta').map((x) => x.textContent);
  /* DOM 顺序是最新在上：[0] = 换标准那次，[1] = 降分那次，[2] = 最早那条（没有上一次可比） */
  check('同标准的两条算出降幅', deltas[1] === '↓25', deltas.join(' | '));
  check('跨标准的那条写「不可比」，不写 0',
    deltas[0] === '不可比', deltas.join(' | '));
  check('最早那条没有"与上一比"可写', deltas[2] === '', JSON.stringify(deltas[2]));
  check('跨标准行标出「换了标准」',
    $$('.hlist .hrow')[0].textContent.indexOf('换了标准') !== -1,
    $$('.hlist .hrow')[0].textContent);
  check('正文真的改了才标「正文有改动」',
    $$('.hlist .hmark').filter((x) => x.textContent === '正文有改动').length === 1,
    $$('.hlist .hmark').map((x) => x.textContent).join(' | '));
  check('证据多半查不到也标出来',
    body.indexOf('引用多半查不到') !== -1);
  check('降分那一行标红、不是标绿',
    $$('.hlist .hdelta')[1].className.indexOf('down') !== -1,
    $$('.hlist .hdelta')[1].className);
  check('底部说明跨标准不比分数的道理',
    body.indexOf('不同标准在回答不同的问题') !== -1);
  check('说明指纹口径（前 800 字哈希 + 总字数）',
    body.indexOf('前 800 字哈希') !== -1);
  check('拉的是这个岗位的轨迹',
    sentMessages.filter((m) => m.type === 'VERDICT_LOG' && m.key === 'k1').length === 1);

  /* ---------- 升级前的旧结论 ---------- */
  console.log('\n=== 没有轨迹的三种情况 ===');
  win.JR_VIEW_LIBRARY.openInspector('k2');
  await wait(60);
  check('旧记录明说"升级之前判的"',
    $('#inspBody').textContent.indexOf('0.3.0 之前') !== -1,
    $('.insp-hist') && $('.insp-hist').textContent);
  check('旧记录不会假装"从没判过"',
    $('#inspBody').textContent.indexOf('还没有用模型判过') === -1);

  win.JR_VIEW_LIBRARY.openInspector('k3');
  await wait(60);
  check('真没判过的写"还没判过"',
    $('#inspBody').textContent.indexOf('还没有用模型判过') !== -1);

  win.JR_VIEW_LIBRARY.openInspector('k4');
  await wait(60);
  check('轨迹读不出来时给出错误、不是空白',
    $('#inspBody').textContent.indexOf('读取判定历史失败') !== -1,
    $('.insp-hist') && $('.insp-hist').textContent);
  check('读失败时不给"还没判过"这种误导结论',
    $('#inspBody').textContent.indexOf('还没有用模型判过') === -1);

  /* ---------- 切岗位：迟到的回包不许糊上屏 ---------- */
  console.log('\n=== 切岗位 ===');
  win.JR_VIEW_LIBRARY.openInspector('k1');   /* 这次回包要 45ms */
  win.JR_VIEW_LIBRARY.openInspector('k3');   /* 立刻切走，回包 5ms */
  await wait(140);

  const afterSwitch = $('.insp-hist') ? $('.insp-hist').textContent : '';
  check('停在切过去的那个岗位', $('#inspTitle').textContent.indexOf('没判过的岗位') !== -1,
    $('#inspTitle').textContent);
  check('迟到回包没有把上一个岗位的轨迹画上来',
    afterSwitch.indexOf('86') === -1 && afterSwitch.indexOf('判过 3 次') === -1,
    afterSwitch);
  check('切过去之后仍显示它自己的空态',
    afterSwitch.indexOf('还没有用模型判过') !== -1, afterSwitch);

  /* ---------- 轨迹条顺序 ---------- */
  console.log('\n=== 轨迹方向 ===');
  win.JR_VIEW_LIBRARY.openInspector('k1');
  await wait(120);
  const nums = $$('.htrack .hpt b').map((x) => x.textContent);
  check('轨迹条从左到右是时间正序', nums.join(',') === '86,61,40', nums.join(','));
  const times = $$('.hlist .hwhen').map((x) => x.textContent);
  check('每条都有时间', times.length === 3 && times.every((t) => t.length > 0), times.join(' | '));

  check('历史段没有触发任何回写', patchCount === 0, String(patchCount));

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
