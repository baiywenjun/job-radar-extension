/* 判定轨迹算法测试：node tests/history-test.js
 *
 * 这个文件只测纯函数，因为它回答的问题是整个 S5 里最容易做错的那几个：
 *   1. 跨标准的两次判定，分数能不能比？—— 不能，比出来的差值全是噪声
 *   2. "正文没变"和"不知道变没变"是不是一回事？—— 不是，老记录没有指纹
 *   3. 同一毫秒的两条记录，轨迹顺序稳不稳？—— 不稳的话每次刷新图形都不一样
 */
require('../src/common/history.js');

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

function entry(over) {
  return Object.assign({
    key: 'k1',
    profileId: 'p1',
    profileName: 'FDE',
    profileVersion: 1,
    grade: 'neutral',
    score: 60,
    confidence: 0.7,
    model: 'deepseek-chat',
    jdHash: 'h1',
    jdChars: 1200,
    evidenceFlag: '',
    evidenceRate: 0.8,
    inTokens: 1000,
    outTokens: 300,
    totalTokens: 1300,
    cost: 0.002,
    ms: 4200,
    oneLine: '方向对但偏集成',
    createdAt: 1000
  }, over || {});
}

const DAY = 86400000;

/* ---------- toLogEntry ---------- */
console.log('=== 剪成日志条目 ===');

const v = {
  key: 'k1', jobKey: 'k1', profileId: 'p1', profileName: 'FDE', profileVersion: 2,
  grade: 'strong', score: 88, confidence: 0.9, model: 'deepseek-chat',
  jdHash: 'abc', jdChars: 900, evidenceFlag: 'E_BAD_EVIDENCE',
  evidenceCheck: { checked: 4, passed: 1, rate: 0.25 },
  usage: { in: 1200, out: 400, total: 1600 }, cost: 0.0033, ms: 5100,
  oneLine: '证据充分'.repeat(40), createdAt: 1700000000000,
  evidence: [{ claim: 'x', quote: 'y' }], jdText: '很长很长的正文'
};

const le = H.toLogEntry(v);
check('产出日志条目', !!le && le.key === 'k1');
check('保留档位与分数', le.grade === 'strong' && le.score === 88);
check('保留标准身份', le.profileId === 'p1' && le.profileName === 'FDE' && le.profileVersion === 2);
check('保留正文指纹（判断"改没改"的唯一依据）', le.jdHash === 'abc' && le.jdChars === 900);
check('token 从 usage 摊平', le.inTokens === 1200 && le.outTokens === 400 && le.totalTokens === 1600);
check('证据通过率单独留一份', le.evidenceRate === 0.25);
check('一句话结论被截断到 80 字', le.oneLine.length === H.MAX_ONE_LINE, String(le.oneLine.length));
check('不存正文（正文在 jobs 表里，重复存会让库翻倍）', !('jdText' in le));
check('不存证据原文（只有最新一份需要引文）', !('evidence' in le));

check('没有 key 的结论不进历史', H.toLogEntry({ grade: 'strong' }) === null);
check('试跑结论不进历史（用的是没保存的标准，混进来轨迹无法复现）',
  H.toLogEntry(Object.assign({}, v, { dryRun: true })) === null);
check('空值也不抛错', H.toLogEntry(null) === null);

const sparse = H.toLogEntry({ key: 'k9', createdAt: 1 });
check('缺字段时给安全默认值',
  sparse.profileId === '' && sparse.score === null && sparse.inTokens === 0 && sparse.oneLine === '',
  JSON.stringify(sparse));

/* ---------- sameJd ---------- */
console.log('\n=== 正文有没有改过 ===');

check('同 hash 同字数 → 没改', H.sameJd({ jdHash: 'a', jdChars: 10 }, { jdHash: 'a', jdChars: 10 }) === true);
check('同 hash 但字数变了 → 改了（800 字之后被改）',
  H.sameJd({ jdHash: 'a', jdChars: 10 }, { jdHash: 'a', jdChars: 11 }) === false);
