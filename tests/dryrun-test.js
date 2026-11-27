/* 试跑（dryRun）测试：node tests/dryrun-test.js
 *
 * 试跑存在的意义是「改一版提示词 → 试跑 → 对比」这个循环能闭合。
 * 只要有一处没断开，这个循环就是假的：
 *   - 还读缓存        → 看到的是三天前的旧结论
 *   - 还被限额/冷却拦 → 以为标准写坏了
 *   - 用库里那份标准  → 改了半天，试跑的还是旧版本
 *   - 不落 payload    → 设置页看不到「实际发出去的是什么」
 * 所以四条各一个用例，另外补一条「同样的条件下普通判定确实会被拦住」做对照，
 * 否则前面几条通过也可能只是夹具没生效。
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

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeArea(store) {
  return {
    get(keys, cb) {
      const out = {};
      let list;
      if (typeof keys === 'string') list = [keys];
      else if (Array.isArray(keys)) list = keys;
      else if (keys && typeof keys === 'object') list = Object.keys(keys);
      else list = Object.keys(store);
      list.forEach((k) => { if (k in store) out[k] = clone(store[k]); });
      setImmediate(() => cb(out));
    },
    set(obj, cb) {
      Object.keys(obj).forEach((k) => { store[k] = clone(obj[k]); });
      setImmediate(() => cb && cb());
    },
    remove(keys, cb) {
      const list = typeof keys === 'string' ? [keys] : keys;
      list.forEach((k) => { delete store[k]; });
      setImmediate(() => cb && cb());
    }
  };
}

const localStore = {};
const sessionStore = {};

global.chrome = {
  runtime: {},
  storage: {
    local: makeArea(localStore),
    session: makeArea(sessionStore)
  },
  permissions: {
    contains(_q, cb) { setImmediate(() => cb(true)); },
    request(_q, cb) { setImmediate(() => cb(true)); }
  }
};

require(path.join(__dirname, '../src/common/settings.js'));
require(path.join(__dirname, '../src/common/profiles.js'));
require(path.join(__dirname, '../src/common/prompt.js'));
require(path.join(__dirname, '../src/common/verdict.js'));
require(path.join(__dirname, '../src/background/judge.js'));

const S = globalThis.JR_SETTINGS;
const P = globalThis.JR_PROFILES;
const PR = globalThis.JR_PROMPT;
const J = globalThis.JR_JUDGE;

/* ---------- 假 IndexedDB ---------- */
const store = { verdict: null, usage: { calls: 0 } };
let verdictWritten = 0;

globalThis.JR_DB = {
  getVerdict() { return Promise.resolve(store.verdict ? clone(store.verdict) : null); },
  getUsage() { return Promise.resolve({ date: '2026-11-27', calls: store.usage.calls }); },
  putVerdict(v) { verdictWritten++; store.verdict = clone(v); return Promise.resolve(v); }
};

/* ---------- 假 fetch ---------- */
const JD =
  '负责客户现场的大模型应用与智能体项目交付。基于 vLLM 搭建私有化推理服务，' +
  '完成 PD 分离与量化优化；使用 LangGraph 编排多智能体流程，接入 MCP 工具调用；' +
  '要求 3-5 年经验，能适应短期出差与驻场交付。';

function modelJson(over) {
  return JSON.stringify(Object.assign({
    grade: 'strong',
    confidence: 0.8,
    oneLine: '私有化推理与智能体交付都在做，值得投',
    evidence: [
      { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' },
      { type: 'must', claim: '智能体编排', quote: '使用 LangGraph 编排多智能体流程' }
    ],
    missing: [],
    risks: []
  }, over || {}));
}

let fetchCalls = 0;
let lastRequestBody = null;
let replyContent = modelJson();

globalThis.fetch = function (url, init) {
  fetchCalls++;
  lastRequestBody = JSON.parse(init.body);
  const body = JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content: replyContent }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 }
  });
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
};

function userText() {
  const msgs = (lastRequestBody && lastRequestBody.messages) || [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'user') return msgs[i].content;
  return '';
}

async function reset() {
  Object.keys(localStore).forEach((k) => delete localStore[k]);
  Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
  store.verdict = null;
  store.usage = { calls: 0 };
  verdictWritten = 0;
  fetchCalls = 0;
  replyContent = modelJson();
  lastRequestBody = null;

  await S.save({
    apiKey: 'sk-test-key-123456',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    stream: false,
    dailyLimit: 100,
    priceInPerM: 1,
    priceOutPerM: 2
  });
  await P.save({
    name: 'FDE',
    requirement: '面向客户的交付岗，能独立完成 POC 与部署联调。',
    mustHave: '私有化部署',
    redFlags: '纯外包'
  });
  await S.save({ lastProfileId: (await P.list())[0].id });
}

async function judge(extra) {
  try {
    return { ok: true, v: await J.judgeJob(Object.assign({ jdText: JD }, extra || {})) };
  } catch (e) {
    return { ok: false, code: e && e.code, e };
  }
}

