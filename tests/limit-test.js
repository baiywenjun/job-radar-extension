/* 缓存 / 每日限额 / 429 冷却 测试：node tests/limit-test.js
 *
 * 三件事都是"要不要发这一次请求"，出错的代价都是真金白银：
 *   - 缓存没命中 → 同一条 JD 反复调模型
 *   - 限额没拦住 → 一天烧掉一整月的额度
 *   - 冷却没记住 → 限流期间连续撞 429，越撞越久
 * 所以这里用真实的 settings/profiles/prompt/verdict，只桩掉 fetch 与 IndexedDB。
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

globalThis.JR_DB = {
  getVerdict() { return Promise.resolve(store.verdict ? clone(store.verdict) : null); },
  getUsage() { return Promise.resolve({ date: '2026-11-27', calls: store.usage.calls }); }
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
let replyContent = modelJson();
let replyStatus = 200;
let replyBody = '';
let lastRequestBody = null;

globalThis.fetch = function (url, init) {
  fetchCalls++;
  lastRequestBody = JSON.parse(init.body);
  if (replyStatus !== 200) {
    return Promise.resolve({
      ok: false,
      status: replyStatus,
      text: () => Promise.resolve(replyBody || '{"error":"rate limited"}')
    });
  }
  const body = JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content: replyContent }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 }
  });
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
};

/* ---------- 夹具 ---------- */
let profileId = '';

async function reset() {
  Object.keys(localStore).forEach((k) => delete localStore[k]);
  Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
  store.verdict = null;
  store.usage = { calls: 0 };
  fetchCalls = 0;
  replyContent = modelJson();
  replyStatus = 200;
  replyBody = '';

  await S.save({
    apiKey: 'sk-test-key-123456',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    stream: false,
    dailyLimit: 100,
    priceInPerM: 1,
    priceOutPerM: 2
  });

  const list = await P.list();
  if (list.length) {
    profileId = list[0].id;
  } else {
    const rec = await P.save({ name: 'FDE', requirement: '面向客户的交付岗，能驻场。' });
    profileId = rec.id;
  }
  await S.save({ lastProfileId: profileId });
}

function input(over) {
  return Object.assign({
    jobKey: 'job-1',
    fields: { jobTitle: 'FDE', company: '某公司', jdText: JD },
    sources: { jd: '选择器' },
    jdText: JD,
    profileId: profileId
  }, over || {});
}

async function judge(over) {
  try {
    const v = await J.judgeJob(input(over));
    return { ok: true, v };
  } catch (e) {
    return { ok: false, code: e && e.code, e };
  }
}

