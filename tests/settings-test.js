/* 设置存储测试：node tests/settings-test.js
 * 覆盖默认值、Key 的双落点（local / session）、切换存储位置时的清理、数值越界收敛。
 * 用内存 mock 代替 chrome.storage，不依赖浏览器。
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

/* ---------- chrome.storage mock ---------- */
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
  }
};

require(path.join(__dirname, '../src/common/settings.js'));
const S = globalThis.JR_SETTINGS;

(async function () {
  /* ---------- 默认值 ---------- */
  let s = await S.get();
  check('默认 baseURL 指向 DeepSeek', s.baseURL === 'https://api.deepseek.com/v1', s.baseURL);
  check('默认模型 deepseek-chat', s.model === 'deepseek-chat', s.model);
  check('默认 temperature 0.2', s.temperature === 0.2, String(s.temperature));
  check('默认每日上限 100', s.dailyLimit === 100, String(s.dailyLimit));
  check('默认自动判定开启', s.autoJudge === true);
  check('默认不脱敏（本轮决定）', !('redact' in s), JSON.stringify(Object.keys(s)));
  check('默认未接受外发提示', s.disclosureAccepted === false);
  check('单价默认为 0，代码不内置价格', s.priceInPerM === 0 && s.priceOutPerM === 0);
  check('schemaVersion 为 1', s.schemaVersion === 1, String(s.schemaVersion));
  check('默认 apiKey 为空串', s.apiKey === '');
  check('默认 keyFrom 为 local', s.keyFrom === 'local', s.keyFrom);

  /* ---------- baseURL 规范化 ---------- */
  check('去尾部斜杠', S.normalizeBaseURL('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1');
  check('去掉误粘的 /chat/completions',
    S.normalizeBaseURL('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1',
    S.normalizeBaseURL('https://api.deepseek.com/v1/chat/completions'));
  check('两个斜杠也裁',
    S.normalizeBaseURL('https://api.deepseek.com//') === 'https://api.deepseek.com');
  check('空值保持空', S.normalizeBaseURL('   ') === '');
  check('originOf 只取到域名',
    S.originOf('https://api.deepseek.com/v1') === 'https://api.deepseek.com',
    S.originOf('https://api.deepseek.com/v1'));
  check('originOf 处理无协议字符串为空',
    S.originOf('api.deepseek.com') === '');

  /* ---------- 写入与读回 ---------- */
  s = await S.save({ model: 'deepseek-reasoner', temperature: 0.7 });
  check('保存后能读回模型名', s.model === 'deepseek-reasoner', s.model);
  check('保存后能读回温度', s.temperature === 0.7, String(s.temperature));
  check('local 里落了 settings', !!localStore.settings);
  check('local 里没有 apiKey 字段', !localStore.settings.apiKey);

  /* ---------- 越界收敛 ---------- */
  s = await S.save({ temperature: 9, maxOutputTokens: 1, timeoutMs: 100, dailyLimit: 0 });
  check('温度超上限被压到 2', s.temperature === 2, String(s.temperature));
  check('输出上限低于下限被抬到 64', s.maxOutputTokens === 64, String(s.maxOutputTokens));
  check('超时低于下限被抬到 3000', s.timeoutMs === 3000, String(s.timeoutMs));
  check('每日上限 0 被抬到 1', s.dailyLimit === 1, String(s.dailyLimit));

  /* ---------- Key 存 local ---------- */
  s = await S.save({ apiKey: 'sk-aaaaaaaaaaaaaaaa1111' });
  check('Key 存进 local', localStore.apiKey === 'sk-aaaaaaaaaaaaaaaa1111', localStore.apiKey);
  check('Key 不落进 settings 对象', !localStore.settings.apiKey);
  check('session 里没有残留', sessionStore.apiKey === undefined, String(sessionStore.apiKey));
  check('读回的 Key 正确', s.apiKey === 'sk-aaaaaaaaaaaaaaaa1111');
  check('keyFrom 标记为 local', s.keyFrom === 'local');
  check('maskKey 只露头尾', S.maskKey('sk-aaaaaaaaaaaaaaaa1111') === 'sk-****1111',
    S.maskKey('sk-aaaaaaaaaaaaaaaa1111'));
  check('maskKey 对短串全遮', S.maskKey('short') === '****');

  /* ---------- 切到 session，旧位置要清掉 ---------- */
  s = await S.save({ keyMode: 'session' });
  check('切到 session 后 Key 进 session', sessionStore.apiKey === 'sk-aaaaaaaaaaaaaaaa1111', sessionStore.apiKey);
  check('切到 session 后 local 被清空', localStore.apiKey === undefined, String(localStore.apiKey));
  check('keyFrom 标记为 session', s.keyFrom === 'session', s.keyFrom);
  check('settings 里 keyMode 已记录', localStore.settings.keyMode === 'session', localStore.settings.keyMode);

  /* 切回来，session 也要清掉 */
  s = await S.save({ keyMode: 'local' });
  check('切回 local 后 session 被清空', sessionStore.apiKey === undefined, String(sessionStore.apiKey));
  check('切回 local 后 local 有 Key', localStore.apiKey === 'sk-aaaaaaaaaaaaaaaa1111');

  /* ---------- 其它字段 ---------- */
  s = await S.save({ lastProfileId: 'p_abc', disclosureAccepted: true, jsonModeSupported: false });
  check('lastProfileId 落库', s.lastProfileId === 'p_abc', s.lastProfileId);
  check('外发确认标记可持久化', s.disclosureAccepted === true);
  check('jsonModeSupported 可关', s.jsonModeSupported === false);

  s = await S.save({ baseURL: '  https://my-gw.example.com/v1/chat/completions  ' });
  check('保存时也会规范化 baseURL', s.baseURL === 'https://my-gw.example.com/v1', s.baseURL);

  /* ---------- reset ---------- */
  s = await S.reset();
  check('reset 后 Key 清空', s.apiKey === '', s.apiKey);
  check('reset 后 local 无 Key', localStore.apiKey === undefined);
  check('reset 后 session 无 Key', sessionStore.apiKey === undefined);
  check('reset 后模型名回默认', s.model === 'deepseek-chat', s.model);
  check('reset 后 baseURL 回默认', s.baseURL === 'https://api.deepseek.com/v1', s.baseURL);

  /* ---------- 无 session 环境回落 ---------- */
  const savedSession = global.chrome.storage.session;
  delete global.chrome.storage.session;
  delete require.cache[require.resolve(path.join(__dirname, '../src/common/settings.js'))];
  require(path.join(__dirname, '../src/common/settings.js'));
  const S2 = globalThis.JR_SETTINGS;
  check('无 session API 时 hasSession 为 false', S2.hasSession() === false);
  const s2 = await S2.save({ keyMode: 'session', apiKey: 'sk-bbbbbbbbbbbbbbbb2222' });
  check('无 session 时 keyMode 回落 local', s2.keyMode === 'local', s2.keyMode);
  check('无 session 时 Key 仍能存下', localStore.apiKey === 'sk-bbbbbbbbbbbbbbbb2222', localStore.apiKey);

  global.chrome.storage.session = savedSession;

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
