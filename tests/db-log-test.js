/* 判定轨迹存储测试：node tests/db-log-test.js
 *
 * 为什么单独一套：这是全项目唯一真正跑 IndexedDB 的测试。
 * 上一轮的教训（verdict 缺 key → put 抛 DataError → 被静默吞掉）就是
 * "单测用桩、真机才炸"。轨迹表也是同一类风险：
 *   - 升级到 v3 时会不会弄坏已有的岗位库？
 *   - 自增主键 + 索引 + 同事务裁剪，写法错一点在桩里根本看不出来
 *
 * 用 fake-indexeddb 起一个真实现，先手搓一个 v2 老库，再让 db.js 升上来。
 */
const { IDBFactory } = require('fake-indexeddb');

globalThis.indexedDB = new IDBFactory();

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

const DB_NAME = 'jr-radar';
const DAY = 86400000;

/* ---------- 先造一个 v2 的老库（v1 岗位 + v2 判定/用量，没有轨迹表） ---------- */
function seedV2() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const jobs = db.createObjectStore('jobs', { keyPath: 'key' });
      jobs.createIndex('firstSeen', 'firstSeen');
      jobs.createIndex('lastSeen', 'lastSeen');
      jobs.createIndex('score', 'score');
      jobs.createIndex('platform', 'platform');
      jobs.createIndex('group', 'group');
      db.createObjectStore('verdicts', { keyPath: ['key', 'profileId'] });
      db.createObjectStore('usage', { keyPath: 'date' });

      jobs.put({
        key: 'old-1',
        jobTitle: '升级前就在的岗位',
        company: '老东家',
        grade: 'neutral',
        score: 61,
        firstSeen: 1000,
        lastSeen: 2000,
        seenCount: 7
      });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

/* db.js 是给浏览器挂全局的写法，require 只是为了执行它 */
require('../src/common/db.js');
const DB = globalThis.JR_DB;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(over) {
  return Object.assign({
    key: 'k1',
    profileId: 'p1',
    profileName: 'FDE',
    profileVersion: 1,
    grade: 'neutral',
    score: 60,
    jdHash: 'h1',
    jdChars: 1200,
    totalTokens: 1000,
    cost: 0.002,
    createdAt: 1000
  }, over || {});
}

(async function () {
  console.log('=== 版本与迁移 ===');

  await seedV2();
  check('db.js 声明的版本是 3', DB.DB_VER === 3, String(DB.DB_VER));
  check('轨迹表名固定为 verdictlog', DB.LOG === 'verdictlog');

  const db = await DB.open();
  check('升级后仍能打开库', !!db);
  const names = Array.prototype.slice.call(db.objectStoreNames);
  check('v3 新增了轨迹表', names.indexOf('verdictlog') !== -1, names.join(','));
  check('原有的三张表都在', ['jobs', 'verdicts', 'usage'].every((n) => names.indexOf(n) !== -1), names.join(','));
  check('轨迹表按 createdAt 建了索引',
    Array.prototype.slice.call(db.transaction('verdictlog').objectStore('verdictlog').indexNames)
      .indexOf('createdAt') !== -1);

  const jobs = await DB.getAll();
  check('升级后岗位库数据完好（条数不变）', jobs.length === 1, String(jobs.length));
  check('升级不动 firstSeen / seenCount',
    jobs[0].key === 'old-1' && jobs[0].seenCount === 7 && jobs[0].firstSeen === 1000,
    JSON.stringify(jobs[0]));
  check('升级后岗位表索引还在',
    Array.prototype.slice.call(db.transaction('jobs').objectStore('jobs').indexNames).indexOf('firstSeen') !== -1);

  /* ---------- 追加与读取 ---------- */
  console.log('\n=== 追加与读取 ===');

  const added = await DB.appendLog(log({ createdAt: 1000, score: 55 }));
  check('appendLog 返回自增 id', !!added && typeof added.id === 'number' && added.id > 0, JSON.stringify(added));

  await DB.appendLog(log({ createdAt: 3000, score: 70, jdHash: 'h2' }));
  await DB.appendLog(log({ createdAt: 2000, score: 61 }));

  const list = await DB.listLog('k1');
  check('按时间正序返回（画轨迹条要的就是时间轴）',
    list.map((x) => x.score).join(',') === '55,61,70', list.map((x) => x.score).join(','));
  check('保留写入时的字段', list[0].profileName === 'FDE' && list[0].jdHash === 'h1');

  await DB.appendLog(log({ key: 'k2', profileId: 'p1', score: 90 }));
  const other = await DB.listLog('k2');
  check('不同岗位的轨迹不串', other.length === 1 && other[0].score === 90, JSON.stringify(other));
  check('按岗位查只返回自己的', (await DB.listLog('k1')).length === 3);

  check('没有轨迹的岗位返回空数组', (await DB.listLog('nope')).length === 0);
  check('空 key 不写入', (await DB.appendLog(log({ key: '' }))) === null);
  check('null 不抛错', (await DB.appendLog(null)) === null);
  check('countLog 数的是全部轨迹', (await DB.countLog()) === 4, String(await DB.countLog()));

  /* ---------- 每岗位上限定额 ---------- */
  console.log('\n=== 超额裁剪 ===');

  const cap = DB.LOG === 'verdictlog' ? 30 : 0;   /* 与 history.MAX_PER_JOB 一致 */
  for (let i = 0; i < 40; i++) {
    await DB.appendLog(log({ key: 'bulk', score: i, createdAt: i * 1000 }));
  }
  const bulk = await DB.listLog('bulk');
  check('同一岗位最多留 ' + cap + ' 条', bulk.length === cap, String(bulk.length));
  check('丢掉的是最旧的，不是最新的', bulk[0].score === 10 && bulk[bulk.length - 1].score === 39,
    bulk[0].score + '..' + bulk[bulk.length - 1].score);
  check('裁剪只影响这一个岗位', (await DB.listLog('k1')).length === 3);

  /* ---------- 与 verdicts 的关系 ---------- */
  console.log('\n=== 与判定缓存的关系 ===');

  await DB.putVerdict({ key: 'k1', profileId: 'p1', grade: 'neutral', score: 70, createdAt: 3000 });
  const v = await DB.getVerdict('k1', 'p1');
  check('复合主键仍然可写可读', !!v && v.score === 70);
  check('缓存条数与轨迹条数各算各的',
    (await DB.countVerdicts()) === 1 && (await DB.countLog()) === 3 + 1 + cap,
    (await DB.countVerdicts()) + ' / ' + (await DB.countLog()));

  /* ---------- 清空 ---------- */
  console.log('\n=== 清空判定 ===');

  await DB.clearVerdicts();
  check('清空判定同时清掉轨迹', (await DB.countLog()) === 0);
  check('清空判定同时清掉缓存', (await DB.countVerdicts()) === 0);
  check('清空判定不动岗位库', (await DB.count()) === 1);

  await DB.appendLog(log({ key: 'after', createdAt: 5000 }));
  check('清空后还能继续写轨迹', (await DB.listLog('after')).length === 1);

  /* ---------- 单例 ---------- */
  console.log('\n=== 连接单例 ===');

  const db2 = await DB.open();
  check('重复 open 返回同一个连接（不重复升级、不泄漏）', db2 === db);

  await DB.clearLog();
  check('clearLog 可单独清轨迹', (await DB.countLog()) === 0);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
