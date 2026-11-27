/* 落库顺序测试：node tests/persist-test.js
 *
 * 这套断言存在的理由只有一条，但它值钱：
 * **用量必须写在轨迹之前**。轨迹写失败只是少一条历史；用量写失败是限额失灵，
 * 而限额失灵要到月底看账单才会发现。顺序错在桩里完全看不出来——
 * 两个 promise 都会 resolve，结果也对，只有写入顺序不对。
 */
require('../src/background/persist.js');
require('../src/common/history.js');

const PS = globalThis.JR_PERSIST;
const H = globalThis.JR_HISTORY;

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

function verdict(over) {
  return Object.assign({
    key: 'k1', jobKey: 'k1', profileId: 'p1', profileName: 'FDE', profileVersion: 2,
    grade: 'neutral', score: 61, model: 'deepseek-chat', jdHash: 'h1', jdChars: 1200,
    usage: { in: 1200, out: 400, total: 1600 }, cost: 0.003, ms: 4000,
    createdAt: 1790000000000
  }, over || {});
}

/* 记录调用顺序的桩库 */
function makeDB(opts) {
  opts = opts || {};
  const calls = [];
  return {
    calls,
    putVerdict(v) {
      calls.push('putVerdict');
      if (opts.putFail) return Promise.reject(new Error('put 失败'));
      return Promise.resolve(v);
    },
    bumpUsage(date, delta) {
      calls.push('bumpUsage');
      if (opts.bumpFail) return Promise.reject(new Error('用量写失败'));
      this.lastDelta = delta;
      this.lastDate = date;
      return Promise.resolve({ date: date, calls: delta.calls });
    },
    appendLog(entry) {
      calls.push('appendLog');
      this.lastEntry = entry;
      if (opts.logFail) return Promise.reject(new Error('轨迹写失败'));
      return Promise.resolve(entry);
    }
  };
}

(async function () {
  console.log('=== 顺序 ===');

  let db = makeDB();
  await PS.save(db, H, verdict(), '2026-11-27');
  check('三步都执行了', db.calls.join('>') === 'putVerdict>bumpUsage>appendLog', db.calls.join('>'));
  check('顺序是缓存 → 用量 → 轨迹，不允许换',
    db.calls.indexOf('bumpUsage') < db.calls.indexOf('appendLog'));

  console.log('\n=== 用量口径 ===');

  check('每次判定记一次调用', db.lastDelta.calls === 1);
  check('token 从 usage 摊平', db.lastDelta.inTokens === 1200 && db.lastDelta.outTokens === 400);
  check('花费跟着写（否则额度按次算、账单按钱算，两个口径会打架）', db.lastDelta.cost === 0.003);
  check('用量键用传入的日期（与面板同一口径）', db.lastDate === '2026-11-27');

  db = makeDB();
  await PS.save(db, H, verdict({ usage: null, cost: 0 }), '2026-11-27');
  check('缺 usage 时按 0 记，不写 NaN', db.lastDelta.inTokens === 0 && db.lastDelta.outTokens === 0);

  console.log('\n=== 轨迹内容 ===');

  check('写进去的是剪过的日志条目', !!db.lastEntry && db.lastEntry.key === 'k1' && db.lastEntry.score === 61);
  check('日志条目不含正文', db.lastEntry && !('jdText' in db.lastEntry));

  db = makeDB();
  await PS.save(db, H, verdict({ dryRun: true }), '2026-11-27');
  check('试跑结论不进轨迹（用了没保存的标准）',
    db.calls.indexOf('appendLog') === -1, db.calls.join('>'));

  db = makeDB();
  await PS.save(db, null, verdict(), '2026-11-27');
  check('没有 history 模块时跳过轨迹、不报错',
    db.calls.join('>') === 'putVerdict>bumpUsage', db.calls.join('>'));

  console.log('\n=== 失败处理 ===');

  db = makeDB({ logFail: true });
  let threw = false;
  try {
    await PS.save(db, H, verdict(), '2026-11-27');
  } catch (e) {
    threw = true;
  }
  check('轨迹写失败不影响结论落库（不往外抛）', threw === false);
  check('轨迹失败时用量照样记了（这是最要紧的一条）',
    db.calls.indexOf('bumpUsage') !== -1, db.calls.join('>'));

  db = makeDB({ bumpFail: true });
  threw = false;
  try {
    await PS.save(db, H, verdict(), '2026-11-27');
  } catch (e) {
    threw = true;
  }
  check('用量写失败必须往外抛（闸门失灵不能静默）', threw === true);
  check('用量失败后不再写轨迹（省一次无意义的写）', db.calls.indexOf('appendLog') === -1);

  db = makeDB({ putFail: true });
  threw = false;
  try {
    await PS.save(db, H, verdict(), '2026-11-27');
  } catch (e) {
    threw = true;
  }
  check('缓存写失败也往外抛', threw === true);
  check('缓存失败时既不记用量也不写轨迹（这次判定等于没发生）',
    db.calls.join('>') === 'putVerdict', db.calls.join('>'));

  check('空结论直接返回 null，不碰库', (await PS.save(makeDB(), H, null, '2026-11-27')) === null);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