(async function () {
  await reset();

  /* ---------- 1. 不吃缓存 ---------- */
  console.log('\n=== 试跑不读缓存 ===');
  const r1 = await judge({ jobKey: 'job-1' });
  check('普通判定先跑一次成功', r1.ok, r1.code);
  store.verdict = store.verdict || null;
  // 把这条结论当作缓存写回去（key 由 prompt 决定，这里直接用返回值的 cacheKey）
  store.verdict = clone(Object.assign({}, r1.v, { key: 'job-1' }));

  const beforeCache = fetchCalls;
  const cached = await judge({ jobKey: 'job-1' });
  check('同一岗位普通判定命中缓存、不再发请求',
    cached.ok && cached.v.cached === true && fetchCalls === beforeCache,
    'fetch=' + fetchCalls + ' cached=' + (cached.v && cached.v.cached));

  const beforeDry = fetchCalls;
  const dry1 = await judge({ jobKey: 'job-1', dryRun: true });
  check('试跑不吃缓存：仍然发了请求', dry1.ok && fetchCalls === beforeDry + 1,
    'fetch=' + fetchCalls + ' ' + dry1.code);
  check('试跑结论没有 cached 标记', dry1.ok && !dry1.v.cached);
  /* 上面两条passing 可能是碰巧。真正的结构保证是这两条：
     试跑把 jobKey 抹掉 → 缓存键为空；就算传了 jobKey 也不会去读 */
  check('试跑的清空 jobKey 使缓存键为空', dry1.ok && dry1.v.cacheKey === '',
    dry1.ok && String(dry1.v.cacheKey));
  check('试跑结论带 dryRun 标记', dry1.ok && dry1.v.dryRun === true);
  check('试跑结论的 jobKey 为空（不挂到任何岗位）', dry1.ok && dry1.v.jobKey === '',
    dry1.ok && String(dry1.v.jobKey));

  /* ---------- 2. 不受每日上限 ---------- */
  console.log('\n=== 试跑不受每日上限 ===');
  await S.save({ dailyLimit: 1 });
  store.usage = { calls: 7 };

  const blocked = await judge({ jobKey: 'job-2' });
  check('对照：普通判定被每日上限拦住', !blocked.ok && blocked.code === 'E_LIMIT_DAY', blocked.code);
  check('拦住时确实没发请求', fetchCalls === beforeDry + 1, String(fetchCalls));

  const dry2 = await judge({ jobKey: 'job-2', dryRun: true });
  check('试跑越过每日上限', dry2.ok, dry2.code);

  /* ---------- 3. 不受 429 冷却 ---------- */
  console.log('\n=== 试跑不受冷却 ===');
  await S.save({ dailyLimit: 100, rateLimitUntil: Date.now() + 5 * 60 * 1000 });
  const cooling = await judge({ jobKey: 'job-3' });
  check('对照：普通判定被冷却拦住', !cooling.ok && cooling.code === 'E_COOLDOWN', cooling.code);

  const dry3 = await judge({ jobKey: 'job-3', dryRun: true });
  check('试跑越过冷却', dry3.ok, dry3.code);
  await S.save({ rateLimitUntil: 0 });

  /* ---------- 4. 用屏幕上那份标准 ---------- */
  console.log('\n=== 试跑用 override 标准 ===');
  const override = {
    name: '试跑标准',
    requirement: '必须明确提到 Kubernetes 与 GPU 调度。',
    mustHave: 'Kubernetes',
    redFlags: '外包驻场',
    version: 0
  };
  const dry4 = await judge({ jobKey: '', dryRun: true, profileOverride: override, jdText: JD });
  check('试跑成功', dry4.ok, dry4.code);
  check('请求里用的是 override 的要求', userText().indexOf('必须明确提到 Kubernetes') !== -1);
  check('请求里不再有库里那份标准', userText().indexOf('面向客户的交付岗') === -1);
  check('结论带上 override 的标准名', dry4.ok && dry4.v.profileName === '试跑标准', dry4.ok && dry4.v.profileName);
  check('未保存的标准把版本记为 0', dry4.ok && dry4.v.profileVersion === 0, dry4.ok && dry4.v.profileVersion);

  /* ---------- 5. 空正文直接拒绝，不发请求 ---------- */
  console.log('\n=== 空正文 ===');
  const beforeEmpty = fetchCalls;
  const dry5 = await judge({ dryRun: true, jdText: '   ' });
  check('空正文报 E_NO_JD', !dry5.ok && dry5.code === 'E_NO_JD', dry5.code);
  check('空正文不发请求', fetchCalls === beforeEmpty, String(fetchCalls));

  /* ---------- 6. 落 payload ---------- */
  console.log('\n=== 最近一次 payload ===');
  const saved = localStore.lastPayload;
  check('payload 已写入本机', !!saved, typeof saved);
  check('payload 含 system 段',
    !!saved && (saved.messages || [])[0].role === 'system');
  check('payload 的 user 段与 override 一致',
    !!saved && saved.messages[1].content.indexOf('必须明确提到 Kubernetes') !== -1);
  check('payload 标记为试跑', !!saved && saved.dryRun === true);
  check('payload 记录了提示词版本', !!saved && saved.promptVersion === PR.PROMPT_VERSION,
    saved && String(saved.promptVersion));
  check('payload 记录正文长度', !!saved && saved.meta.jdChars === JD.length,
    saved && String(saved.meta.jdChars));
  check('Key 只以掩码出现',
    !!saved && saved.keyMasked === 'sk-****3456', saved && saved.keyMasked);
  check('payload 全文里没有明文 Key',
    JSON.stringify(saved).indexOf('sk-test-key-123456') === -1);

  /* ---------- 7. 试跑不落库 ---------- */
  console.log('\n=== 试跑不落库 ===');
  check('judgeJob 本身不写 verdicts', verdictWritten <= 1,
    '写入次数 ' + verdictWritten + '（首次普通判定允许 1 次）');

  /* ---------- 8. 普通判定仍然会拦没 Key ---------- */
  console.log('\n=== 无 Key ===');
  await S.save({ apiKey: '' });
  const noKey = await judge({ dryRun: true, jdText: JD });
  check('无 Key 时试跑也报 E_NO_KEY（不能假装跑过）', !noKey.ok && noKey.code === 'E_NO_KEY', noKey.code);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
