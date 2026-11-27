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
require(path.join(__dirname, '../src/background/judge.js'));

const S = globalThis.JR_SETTINGS;
const J = globalThis.JR_JUDGE;

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

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
