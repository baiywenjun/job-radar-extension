/* 岗位雷达 · Service Worker
 * 只承担两件事：代理 IndexedDB 读写（内容脚本不直接落库），以及响应 popup 的查询。
 * MV3 的 service worker 会被休眠，所有逻辑都做成事件驱动、无常驻状态。
 */
importScripts('../common/db.js');

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'SAVE') {
    JR_DB.save(msg.payload)
      .then(function (record) {
        sendResponse({ ok: true, record: record });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }

  if (msg.type === 'QUERY_ONE') {
    JR_DB.getOne(msg.key)
      .then(function (record) {
        sendResponse({ ok: true, record: record });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }

  if (msg.type === 'QUERY_ALL') {
    JR_DB.getAll()
      .then(function (list) {
        sendResponse({ ok: true, list: list });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }

  if (msg.type === 'DELETE') {
    JR_DB.remove(msg.key)
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }

  if (msg.type === 'CLEAR') {
    JR_DB.clearAll()
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    console.log('[岗位雷达] 已安装。打开 BOSS 直聘 / 猎聘 / 脉脉 / 国聘 的岗位详情页即可使用。');
  }
});