check('等长但 hash 变了 → 改了（等长替换）',
  H.sameJd({ jdHash: 'a', jdChars: 10 }, { jdHash: 'b', jdChars: 10 }) === false);
check('缺 hash → null，不能当成"没变"',
  H.sameJd({ jdChars: 10 }, { jdHash: 'b', jdChars: 10 }) === null);
check('缺字数 → null', H.sameJd({ jdHash: 'a' }, { jdHash: 'a' }) === null);
check('任一条为空 → null', H.sameJd(null, { jdHash: 'a', jdChars: 1 }) === null);

/* ---------- buildTimeline：边界 ---------- */
console.log('\n=== 时间线 ===');

const empty = H.buildTimeline([]);
check('空历史 count 为 0', empty.stats.count === 0 && empty.rows.length === 0);
check('空历史的文案明说没有记录', H.describe(empty.stats).main === '还没有判定记录');

check('null 入参不抛错', H.buildTimeline(null).stats.count === 0);
check('脏数据（无 key）被过滤',
  H.buildTimeline([entry(), { createdAt: 1 }]).stats.count === 1);

const one = H.buildTimeline([entry({ createdAt: 1000 })]);
check('单条没有"与上一比"的概念',
  one.rows[0].jdChanged === null && one.rows[0].scoreDelta === null && one.rows[0].profileChanged === false);

/* 乱序输入必须按时间排好 */
const shuffled = H.buildTimeline([
  entry({ createdAt: 3000, score: 70, jdHash: 'h3', jdChars: 1300 }),
  entry({ createdAt: 1000, score: 50, jdHash: 'h1', jdChars: 1200 }),
  entry({ createdAt: 2000, score: 60, jdHash: 'h2', jdChars: 1250 })
]);
check('乱序输入按时间正序排好',
  shuffled.rows.map((r) => r.entry.score).join(',') === '50,60,70',
  shuffled.rows.map((r) => r.entry.score).join(','));
check('每次正文都变了 → 两次改动', shuffled.stats.jdChanges === 2);
check('三版正文 → jdVersions 为 3', shuffled.stats.jdVersions === 3);
check('同标准下的分数差是相邻两条之比',
  shuffled.rows[1].scoreDelta === 10 && shuffled.rows[2].scoreDelta === 10);

/* 同毫秒：顺序必须稳定（用 profileId 兜底） */
const tie = H.buildTimeline([
  entry({ createdAt: 5000, profileId: 'pb', grade: 'weak', score: 40 }),
  entry({ createdAt: 5000, profileId: 'pa', grade: 'strong', score: 90 })
]);
check('同一毫秒按标准 id 稳定排序',
  tie.rows[0].entry.profileId === 'pa' && tie.rows[1].entry.profileId === 'pb',
  tie.rows.map((r) => r.entry.profileId).join(','));

/* 跨标准：分数不可比 */
const cross = H.buildTimeline([
  entry({ createdAt: 1000, profileId: 'p1', profileName: 'FDE', grade: 'strong', score: 86 }),
  entry({ createdAt: 2000, profileId: 'p2', profileName: 'AI应用', grade: 'weak', score: 40 })
]);
check('换标准时不算分数差', cross.rows[1].scoreDelta === null);
check('换标准时标明已切换', cross.rows[1].profileChanged === true);
check('换标准时也不算"档位变化"结论（给了 gradeChanged 但 UI 不拿它做差评）',
  cross.rows[1].gradeChanged === true);
check('跨标准汇总里分两个桶', cross.stats.perProfile.length === 2);

/* 老记录没有指纹 */
const legacy = H.buildTimeline([
  entry({ createdAt: 1000, jdHash: '', jdChars: 0 }),
  entry({ createdAt: 2000, jdHash: 'h1', jdChars: 1200 })
]);
check('老记录缺指纹时 jdChanged 为 null（不是 false）', legacy.rows[1].jdChanged === null);
check('缺指纹的老记录不计入正文改动次数', legacy.stats.jdChanges === 0);

/* ---------- 按标准聚合 ---------- */
console.log('\n=== 按标准聚合 ===');

