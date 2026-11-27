/* 超时与取消的归一化测试：node tests/judge-abort-test.js
 *
 * 现场故障：面板底部显示「（模型失败：signal is aborted without reason）」，
 * 诊断里错误码是数字 20。
 *
 * 根因有两层：
 *   1. DOMException 也带 code（ABORT_ERR=20），旧实现「有 code 就当业务错误」
 *      直接把它透给上层，于是 abort 既没被识别成 E_TIMEOUT 也没被识别成 E_ABORT；
 *   2. 超时是「整体计时」，流式长输出写满 4096 tokens 常常超过 30 秒，
 *      正常的慢输出被误杀。
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

global.chrome = {
  runtime: {},
  storage: { local: makeArea({}), session: makeArea({}) },
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

const J = globalThis.JR_JUDGE;

/* 浏览器真实的 abort 长这样：name=AbortError，code 是数字 20（不是 E_XXX） */
function domAbortErr() {
  const e = new Error('signal is aborted without reason');
  e.name = 'AbortError';
  e.code = 20;
  return e;
}

function settings(over) {
  return Object.assign({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'sk-testtesttesttest1234',
    model: 'deepseek-flash',
    temperature: 0.2,
    maxOutputTokens: 1200,
    timeoutMs: 3000
  }, over || {});
}

/* 挂起不返回，直到 signal 被 abort */
function hangFetch(url, opts) {
  return new Promise((resolve, reject) => {
    const sig = opts && opts.signal;
    if (!sig) return;
    sig.addEventListener('abort', () => reject(domAbortErr()));
  });
}

function sseFrame(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}

/* 按固定间隔吐数据块，用于验证「空闲超时」而不是「整体超时」。
   signal 被 abort 时像真实浏览器一样中断读取。 */
function slowStream(chunks, gap, win, signal) {
  let i = 0;
  return {
    getReader() {
      return {
        read() {
          return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(domAbortErr());
            const t = win.setTimeout(() => {
              if (i >= chunks.length) return resolve({ done: true });
              resolve({ done: false, value: new Uint8Array(Buffer.from(chunks[i++])) });
            }, gap);
            if (signal) {
              signal.addEventListener('abort', () => {
                win.clearTimeout(t);
                reject(domAbortErr());
              }, { once: true });
            }
          });
        }
      };
    }
  };
}

(async function () {
  /* ---------- 1. jerr 必须自带业务标记 ---------- */
  const je = J.jerr('E_X', 'x');
  check('业务错误带 jr 标记', je.jr === true && je.code === 'E_X');
  check('DOMException 不带 jr 标记', domAbortErr().jr === undefined);

  /* ---------- 2. 超时：DOMException code=20 必须归一化成 E_TIMEOUT ---------- */
  global.fetch = hangFetch;
  let err = null;
  try {
    await J.chat({
      settings: settings({ timeoutMs: 30 }),
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 8,
      stream: false
    });
  } catch (e) {
    err = e;
  }
  check('超时不再漏出数字错误码 20', err && err.code !== 20, String(err && err.code));
  check('超时归一化为 E_TIMEOUT', err && err.code === 'E_TIMEOUT',
    (err && err.code) + ' / ' + (err && err.message));

  /* ---------- 3. 外部取消：同样带 code=20，必须归一化成 E_ABORT ---------- */
  const ctrl = new AbortController();
  const p = J.chat({
    settings: settings({ timeoutMs: 5000 }),
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 8,
    stream: false,
    signal: ctrl.signal
  }).catch((e) => e);
  setTimeout(() => ctrl.abort(), 20);
  const abortErr = await p;
  check('外部取消归一化为 E_ABORT', abortErr && abortErr.code === 'E_ABORT',
    (abortErr && abortErr.code) + ' / ' + (abortErr && abortErr.message));
  check('取消文案不暴露底层 abort 信息',
    abortErr && /判定已取消/.test(abortErr.message), abortErr && abortErr.message);

  /* ---------- 4. 流式：有数据在流动时，总耗时超过超时也不该失败 ---------- */
  const chunks = [sseFrame('{"grade":'), sseFrame('"strong",'), sseFrame('"confidence":0.8}')];
  global.fetch = function (url, opts) {
    return Promise.resolve({ ok: true, status: 200, body: slowStream(chunks, 60, globalThis, opts && opts.signal) });
  };
  let streamed = null;
  let streamErr = null;
  try {
    streamed = await J.chat({
      settings: settings({ timeoutMs: 120 }),
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 100,
      stream: true
    });
  } catch (e) {
    streamErr = e;
  }
  check('慢速长输出不因整体超时而失败', !!streamed,
    String(streamErr && (streamErr.code + ' / ' + streamErr.message)));
  check('慢速流式内容完整', !!streamed && J.pickContent(streamed.data) === '{"grade":"strong","confidence":0.8}',
    streamed ? J.pickContent(streamed.data) : '—');
  check('慢速流式耗时确实超过超时阈值', !!streamed && streamed.ms > 120, String(streamed && streamed.ms));

  /* ---------- 5. 流式真的卡住（间隔大于超时）仍然要失败 ---------- */
  global.fetch = function (url, opts) {
    return Promise.resolve({ ok: true, status: 200, body: slowStream([sseFrame('a'), sseFrame('b')], 200, globalThis, opts && opts.signal) });
  };
  let stuckErr = null;
  try {
    await J.chat({
      settings: settings({ timeoutMs: 80 }),
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 100,
      stream: true
    });
  } catch (e) {
    stuckErr = e;
  }
  check('卡住不动的流式仍判超时', stuckErr && stuckErr.code === 'E_TIMEOUT',
    String(stuckErr && stuckErr.code));

  /* ---------- 6. opts.timeoutMs 能覆盖设置（重试放宽超时靠它） ---------- */
  global.fetch = hangFetch;
  let overErr = null;
  try {
    await J.chat({
      settings: settings({ timeoutMs: 3000 }),
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 8,
      stream: false,
      timeoutMs: 30
    });
  } catch (e) {
    overErr = e;
  }
  check('opts.timeoutMs 能覆盖设置里的超时', overErr && overErr.code === 'E_TIMEOUT',
    String(overErr && overErr.code));

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
