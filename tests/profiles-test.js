/* 判定标准测试：node tests/profiles-test.js
 * 重点是版本号语义（编辑才 +1）、校验的拒绝路径、以及 lastProfileId 悬空时的回退。
 * 回退这条最关键：标准被删掉后，面板不能拿着一个不存在的 id 去调模型。
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
  }
};

require(path.join(__dirname, '../src/common/settings.js'));
require(path.join(__dirname, '../src/common/profiles.js'));

const S = globalThis.JR_SETTINGS;
const P = globalThis.JR_PROFILES;

const REQ = '面向客户的交付岗，能独立完成 POC 与部署联调。';

async function expectReject(fn, code, name) {
  try {
    await fn();
    check(name, false, '应当抛错但没有');
  } catch (e) {
    check(name, e.code === code, '实际 code=' + e.code + ' message=' + e.message);
  }
}

(async function () {
  /* ---------- 空态 ---------- */
  let list = await P.list();
  check('初始列表为空', list.length === 0, JSON.stringify(list));
  let act = await P.getActive();
  check('无标准时 active 为 null', act.profile === null);
  check('无标准时 fellBack 为 false', act.fellBack === false);

  /* ---------- 新建 ---------- */
  const a = await P.save({ name: '  FDE  ', requirement: REQ });
  check('新建生成 id 且以 p_ 开头', /^p_/.test(a.id), a.id);
  check('新建 version 为 1', a.version === 1, String(a.version));
  check('名称首尾空白被 trim', a.name === 'FDE', '[' + a.name + ']');
  check('createdAt 与 updatedAt 同时写入', !!a.createdAt && !!a.updatedAt);
  check('未提供 mustHave 时为空串', a.mustHave === '');

  /* ---------- 校验拒绝 ---------- */
  await expectReject(() => P.save({ name: '', requirement: REQ }), 'E_NAME_EMPTY', '空名称被拒绝');
  await expectReject(() => P.save({ name: '   ', requirement: REQ }), 'E_NAME_EMPTY', '全空格名称被拒绝');
  await expectReject(() => P.save({ name: 'FDE', requirement: '太短' }), 'E_REQ_SHORT', '要求过短被拒绝');
  await expectReject(() => P.save({ name: 'FDE', requirement: '' }), 'E_REQ_SHORT', '空要求被拒绝');

  /* ---------- 编辑：版本号语义 ---------- */
  const b = await P.save({
    id: a.id,
    name: 'FDE（改）',
    requirement: REQ + ' 需要接受阶段性驻场。',
    mustHave: '私有化部署经验\n客户现场沟通',
    redFlags: '纯外包派遣\n电话销售'
  });
  check('编辑后 id 不变', b.id === a.id, b.id);
  check('编辑后 version 递增到 2', b.version === 2, String(b.version));
  check('编辑后 createdAt 保持', b.createdAt === a.createdAt);
  check('mustHave 落库', b.mustHave.indexOf('私有化部署') === 0, b.mustHave);
  check('redFlags 落库', b.redFlags.indexOf('纯外包') === 0, b.redFlags);

  const c = await P.save({ id: a.id, name: 'FDE（再改）', requirement: REQ, mustHave: b.mustHave, redFlags: b.redFlags });
  check('再编辑 version 到 3', c.version === 3, String(c.version));

  /* 超长名称用 id 更新，验证截断，同时确认不会多出一条记录 */
  const longName = await P.save({ id: a.id, name: 'x'.repeat(60), requirement: REQ });
  check('超长名称被截到 40 字', longName.name.length === 40, String(longName.name.length));
  const countAfterLong = await P.count();
  check('用 id 更新不会新增记录', countAfterLong === 1, String(countAfterLong));

  /* ---------- 顺序：按创建时间，不因编辑跳位 ---------- */
  const d = await P.save({ name: 'AI Agent', requirement: '做 RAG / Agent 落地，需要独立完成评测。' });
  list = await P.list();
  check('列表按创建时间升序', list[0].id === a.id && list[1].id === d.id,
    list.map((x) => x.name).join(' / '));
  check('编辑过的那条仍在第一位', list[0].version === 4, String(list[0].version));

  /* ---------- getActive ---------- */
  await S.save({ lastProfileId: '' });
  act = await P.getActive();
  check('无 lastProfileId 时取第一条', act.profile.id === a.id, act.profile && act.profile.name);
  check('无 lastProfileId 时不算回退', act.fellBack === false);

  await S.save({ lastProfileId: d.id });
  act = await P.getActive();
  check('lastProfileId 有效时取该条', act.profile.id === d.id, act.profile && act.profile.name);

  await S.save({ lastProfileId: 'p_not_exist' });
  act = await P.getActive();
  check('lastProfileId 悬空时回退第一条', act.profile.id === a.id);
  check('悬空时 fellBack 为 true（调用方可回写）', act.fellBack === true);

  /* ---------- get / count ---------- */
  const one = await P.get(d.id);
  check('按 id 能取到', one && one.name === 'AI Agent', one && one.name);
  check('取不存在的 id 返回 null', (await P.get('p_none')) === null);
  check('count 与列表长度一致', (await P.count()) === 2);

  /* ---------- 删除 ---------- */
  let r = await P.remove(d.id);
  check('删除存在的记录返回 removed=true', r.removed === true);
  check('删除后列表只剩一条', r.list.length === 1, String(r.list.length));
  check('删除后存储里也少了', localStore.profiles.length === 1);

  r = await P.remove('p_none');
  check('删除不存在的记录返回 removed=false', r.removed === false);
  check('删除不存在时不破坏原有列表', r.list.length === 1);

  /* 删掉唯一一条后 lastProfileId 仍指向它，getActive 必须是 null 而不是抛错 */
  await S.save({ lastProfileId: a.id });
  await P.remove(a.id);
  act = await P.getActive();
  check('删空后 active 为 null', act.profile === null);
  check('删空后列表为空', act.list.length === 0);

  /* ---------- 存储结构 ---------- */
  check('标准存在 local.profiles 下', Array.isArray(localStore.profiles));
  check('标准里没有 keywords 字段（D3 选 A，不做预筛）',
    !('keywords' in (localStore.profiles[0] || {})),
    JSON.stringify(Object.keys(localStore.profiles[0] || {})));

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
