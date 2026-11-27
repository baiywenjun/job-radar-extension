/* 模型请求层测试：node tests/judge-test.js
 * S1 只覆盖「测试连接」这条路径：URL 拼接、错误码分类、权限判定、超时收敛。
 * S2 会在此文件追加流式解析与 JSON 契约校验的用例。
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
let granted = true;

global.chrome = {
  runtime: {},
  storage: {
    local: makeArea(localStore),
    session: makeArea(sessionStore)
  },
  permissions: {
    contains(_q, cb) { setImmediate(() => cb(granted)); },
    request(_q, cb) { setImmediate(() => cb(granted)); }
  }
};

/* ---------- fetch mock ---------- */
let lastRequest = null;
let fetchMode = 'ok';

function mockFetch(url, opts) {
  lastRequest = { url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null };

  if (fetchMode === 'network') return Promise.reject(new Error('Failed to fetch'));
  if (fetchMode === 'hang') {
    return new Promise((resolve, reject) => {
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  }

  const map = {
    ok: { status: 200, body: { model: 'deepseek-chat', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } } },
    auth: { status: 401, body: { error: { message: 'Authentication Fails' } } },
    notfound: { status: 404, body: { error: { message: 'Model Not Exist' } } },
    ratelimit: { status: 429, body: { error: { message: 'Rate limit' } } },
    badrequest: { status: 400, body: { error: { message: 'response_format unsupported' } } },
    notjson: { status: 200, body: null, raw: '<html>gateway</html>' }
  };
  const m = map[fetchMode] || map.ok;

  return Promise.resolve({
    ok: m.status === 200,
    status: m.status,
    text() {
      return Promise.resolve(m.raw != null ? m.raw : JSON.stringify(m.body));
    }
  });
}

global.fetch = mockFetch;

require(path.join(__dirname, '../src/common/settings.js'));
require(path.join(__dirname, '../src/common/profiles.js'));
require(path.join(__dirname, '../src/common/prompt.js'));
require(path.join(__dirname, '../src/common/verdict.js'));
require(path.join(__dirname, '../src/background/judge.js'));

const S = globalThis.JR_SETTINGS;
const J = globalThis.JR_JUDGE;
const P2 = globalThis.JR_PROFILES;
const V = globalThis.JR_VERDICT;

(async function () {
  /* ---------- URL 与权限模式 ---------- */
  check('endpoint 拼出 /chat/completions',
    J.endpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions',
    J.endpoint('https://api.deepseek.com/v1'));
  check('endpoint 容忍尾部斜杠',
    J.endpoint('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1/chat/completions');
  check('originPattern 生成通配符',
    J.originPattern('https://api.deepseek.com/v1') === 'https://api.deepseek.com/*',
    J.originPattern('https://api.deepseek.com/v1'));
  check('originPattern 对空值返回空串', J.originPattern('') === '');

  /* ---------- 错误分类 ---------- */
  const cases = [
    [401, 'E_AUTH'],
    [403, 'E_AUTH'],
    [404, 'E_NOT_FOUND'],
    [429, 'E_RATE_LIMIT'],
    [400, 'E_BAD_REQUEST'],
    [500, 'E_HTTP']
  ];
  cases.forEach(([status, code]) => {
    const e = J.classify(status, 'boom');
    check('HTTP ' + status + ' → ' + code, e.code === code, e.code);
  });
  check('错误详情做了长度截断', J.classify(500, 'x'.repeat(1000)).detail.length <= 301,
    String(J.classify(500, 'x'.repeat(1000)).detail.length));
  check('错误详情压掉换行', J.classify(500, 'a\n\n b').detail === 'a b',
    JSON.stringify(J.classify(500, 'a\n\n b').detail));

  /* ---------- 未配置 Key ---------- */
  await S.reset();
  try {
    await J.testConnection();
    check('无 Key 时应拒绝', false);
  } catch (e) {
    check('无 Key 报 E_NO_KEY', e.code === 'E_NO_KEY', e.code);
  }

  /* ---------- 无 baseURL ---------- */
  await S.save({ apiKey: 'sk-testtesttesttest1234', baseURL: '' });
  try {
    await J.testConnection();
    check('无 baseURL 时应拒绝', false);
  } catch (e) {
    check('无 baseURL 报 E_NO_URL', e.code === 'E_NO_URL', e.code);
  }

  /* ---------- 域名未授权 ---------- */
  await S.save({ apiKey: 'sk-testtesttesttest1234', baseURL: 'https://my-gw.example.com/v1' });
  granted = false;
  try {
    await J.testConnection();
    check('未授权时应拒绝', false);
  } catch (e) {
    check('显示"重新点一次测试连接"的 E_NO_PERM', e.code === 'E_NO_PERM', e.code);
    check('E_NO_PERM 带上 origin 便于提示', e.origin === 'https://my-gw.example.com', String(e.origin));
  }

  /* ---------- 正常连接 ---------- */
  granted = true;
  fetchMode = 'ok';
  await S.save({
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    maxOutputTokens: 1200
  });
  let r = await J.testConnection();
  check('连接成功返回 ok', r.ok === true);
  check('回显模型名', r.model === 'deepseek-chat', r.model);
  check('带回耗时', typeof r.ms === 'number' && r.ms >= 0, String(r.ms));
  check('带回输入 token', r.usage.in === 12, String(r.usage.in));
  check('带回输出 token', r.usage.out === 5, String(r.usage.out));
  check('请求打到 /chat/completions',
    lastRequest.url === 'https://api.deepseek.com/v1/chat/completions', lastRequest.url);
  check('请求用 Bearer 头', lastRequest.opts.headers.Authorization === 'Bearer sk-testtesttesttest1234',
    lastRequest.opts.headers.Authorization);
  check('测试连接请求很小（max_tokens=8）', lastRequest.body.max_tokens === 8, String(lastRequest.body.max_tokens));
  check('测试连接不走流式', lastRequest.body.stream === false);
  check('测试连接不带 response_format',
    !('response_format' in lastRequest.body), JSON.stringify(lastRequest.body.response_format));

  /* ---------- 表单未保存值也能测 ---------- */
  r = await J.testConnection({ model: 'deepseek-chat', apiKey: 'sk-overrideoverride1234' });
  check('override 的 Key 生效',
    lastRequest.opts.headers.Authorization === 'Bearer sk-overrideoverride1234',
    lastRequest.opts.headers.Authorization);
  check('override 不写回存储', localStore.apiKey === 'sk-testtesttesttest1234', localStore.apiKey);

  /* ---------- 各类 HTTP 错误 ---------- */
  const errCases = [
    ['auth', 'E_AUTH', 'Key 无效'],
    ['notfound', 'E_NOT_FOUND', '模型名或地址不对'],
    ['ratelimit', 'E_RATE_LIMIT', '触发限流'],
    ['badrequest', 'E_BAD_REQUEST', '请求被拒绝'],
    ['network', 'E_NETWORK', '网络不可达']
  ];
  for (const [mode, code, label] of errCases) {
    fetchMode = mode;
    try {
      await J.testConnection();
      check(label + ' 应报错', false);
    } catch (e) {
      check(label + ' → ' + code, e.code === code, e.code + ' / ' + e.message);
    }
  }

  /* ---------- 返回非 JSON ---------- */
  fetchMode = 'notjson';
  try {
    await J.testConnection();
    check('非 JSON 应报错', false);
  } catch (e) {
    check('非 JSON → E_BAD_JSON', e.code === 'E_BAD_JSON', e.code);
  }

  /* ---------- 超时 ---------- */
  fetchMode = 'hang';
  try {
    await J.chat({
      settings: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', timeoutMs: 30, temperature: 0.2, maxOutputTokens: 10 },
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 8,
      stream: false
    });
    check('超时应报错', false);
  } catch (e) {
    check('超时 → E_TIMEOUT', e.code === 'E_TIMEOUT', e.code + ' / ' + e.message);
  }

  /* ---------- jsonMode 开关 ---------- */
  fetchMode = 'ok';
  await J.chat({
    settings: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', timeoutMs: 3000, temperature: 0.2, maxOutputTokens: 10, jsonModeSupported: true },
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 8,
    stream: false,
    jsonMode: true
  });
  check('jsonModeSupported 时带 response_format',
    lastRequest.body.response_format && lastRequest.body.response_format.type === 'json_object',
    JSON.stringify(lastRequest.body.response_format));

  await J.chat({
    settings: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', timeoutMs: 3000, temperature: 0.2, maxOutputTokens: 10, jsonModeSupported: false },
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 8,
    stream: false,
    jsonMode: true
  });
  check('jsonModeSupported=false 时不带该字段',
    !('response_format' in lastRequest.body));

  /* ================= S2：流式解析 / 重试 / 完整判定 ================= */

  const JD = '负责客户现场的大模型应用与智能体项目交付，基于 vLLM 搭建私有化推理服务，' +
    '使用 LangGraph 编排多智能体流程，建设评测回归体系与监控告警，需要 3-5 年经验并能驻场。';

  const CONTRACT = JSON.stringify({
    grade: 'strong',
    confidence: 0.8,
    oneLine: '私有化推理与智能体交付都在做，值得投',
    evidence: [{ type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' }],
    missing: ['客户现场沟通'],
    risks: []
  });

  function sseBody(frames, cuts) {
    const text = frames
      .map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n')
      .join('') + 'data: [DONE]\n\n';
    const buf = Buffer.from(text, 'utf8');
    const pieces = [];
    let prev = 0;
    (cuts || []).forEach((c) => { pieces.push(buf.slice(prev, c)); prev = c; });
    pieces.push(buf.slice(prev));

    let i = 0;
    return {
      getReader() {
        return {
          read() {
            if (i >= pieces.length) return Promise.resolve({ done: true });
            return Promise.resolve({ done: false, value: new Uint8Array(pieces[i++]) });
          }
        };
      }
    };
  }

  function jsonRes(status, obj) {
    return Promise.resolve({
      ok: status === 200,
      status,
      text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj))
    });
  }

  /* ---------- SSE 分块解析 ---------- */
  const deltas = [];
  global.fetch = function (url, opts) {
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return Promise.resolve({
      ok: true,
      status: 200,
      body: sseBody([
        { model: 'deepseek-chat', choices: [{ delta: { content: '{"grade":"str' } }] },
        { choices: [{ delta: { content: 'ong","confidence":0.8}' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 60 } }
      ], [37])   // 故意切在一帧的中间，验证跨块拼帧
    });
  };

  let sr = await J.chat({
    settings: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', timeoutMs: 3000, temperature: 0.2, maxOutputTokens: 1200 },
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
    onDelta: (n) => deltas.push(n)
  });
  check('SSE 跨块拼帧后内容完整',
    J.pickContent(sr.data) === '{"grade":"strong","confidence":0.8}',
    J.pickContent(sr.data));
  check('SSE 带上 usage', sr.data.usage && sr.data.usage.prompt_tokens === 900,
    JSON.stringify(sr.data.usage));
  check('SSE 触发 onDelta', deltas.length >= 2, String(deltas.length));
  check('onDelta 的计数递增', deltas[deltas.length - 1] > deltas[0],
    deltas.join(','));
  check('SSE 记下 finish_reason',
    sr.data.choices[0].finish_reason === 'stop', String(sr.data.choices[0].finish_reason));
  check('流式请求带 stream_options',
    lastRequest && lastRequest.body.stream_options &&
    lastRequest.body.stream_options.include_usage === true);

  /* 网关无视 stream 参数，直接回完整 JSON */
  const plainEnvelope = Buffer.from(JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { content: '{"grade":"neutral"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }), 'utf8');

  global.fetch = function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          let done = false;
          return {
            read() {
              if (done) return Promise.resolve({ done: true });
              done = true;
              return Promise.resolve({ done: false, value: new Uint8Array(plainEnvelope) });
            }
          };
        }
      }
    });
  };
  sr = await J.chat({
    settings: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', timeoutMs: 3000, temperature: 0.2, maxOutputTokens: 1200 },
    messages: [{ role: 'user', content: 'x' }],
    stream: true
  });
  check('网关忽略 stream 时仍能取到内容',
    J.pickContent(sr.data) === '{"grade":"neutral"}', J.pickContent(sr.data));

  /* ---------- 完整判定 ---------- */
  await S.reset();
  await S.save({ apiKey: 'sk-testtesttesttest1234', baseURL: 'https://api.deepseek.com/v1', stream: false });
  localStore.profiles = [];
  await P2.save({
    name: 'FDE',
    requirement: '面向客户的交付岗，能接受驻场，能独立做方案。',
    mustHave: '私有化部署经验',
    redFlags: ''
  });

  const jobInput = {
    jobKey: 'k1',
    fields: {
      jobTitle: 'AI部署工程师（FDE）',
      company: '广东保伦电子',
      salaryText: '12-15K',
      city: '广州',
      experienceText: '3-5年',
      sources: { company: '列表匹配', jd: '选择器' }
    },
    sources: { company: '列表匹配', jd: '选择器' },
    jdText: JD
  };

  let calls = 0;
  global.fetch = function (url, opts) {
    calls++;
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return jsonRes(200, {
      model: 'deepseek-chat',
      choices: [{ message: { content: CONTRACT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 200 }
    });
  };

  const verdict = await J.judgeJob(jobInput);
  check('判定返回档位', verdict.grade === 'strong', verdict.grade);
  check('判定分数按映射算出', verdict.score === 92, String(verdict.score));
  check('带上岗位 key', verdict.jobKey === 'k1');
  check('带上标准 id 与版本',
    verdict.profileId === localStore.profiles[0].id && verdict.profileVersion === 1);
  check('带上提示词版本', verdict.promptVersion === 1, String(verdict.promptVersion));
  check('带上 jdHash', typeof verdict.jdHash === 'string' && verdict.jdHash.length > 0);
  check('标记结论来源为模型', verdict.source === 'model');
  check('带上 usage', verdict.usage.in === 1500 && verdict.usage.out === 200,
    JSON.stringify(verdict.usage));
  check('单价为 0 时成本为 0', verdict.cost === 0, String(verdict.cost));
  check('请求带 json_object',
    lastRequest.body.response_format &&
    lastRequest.body.response_format.type === 'json_object');
  check('请求里的提示词含标准与 JD',
    lastRequest.body.messages[1].content.indexOf('面向客户的交付岗') !== -1 &&
    lastRequest.body.messages[1].content.indexOf('vLLM') !== -1);
  check('请求里带上字段可信度提示',
    lastRequest.body.messages[1].content.indexOf('左侧列表卡片') !== -1);

  /* ---------- json_object 不被支持：自动去参重试 ---------- */
  calls = 0;
  global.fetch = function (url, opts) {
    calls++;
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    if (calls === 1) {
      return jsonRes(400, { error: { message: 'response_format json_object is not supported' } });
    }
    return jsonRes(200, {
      model: 'deepseek-chat',
      choices: [{ message: { content: CONTRACT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    });
  };

  const v2 = await J.judgeJob(jobInput).catch((e) => ({ __err: e }));
  check('不支持 json_object 时自动重试成功', !v2.__err && v2.grade === 'strong',
    v2.__err && v2.__err.code);
  check('重试次数为 2', calls === 2, String(calls));
  check('第二次请求去掉了 response_format',
    !('response_format' in lastRequest.body), JSON.stringify(lastRequest.body.response_format));
  const afterDegrade = await S.get();
  check('能力降级写回设置', afterDegrade.jsonModeSupported === false);

  /* ---------- 格式错误：只重试一次 ---------- */
  await S.save({ jsonModeSupported: true });
  calls = 0;
  global.fetch = function (url, opts) {
    calls++;
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    if (calls === 1) {
      return jsonRes(200, { choices: [{ message: { content: '这不是 json' }, finish_reason: 'stop' }] });
    }
    return jsonRes(200, {
      model: 'deepseek-chat',
      choices: [{ message: { content: CONTRACT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    });
  };
  const v3 = await J.judgeJob(jobInput).catch((e) => ({ __err: e }));
  check('格式错误后重试一次成功', !v3.__err && v3.grade === 'strong',
    v3.__err && v3.__err.code);
  check('格式重试只发生一次', calls === 2, String(calls));
  check('重试改为非流式', lastRequest.body.stream === false);

  calls = 0;
  global.fetch = function (url, opts) {
    calls++;
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return jsonRes(200, { choices: [{ message: { content: '还是不是 json' }, finish_reason: 'stop' }] });
  };
  let badErr = null;
  try {
    await J.judgeJob(jobInput);
  } catch (e) {
    badErr = e;
  }
  check('两次都失败时报 E_BAD_JSON', badErr && badErr.code === 'E_BAD_JSON',
    badErr && badErr.code);
  check('失败后不再无限重试', calls === 2, String(calls));

  /* ---------- 输出被 max_tokens 截断 ---------- */
  global.fetch = function (url, opts) {
    lastRequest = { url, opts, body: JSON.parse(opts.body) };
    return jsonRes(200, {
      choices: [{ message: { content: '{"grade":"str' }, finish_reason: 'length' }]
    });
  };
  let lenErr = null;
  try {
    await J.judgeJob(jobInput);
  } catch (e) {
    lenErr = e;
  }
  check('截断时提示 maxOutputTokens', lenErr && /maxOutputTokens/.test(lenErr.message),
    lenErr && lenErr.message);

  /* ---------- 前置条件 ---------- */
  await S.save({ apiKey: '' });
  let noKey = null;
  try {
    await J.judgeJob(jobInput);
  } catch (e) {
    noKey = e;
  }
  check('没有 Key 时报 E_NO_KEY', noKey && noKey.code === 'E_NO_KEY', noKey && noKey.code);

  await S.save({ apiKey: 'sk-testtesttesttest1234' });
  localStore.profiles = [];
  let noProfile = null;
  try {
    await J.judgeJob(jobInput);
  } catch (e) {
    noProfile = e;
  }
  check('没有判定标准时报 E_NO_PROFILE',
    noProfile && noProfile.code === 'E_NO_PROFILE', noProfile && noProfile.code);

  /* ---------- 外部取消 ---------- */
  await P2.save({ name: 'FDE', requirement: '面向客户的交付岗，能接受驻场，能独立做方案。' });
  global.fetch = function (url, opts) {
    return new Promise((resolve, reject) => {
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  let abortErr = null;
  try {
    await J.judgeJob(Object.assign({}, jobInput, { signal: ac.signal }));
  } catch (e) {
    abortErr = e;
  }
  check('外部取消报 E_ABORT（不是超时）',
    abortErr && abortErr.code === 'E_ABORT', abortErr && abortErr.code);

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