async function main() {
  await reset();

  /* ---------- 1. 首次判定：真的发请求 ---------- */
  console.log('=== 首次判定 ===');
  let r = await judge();
  check('首次判定成功', r.ok, r.code);
  check('发了 1 次请求', fetchCalls === 1, String(fetchCalls));
  check('结论来源标记为模型', r.v && r.v.source === 'model');
  check('带 cacheKey', !!(r.v && r.v.cacheKey), r.v && r.v.cacheKey);
  check('cacheKey 含标准版本与模型名',
    !!(r.v && r.v.cacheKey.indexOf('deepseek-chat') !== -1), r.v && r.v.cacheKey);
  check('带 JD 长度', r.v && r.v.jdChars === JD.length, String(r.v && r.v.jdChars));
  check('带证据核验统计', !!(r.v && r.v.evidenceCheck), JSON.stringify(r.v && r.v.evidenceCheck));
  check('两条证据都核对通过', r.v && r.v.evidenceCheck.passed === 2,
    JSON.stringify(r.v && r.v.evidenceCheck));
  check('证据全部通过时不标红', r.v && !r.v.evidenceFlag, r.v && r.v.evidenceFlag);
  check('结论带 profileVersion', r.v && r.v.profileVersion >= 1);
  check('结论带 promptVersion', r.v && r.v.promptVersion === PR.PROMPT_VERSION);
  check('结论带 jdHash', !!(r.v && r.v.jdHash));
  check('结论带成本', r.v && r.v.cost === 0.00156, String(r.v && r.v.cost));

  /* 模拟落库：下一条同名岗位应当直接命中 */
  store.verdict = clone(r.v);

  /* ---------- 2. 缓存命中 ---------- */
  console.log('\n=== 缓存命中 ===');
  const before = fetchCalls;
  let r2 = await judge();
  check('二次判定成功', r2.ok, r2.code);
  check('没有再次发请求', fetchCalls === before, String(fetchCalls));
  check('结论标记为缓存', r2.v && r2.v.cached === true);
  check('带缓存年龄', r2.v && typeof r2.v.cacheAgeMs === 'number');
  check('缓存结论保留原成本', r2.v && r2.v.cost === 0.00156, String(r2.v && r2.v.cost));
  check('缓存结论保留原证据核验', r2.v && r2.v.evidenceCheck.passed === 2);

  /* ---------- 3. 缓存失效条件 ---------- */
  console.log('\n=== 缓存失效 ===');
  await P.save({ id: profileId, name: 'FDE', requirement: '面向客户的交付岗，能驻场。改一版。' });
  const before3 = fetchCalls;
  let r3 = await judge();
  check('标准版本变化后重新请求', fetchCalls === before3 + 1, String(fetchCalls));
  check('版本变化后不再标缓存', r3.v && !r3.v.cached);
  store.verdict = clone(r3.v);

  const before4 = fetchCalls;
  /* 前 800 字完全一致，只在尾部追加一句：jdHash 相同，只能靠长度分辨 */
  const jdTail = JD + ' 另外负责客户侧的知识库维护。';
  let r4 = await judge({ jdText: jdTail, fields: { jobTitle: 'FDE', company: '某公司', jdText: jdTail } });
  check('JD 长度变化后重新请求（jdHash 只看前 800 字）',
    fetchCalls === before4 + 1, String(fetchCalls));
  check('JD 变化后不标缓存', r4.v && !r4.v.cached);
  store.verdict = clone(r4.v);

  const before5 = fetchCalls;
  let r5 = await judge({ jdText: JD, fields: { jobTitle: 'FDE', company: '某公司', jdText: JD } });
  check('回到原 JD 时旧记录已不匹配', fetchCalls === before5 + 1, String(fetchCalls));
  store.verdict = clone(r5.v);

  const before6 = fetchCalls;
  let r6 = await judge({ force: true });
  check('force 跳过缓存', fetchCalls === before6 + 1, String(fetchCalls));
  check('force 时不标缓存', r6.v && !r6.v.cached);
  store.verdict = clone(r6.v);

  /* ---------- 4. 每日限额 ----------
   * 一律带 force：库里已经有这个岗位的结论，不带 force 会直接命中缓存
   * （那是正确行为，见下一节），这样就测不到限额分支了。 */
  console.log('\n=== 每日限额 ===');
  await S.save({ dailyLimit: 1 });
  store.usage = { calls: 1 };
  const before7 = fetchCalls;
  let r7 = await judge({ force: true });
  check('达到上限时不发请求', fetchCalls === before7, String(fetchCalls));
  check('报 E_LIMIT_DAY', !r7.ok && r7.code === 'E_LIMIT_DAY', r7.code);
  check('错误里带已用次数', r7.e && r7.e.used === 1, JSON.stringify(r7.e && r7.e.used));
  check('错误里带上限', r7.e && r7.e.limit === 1);

  const before8 = fetchCalls;
  let r8 = await judge({ force: true, allowOverLimit: true });
  check('手动放行后发请求', fetchCalls === before8 + 1, String(fetchCalls));
  check('放行时结论正常返回', r8.ok, r8.code);
  store.verdict = clone(r8.v);

  store.usage = { calls: 99 };
  let r9 = await judge({ force: true });
  check('超过上限同样拦住', !r9.ok && r9.code === 'E_LIMIT_DAY', r9.code);

  console.log('\n=== 缓存优先于限额 ===');
  await S.save({ dailyLimit: 1 });
  store.usage = { calls: 5 };
  const before10 = fetchCalls;
  let r10 = await judge();
  check('超限但有缓存时直接返回缓存', r10.ok && r10.v.cached === true, r10.code);
  check('命中缓存不发请求', fetchCalls === before10, String(fetchCalls));

  /* ---------- 5. 429 冷却 ---------- */
  console.log('\n=== 429 冷却 ===');
  await S.save({ dailyLimit: 100 });
  store.usage = { calls: 0 };
  store.verdict = null;
  replyStatus = 429;
  replyBody = '{"error":{"message":"rate limit exceeded"}}';

  const t0 = Date.now();
  let r11 = await judge();
  check('429 报 E_RATE_LIMIT', !r11.ok && r11.code === 'E_RATE_LIMIT', r11.code);
  check('429 后错误带冷却时长', r11.e && r11.e.remainMs > 0, String(r11.e && r11.e.remainMs));

  const saved = await S.get();
  check('429 后把冷却截止时间写进设置',
    saved.rateLimitUntil >= t0 + J.COOLDOWN_MS - 1000, String(saved.rateLimitUntil));
  check('冷却时长是 5 分钟', J.COOLDOWN_MS === 5 * 60 * 1000, String(J.COOLDOWN_MS));

  replyStatus = 200;
  replyContent = modelJson();

  const before12 = fetchCalls;
  let r12 = await judge();
  check('冷却期内不发请求', fetchCalls === before12, String(fetchCalls));
  check('冷却期内报 E_COOLDOWN', !r12.ok && r12.code === 'E_COOLDOWN', r12.code);
  check('E_COOLDOWN 带剩余时间', r12.e && r12.e.remainMs > 0, String(r12.e && r12.e.remainMs));

  const before13 = fetchCalls;
  let r13 = await judge({ allowOverLimit: true });
  check('手动放行可越过冷却', fetchCalls === before13 + 1, String(fetchCalls));
  check('越过冷却后结论正常', r13.ok, r13.code);
  store.verdict = clone(r13.v);

  console.log('\n=== 缓存优先于冷却 ===');
  await S.save({ rateLimitUntil: Date.now() + 300000 });
  const before14 = fetchCalls;
  let r14 = await judge();
  check('冷却中命中缓存仍可返回', r14.ok && r14.v.cached === true, r14.code);
  check('冷却命中缓存不发请求', fetchCalls === before14, String(fetchCalls));

  /* ---------- 6. 没有 Key 也能读缓存 ---------- */
  console.log('\n=== 无 Key 时的缓存 ===');
  await S.save({ apiKey: '' , rateLimitUntil: 0 });
  const before15 = fetchCalls;
  let r15 = await judge();
  check('没 Key 时仍能读缓存', r15.ok && r15.v.cached === true, r15.code);
  check('没 Key 时不发请求', fetchCalls === before15, String(fetchCalls));

  let r16 = await judge({ force: true });
  check('没 Key 且跳过缓存时报 E_NO_KEY', !r16.ok && r16.code === 'E_NO_KEY', r16.code);

  /* ---------- 7. 证据不可信 ---------- */
  console.log('\n=== 证据不可信 ===');
  await S.save({ apiKey: 'sk-test-key-123456', dailyLimit: 100 });
  store.verdict = null;
  store.usage = { calls: 0 };
  replyContent = modelJson({
    evidence: [
      { type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' },
      { type: 'must', claim: '集群运维', quote: '要求具备 Kubernetes 集群运维经验' },
      { type: 'must', claim: 'Prometheus 监控', quote: '搭建 Prometheus 监控与告警体系' }
    ]
  });

  let r17 = await judge();
  check('证据不足时仍返回结论', r17.ok, r17.code);
  check('证据通过率低于 0.5',
    r17.v && r17.v.evidenceCheck.rate < 0.5, JSON.stringify(r17.v && r17.v.evidenceCheck));
  check('标记 E_BAD_EVIDENCE', r17.v && r17.v.evidenceFlag === 'E_BAD_EVIDENCE',
    r17.v && r17.v.evidenceFlag);
  check('置信度被下调（0.8 → 0.6）', r17.v && r17.v.confidence === 0.6, String(r17.v && r17.v.confidence));
  check('分数按新置信度重算', r17.v && r17.v.score === 89, String(r17.v && r17.v.score));
  check('档位不变（仍是 strong）', r17.v && r17.v.grade === 'strong');

  console.log('\n=== 请求体 ===');
  check('请求带 model', lastRequestBody && lastRequestBody.model === 'deepseek-chat');
  check('非流式请求不带 stream_options',
    lastRequestBody && !lastRequestBody.stream_options);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
