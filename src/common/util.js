/* 岗位雷达 · 通用工具
 * 内容脚本与 popup 共用，挂到 window.JR_UTIL。
 * 不依赖任何第三方库。
 */
(function (global) {
  'use strict';

  var CJK = /[\u4e00-\u9fa5]/;

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r/g, '')
      .trim();
  }

  /* 归一化：去掉站点加的高亮标签残留、连续空白、全角括号差异，用于去重比对 */
  function squeeze(s) {
    return clean(s)
      .toLowerCase()
      .replace(/[\s\-_·•|/\\()（）\[\]【】「」,，.。:：]+/g, '');
  }

  /* FNV-1a 双通道，产出短 hash，用于生成记录主键 */
  function hash(str) {
    var s = String(str || '');
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ c, 2246822507) + 0x9e3779b9) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  }

  function isCJK(s) {
    return CJK.test(s);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 词条匹配器
   * - 中文词：允许内部空白差异（"PD 分离" 命中 "PD分离"）
   * - 英文词：加字母数字边界，"RAG" 不会命中 "storage"
   */
  function matcher(term) {
    var t = clean(term);
    if (!t) return null;
    var body = t.split(/\s+/).map(escapeRegExp).join('\\s*');
    var boundary = !isCJK(t);
    var re;
    try {
      re = new RegExp(
        (boundary ? '(?<![A-Za-z0-9])' : '') + body + (boundary ? '(?![A-Za-z0-9])' : ''),
        'i'
      );
    } catch (e) {
      try {
        re = new RegExp(body, 'i');
      } catch (e2) {
        return null;
      }
    }
    return {
      term: t,
      test: function (text) {
        return re.test(text);
      }
    };
  }

  /* 薪资解析：支持 30-60K·15薪 / 20k-40k / 15~25K / 8000-12000元/月 */
  function parseSalary(text) {
    var raw = clean(text);
    var out = { min: null, max: null, unit: '', raw: raw };
    if (!raw) return out;
    var normalized = raw.replace(/[‐‑‒–—−－]/g, '-');

    if (/面议|待定/.test(raw)) {
      out.unit = '面议';
      return out;
    }

    var m = normalized.match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*(k|K|千|万)/);
    if (m) {
      var a = parseFloat(m[1]);
      var b = parseFloat(m[2]);
      var u = m[3].toLowerCase();
      if (u === '万') {
        a *= 10;
        b *= 10;
        out.unit = 'K';
      } else {
        out.unit = 'K';
      }
      out.min = a;
      out.max = b;
      return out;
    }

    m = normalized.match(/(\d+(?:\.\d+)?)\s*(k|K|千)\s*(?:以上|\+)?/);
    if (m) {
      out.min = parseFloat(m[1]);
      out.max = parseFloat(m[1]);
      out.unit = 'K';
      return out;
    }

    m = normalized.match(/(\d{4,6})\s*[-~至]\s*(\d{4,6})\s*元?/);
    if (m) {
      out.min = Math.round(parseFloat(m[1]) / 1000);
      out.max = Math.round(parseFloat(m[2]) / 1000);
      out.unit = 'K';
      return out;
    }

    return out;
  }

  /* 经验要求解析：返回 {min,max}，单位年；应届/不限返回 0 */
  function parseExperience(text) {
    var raw = clean(text);
    var out = { min: null, max: null, raw: raw };
    if (!raw) return out;
    if (/应届|在校|实习|经验不限|不限经验/.test(raw)) {
      out.min = 0;
      out.max = 0;
      return out;
    }
    var m = raw.match(/(\d+)\s*[-~至]\s*(\d+)\s*年/);
    if (m) {
      out.min = parseInt(m[1], 10);
      out.max = parseInt(m[2], 10);
      return out;
    }
    m = raw.match(/(\d+)\s*年(?:以上|\+)?/);
    if (m) {
      out.min = parseInt(m[1], 10);
      out.max = null;
      return out;
    }
    return out;
  }

  function daysBetween(tsFrom, tsTo) {
    if (!tsFrom) return 0;
    var to = tsTo || Date.now();
    return Math.max(0, Math.floor((to - tsFrom) / 86400000));
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return fmtDate(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 截断长文本，保留首尾，用于面板预览 */
  function ellipsis(s, n) {
    var t = clean(s);
    if (t.length <= n) return t;
    return t.slice(0, n) + '…';
  }

  function uniq(arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) {
        seen[k] = 1;
        out.push(arr[i]);
      }
    }
    return out;
  }

  global.JR_UTIL = {
    clean: clean,
    squeeze: squeeze,
    hash: hash,
    isCJK: isCJK,
    escapeRegExp: escapeRegExp,
    matcher: matcher,
    parseSalary: parseSalary,
    parseExperience: parseExperience,
    daysBetween: daysBetween,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    clamp: clamp,
    escapeHtml: escapeHtml,
    ellipsis: ellipsis,
    uniq: uniq
  };
})(typeof window !== 'undefined' ? window : globalThis);
