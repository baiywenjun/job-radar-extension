/* 岗位雷达 · 模型请求层
 * 只有 service worker 加载本文件。内容脚本永远拿不到 Key，也不发模型请求。
 *
 * 分三层：
 *   chat()        单次 HTTP 请求。支持非流式与 SSE 流式，统一错误码。
 *   attemptOnce() 一次「请求 + 取内容 + 契约校验」，带重试策略。
 *   judgeJob()    一次完整判定：取设置与标准 → 构造提示词 → 重试 → 组装结论。
 *
 * 重试策略（每种最多一次，避免把失败变成烧钱）：
 *   400 且提到 response_format → 去掉 json_object 重试，并把能力标记写回设置
 *   400 且提到 stream_options  → 去掉该字段重试
 *   E_BAD_JSON                 → 降级为非流式 + 去 json 模式重试一次
 */
(function (global) {
  'use strict';

  var CHAT_PATH = '/chat/completions';
  var ERR_BODY_LIMIT = 300;
  var CHARS_PER_TOKEN = 1.6;   // 中英混排的粗估，仅在接口不回 usage 时兜底

  function jerr(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }

  function merge(a, b) {
    var out = {};
    var k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }

  function endpoint(baseURL) {
    return global.JR_SETTINGS.normalizeBaseURL(baseURL) + CHAT_PATH;
  }

  function originPattern(baseURL) {
    var o = global.JR_SETTINGS.originOf(baseURL);
    return o ? o + '/*' : '';
  }

  function hasHost() {
    return !!(global.chrome && global.chrome.permissions && global.chrome.permissions.contains);
  }

  /* 域名授权探测。自定义 baseURL 需要在 popup 里由用户手势触发 request，
     service worker 里只能查，不能申请（会报 must be called during a user gesture）。 */
  function hasPermission(baseURL) {
    var pattern = originPattern(baseURL);
    if (!pattern) return Promise.resolve(false);
    if (!hasHost()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      global.chrome.permissions.contains({ origins: [pattern] }, function (ok) {
        resolve(!!ok && !(global.chrome.runtime && global.chrome.runtime.lastError));
      });
    });
  }

  function clip(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > ERR_BODY_LIMIT ? s.slice(0, ERR_BODY_LIMIT) + '…' : s;
  }

  /* HTTP 状态 → 稳定错误码。文案与 docs/PLAN-01 §4.4 一一对应。 */
  function classify(status, bodyText) {
    if (status === 401 || status === 403) {
      return jerr('E_AUTH', 'API Key 无效或权限不足', { status: status, detail: clip(bodyText) });
    }
    if (status === 404) {
      return jerr('E_NOT_FOUND', '模型名或 baseURL 不对', { status: status, detail: clip(bodyText) });
    }
    if (status === 429) {
      return jerr('E_RATE_LIMIT', '触发限流', { status: status, detail: clip(bodyText) });
    }
    if (status === 400) {
      return jerr('E_BAD_REQUEST', '请求被拒绝', { status: status, detail: clip(bodyText) });
    }
    return jerr('E_HTTP', '模型接口返回 ' + status, { status: status, detail: clip(bodyText) });
  }

  /* ---------- SSE 流式解析 ----------
   * 逐块读、按空行切帧、只认 data: 行。三类真实情况都要能处理：
   *   1. 标准 SSE（DeepSeek / OpenAI）
   *   2. 一个 JSON 被拆在两个 chunk 之间
   *   3. 网关无视 stream 参数，直接返回完整 JSON
   */
  function readSSE(stream, onDelta) {
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var raw = '';
    var content = '';
    var usage = null;
    var model = '';
    var finish = '';
    var sawEvent = false;

    function handleFrame(frame) {
      var lines = String(frame).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!ln) continue;
        var p = ln.indexOf(':');
        if (p < 0) continue;
        if (ln.slice(0, p).trim() !== 'data') continue;
        var payload = ln.slice(p + 1).trim();
        if (!payload || payload === '[DONE]') continue;

        var obj;
        try {
          obj = JSON.parse(payload);
        } catch (e) {
          continue;   // 心跳、注释行、半帧残留都跳过
        }
        sawEvent = true;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;

        var ch = obj.choices && obj.choices[0];
        if (!ch) continue;
        if (ch.delta && typeof ch.delta.content === 'string' && ch.delta.content) {
          content += ch.delta.content;
          if (onDelta) onDelta(content.length);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          buf += decoder.decode();
          if (buf.trim()) handleFrame(buf);
          return finishUp();
        }
        var piece = decoder.decode(r.value, { stream: true });
        raw += piece;
        buf += piece;
        var parts = buf.split('\n\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) handleFrame(parts[i]);
        return pump();
      });
    }

    function finishUp() {
      /* 网关忽略 stream 时，raw 是一整个 JSON 而不是 SSE */
      if (!sawEvent && raw.trim().charAt(0) === '{') {
        try {
          var env = JSON.parse(raw);
          var ch = env.choices && env.choices[0];
          if (ch && ch.message && typeof ch.message.content === 'string') {
            content = ch.message.content;
            if (env.model) model = env.model;
            if (env.usage) usage = env.usage;
            if (ch.finish_reason) finish = ch.finish_reason;
          }
        } catch (e) { /* 不是完整 JSON，交给上层报 E_BAD_JSON */ }
      }
      return { content: content, usage: usage, model: model, finish: finish, sawEvent: sawEvent, raw: raw };
    }

    return pump();
  }

  /* 发一次 chat/completions。
     opts.signal 用于「切换岗位即取消」；超时用独立的 AbortController，
     两者要能区分：外部取消不该显示成"超时"。 */
  function chat(opts) {
    var s = opts.settings;
    var url = endpoint(s.baseURL);
    var timeoutMs = Number(s.timeoutMs) || 30000;
    var streaming = !!opts.stream;
    var body = {
      model: s.model,
      messages: opts.messages,
      temperature: opts.temperature == null ? s.temperature : opts.temperature,
      max_tokens: opts.maxTokens || s.maxOutputTokens,
      stream: streaming
    };
    if (streaming && opts.streamUsage !== false) {
      /* 不加这个，流式响应就不会带 usage，成本统计只能靠估算 */
      body.stream_options = { include_usage: true };
    }
    if (opts.jsonMode && s.jsonModeSupported) {
      body.response_format = { type: 'json_object' };
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var started = Date.now();
    var timedOut = false;
    var aborted = false;
    var external = opts.signal;

    var p = new Promise(function (resolve, reject) {
      if (ctrl) {
        timer = setTimeout(function () {
          timedOut = true;
          try { ctrl.abort(); } catch (e) { /* 已结束 */ }
        }, timeoutMs);
      }

      if (external) {
        if (external.aborted) {
          aborted = true;
          if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } }
        } else {
          external.addEventListener('abort', function () {
            aborted = true;
            if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } }
          });
        }
      }

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + s.apiKey
        },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (text) {
            throw classify(res.status, text);
          });
        }

        if (streaming && res.body && typeof res.body.getReader === 'function') {
          return readSSE(res.body, opts.onDelta).then(function (out) {
            resolve({
              data: {
                model: out.model,
                choices: [{ message: { content: out.content }, finish_reason: out.finish }],
                usage: out.usage
              },
              ms: Date.now() - started,
              streamed: true,
              raw: out.raw
            });
          });
        }

        return res.text().then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            throw jerr('E_BAD_JSON', '模型返回的不是合法 JSON', { detail: clip(text) });
          }
          resolve({ data: data, ms: Date.now() - started, streamed: false });
        });
      }).catch(function (e) {
        if (e && e.code) {
          reject(e);
          return;
        }
        var msg = String((e && e.message) || '');
        if (aborted || (e && e.name === 'AbortError') || /abort/i.test(msg)) {
          if (aborted && !timedOut) {
            reject(jerr('E_ABORT', '判定已取消'));
            return;
          }
          reject(jerr('E_TIMEOUT', '模型响应超时（' + Math.round(timeoutMs / 1000) + 's）'));
          return;
        }
        reject(jerr('E_NETWORK', '网络不可达或域名未授权', { detail: clip(msg) }));
      });
    });

    return p.then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  function pickContent(data) {
    var ch = data && data.choices && data.choices[0];
    if (!ch) return '';
    if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
    if (typeof ch.text === 'string') return ch.text;
    return '';
  }

  /* 测试连接：发一个极小的真实请求，验证 Key、模型名、baseURL 三者都通。
     刻意不走缓存、不计入用量——这是配置动作，不是判定动作。 */
  function testConnection(override) {
    return global.JR_SETTINGS.get().then(function (cur) {
      var s = merge(cur, override || {});
      s.baseURL = global.JR_SETTINGS.normalizeBaseURL(s.baseURL);

      if (!s.baseURL) return Promise.reject(jerr('E_NO_URL', '请先填 baseURL'));
      if (!s.apiKey) return Promise.reject(jerr('E_NO_KEY', '请先填 API Key'));

      return hasPermission(s.baseURL).then(function (ok) {
        if (!ok) {
          return Promise.reject(jerr(
            'E_NO_PERM',
            '未授权访问 ' + global.JR_SETTINGS.originOf(s.baseURL) + '，请重新点一次「测试连接」并在弹窗里允许',
            { origin: global.JR_SETTINGS.originOf(s.baseURL) }
          ));
        }

        return chat({
          settings: s,
          messages: [
            { role: 'system', content: '你是连通性测试助手。' },
            { role: 'user', content: '只回复：ok' }
          ],
          maxTokens: 8,
          stream: false
        }).then(function (r) {
          var content = pickContent(r.data);
          if (!r.data || !r.data.choices) {
            throw jerr('E_BAD_JSON', '返回结构异常：缺少 choices', { detail: clip(JSON.stringify(r.data)) });
          }
          return {
            ok: true,
            model: (r.data && r.data.model) || s.model,
            ms: r.ms,
            reply: clip(content),
            usage: {
              in: (r.data.usage && r.data.usage.prompt_tokens) || 0,
              out: (r.data.usage && r.data.usage.completion_tokens) || 0
            }
          };
        });
      });
    });
  }

  function normalizeUsage(raw, content, promptChars) {
    var u = raw || {};
    var pin = Number(u.prompt_tokens) || 0;
    var pout = Number(u.completion_tokens) || 0;
    var estimated = false;
    if (!pin && !pout) {
      estimated = true;
      pin = Math.ceil((promptChars || 0) / CHARS_PER_TOKEN);
      pout = Math.ceil(String(content || '').length / CHARS_PER_TOKEN);
    }
    return { in: pin, out: pout, total: pin + pout, estimated: estimated };
  }

  function estimateCost(settings, usage) {
    var pin = Number(settings.priceInPerM) || 0;
    var pout = Number(settings.priceOutPerM) || 0;
    var u = usage || {};
    var c = (u.in || 0) / 1e6 * pin + (u.out || 0) / 1e6 * pout;
    return Math.round(c * 1e6) / 1e6;
  }

  function promptChars(messages) {
    var n = 0;
    (messages || []).forEach(function (m) { n += String(m.content || '').length; });
    return n;
  }

  /* 一次「请求 + 取内容 + 契约校验」。重试策略在外层。 */
  function attemptOnce(ctx, cfg) {
    var V = global.JR_VERDICT;
    return chat({
      settings: ctx.settings,
      messages: ctx.messages,
      stream: cfg.stream,
      streamUsage: cfg.streamUsage,
      jsonMode: cfg.jsonMode,
      onDelta: ctx.onDelta,
      signal: ctx.signal,
      maxTokens: ctx.settings.maxOutputTokens
    }).then(function (r) {
      var content = pickContent(r.data);
      var ch = r.data && r.data.choices && r.data.choices[0];
      var finish = (ch && ch.finish_reason) || '';

      if (!content) {
        throw jerr('E_BAD_JSON', '模型未返回内容', { reason: 'empty' });
      }

      var v;
      try {
        v = V.parse(content);
      } catch (e) {
        if (finish === 'length') {
          throw jerr('E_BAD_JSON',
            '输出被 maxOutputTokens（' + ctx.settings.maxOutputTokens + '）截断，json 不完整',
            { reason: 'length', detail: clip(content) });
        }
        if (!e.detail) e.detail = clip(content);
        throw e;
      }

      return {
        verdict: v,
        ms: r.ms,
        model: (r.data && r.data.model) || ctx.settings.model,
        usage: normalizeUsage(r.data && r.data.usage, content, promptChars(ctx.messages))
      };
    });
  }

  /* 能力降级要写回设置：不然每次判定都要先撞一次 400 才知道不支持。
     返回 Promise 是为了让调用方等它写完——否则紧接着的断言/下次判定会读到旧值。 */
  function degradeJsonMode() {
    try {
      var S = global.JR_SETTINGS;
      if (S && S.save) {
        var p = S.save({ jsonModeSupported: false });
        return (p && p.then) ? p.then(function () {}, function () {}) : Promise.resolve();
      }
    } catch (e) { /* noop */ }
    return Promise.resolve();
  }

  function runAttempts(ctx) {
    var cfg = {
      jsonMode: ctx.settings.jsonModeSupported !== false,
      stream: !!ctx.settings.stream,
      streamUsage: true
    };
    var parseRetried = false;
    var jsonDegraded = false;

    function step() {
      return attemptOnce(ctx, cfg).catch(function (e) {
        var detail = String((e && e.detail) || '');

        if (e.code === 'E_BAD_REQUEST' && cfg.jsonMode &&
            /response_format|json_object|json mode/i.test(detail)) {
          cfg.jsonMode = false;
          if (!jsonDegraded) {
            jsonDegraded = true;
            return degradeJsonMode().then(step);
          }
          return step();
        }

        if (e.code === 'E_BAD_REQUEST' && cfg.streamUsage &&
            /stream_options|include_usage/i.test(detail)) {
          cfg.streamUsage = false;
          return step();
        }

        /* 格式类失败只再试一次，且换成最保守的组合：非流式 + 不带 json 模式 */
        if (e.code === 'E_BAD_JSON' && !parseRetried) {
          parseRetried = true;
          cfg.stream = false;
          cfg.jsonMode = false;
          return step();
        }

        throw e;
      });
    }

    return step();
  }

  /* 完整判定。input:
   *   { jobKey, fields, sources, jdText, profileId, onDelta, signal }
   * 返回带元信息的 verdict（档位、分数、证据、模型、token、耗时、jdHash）。 */
  function judgeJob(input) {
    input = input || {};
    var S = global.JR_SETTINGS;
    var P = global.JR_PROFILES;
    var PR = global.JR_PROMPT;
    var V = global.JR_VERDICT;

    if (!PR || !V) {
      return Promise.reject(jerr('E_INTERNAL', '提示词或结论模块未加载'));
    }

    return Promise.all([S.get(), P.list()]).then(function (r) {
      var settings = r[0];
      var list = r[1] || [];

      var wantId = input.profileId || settings.lastProfileId;
      var profile = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === wantId) { profile = list[i]; break; }
      if (!profile && list.length) profile = list[0];

      if (!profile) {
        return Promise.reject(jerr('E_NO_PROFILE', '还没有判定标准，请先在扩展弹窗里新建一条'));
      }
      if (!settings.apiKey) {
        return Promise.reject(jerr('E_NO_KEY', '未配置模型 API'));
      }

      return hasPermission(settings.baseURL).then(function (ok) {
        if (!ok) {
          return Promise.reject(jerr(
            'E_NO_PERM',
            '未授权访问 ' + global.JR_SETTINGS.originOf(settings.baseURL),
            { origin: global.JR_SETTINGS.originOf(settings.baseURL) }
          ));
        }

        var fields = input.fields || {};
        var messages = PR.buildMessages({
          profile: profile,
          fields: fields,
          sources: input.sources || fields.sources || {},
          jdText: input.jdText
        });

        return runAttempts({
          settings: settings,
          messages: messages,
          onDelta: input.onDelta,
          signal: input.signal
        }).then(function (out) {
          var v = out.verdict;
          v.jobKey = input.jobKey || '';
          v.profileId = profile.id;
          v.profileName = profile.name;
          v.profileVersion = profile.version || 1;
          v.promptVersion = PR.PROMPT_VERSION;
          v.model = out.model || settings.model;
          v.jdHash = PR.jdHash(input.jdText);
          v.createdAt = Date.now();
          v.source = 'model';
          v.ms = out.ms;
          v.usage = out.usage;
          v.cost = estimateCost(settings, out.usage);
          return v;
        });
      });
    });
  }

  global.JR_JUDGE = {
    chat: chat,
    testConnection: testConnection,
    judgeJob: judgeJob,
    readSSE: readSSE,
    normalizeUsage: normalizeUsage,
    estimateCost: estimateCost,
    endpoint: endpoint,
    originPattern: originPattern,
    hasPermission: hasPermission,
    classify: classify,
    pickContent: pickContent,
    jerr: jerr,
    CHAT_PATH: CHAT_PATH
  };
})(typeof self !== 'undefined' ? self : globalThis);
