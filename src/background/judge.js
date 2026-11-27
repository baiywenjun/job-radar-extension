/* 岗位雷达 · 模型请求层
 * 只有 service worker 加载本文件。内容脚本永远拿不到 Key，也不发模型请求。
 *
 * S1 阶段只实现「连通性测试」所需的最小请求；
 * 完整判定（流式 SSE、JSON 契约校验、证据核对、档位映射）在 S2 补齐。
 */
(function (global) {
  'use strict';

  var CHAT_PATH = '/chat/completions';
  var ERR_BODY_LIMIT = 300;

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

  /* 发一次 chat/completions。返回已解析的 JSON 与耗时。
     网络异常统一收敛成 E_NETWORK，超时收敛成 E_TIMEOUT。 */
  function chat(opts) {
    var s = opts.settings;
    var url = endpoint(s.baseURL);
    var timeoutMs = Number(s.timeoutMs) || 30000;
    var body = {
      model: s.model,
      messages: opts.messages,
      temperature: opts.temperature == null ? s.temperature : opts.temperature,
      max_tokens: opts.maxTokens || s.maxOutputTokens,
      stream: !!opts.stream
    };
    if (opts.jsonMode && s.jsonModeSupported) {
      body.response_format = { type: 'json_object' };
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var started = Date.now();

    var p = new Promise(function (resolve, reject) {
      if (ctrl) {
        timer = setTimeout(function () {
          try { ctrl.abort(); } catch (e) { /* 已结束 */ }
        }, timeoutMs);
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
        return res.text().then(function (text) {
          if (!res.ok) throw classify(res.status, text);
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            throw jerr('E_BAD_JSON', '模型返回的不是合法 JSON', { detail: clip(text) });
          }
          resolve({ data: data, ms: Date.now() - started });
        });
      }).catch(function (e) {
        if (e && e.code) {
          reject(e);
          return;
        }
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
          reject(jerr('E_TIMEOUT', '模型响应超时（' + Math.round(timeoutMs / 1000) + 's）'));
          return;
        }
        reject(jerr('E_NETWORK', '网络不可达或域名未授权', { detail: clip(e && e.message) }));
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

  global.JR_JUDGE = {
    chat: chat,
    testConnection: testConnection,
    endpoint: endpoint,
    originPattern: originPattern,
    hasPermission: hasPermission,
    classify: classify,
    pickContent: pickContent,
    jerr: jerr,
    CHAT_PATH: CHAT_PATH
  };
})(typeof self !== 'undefined' ? self : globalThis);
