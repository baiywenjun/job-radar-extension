/* 空内容路径测试：node tests/judge-empty-test.js
 *
 * 现场故障：「模型失败：模型未返回内容」。
 * 空内容有四种成因，修法完全不同：
 *   thinking  — 思考型模型把输出预算用在 reasoning 上，正文还没开始就结束了
 *   length    — 正文写到一半被 max_tokens 截断
 *   no-frames — 流式请求一帧数据都没收到（网关不认 SSE）
 *   empty     — 接口正常但正文确实为空
 * 这里逐条验证「成因判定」与「放大预算重试」是否真的生效。
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
const J = globalThis.JR_JUDGE;

/* ---------- SSE 构造 ---------- */
function sseBody(frames) {
  const text = frames
    .map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n')
    .join('') + 'data: [DONE]\n\n';
  const buf = Buffer.from(text, 'utf8');
  let i = 0;
  let sent = false;
  return {
    getReader() {
      return {
        read() {
          if (sent) return Promise.resolve({ done: true });
          sent = true;
          return Promise.resolve({ done: false, value: new Uint8Array(buf) });
        }
      };
    }
  };
}

function jsonRes(obj) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text() { return Promise.resolve(JSON.stringify(obj)); }
  });
}

const REPLY = JSON.stringify({
  grade: 'strong',
  confidence: 0.8,
  oneLine: '私有化推理与智能体交付都在做，值得投',
  evidence: [{ type: 'must', claim: '私有化推理', quote: '基于 vLLM 搭建私有化推理服务' }]
});

/* 每次请求都记录下来，供断言检查参数变化 */
let calls = [];

function installFetch(handler) {
  calls = [];
  global.fetch = function (url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    return handler(body, calls.length);
  };
}

const JD =
  '负责客户现场的大模型应用交付，基于 vLLM 搭建私有化推理服务，使用 LangGraph 编排多智能体流程，' +
  '建设评测回归体系与监控告警，需要 3-5 年经验，能适应短期出差与驻场交付。';

const JOB = {
  jobKey: 'k-empty-1',
  fields: {
    jobTitle: 'AI 交付工程师',
    company: '中电金信',
    salaryText: '25-40K',
    city: '北京',
    experienceText: '3-5年',
    platform: 'zhipin',
    siteName: 'BOSS直聘'
  },
  sources: { jobTitle: '详情区', company: '详情区', salary: '详情区', jd: '选择器' },
  jdText: JD
};