const multi = H.buildTimeline([
  entry({ createdAt: 1 * DAY, profileId: 'p1', profileName: 'FDE', score: 80, grade: 'strong', cost: 0.001, totalTokens: 1000 }),
  entry({ createdAt: 2 * DAY, profileId: 'p1', profileName: 'FDE', score: 61, grade: 'neutral', cost: 0.002, totalTokens: 1200 }),
  entry({ createdAt: 3 * DAY, profileId: 'p1', profileName: 'FDE', score: 58, grade: 'neutral', cost: 0.003, totalTokens: 1100, jdHash: 'h2', jdChars: 1210 }),
  entry({ createdAt: 4 * DAY, profileId: 'p2', profileName: 'AI应用', score: 40, grade: 'weak', jdHash: 'h2', jdChars: 1210 })
]);

const fde = multi.stats.perProfile.filter((b) => b.profileId === 'p1')[0];
check('聚合出首末分数', fde.firstScore === 80 && fde.lastScore === 58);
check('聚合出净变化 -22', fde.delta === -22);
check('聚合出最好/最差', fde.best === 80 && fde.worst === 58);
check('聚合出次数', fde.count === 3);
check('聚合出花费（按岗位这条标准的累加）', Math.abs(fde.cost - 0.006) < 1e-9, String(fde.cost));
check('趋势判定为 down', fde.trend === 'down');
check('记录多的标准排前面', multi.stats.perProfile[0].profileId === 'p1');

check('只判过一次的标准没有 delta', multi.stats.perProfile[1].delta === null);
check('只判过一次的趋势是 flat', multi.stats.perProfile[1].trend === 'flat');

const verChange = H.buildTimeline([
  entry({ createdAt: 1000, profileVersion: 1 }),
  entry({ createdAt: 2000, profileVersion: 3 })
]);
check('统计标准版本跨度', verChange.stats.perProfile[0].versionCount === 2 &&
  verChange.stats.perProfile[0].maxVersion === 3);

check('时间跨度按天取整',
  H.buildTimeline([entry({ createdAt: 0 }), entry({ createdAt: 2.6 * DAY })]).stats.spanDays === 3);

/* ---------- 文案 ---------- */
console.log('\n=== 汇总文案 ===');

const d1 = H.describe(multi.stats);
check('汇总写明次数', d1.main.indexOf('判过 4 次') !== -1, d1.main);
check('汇总写明跨标准', d1.main.indexOf('跨 2 个标准') !== -1, d1.main);
check('汇总写明正文改动次数', d1.main.indexOf('正文改过 1 次') !== -1, d1.main);
check('同一版正文跨标准不算改动', multi.stats.jdVersions === 2, String(multi.stats.jdVersions));
check('明细写首末与箭头', d1.detail.indexOf('80 → 58') !== -1 && d1.detail.indexOf('↓22') !== -1, d1.detail);

const d2 = H.describe(H.buildTimeline([entry(), entry({ createdAt: 2000, score: 60 })]).stats);
check('持平写"持平"不写 ↑0', d2.detail.indexOf('持平') !== -1, d2.detail);
check('单条标准写"只判过 1 次"',
  H.describe(H.buildTimeline([entry()]).stats).detail.indexOf('只判过 1 次') !== -1);

check('空统计的文案安全', H.describe(null).main === '还没有判定记录');

/* ---------- 小工具 ---------- */
console.log('\n=== 小工具 ===');

check('deltaText 正数带 ↑', H.deltaText({ scoreDelta: 12 }) === '↑12');
check('deltaText 负数带 ↓', H.deltaText({ scoreDelta: -8 }) === '↓8');
check('deltaText 0 写持平', H.deltaText({ scoreDelta: 0 }) === '持平');
check('deltaText 跨标准为空串（不写 0，避免读成"没变化"）', H.deltaText({ scoreDelta: null }) === '');
check('档位有等级可比', H.levelOf('strong') > H.levelOf('neutral') && H.levelOf('neutral') > H.levelOf('poor'));
check('未知档位等级为 0', H.levelOf('?') === 0);
check('档位标签有兜底', H.gradeLabel('strong') === '强信号' && H.gradeLabel('') === '—');

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
