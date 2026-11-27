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
  /* 429 之后多久不再自动请求。限流通常按分钟窗口恢复，
     5 分钟既能覆盖多数窗口，又不至于让用户等到失去耐心。 */
  var COOLDOWN_MS = 5 * 60 * 1000;

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* 与 usage 存储的 date 主键一致，跨 service worker 休眠也不能变 */
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function monthKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function jerr(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    /* 业务错误的标记。DOMException 也有数字 code（ABORT_ERR=20），
       只判 e.code 存在会把 abort 当成业务错误直接抛给上层，
       结果面板上出现「错误码 20 / signal is aborted without reason」。 */
    e.jr = true;
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
  function readSSE(stream, onDelta, onActivity) {
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var raw = '';
    var content = '';
    var reasoning = '';
    var usage = null;
    var model = '';
    var finish = '';
    var sawEvent = false;
    var frames = 0;

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
        frames++;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;

        var ch = obj.choices && obj.choices[0];
        if (!ch) continue;
        /* 思考型模型（deepseek-reasoner / 部分网关的思考模式）先吐 reasoning_content，
           正文在 content。只认 content 会把「思考吃光预算」误判成「模型没说话」。 */
        if (ch.delta) {
          if (typeof ch.delta.reasoning_content === 'string' && ch.delta.reasoning_content) {
            reasoning += ch.delta.reasoning_content;
          } else if (typeof ch.delta.reasoning === 'string' && ch.delta.reasoning) {
            reasoning += ch.delta.reasoning;
          }
        }
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
        /* 有数据在流动就说明没卡死，重新计空闲超时 */
        if (onActivity) onActivity();
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
            if (typeof ch.message.reasoning_content === 'string') {
              reasoning = ch.message.reasoning_content;
            }
          }
        } catch (e) { /* 不是完整 JSON，交给上层报 E_BAD_JSON */ }
      }
      return {
        content: content,
        reasoning: reasoning,
        usage: usage,
        model: model,
        finish: finish,
        sawEvent: sawEvent,
        frames: frames,
        raw: raw
      };
    }

    return pump();
  }

  /* 发一次 chat/completions。
     opts.signal   用于「切换岗位即取消」；超时用独立的 AbortController，两者要能区分。
     opts.timeoutMs 覆盖设置里的超时（重试时放宽用）。
     流式响应用「空闲超时」：每收到一块数据就重新计时。整体超时会把
     正常的慢速长输出误杀——思考型模型写满 4096 tokens 常常超过 30 秒。 */
  function chat(opts) {
    var s = opts.settings;
    var url = endpoint(s.baseURL);
    var timeoutMs = Number(opts.timeoutMs != null ? opts.timeoutMs : s.timeoutMs) || 30000;
    /* 非流式请求是「一次性等完」，没有数据流动可依，必须给足时间；
       老版本默认 30s 会稳定杀掉思考型模型的长输出。 */
    if (opts.minTimeoutMs) timeoutMs = Math.max(timeoutMs, Number(opts.minTimeoutMs) || 0);
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

    function armTimer() {
      if (!ctrl) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timedOut = true;
        try { ctrl.abort(); } catch (e) { /* 已结束 */ }
      }, timeoutMs);
    }

    var p = new Promise(function (resolve, reject) {
      armTimer();

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
          return readSSE(res.body, opts.onDelta, armTimer).then(function (out) {
            resolve({
              data: {
                model: out.model,
                choices: [{
                  message: { content: out.content, reasoning_content: out.reasoning },
                  finish_reason: out.finish
                }],
                usage: out.usage,
                _jr: { sawEvent: out.sawEvent, frames: out.frames, raw: clip(out.raw) }
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
        /* 只放行我们自己造的错（e.jr）。DOMException 也带数字 code
           （ABORT_ERR=20），按 e.code 真值判断会把 abort 原样抛给上层，
           面板就显示成「错误码 20 / signal is aborted without reason」。 */
        if (e && e.jr) {
          reject(e);
          return;
        }
        var msg = String((e && e.message) || '');
        if (aborted || timedOut || (e && e.name === 'AbortError') || /abort/i.test(msg)) {
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

  /* 正文之外的「思考内容」。只用于判断空内容的原因，不进结论、不展示。 */
  function pickReasoning(data) {
    var ch = data && data.choices && data.choices[0];
    if (!ch || !ch.message) return '';
    if (typeof ch.message.reasoning_content === 'string') return ch.message.reasoning_content;
    if (typeof ch.message.reasoning === 'string') return ch.message.reasoning;
    return '';
  }

  /* 空内容有四种成因，处理方式和用户该做的事完全不同，不能合并成一句话：
   *   thinking  — 思考型模型把输出预算用在 reasoning 上，正文还没开始就结束了
   *   length    — 正文写到一半被 max_tokens 截断（json 不完整，但至少非空）
   *   no-frames — 流式请求一帧数据都没收到（网关不支持 SSE，或返回了包装层）
   *   empty     — 接口正常但正文确实为空
   */
  var EMPTY_TEXT = {
    thinking: '模型只输出了思考过程，没写出结论',
    length: '输出被 maxOutputTokens 截断，未写出结论',
    'no-frames': '接口未返回任何流式数据帧',
    empty: '模型返回了空内容'
  };

  function emptyInfo(r) {
    var data = (r && r.data) || {};
    var ch = data.choices && data.choices[0];
    var finish = (ch && ch.finish_reason) || '';
    var reasoning = pickReasoning(data);
    var meta = data._jr || {};
    var streamed = !!(r && r.streamed);

    var reason = 'empty';
    if (reasoning) reason = 'thinking';
    else if (finish === 'length') reason = 'length';
    else if (streamed && meta.sawEvent === false) reason = 'no-frames';

    return {
      reason: reason,
      finish: finish,
      sawEvent: streamed ? meta.sawEvent !== false : true,
      frames: meta.frames || 0,
      streamed: streamed,
      reasoningChars: reasoning.length,
      usage: data.usage || null,
      detail: clip(reasoning || meta.raw || JSON.stringify(data))
    };
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
      timeoutMs: cfg.timeoutMs,
      minTimeoutMs: cfg.stream ? 0 : 45000,
      maxTokens: cfg.maxTokens || ctx.settings.maxOutputTokens
    }).then(function (r) {
      var content = pickContent(r.data);
      var ch = r.data && r.data.choices && r.data.choices[0];
      var finish = (ch && ch.finish_reason) || '';

      if (!content) {
        /* 单独一个错误码：空内容的修法与「json 格式错」不同
           （要放大输出预算并改用非流式），不能混进 E_BAD_JSON 的重试分支。 */
        var info = emptyInfo(r);
        var e = jerr('E_EMPTY', EMPTY_TEXT[info.reason] || EMPTY_TEXT.empty, info);
        throw e;
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
      streamUsage: true,
      timeoutMs: Number(ctx.settings.timeoutMs) || 30000
    };
    var parseRetried = false;
    var emptyRetried = false;
    var emptyFirst = null;
    var jsonDegraded = false;
    var attempts = [];

    function snap() {
      return {
        stream: !!cfg.stream,
        maxTokens: cfg.maxTokens || ctx.settings.maxOutputTokens,
        timeoutMs: cfg.timeoutMs
      };
    }

    function fail(e) {
      e.attempts = attempts;
      throw e;
    }

    function step() {
      var base = snap();
      var t0 = Date.now();

      return attemptOnce(ctx, cfg).then(function (r) {
        attempts.push({ stream: base.stream, maxTokens: base.maxTokens, ok: true, ms: Date.now() - t0 });
        return r;
      }).catch(function (e) {
        attempts.push({
          stream: base.stream,
          maxTokens: base.maxTokens,
          code: (e && e.code) || 'E_UNKNOWN',
          reason: (e && e.reason) || '',
          ms: Date.now() - t0
        });

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

        /* 空内容：放大输出预算，并按成因决定要不要改传输方式。
           thinking / length 的场景里流式是正常的（有 reasoning 帧在流动），
           改非流式只会更慢、更容易撞超时；只有「一帧都没收到」才需要换非流式。
           超时同时放宽：写满 4096 tokens 的思考模型，30 秒不够。 */
        if (e.code === 'E_EMPTY') {
          if (!emptyRetried) {
            emptyRetried = true;
            /* 保留首次成因：重试后成因往往退化成 "empty"，
               而最早的 no-frames / thinking 才是用户需要看到的线索。 */
            emptyFirst = {
              reason: e.reason,
              detail: e.detail,
              finish: e.finish,
              sawEvent: e.sawEvent,
              frames: e.frames,
              reasoningChars: e.reasoningChars
            };
            if (e.reason === 'no-frames' || e.reason === 'empty' || !e.reason) {
              cfg.stream = false;
            }
            var want = (e.reason === 'thinking' || e.reason === 'length' || e.reason === 'no-frames')
              ? Math.max((Number(ctx.settings.maxOutputTokens) || 1200) * 2, 4096)
              : Math.max((Number(ctx.settings.maxOutputTokens) || 1200) * 2, 1600);
            cfg.maxTokens = Math.min(want, 8192);
            cfg.timeoutMs = Math.max(cfg.timeoutMs, 90000);
            return step();
          }
          if (emptyFirst) {
            e.reason = emptyFirst.reason || e.reason;
            e.detail = emptyFirst.detail || e.detail;
            e.finish = emptyFirst.finish || e.finish;
            e.sawEvent = emptyFirst.sawEvent;
            e.frames = emptyFirst.frames || e.frames;
            e.reasoningChars = emptyFirst.reasoningChars || e.reasoningChars;
            e.message = (EMPTY_TEXT[e.reason] || e.message) +
              '（已放大输出上限至 ' + cfg.maxTokens + ' tokens 重试）';
          } else {
            e.message += '（已放大输出上限至 ' + cfg.maxTokens + ' tokens 重试）';
          }
          fail(e);
        }

        /* 格式类失败只再试一次，且换成最保守的组合：非流式 + 不带 json 模式 */
        if (e.code === 'E_BAD_JSON' && !parseRetried) {
          parseRetried = true;
          cfg.stream = false;
          cfg.jsonMode = false;
          cfg.timeoutMs = Math.max(cfg.timeoutMs, 90000);
          return step();
        }

        fail(e);
      });
    }

    return step();
  }

  /* ---------- 缓存 / 限额 / 冷却 ----------
   * 三者都在「要不要发那次请求」这一层，顺序不能乱：
   *   缓存命中 → 直接回（既省钱又不该被限额拦住）
   *   冷却中   → E_COOLDOWN（连权重都没恢复，发了也是 429）
   *   达上限   → E_LIMIT_DAY（只挡自动判定，用户可手动放行一次）
   *
   * 全部走 global.X 现取而不是模块顶部取：测试里注入的桩要能生效，
   * service worker 也可能因为 importScripts 顺序而晚于本文件就绪。
   */
  function readCache(jobKey, profileId, cacheKey, jdChars, input) {
    var DB = global.JR_DB;
    if (!cacheKey || input.force || input.noCache) return Promise.resolve(null);
    if (!DB || !DB.getVerdict) return Promise.resolve(null);

    return DB.getVerdict(jobKey, profileId).then(function (rec) {
      if (!rec || !rec.grade) return null;
      /* cacheKey 已经含 profileVersion / promptVersion / model / jdHash，
         再比一次 JD 长度：jdHash 只取前 800 字，长 JD 的中段改动它看不出来。 */
      if (rec.cacheKey !== cacheKey) return null;
      if (typeof rec.jdChars === 'number' && rec.jdChars !== jdChars) return null;

      var out = merge(rec, {});
      out.cached = true;
      out.cacheAgeMs = Math.max(0, Date.now() - (Number(rec.createdAt) || 0));
      return out;
    }).catch(function () {
      return null;   // 库读不出来就当没缓存，不阻断判定
    });
  }

  function usedToday() {
    var DB = global.JR_DB;
    if (!DB || !DB.getUsage) return Promise.resolve(0);
    return DB.getUsage(dateKey()).then(function (u) {
      return Number(u && u.calls) || 0;
    }).catch(function () {
      return 0;
    });
  }

  /* 429 之后写一次冷却截止时间。失败不影响抛错——
     最坏情况是用户再撞一次 429，不至于让错误被吞掉。 */
  function armCooldown(e) {
    if (!e || e.code !== 'E_RATE_LIMIT') return Promise.resolve();
    var until = Date.now() + COOLDOWN_MS;
    e.remainMs = COOLDOWN_MS;
    e.rateLimitUntil = until;

    var S = global.JR_SETTINGS;
    try {
      if (!S || !S.save) return Promise.resolve();
      var p = S.save({ rateLimitUntil: until });
      return (p && p.then) ? p.then(function () {}, function () {}) : Promise.resolve();
    } catch (err) {
      return Promise.resolve();
    }
  }

  /* 证据核对 + 组装结论。核验放在这里而不是面板：
     落库的结论必须自带核对结果，缓存命中时才不会重新比一遍（也就不会漂）。 */
  function assembleVerdict(out, ctx) {
    var V = global.JR_VERDICT;
    var PR = global.JR_PROMPT;
    var v = out.verdict;

    v.jobKey = ctx.jobKey;
    v.profileId = ctx.profile.id;
    v.profileName = ctx.profile.name;
    v.profileVersion = ctx.profile.version || 1;
    v.promptVersion = PR.PROMPT_VERSION;
    v.model = out.model || ctx.settings.model;
    v.jdHash = PR.jdHash(ctx.jdText);
    v.jdChars = ctx.jdText.length;
    v.cacheKey = ctx.cacheKey || '';
    v.createdAt = Date.now();
    v.source = 'model';
    v.ms = out.ms;
    v.usage = out.usage;
    v.cost = estimateCost(ctx.settings, out.usage);

    var check = V.verifyEvidence(v, ctx.jdText);
    v.evidenceCheck = {
      checked: check.checked,
      passed: check.passed,
      rate: Math.round(check.rate * 100) / 100
    };

    /* 通过率过低说明模型的"原文引用"大面积是编的，档位本身也可疑。
       不直接丢弃结论（档位仍可能有价值），而是压低置信度并明确标记，
       让面板能把它标红——这比静默接受或静默丢弃都诚实。 */
    var min = typeof V.EVIDENCE_RATE_MIN === 'number' ? V.EVIDENCE_RATE_MIN : 0.5;
    if (check.checked > 0 && check.rate < min) {
      v.evidenceFlag = 'E_BAD_EVIDENCE';
      var c = Number(v.confidence);
      if (!isFinite(c)) c = 0.5;
      v.confidence = Math.round(Math.max(0, Math.min(1, c * 0.75)) * 100) / 100;
      v.score = V.scoreOf(v.grade, v.confidence);
    }

    return v;
  }

  function pickProfile(list, wantId) {
    var i;
    for (i = 0; i < list.length; i++) if (list[i].id === wantId) return list[i];
    return list.length ? list[0] : null;
  }

  /* 完整判定。input:
   *   { jobKey, fields, sources, jdText, profileId, onDelta, signal,
   *     force, allowOverLimit, noCache }
   * 返回带元信息的 verdict（档位、分数、证据、模型、token、耗时、jdHash、
   * cacheKey、evidenceCheck）；命中缓存时额外带 cached / cacheAgeMs。 */
  function judgeJob(input) {
    input = input || {};
    var S = global.JR_SETTINGS;
    var P = global.JR_PROFILES;
    var PR = global.JR_PROMPT;
    var V = global.JR_VERDICT;

    if (!PR || !V) {
      return Promise.reject(jerr('E_INTERNAL', '提示词或结论模块未加载'));
    }

    var jdText = String(input.jdText == null ? '' : input.jdText);
    var jobKey = input.jobKey || '';

    return Promise.all([S.get(), P.list()]).then(function (r) {
      var settings = r[0];
      var profile = pickProfile(r[1] || [], input.profileId || settings.lastProfileId);

      if (!profile) {
        return Promise.reject(jerr('E_NO_PROFILE', '还没有判定标准，请先在扩展弹窗里新建一条'));
      }

      var cacheKey = (jobKey && PR.cacheKey)
        ? PR.cacheKey({ jobKey: jobKey, profile: profile, model: settings.model, jdText: jdText })
        : '';

      return readCache(jobKey, profile.id, cacheKey, jdText.length, input).then(function (hit) {
        if (hit) return hit;

        if (!settings.apiKey) {
          return Promise.reject(jerr('E_NO_KEY', '未配置模型 API'));
        }

        return hasPermission(settings.baseURL).then(function (ok) {
          if (!ok) {
            throw jerr(
              'E_NO_PERM',
              '未授权访问 ' + global.JR_SETTINGS.originOf(settings.baseURL),
              { origin: global.JR_SETTINGS.originOf(settings.baseURL) }
            );
          }

          var now = Date.now();
          if (!input.allowOverLimit && Number(settings.rateLimitUntil) > now) {
            throw jerr('E_COOLDOWN', '触发限流后冷却中，请稍后再试', {
              remainMs: Number(settings.rateLimitUntil) - now,
              rateLimitUntil: Number(settings.rateLimitUntil)
            });
          }

          return usedToday().then(function (used) {
            var limit = Number(settings.dailyLimit);
            if (!input.allowOverLimit && limit > 0 && used >= limit) {
              throw jerr(
                'E_LIMIT_DAY',
                '今日已调用 ' + used + ' 次，达到上限 ' + limit,
                { used: used, limit: limit }
              );
            }

            var messages = PR.buildMessages({
              profile: profile,
              fields: input.fields || {},
              sources: input.sources || (input.fields && input.fields.sources) || {},
              jdText: jdText
            });

            return runAttempts({
              settings: settings,
              messages: messages,
              onDelta: input.onDelta,
              signal: input.signal
            }).then(function (out) {
              return assembleVerdict(out, {
                jobKey: jobKey,
                profile: profile,
                settings: settings,
                jdText: jdText,
                cacheKey: cacheKey
              });
            }, function (e) {
              return armCooldown(e).then(function () { throw e; });
            });
          });
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
    pickReasoning: pickReasoning,
    emptyInfo: emptyInfo,
    dateKey: dateKey,
    monthKey: monthKey,
    EMPTY_TEXT: EMPTY_TEXT,
    COOLDOWN_MS: COOLDOWN_MS,
    jerr: jerr,
    CHAT_PATH: CHAT_PATH
  };
})(typeof self !== 'undefined' ? self : globalThis);
