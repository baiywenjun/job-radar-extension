/* 岗位雷达 · 页面诊断
 *
 * 存在的理由：BOSS 直聘会拦截 F12 / 右键检查，用户没法自己取 class 回来。
 * 于是把「插件到底看到了什么」在页面内打包成一段可复制的文本：
 * 选择器命中情况、JD 锚点位置、详情列几何范围、右半页 DOM 骨架、全页大字号元素。
 * 用户只需点一下「复制诊断」，粘给维护者即可完成一次远程校准，不需要开发者工具。
 *
 * 只读当前页面已有的 DOM，不发起任何请求、不采集他人信息、不落库。
 */
(function (global) {
  'use strict';

  var U = global.JR_UTIL;
  var E = global.JR_EXTRACT;

  var SKIP_TAG = /^(SCRIPT|STYLE|SVG|PATH|NOSCRIPT|LINK|META|IFRAME|CANVAS|IMG|INPUT|TEXTAREA)$/;
  var HOST_ID = 'jr-radar-host';

  function doc() {
    return global.document || (typeof document !== 'undefined' ? document : null);
  }

  function clean(s) {
    return U ? U.clean(s) : String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function cut(s, n) {
    var t = clean(s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function q(v) {
    return v ? '"' + cut(v, 40) + '"' : '（空）';
  }

  function sig(el) {
    if (!el || el.nodeType !== 1) return '?';
    var s = el.tagName.toLowerCase();
    var cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
    if (el.id) s = '#' + el.id + ' ' + s;
    return s;
  }

  function box(el) {
    var r = E && E.rectOf ? E.rectOf(el) : null;
    if (!r || !r.width) return '';
    return '@' + Math.round(r.left) + ',' + Math.round(r.top) +
      ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
  }

  function fsOf(el) {
    return E && E.fontPx ? Math.round(E.fontPx(el)) : 0;
  }

  /* ---- DOM 骨架：保留标签/类名/短文本，压缩到可粘贴的体量 ---- */
  function skeleton(root, maxDepth, budget) {
    var state = { n: 0, lines: [] };

    function walk(el, depth) {
      if (!el || state.n >= budget || depth > maxDepth) return;
      if (el.nodeType !== 1 || SKIP_TAG.test(el.tagName)) return;
      if (el.id === HOST_ID) return;

      var own = [];
      var kids = [];
      for (var i = 0; i < el.childNodes.length; i++) {
        var c = el.childNodes[i];
        if (c.nodeType === 3) {
          var t = clean(c.nodeValue);
          if (t) own.push(t);
        } else if (c.nodeType === 1) {
          kids.push(c);
        }
      }
      // 子树完全没文本的节点不打印，避免一堆空壳占满预算
      if (!own.length && !clean(el.textContent)) return;

      state.n++;
      var attrs = [];
      var fs = fsOf(el);
      if (fs >= 15) attrs.push('fs=' + fs);
      var b = box(el);
      if (b) attrs.push(b);

      var label = cut(own.join(' / '), 40);
      state.lines.push(
        pad(depth) + sig(el) +
        (attrs.length ? ' [' + attrs.join(' ') + ']' : '') +
        (label ? ' ' + label : '')
      );
      for (var j = 0; j < kids.length; j++) walk(kids[j], depth + 1);
    }

    walk(root, 0);
    return state.lines.join('\n');
  }

  function pad(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '  ';
    return s;
  }

  /* ---- 选择器命中：告诉我哪一条还有效、哪一条已经死了 ---- */
  function selectorTable(adapter) {
    var d = doc();
    var out = [];
    if (!adapter || !adapter.selectors) return out;
    var keys = ['jobTitle', 'company', 'salary', 'meta', 'active', 'jd'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var list = adapter.selectors[k] || [];
      out.push(k + ':');
      for (var j = 0; j < list.length; j++) {
        var sel = list[j];
        var n = 0;
        var sample = '';
        try {
          var els = d.querySelectorAll(sel);
          n = els.length;
          if (n) {
            var el = els[0];
            sample = ' ' + q(el.textContent) + ' fs=' + fsOf(el);
          }
        } catch (e) {
          sample = ' 选择器语法错误';
        }
        out.push('  ' + sel + ' → ' + n + sample);
      }
    }
    return out;
  }

  /* ---- 全页大字号元素：详情列判定失败时的最后线索 ---- */
  function bigTexts() {
    var d = doc();
    if (!d || !d.body) return [];
    var els = d.body.querySelectorAll('*');
    var limit = Math.min(els.length, 4000);
    var found = [];
    for (var i = 0; i < limit; i++) {
      var el = els[i];
      if (el.children.length > 1) continue;
      if (el.id === HOST_ID) continue;
      var fs = fsOf(el);
      if (fs < 16) continue;
      var t = clean(el.textContent);
      if (!t || t.length > 40) continue;
      found.push({ fs: fs, t: t, el: el });
    }
    found.sort(function (a, b) { return b.fs - a.fs; });
    return found.slice(0, 12).map(function (x) {
      return '  ' + x.fs + 'px ' + q(x.t) + ' ← ' +
        (E && E.pathOf ? E.pathOf(x.el, 3) : sig(x.el)) + ' ' + box(x.el);
    });
  }

  function glyphSamples() {
    var d = doc();
    if (!d || !d.body) return [];
    var els = d.body.querySelectorAll('*');
    var found = [];
    var limit = Math.min(els.length, 5000);
    for (var i = 0; i < limit; i++) {
      var el = els[i];
      if (el.id === HOST_ID || (el.closest && el.closest('#' + HOST_ID))) continue;
      if (el.children.length > 1) continue;
      var t = clean(el.textContent);
      if (t.length < 2 || t.length > 32) continue;
      if (!/[\uE000-\uF8FF\uFFFD]|[Kk](?:[·・]\d+薪)?$/.test(t)) continue;
      var r = E && E.rectOf ? E.rectOf(el) : null;
      if (!r || r.width < 1) continue;
      var family = '';
      try { family = getComputedStyle(el).fontFamily || ''; } catch (e) { /* 无布局环境 */ }
      var codes = Array.from(t.slice(0, 24)).map(function (c) {
        return 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      }).join(' ');
      var attrs = ['aria-label', 'title', 'data-salary', 'data-pay', 'data-value']
        .map(function (name) {
          var value = el.getAttribute(name);
          return value ? name + '=' + q(value) : '';
        }).filter(Boolean).join(' ');
      found.push({
        right: r.left >= (global.innerWidth || 1400) * 0.35,
        top: r.top,
        line: '  ' + q(t) + ' [' + codes + '] font=' + cut(family, 70) + ' ' +
          (E && E.pathOf ? E.pathOf(el, 4) : sig(el)) + ' ' + box(el) +
          (attrs ? ' ' + attrs : '')
      });
    }
    found.sort(function (a, b) { return Number(b.right) - Number(a.right) || a.top - b.top; });
    return found.slice(0, 20).map(function (x) { return x.line; });
  }

  /* 模型侧的失败详情。内容脚本看不到 service worker 的网络面板，
     这段文本是用户唯一能把「模型到底回了什么」带出来的通道。 */
  var REASON_TEXT = {
    thinking: '模型只输出了思考过程，正文为空（多见思考型模型 + 输出上限太小）',
    length: '正文被 maxOutputTokens 截断，未写出结论',
    'no-frames': '流式请求一帧数据都没收到（网关可能不支持 SSE，或返回了包装层）',
    empty: '接口返回正常，但正文确实为空'
  };

  function judgeSection() {
    var d = global.__jrJudgeDiag;
    if (!d) return ['【模型判定】', '  本次未触发模型判定（可能未配置 Key / 标准，或仍在等待）'];
    if (d.status !== 'failed') {
      return ['【模型判定】', '  状态: ' + d.status];
    }
    var out = ['【模型判定】'];
    out.push('  状态: 失败');
    out.push('  时间: ' + (d.at || '—'));
    out.push('  模型: ' + (d.model || '—') + ' @ ' + (d.baseOrigin || '—'));
    out.push('  错误码: ' + (d.code || '—'));
    out.push('  说明: ' + (d.error || '—'));
    if (d.reason) {
      out.push('  成因: ' + d.reason + ' —— ' + (REASON_TEXT[d.reason] || '未分类'));
    }
    out.push('  传输: ' + (d.streamed ? '流式' : '非流式') +
      ' · sawEvent=' + String(d.sawEvent) +
      ' · 数据帧=' + (d.frames || 0) +
      ' · finish=' + (d.finish || '—') +
      ' · 思考字数=' + (d.reasoningChars || 0));
    if (d.usage) {
      out.push('  usage: in ' + (d.usage.prompt_tokens || 0) +
        ' / out ' + (d.usage.completion_tokens || 0));
    }
    if (d.attempts && d.attempts.length) {
      /* 重试链是定位「第一次为什么失败」的唯一线索：
         最终报错往往只是最后一次的，而最早的成因才决定要不要改配置。 */
      out.push('  尝试链:');
      d.attempts.forEach(function (a, i) {
        var bits = [(a.stream ? '流式' : '非流式'), 'max=' + a.maxTokens];
        bits.push(a.ok ? '成功' : (a.code + (a.reason ? '/' + a.reason : '')));
        bits.push((a.ms || 0) + 'ms');
        out.push('    #' + (i + 1) + ' ' + bits.join(' · '));
      });
    }
    if (d.detail) out.push('  原始片段: ' + cut(d.detail, 280));
    return out;
  }

  function report(adapter) {
    var d = doc();
    var lines = [];
    lines.push('=== 岗位雷达 · 页面诊断 ===');
    lines.push('时间: ' + new Date().toISOString());
    lines.push('URL: ' + (global.location ? global.location.href : '—'));
    lines.push('标题: ' + (d ? d.title : '—'));
    lines.push('适配器: ' + (adapter ? adapter.id + ' / ' + adapter.name : '未匹配'));
    lines.push('视口: ' + (global.innerWidth || 0) + 'x' + (global.innerHeight || 0));
    lines.push('');

    var f = null;
    var err = '';
    try {
      f = E.extract(adapter);
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    lines.push('【抽取结果】');
    if (err) {
      lines.push('  extract() 抛错: ' + err);
    } else if (!f) {
      lines.push('  null（连 JD 都没拿到）');
    } else {
      lines.push('  职位=' + q(f.jobTitle) + ' 公司=' + q(f.company) +
        ' 薪资=' + q(f.salaryText) + ' 城市=' + q(f.city) +
        ' 经验=' + q(f.experienceText) + ' 学历=' + q(f.educationText));
      lines.push('  JD ' + f.jdText.length + ' 字');
      lines.push('  来源: ' + JSON.stringify(f.sources));
    }
    lines.push('');
    lines.push.apply(lines, judgeSection());
    lines.push('');

    lines.push('【选择器命中】');
    lines.push.apply(lines, selectorTable(adapter));
    lines.push('');

    lines.push('【JD 锚点】');
    var anchor = E.findJdAnchor ? E.findJdAnchor() : null;
    if (anchor) {
      lines.push('  ' + (E.pathOf ? E.pathOf(anchor, 5) : sig(anchor)) +
        ' ' + box(anchor) + ' 文本 ' + clean(anchor.textContent).length + ' 字');
    } else {
      lines.push('  未找到（页面里没有「职位描述 / 岗位职责 / 任职要求」这类锚点文本）');
    }

    var pane = anchor && E.findDetailPane ? E.findDetailPane(anchor) : null;
    lines.push('【详情列】' + (pane ? ' ' + (E.pathOf ? E.pathOf(pane, 5) : sig(pane)) + ' ' + box(pane)
      : ' 未判定出（可能没有布局信息，或 JD 锚点为空）'));
    lines.push('');

    if (pane) {
      lines.push('【详情列结构骨架（文本截断 40 字）】');
      lines.push(skeleton(pane, 7, 260));
    } else if (d && d.body) {
      lines.push('【页面结构骨架（仅前 3 层）】');
      lines.push(skeleton(d.body, 3, 160));
    }
    lines.push('');

    var big = bigTexts();
    if (big.length) {
      lines.push('【全页大字号元素 top 12】');
      lines.push.apply(lines, big);
      lines.push('');
    }

    var glyphs = glyphSamples();
    if (glyphs.length) {
      lines.push('【薪资字形线索（字符码 / 字体 / 属性）】');
      lines.push.apply(lines, glyphs);
      lines.push('');
    }

    lines.push('=== 诊断结束 ===');
    return lines.join('\n');
  }

  global.JR_DIAGNOSE = {
    report: report,
    skeleton: skeleton
  };
})(typeof window !== 'undefined' ? window : globalThis);
