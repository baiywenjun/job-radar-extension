/* 岗位雷达 · Service Worker
 * 三件事：
 *   1. 代理 IndexedDB 读写（内容脚本不直接落库，避免写进招聘站点的 origin）
 *   2. 保存配置与判定标准（只有扩展页面能访问，内容脚本读不到 API Key）
 *   3. 唯一发模型网络请求的地方
 * MV3 的 service worker 会被休眠，所有逻辑都做成事件驱动、无常驻状态。
 */
importScripts(
  '../common/settings.js',
  '../common/profiles.js',
  '../common/prompt.js',
  '../common/verdict.js',
  '../common/db.js',
  'judge.js'
);

var S = JR_SETTINGS;
var P = JR_PROFILES;
var J = JR_JUDGE;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fail(e) {
  return {
    ok: false,
    code: (e && e.code) || 'E_UNKNOWN',
    error: String((e && e.message) || e || '未知错误')
  };
}

function reply(promise, sendResponse) {
  promise.then(function (data) {
    sendResponse(Object.assign({ ok: true }, data || {}));
  }).catch(function (e) {
    sendResponse(fail(e));
  });
  return true;
}

/* 安全边界：内容脚本发来的消息带 sender.tab，扩展页面（popup/options）没有。
   凡是涉及 Key、完整设置、标准原文的消息，一律只认扩展页面。
   内容脚本需要的那点信息走 SETTINGS_PUBLIC（脱敏视图），永远拿不到 apiKey。 */
function fromExtensionPage(sender) {
  return !!(sender && !sender.tab);
}

function deny(sendResponse) {
  sendResponse({ ok: false, code: 'E_FORBIDDEN', error: '该消息只允许扩展页面调用' });
  return true;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  var PRIVATE = {
    SETTINGS_GET: 1,
    SETTINGS_SAVE: 1,
    SETTINGS_RESET: 1,
    SETTINGS_TEST: 1,
    PROFILES_SAVE: 1,
    PROFILES_DELETE: 1,
    STATS: 1,
    USAGE_GET: 1,
    CLEAR_VERDICTS: 1
  };
  if (PRIVATE[msg.type] && !fromExtensionPage(sender)) return deny(sendResponse);

  /* 内容脚本唯一的设置入口：只给"能不能用、用哪个标准"，不给 Key、不给单价。
     标准只回 id / 名称 / 版本，不回 requirement 原文——面板要的只是下拉选项。 */
  if (msg.type === 'SETTINGS_PUBLIC') {
    return reply(Promise.all([
      S.get(),
      P.getActive(),
      JR_DB.getUsage(todayKey()).catch(function () {
        return { date: todayKey(), calls: 0 };
      })
    ]).then(function (r) {
      var s = r[0];
      var a = r[1];
      var u = r[2] || { calls: 0 };
      return {
        settings: {
          model: s.model,
          hasKey: !!s.apiKey,
          autoJudge: s.autoJudge,
          dailyLimit: s.dailyLimit,
          baseOrigin: S.originOf(s.baseURL),
          dailyUsed: u.calls || 0
        },
        active: a.profile
          ? { id: a.profile.id, name: a.profile.name, version: a.profile.version }
          : null,
        profiles: (a.list || []).map(function (p) {
          return { id: p.id, name: p.name, version: p.version };
        })
      };
    }), sendResponse);
  }

  /* 面板里的标准下拉：内容脚本可以切换当前标准，但不涉及 Key 与标准原文，
     所以不列入 PRIVATE。id 必须真实存在，否则拒绝——避免面板把悬空 id 写进去。 */
  if (msg.type === 'PROFILE_SET_ACTIVE') {
    return reply(P.list().then(function (list) {
      var hit = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === msg.id) { hit = list[i]; break; }
      if (!hit) throw new Error('该判定标准不存在');
      return S.save({ lastProfileId: hit.id }).then(function () {
        return { active: { id: hit.id, name: hit.name, version: hit.version } };
      });
    }), sendResponse);
  }

  /* ---------- 岗位库（v1 已有，保持不变） ---------- */
  if (msg.type === 'SAVE') {
    return reply(JR_DB.save(msg.payload).then(function (record) {
      return { record: record };
    }), sendResponse);
  }

  if (msg.type === 'QUERY_ONE') {
    return reply(JR_DB.getOne(msg.key).then(function (record) {
      return { record: record };
    }), sendResponse);
  }

  if (msg.type === 'QUERY_ALL') {
    return reply(JR_DB.getAll().then(function (list) {
      return { list: list };
    }), sendResponse);
  }

  if (msg.type === 'DELETE') {
    return reply(JR_DB.remove(msg.key).then(function () { return {}; }), sendResponse);
  }

  if (msg.type === 'CLEAR') {
    return reply(JR_DB.clearAll().then(function () { return {}; }), sendResponse);
  }

  /* ---------- 设置 ---------- */
  if (msg.type === 'SETTINGS_GET') {
    return reply(S.get().then(function (s) {
      /* Key 不原样回传内容脚本；popup 自己需要明文编辑，另走 SETTINGS_GET_RAW */
      return { settings: s };
    }), sendResponse);
  }

  if (msg.type === 'SETTINGS_SAVE') {
    return reply(S.save(msg.patch).then(function (s) {
      return { settings: s };
    }), sendResponse);
  }

  if (msg.type === 'SETTINGS_RESET') {
    return reply(S.reset().then(function (s) {
      return { settings: s };
    }), sendResponse);
  }

  /* ---------- 判定标准 ---------- */
  if (msg.type === 'PROFILES_LIST') {
    return reply(P.list().then(function (list) {
      return { list: list };
    }), sendResponse);
  }

  if (msg.type === 'PROFILE_ACTIVE') {
    return reply(P.getActive().then(function (r) {
      return r;
    }), sendResponse);
  }

  if (msg.type === 'PROFILES_SAVE') {
    reply(
      P.save(msg.profile).then(function (rec) {
        /* 第一条标准自动生效，省去用户多点一次 */
        return S.get().then(function (cur) {
          if (cur.lastProfileId) return { record: rec };
          return S.save({ lastProfileId: rec.id }).then(function () {
            return { record: rec, activated: true };
          });
        });
      }),
      sendResponse
    );
    return true;
  }

  if (msg.type === 'PROFILES_DELETE') {
    reply(
      P.remove(msg.id).then(function (r) {
        if (!r.removed) return { removed: false, list: r.list };
        return S.get().then(function (cur) {
          /* 删掉的正是当前生效标准 → 回退到剩下的第一条，避免面板拿着悬空 id */
          if (cur.lastProfileId !== msg.id) return { removed: true, list: r.list };
          var nextId = r.list.length ? r.list[0].id : '';
          return S.save({ lastProfileId: nextId }).then(function () {
            return { removed: true, list: r.list, nextActiveId: nextId };
          });
        });
      }),
      sendResponse
    );
    return true;
  }

  /* ---------- 连通性测试 ---------- */
  if (msg.type === 'SETTINGS_TEST') {
    reply(J.testConnection(msg.override), sendResponse);
    return true;
  }

  /* ---------- 用量与统计 ---------- */
  if (msg.type === 'USAGE_GET') {
    var date = msg.date || todayKey();
    return reply(JR_DB.getUsage(date).then(function (u) {
      return { usage: u, date: date };
    }), sendResponse);
  }

  if (msg.type === 'STATS') {
    return reply(Promise.all([
      JR_DB.count(),
      JR_DB.countVerdicts(),
      JR_DB.getUsage(todayKey()),
      P.count()
    ]).then(function (r) {
      return {
        jobs: r[0],
        verdicts: r[1],
        usageToday: r[2],
        profiles: r[3],
        today: todayKey()
      };
    }), sendResponse);
  }

  if (msg.type === 'CLEAR_VERDICTS') {
    return reply(JR_DB.clearVerdicts().then(function () { return {}; }), sendResponse);
  }
});

