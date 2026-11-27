/* 岗位雷达 · 一条结论的落库顺序
 *
 * 抽出来单独一个文件只为一个原因：**顺序是有语义的，而且写错不会被立刻发现**。
 *   1. verdicts   缓存与界面读的那份
 *   2. usage      今天调用了几次、花了多少 —— 成本闸门唯一的依据
 *   3. verdictlog 判定轨迹（检查器的「判定历史」）
 *
 * 2 必须排在 3 前面。轨迹写失败只是少一条历史；用量写失败就是限额失灵，
 * 而限额失灵的表现是"月底看账单才知道"。所以 appendLog 的失败在这里被吃掉，
 * bumpUsage 的失败必须往上抛。
 */
(function (global) {
  'use strict';

  /* DB：JR_DB（需要 putVerdict / bumpUsage / appendLog）
     H ：JR_HISTORY（提供 toLogEntry；缺了就不写轨迹，不能因此让整条链失败）
     date：用量按天累计的键（与面板显示同一口径） */
  function save(DB, H, v, date) {
    if (!v) return Promise.resolve(null);

    return DB.putVerdict(v).then(function () {
      var u = v.usage || {};
      return DB.bumpUsage(date, {
        calls: 1,
        inTokens: u.in || 0,
        outTokens: u.out || 0,
        cost: v.cost || 0
      });
    }).then(function (usage) {
      var entry = (H && H.toLogEntry) ? H.toLogEntry(v) : null;
      if (!entry || !DB.appendLog) return usage;
      return DB.appendLog(entry).then(function () {
        return usage;
      }).catch(function (e) {
        console.warn('[岗位雷达] 判定轨迹写入失败：', (e && e.message) || e);
        return usage;
      });
    });
  }

  global.JR_PERSIST = { save: save };
})(typeof window !== 'undefined' ? window : globalThis);