(async function () {
  await S.reset();
  await S.save({ apiKey: 'sk-testtesttesttest1234', baseURL: 'https://api.deepseek.com/v1' });
  await P.save({ name: 'AI 交付', requirement: '要有真实的大模型私有化交付与智能体编排经验，不接受纯外包人力。' });

  /* ---------- 1. 思考型模型：只吐 reasoning，正文空 ---------- */
  installFetch((body, n) => {
    if (n === 1) {
      /* 第一次：流式，只有 reasoning_content，最后被 length 截断 */
      return Promise.resolve({
        ok: true,
        status: 200,
        body: sseBody([
          { model: 'deepseek-reasoner', choices: [{ delta: { reasoning_content: '先看 JD 是否涉及私有化交付…' } }] },
          { choices: [{ delta: { reasoning_content: '再核对是否要求量产经验…' } }] },
          { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 900, completion_tokens: 1200 } }
        ])
      });
    }
    /* 第二次：非流式，正常返回 */
    return jsonRes({ model: 'deepseek-chat', choices: [{ message: { content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 180 } });
  });

  /* 失败时不能直接 await 抛出：那会让整个测试中断，断言数都统计不到 */
  const v = await J.judgeJob(JOB).catch((e) => ({ __err: e }));
  check('思考吃光预算后仍能拿到结论', v && v.grade === 'strong',
    JSON.stringify(v && (v.__err ? v.__err.code + '/' + v.__err.reason : v.grade)));
  check('共发起 2 次请求（原请求 + 一次修正重试）', calls.length === 2, String(calls.length));
  check('第一次是流式且用默认输出上限',
    calls[0].body.stream === true && calls[0].body.max_tokens === 1200,
    JSON.stringify({ stream: calls[0].body.stream, max: calls[0].body.max_tokens }));
  /* thinking 场景下流式是正常的（有 reasoning 帧在流动），
     改非流式只会更慢、更容易撞超时 —— 所以应当保持流式，只放大预算 */
  check('thinking 重试保持流式', calls[1] && calls[1].body.stream === true,
    JSON.stringify(calls[1] && calls[1].body.stream));
  check('重试把输出上限放大到 4096',
    calls[1] && calls[1].body.max_tokens === 4096,
    String(calls[1] && calls[1].body.max_tokens));

  /* ---------- 2. 成因判定：四种情况各归各的 ---------- */
  const infoThinking = J.emptyInfo({
    streamed: true,
    data: {
      choices: [{ message: { content: '', reasoning_content: '思考中…' }, finish_reason: 'length' }],
      _jr: { sawEvent: true, frames: 3 }
    }
  });
  check('有 reasoning 时判为 thinking（优先于 length）',
    infoThinking.reason === 'thinking', infoThinking.reason);
  check('thinking 记录思考字数', infoThinking.reasoningChars === 4, String(infoThinking.reasoningChars));

  const infoLength = J.emptyInfo({
    streamed: false,
    data: { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
  });
  check('非流式 + length 判为 length', infoLength.reason === 'length', infoLength.reason);

  const infoNoFrames = J.emptyInfo({
    streamed: true,
    data: { choices: [{ message: { content: '' } }], _jr: { sawEvent: false, frames: 0, raw: '<html>bad gateway</html>' } }
  });
  check('流式零数据帧判为 no-frames', infoNoFrames.reason === 'no-frames', infoNoFrames.reason);
  check('no-frames 把原始响应片段带出来',
    /bad gateway/.test(String(infoNoFrames.detail)), String(infoNoFrames.detail));

  const infoEmpty = J.emptyInfo({
    streamed: true,
    data: { choices: [{ message: { content: '' } }], _jr: { sawEvent: true, frames: 5 } }
  });
  check('收到数据帧但正文为空判为 empty', infoEmpty.reason === 'empty', infoEmpty.reason);
  check('非流式失败不误判成 no-frames', J.emptyInfo({
    streamed: false, data: { choices: [{ message: { content: '' } }] }
  }).sawEvent === true);

  /* ---------- 3. 网关不认流式：零帧，重试后仍空 → 只重试一次 ---------- */
  installFetch((body) => {
    if (body && body.stream) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) }
      });
    }
    /* 非流式也是空内容：这是「模型确实不说话」，不是格式问题 */
    return jsonRes({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  });

  let err = null;
  try {
    await J.judgeJob(JOB);
  } catch (e) {
    err = e;
  }
  check('两次都空时报 E_EMPTY', err && err.code === 'E_EMPTY', err && err.code);
  check('成因是 no-frames', err && err.reason === 'no-frames', err && err.reason);
  check('只重试一次，不无限烧钱', calls.length === 2, String(calls.length));
  check('最终文案写明已放大输出上限重试',
    err && /已放大输出上限至 \d+ tokens 重试/.test(err.message),
    err && err.message);
  check('no-frames 重试改为非流式',
    calls[1] && calls[1].body.stream === false,
    JSON.stringify(calls[1] && calls[1].body.stream));
  check('失败时带出尝试链', err && err.attempts && err.attempts.length === 2,
    JSON.stringify(err && err.attempts));
  check('尝试链记下每次的错误码', err && err.attempts &&
    err.attempts[0].code === 'E_EMPTY' && err.attempts[1].code === 'E_EMPTY',
    JSON.stringify(err && err.attempts && err.attempts.map((a) => a.code)));

  /* ---------- 4. 正文被截断（有内容但不是合法 json）仍走 E_BAD_JSON ---------- */
  installFetch((body, n) => {
    if (n === 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: sseBody([{ choices: [{ delta: { content: '{"grade":"str' }, finish_reason: 'length' }] }])
      });
    }
    return jsonRes({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }] });
  });
  const v2 = await J.judgeJob(JOB).catch((e) => ({ __err: e }));
  check('有内容但 json 不完整时按格式错重试并恢复', v2 && v2.grade === 'strong',
    JSON.stringify(v2 && (v2.__err ? v2.__err.code : v2.grade)));
  check('格式错重试也只要 2 次', calls.length === 2, String(calls.length));

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