/* ---------- 判定端口 ----------
 * 为什么用长连接而不是 sendMessage：
 *   1. 流式增量要持续回推，sendMessage 是一次性的；
 *   2. 内容脚本 disconnect 就等于取消，切换岗位时旧请求必须立刻停，
 *      否则 5 秒连切 3 个岗位就是 3 个请求并发烧钱，且先返回的旧结论会盖掉新岗位。
 */
var RETRYABLE = {
  E_TIMEOUT: 1,
  E_NETWORK: 1,
  E_BAD_JSON: 1,
  E_RATE_LIMIT: 1
};

function persistVerdict(v, date) {
  return JR_DB.putVerdict(v).then(function () {
    return JR_DB.bumpUsage(date, {
      calls: 1,
      inTokens: (v.usage && v.usage.in) || 0,
      outTokens: (v.usage && v.usage.out) || 0,
      cost: v.cost || 0
    });
  });
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'jr-judge') return;

  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var closed = false;
  var running = false;

  function post(msg) {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      closed = true;   // 端口已断，后续回推不再尝试
    }
  }

  port.onDisconnect.addListener(function () {
    closed = true;
    if (ctrl) {
      try { ctrl.abort(); } catch (e) { /* noop */ }
    }
  });

  port.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'START' || running) return;
    running = true;

    var lastDelta = 0;

    J.judgeJob({
      jobKey: msg.jobKey,
      fields: msg.fields,
      sources: msg.sources,
      jdText: msg.jdText,
      profileId: msg.profileId,
      signal: ctrl ? ctrl.signal : null,
      onDelta: function (chars) {
        /* 节流：流式块可能几十毫秒一个，直接透传会让面板高频重绘 */
        var now = Date.now();
        if (now - lastDelta < 300) return;
        lastDelta = now;
        post({ type: 'DELTA', chars: chars });
      }
    }).then(function (verdict) {
      post({ type: 'DONE', verdict: verdict });
      return persistVerdict(verdict, todayKey()).catch(function () {
        /* 落库失败不影响这次结论的展示 */
      });
    }).catch(function (e) {
      var code = (e && e.code) || 'E_UNKNOWN';
      post({
        type: 'FAIL',
        code: code,
        error: String((e && e.message) || e || '未知错误'),
        detail: (e && e.detail) || '',
        /* 空内容这一类失败必须带上成因，否则面板和诊断都无法区分
           「模型不说话」和「网关不支持流式」 */
        reason: (e && e.reason) || '',
        finish: (e && e.finish) || '',
        sawEvent: e && e.sawEvent,
        frames: (e && e.frames) || 0,
        streamed: !!(e && e.streamed),
        reasoningChars: (e && e.reasoningChars) || 0,
        usage: (e && e.usage) || null,
        retryable: RETRYABLE[code] === 1
      });
    }).then(function () {
      running = false;
    });
  });
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    console.log('[岗位雷达] 已安装。先在扩展弹窗里配置模型 API 与判定标准。');
  }
});
