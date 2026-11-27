/* 岗位雷达 · 字段抽取
 * 三级策略：站点选择器 → 页面标题解析 → 文本启发。
 * 每个字段都回传来源，面板上会显示「选择器 / 标题推断 / 启发式」，抽不到就标灰。
 */
(function (global) {
  'use strict';

  var U = global.JR_UTIL;

  var CITIES = [
    '北京', '上海', '天津', '重庆', '深圳', '广州', '杭州', '成都', '南京', '武汉',
    '西安', '苏州', '长沙', '郑州', '合肥', '青岛', '济南', '厦门', '福州', '无锡',
    '东莞', '佛山', '宁波', '珠海', '大连', '沈阳', '哈尔滨', '昆明', '南昌', '贵阳',
    '南宁', '石家庄', '太原', '长春', '兰州', '海口', '乌鲁木齐', '呼和浩特', '银川',
    '西宁', '拉萨', '香港', '澳门', '台北'
  ];

  /* 数字位：BOSS 会把数字换成私有区字符（U+E031..U+E03A），再用自建字体
     kanzhun-mix 把字形渲染回数字。DOM 里根本没有 \d，所以检测阶段必须两种都认，
     否则「薪资抽不到」会连带把详情区判定也带偏（见 findDetailScope）。 */
  var NUM = '[\\d\\uE031-\\uE03A]';
  var SALARY_RE = new RegExp(
    NUM + '+(?:\\.' + NUM + '+)?\\s*[-~至‐‑‒–—−－]\\s*' +
    NUM + '+(?:\\.' + NUM + '+)?\\s*(?:[Kk]|千|万)(?:\\s*[·・]\\s*\\d+\\s*薪)?'
  );
  var EXP_RE = /(\d+)\s*[-~至]\s*(\d+)\s*年|(\d+)\s*年以上|应届|经验不限|在校/;
  /* 结构推断只认明确年限：JD 正文里常出现「在校」「应届」「经验不限」等描述，
     若用 EXP_RE 去整篇找第一个匹配，会把真实年限覆盖掉。 */
  var EXP_STRICT_RE = /(\d+)\s*[-~至]\s*(\d+)\s*年|(\d+)\s*年以上/;
  var EDU_RE = /(本科|硕士|博士|大专|中专|学历不限|高中)/;

  /* 由城市表构建，供详情区内定位城市文本使用 */
  var CITY_RE = new RegExp(CITIES.join('|'));

  /* 取节点可见文本：innerText 保留段落换行，降级用 textContent */
  function nodeText(el) {
    if (!el) return '';
    var t = '';
    try {
      t = el.innerText || '';
    } catch (e) {
      t = '';
    }
    if (!t) t = el.textContent || '';
    return U.clean(t);
  }

  function pickText(selectors) {
    if (!selectors || !selectors.length) return { text: '', sel: null, el: null };
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try {
        el = document.querySelector(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (!el) continue;
      var t = nodeText(el);
      if (t && t.length >= 2) return { text: t, sel: selectors[i], el: el };
    }
    return { text: '', sel: null, el: null };
  }

  /* 判断元素是否位于列表卡片内：向上 3 层查找，若某层存在 3 个以上同 class 兄弟，
     即认定为列表项。向上查找是必须的——真正的列表容器是卡片，而薪资、职位名
     往往是卡片里的叶子节点，只看自身判不出来。 */
  function looksLikeListItem(el) {
    var cur = el;
    for (var depth = 0; depth < 3 && cur; depth++) {
      var p = cur.parentElement;
      if (!p) break;
      var cls = cur.className;
      if (typeof cls === 'string' && cls) {
        var same = 0;
        for (var i = 0; i < p.children.length; i++) {
          var sib = p.children[i];
          if (typeof sib.className === 'string' && sib.className === cls) {
            same++;
            if (same >= 3) return true;
          }
        }
      }
      cur = p;
    }
    return false;
  }

  /* 只在指定根节点内按选择器抽取。
     必要性：BOSS 搜索结果页是「左列表 + 右侧滑出详情」，同一个类名可能在
     左侧卡片里也有，全文档 querySelector 会抓到列表项而不是当前详情。
     若命中的全是列表项，返回空交给结构推断处理，不退回第一个候选。 */
  function pickIn(root, selectors) {
    if (!root || !selectors || !selectors.length) return { text: '', sel: null, el: null };
    for (var i = 0; i < selectors.length; i++) {
      var els = [];
      try {
        els = root.querySelectorAll(selectors[i]);
      } catch (e) {
        els = [];
      }
      for (var j = 0; j < els.length; j++) {
        var cand = els[j];
        if (looksLikeListItem(cand)) continue;
        var t = nodeText(cand);
        if (!t || t.length < 2) continue;
        return { text: t, sel: selectors[i], el: cand };
      }
    }
    return { text: '', sel: null, el: null };
  }

  function findCity(text) {
    if (!text) return '';
    for (var i = 0; i < CITIES.length; i++) {
      if (text.indexOf(CITIES[i]) !== -1) return CITIES[i];
    }
    return '';
  }

  /* 从页面标题解析：招聘站标题普遍是「职位_公司_薪资_地点-平台名」 */
  function parseDocTitle(docTitle) {
    var raw = U.clean(docTitle);
    var out = { jobTitle: '', company: '', salary: '', city: '', experience: '' };
    if (!raw) return out;

    var s = raw.replace(/[-_—|]\s*(BOSS\s*直聘|BOSS直聘|猎聘网|猎聘|脉脉|国聘|智联招聘|前程无忧|拉勾).*$/i, '');

    var sm = s.match(SALARY_RE);
    if (sm) out.salary = SalClean(sm[0]);

    var em = s.match(EXP_RE);
    if (em) out.experience = em[0];

    out.city = findCity(s);

    // 去掉已识别的片段，剩余按分隔符切分，取职位名与公司名
    var rest = s;
    if (out.salary) rest = rest.split(out.salary).join(' ');
    if (out.experience) rest = rest.split(out.experience).join(' ');
    if (out.city) rest = rest.split(out.city).join(' ');

    var parts = rest
      .split(/[_|—\-·・]+/)
      .map(function (x) {
        return U.clean(x).replace(/^[「『【\[]+/, '').replace(/[」』】\]]+$/, '');
      })
      .filter(function (x) { return x && x.length > 1; });

    /* 站点头衔片段：BOSS 标题形如「FDE招聘 - 2026年人才招聘信息 - BOSS直聘」，
       「2026年人才招聘信息」含「信息」二字，会被公司名规则误判成公司。
       只在判定公司时跳过，不去删 parts —— 否则「FDE招聘」这类合法职位名片段会被误删。 */
    function isSiteNoise(x) {
      return /招聘|人才|求职|岗位|简历|直聘|猎聘|脉脉|国聘|网申|首页/.test(x);
    }

    var companyIdx = -1;
    for (var i = 0; i < parts.length; i++) {
      if (isSiteNoise(parts[i])) continue;
      if (/有限公司|股份|集团|科技|网络|信息|技术|研究院|银行|证券|保险|大学|数字|数据/.test(parts[i])) {
        companyIdx = i;
        break;
      }
    }
    if (companyIdx >= 0) {
      out.company = parts[companyIdx];
      parts.splice(companyIdx, 1);
    }
    if (parts.length) out.jobTitle = parts[0];

    return out;
  }

  function sanitizeJobTitle(t) {
    var s = U.clean(t)
      .replace(/^(急聘|急招|高薪招聘|诚聘)[:：\s]*/, '')
      .replace(/\s*[-_|]\s*招聘$/, '')
      .replace(/招聘$/, '')
      .replace(/^【[^】]*】\s*/, '')
      .slice(0, 80);
    // 纯站点名不是职位名（空页或加载中时标题常只有站名）
    if (/^(BOSS直聘|BOSS|猎聘网|猎聘|脉脉|国聘|智联招聘|前程无忧|拉勾|加载中)$/i.test(s)) return '';
    return s;
  }

  function sanitizeCompany(t) {
    return U.clean(t)
      .replace(/^(公司|企业)[:：]\s*/, '')
      .replace(/\s*(招聘|正在招聘|查看全部)$/, '')
      .slice(0, 60);
  }

  /* JD 启发式：找包含职责/要求关键词、文本量最大的块 */
  var JD_KEY = /岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|工作内容|职责描述|岗位描述|你将负责|我们希望你/;

  /* 找「岗位职责/任职要求」关键词所在的最近语义容器。
     必须取最小的够用块：若按「文本最长的含关键词块」来选，会一路选到 body，
     后续以它为锚点上溯圈定详情区时，必然把左侧列表一起圈进来。 */
  function findJdAnchor() {
    if (!document.body || typeof document.createTreeWalker !== 'function') return null;
    var walker = null;
    try {
      // 用常量 4（SHOW_TEXT）而非 NodeFilter.SHOW_TEXT：
      // NodeFilter 是 window 上的全局对象，在隔离世界以外的环境（如测试）里不存在，
      // 一旦取不到就会抛错并被 catch 吞掉，静默退化为兜底逻辑。
      walker = document.createTreeWalker(document.body, 4, null);
    } catch (e) {
      return null;
    }
    var node;
    var guard = 0;
    while ((node = walker.nextNode()) && guard++ < 20000) {
      var t = node.nodeValue || '';
      if (!JD_KEY.test(t)) continue;
      /* 跳过左侧列表卡片里的摘要（形如「职位描述：负责私有化部署」）：
         它同样含有关键词，会让锚点落到列表容器上，详情判定与字段抽取
         会一起错位。详情正文一定不在重复卡片内。 */
      if (looksLikeListItem(node.parentElement)) continue;
      var cur = node.parentElement;
      for (var i = 0; i < 8 && cur; i++) {
        var len = (cur.textContent || '').length;
        if (len >= 100 && len <= 20000) return cur;
        cur = cur.parentElement;
      }
      return node.parentElement;
    }
    return null;
  }

  /* 判断当前页面是否真的展开了岗位详情。
     用途：必须把「列表页 / 没选中岗位」与「详情已打开但抽不到」分开——
     前者是正常状态，后者才是选择器失效。两者都提示诊断会让用户在搜索页
     看到红色报错卡片，误判插件坏了。
     只认 JD 级证据：职位名、薪资这类选择器在左侧列表卡片上同样能命中，
     不能作为判据（列表页一定有 .salary 和 .job-title .name）。 */
  function hasDetailPane(adapter) {
    if (!adapter) return false;
    var jdRes = pickText(adapter.selectors.jd);
    if (jdRes.sel && U.clean(jdRes.text).length >= 200) return true;
    var anchor = findJdAnchor();
    if (anchor && nodeText(anchor).length >= 200) return true;
    return false;
  }

  function heuristicJD() {
    var anchor = findJdAnchor();
    if (anchor) {
      var at = nodeText(anchor);
      if (at.length >= 100) return { el: anchor, text: at };
    }

    var nodes = document.querySelectorAll('div, section, article, main');
    var best = null;
    var bestLen = 0;
    var limit = Math.min(nodes.length, 2000);

    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (!el || el.children.length > 30) continue;
      if (looksLikeListItem(el)) continue;
      var raw = el.textContent || '';
      // 门槛定在 100 字：含「岗位职责/任职要求」这类关键词本身已是强信号，
      // 门槛过高会让篇幅较短的真实 JD 抽不到。
      if (raw.length < 100 || raw.length > 20000) continue;
      if (!JD_KEY.test(raw)) continue;
      if (raw.length > bestLen) {
        bestLen = raw.length;
        best = el;
      }
    }
    if (best) return { el: best, text: nodeText(best) };

    var main = document.querySelector('main, article, [class*="job-detail"], [class*="jobDetail"]');
    if (main) return { el: main, text: nodeText(main).slice(0, 20000) };
    return { el: null, text: '' };
  }

  /* 以 JD 容器为锚点向上爬，找「JD 正文之外仍同时含薪资与经验」的最小祖先。
     必须排除 JD 子树后再判定：旧实现直接对整段 textContent 跑正则，
     JD 里的「3-5年 / 8K-15K」会让 scope 停在 JD 容器内部，
     头部真实的 8-13K / 1-3年 反而被排除在详情区之外。 */
  function findDetailScope(anchorEl, jdEl) {
    if (!anchorEl) return null;
    var el = anchorEl;
    for (var i = 0; i < 12; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      var t = '';
      try {
        t = el.textContent || '';
      } catch (e) {
        break;
      }
      if (!t || t.length > 12000) break;
      if (findLeafText(el, SALARY_RE, 24, jdEl) &&
          findLeafText(el, EXP_STRICT_RE, 16, jdEl)) return el;
    }
    // 退化：部分站点把年限写进 JD 正文，此时只要求「JD 之外有薪资」
    el = anchorEl;
    for (var j = 0; j < 12; j++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      var t2 = '';
      try {
        t2 = el.textContent || '';
      } catch (e) {
        break;
      }
      if (!t2 || t2.length > 12000) break;
      if (findLeafText(el, SALARY_RE, 24, jdEl)) return el;
    }
    return null;
  }

  /* 在根节点内找第一个「文本匹配正则」的叶子节点。
     excludeEl 用于排除 JD 正文子树：那里常有「3-5K 实习补贴」「在校生亦可」
     「8K-15K」这类描述性数字，结构推断一旦命中就会盖掉头部真实字段。 */
  function findLeafText(root, re, maxLen, excludeEl) {
    if (!root) return null;
    var nodes = root.querySelectorAll('*');
    var limit = Math.min(nodes.length, 3000);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (el.children.length > 1) continue;
      if (looksLikeListItem(el)) continue;
      if (excludeEl && excludeEl.contains && excludeEl.contains(el)) continue;
      var t = U.clean(el.textContent);
      if (!t || t.length > maxLen) continue;
      var m = t.match(re);
      if (m) return { el: el, text: m[0] };
    }
    return null;
  }

  /* 薪资可能由几个相邻 span 拼成「18–25K」，此时没有单个叶子节点能命中。
     只查短容器，并排除 JD 和列表项，避免从职责文字或其他岗位借数字。 */
  function findSalaryIn(root, jdEl, includeListItem) {
    if (!root) return '';
    var nodes = root.querySelectorAll('*');
    var limit = Math.min(nodes.length, 3000);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      if (!includeListItem && looksLikeListItem(el)) continue;
      var t = U.clean(el.textContent);
      if (!t || t.length > 48) continue;
      var salary = SalClean(t);
      if (salary && SALARY_RE.test(salary)) return salary;
    }
    return '';
  }

  /* 有些薪资节点的可见字形与 DOM 字符不同；先查同节点的可访问标签和数据属性。 */
  function findSalaryAttribute(root, jdEl) {
    if (!root) return '';
    var nodes = root.querySelectorAll('*');
    var limit = Math.min(nodes.length, 3000);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      var cls = typeof el.className === 'string' ? el.className : '';
      var named = ['data-salary', 'data-pay'];
      var labels = /salary|pay|wage|薪资|薪酬/i.test(cls)
        ? ['aria-label', 'title', 'data-value'] : [];
      var attrs = named.concat(labels);
      for (var j = 0; j < attrs.length; j++) {
        var t = el.getAttribute(attrs[j]) || '';
        if (t.length > 60) continue;
        var salary = SalClean(t);
        if (salary && SALARY_RE.test(t)) return salary;
      }
    }
    return '';
  }

  /* ---------- 几何 / 字号推断：完全不依赖类名 ----------
     BOSS 新版 /web/geek/jobs 把类名整体换过一轮，且站点会拦截 F12，
     无法逐个校准选择器。但版式没变：职位名一定是详情列里字号最大的短文本，
     薪资是紧跟其后的数字块，公司名是那一行的链接。
     用「详情列几何范围 + 计算字号」定位，跨改版更稳。 */

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }

  function numPx(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function fontPx(el) {
    try {
      return numPx(getComputedStyle(el).fontSize);
    } catch (e) {
      return 0;
    }
  }

  /* 详情列：从 JD 容器向上爬，取最外层「左边界没有明显左移」的祖先。
     双列布局里一旦祖先把左侧列表包进来，左边界会大幅左移，到此为止。
     没有布局信息时（display:none、或测试环境的零尺寸）返回 null，交回旧逻辑。 */
  function findDetailPane(jdEl) {
    if (!jdEl) return null;
    var r0 = rectOf(jdEl);
    if (!r0 || r0.width < 80) return null;
    var best = null;
    var el = jdEl;
    for (var i = 0; i < 15; i++) {
      var p = el.parentElement;
      if (!p) break;
      var r = rectOf(p);
      if (!r || r.width < 80) break;
      if (r.left < r0.left - 60) break;        // 左侧又出现了一列
      if (r.width > r0.width * 3) break;       // 宽度暴涨，说明并进了整页容器
      best = p;
      el = p;
    }
    /* 只比 JD 本身大一点点的祖先说明爬到一半就停了（内边距太深时左边界会提前
       触发上面的 break），拿到也没有标题可用，判定失败交给结构推断。 */
    if (!best) return null;
    var paneLen = (best.textContent || '').length;
    var jdLen = (jdEl.textContent || '').length;
    if (paneLen < jdLen + 10) return null;
    return best;
  }

  function pathOf(el, maxDepth) {
    var out = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && out.length < (maxDepth || 5)) {
      var s = cur.tagName.toLowerCase();
      var cls = typeof cur.className === 'string' ? cur.className.trim() : '';
      if (cls) s += '.' + cls.split(/\s+/).slice(0, 2).join('.');
      if (cur.id) s = '#' + cur.id + ' ' + s;
      out.unshift(s);
      cur = cur.parentElement;
    }
    return out.join(' > ');
  }

  /* 标题类短文本：不能是薪资 / 年限 / 学历 / 栏目名 */
  var TITLE_BLOCKLIST = /^(首页|返回|上一页|下一页|职位描述|岗位职责|任职要求|岗位要求|公司介绍|工商信息|招聘信息|查看全部|相似职位|微信扫码|举报|收藏|分享)$/;

  /* 只用字号选标题：改版后类名不可靠，但「标题字号明显大于正文」这条视觉规律成立。 */
  function guessTitleBySize(pane, jdEl) {
    if (!pane) return '';
    var nodes = pane.querySelectorAll('*');
    var limit = Math.min(nodes.length, 3000);
    var best = null;
    var maxFs = 0;
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (el.children.length > 1) continue;
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      if (looksLikeListItem(el)) continue;
      var t = U.clean(el.textContent);
      if (!t || t.length < 2 || t.length > 40) continue;
      if (TITLE_BLOCKLIST.test(t)) continue;
      if (!validJobTitle(t)) continue;
      var fs = fontPx(el);
      if (fs <= 0 || fs < 15) continue;   // 正文级字号不可能是标题
      var r = rectOf(el);
      var top = r ? r.top : 0;
      if (!best || fs > maxFs + 0.4 ||
          (Math.abs(fs - maxFs) <= 0.4 && top < best.top)) {
        maxFs = Math.max(maxFs, fs);
        best = { text: t, top: top, fs: fs };
      }
    }
    return best ? sanitizeJobTitle(best.text) : '';
  }

  /* 公司名：工商后缀最可靠；没有后缀时只接受明确的公司链接。 */
  var COMPANY_NOISE = /职位描述|岗位职责|任职要求|公司介绍|工商信息|查看全部|相似职位|收藏|举报|分享|微信扫码|立即沟通|继续沟通|投简历|首页|返回/;

  function isCompanyText(t, jobTitle) {
    if (!t || t.length < 2 || t.length > 40 || t === jobTitle) return false;
    if (COMPANY_NOISE.test(t) || INDUSTRY_NOISE.test(t)) return false;
    if (/工程师|产品经理|设计师|招聘|职位|岗位/.test(t)) return false;
    if (/^(全职|兼职|实习|不限|应届生|在校生)$/.test(t)) return false;
    if (SALARY_RE.test(t) || EXP_RE.test(t) || EDU_RE.test(t)) return false;
    if (findCity(t) === t || (findCity(t) && /[·・]/.test(t))) return false;
    return true;
  }

  function isCompanyLink(el) {
    var href = (el.getAttribute && el.getAttribute('href')) || '';
    var cls = typeof el.className === 'string' ? el.className : '';
    return /\/(gongsi|company|brand)(\/|\?|$)/i.test(href) || /company|brand|comp-name/i.test(cls);
  }

  function guessCompanyByPane(pane, jdEl, jobTitle) {
    if (!pane) return '';
    var nodes = pane.querySelectorAll('*');
    var limit = Math.min(nodes.length, 3000);
    var suffixed = '';
    var firstLink = '';
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (el.children.length > 1) continue;
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      if (looksLikeListItem(el)) continue;
      var link = el.closest && el.closest('a[href]');
      if (link && /\/job_detail\/|\/job\/[a-z0-9]/i.test(link.getAttribute('href') || '')) continue;
      var t = U.clean(el.textContent);
      if (!isCompanyText(t, jobTitle) || t.length > 30) continue;
      if (COMPANY_SUFFIX.test(t)) {
        if (!suffixed) suffixed = t;
        continue;
      }
      if (el.tagName === 'A' && isCompanyLink(el) && !firstLink) firstLink = t;
    }
    if (suffixed) return sanitizeCompany(suffixed);
    if (firstLink) return sanitizeCompany(firstLink);
    return '';
  }

  /* 招聘者信息常被宽泛的 `.name` 选择器命中（实测抽成「李润葳 刚刚活跃」），
     这里做一次合理性校验，不通过就交给标题推断。 */
  var TITLE_NOISE = /刚刚活跃|今日活跃|在线|回复率|招聘者|HR|猎头|职位详情|立即沟通|收藏|BOSS直聘/;

  function validJobTitle(t) {
    if (!t || t.length < 2 || t.length > 40) return false;
    if (TITLE_NOISE.test(t)) return false;
    if (SALARY_RE.test(t) || EXP_RE.test(t)) return false;
    // BOSS 的薪资有时使用私有区字形：在网页上是数字，移到扩展字体下却成乱码 + K。
    if (/[\uE000-\uF8FF\uFFFD]/.test(t)) return false;
    if (!/[\u3400-\u9FFF]{2,}|[A-Za-z]{2,}/.test(t)) return false;
    if (/^[^\u3400-\u9FFF]{1,8}[Kk](?:[·・]\d+薪)?$/.test(t)) return false;
    return true;
  }

  /* 详情区内的标题兜底：优先取 JD 正文之外的 h1/h2/h3 */
  function guessTitleIn(scope, jdEl) {
    if (!scope) return '';
    var heads = scope.querySelectorAll('h1, h2, h3');
    for (var i = 0; i < heads.length; i++) {
      var el = heads[i];
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      if (looksLikeListItem(el)) continue;
      var t = U.clean(el.textContent);
      if (!validJobTitle(t)) continue;
      if (/岗位职责|职位描述|任职要求|岗位要求|公司介绍/.test(t)) continue;
      return sanitizeJobTitle(t);
    }
    return '';
  }

  /* 「电子商务」是行业词不是公司名，旧正则里的裸 `电子` 会误命中它。
     行业词单独建黑名单；公司后缀要求更具体。 */
  var INDUSTRY_NOISE = /^(电子商务|互联网|计算机软件|计算机服务|IT服务|人工智能|新能源|咨询服务|贸易|进出口|批发|零售|金融|教育|医疗|游戏|广告|传媒|物流|房地产|信息服务|电子技术)$/;
  var COMPANY_SUFFIX = /有限公司|股份|集团|研究院|事务所|工作室|医院|学校|大学|银行|证券|保险|科技|网络|技术|数字|数据|智能|电子/;

  /* 详情区内的公司名兜底：靠工商后缀或明确的公司链接识别。
     有 pane 时传 pane，没有时传 scope，算法相同。 */
  function guessCompanyIn(scope, jdEl, jobTitle) {
    return guessCompanyByPane(scope, jdEl, jobTitle);
  }

  function bossRecruiterCompany(scope, jobTitle) {
    if (!scope) return '';
    var el = scope.querySelector('.job-boss-info .boss-info-attr');
    if (!el) return '';
    var name = U.clean(el.textContent).split(/\s*[·・]\s*/)[0];
    return isCompanyText(name, jobTitle) ? sanitizeCompany(name) : '';
  }

  /* BOSS 搜索页的左侧卡片与右侧详情展示同一职位。详情里没有公司时，
     用完全一致的职位标题关联卡片，再从卡片底部找公司。 */
  function companyFromCard(card, jobTitle) {
    var nodes = card.querySelectorAll('*');
    var limit = Math.min(nodes.length, 120);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      var cls = typeof el.className === 'string' ? el.className : '';
      if (!/company|brand|merchant|comp-name/i.test(cls) &&
          !(el.tagName === 'A' && isCompanyLink(el))) continue;
      var explicit = U.clean(el.textContent);
      if (isCompanyText(explicit, jobTitle)) return sanitizeCompany(explicit);
    }

    var box = rectOf(card);
    if (!box || box.width < 80 || box.height < 60) return '';
    var best = null;
    for (var j = 0; j < limit; j++) {
      var leaf = nodes[j];
      if (leaf.children.length) continue;
      var t = U.clean(leaf.textContent);
      if (!isCompanyText(t, jobTitle)) continue;
      var r = rectOf(leaf);
      if (!r || r.width < 1 || r.top < box.top + box.height * 0.55 ||
          r.left > box.left + box.width * 0.6) continue;
      if (!best || r.top > best.top || (r.top === best.top && r.left < best.left)) {
        best = { text: t, top: r.top, left: r.left };
      }
    }
    return best ? sanitizeCompany(best.text) : '';
  }

  function matchingListCard(jobTitle, scope) {
    if (!scope || !document.body || !jobTitle) return null;
    var key = U.squeeze(jobTitle);
    if (key.length < 4) return null;
    var nodes = document.body.querySelectorAll('*');
    var matches = [];
    var limit = Math.min(nodes.length, 5000);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (scope.contains(el) || (el.closest && el.closest('#jr-radar-host'))) continue;
      if (el.children.length > 1) continue;
      var raw = el.textContent || '';
      if (raw.length < 2 || raw.length > 90) continue;
      var candidateKey = U.squeeze(sanitizeJobTitle(raw).replace(/[…⋯]+$/, ''));
      var exact = candidateKey === key;
      var prefix = candidateKey.length >= 10 && candidateKey.length >= key.length * 0.55 &&
        key.indexOf(candidateKey) === 0;
      if (!exact && !prefix) continue;
      var childMatches = false;
      for (var j = 0; j < el.children.length; j++) {
        var childKey = U.squeeze(sanitizeJobTitle(el.children[j].textContent).replace(/[…⋯]+$/, ''));
        if (childKey === candidateKey) childMatches = true;
      }
      if (childMatches) continue;

      var knownCard = el.closest && el.closest('li.job-card-box');
      if (knownCard && !scope.contains(knownCard)) {
        var knownCompany = companyFromCard(knownCard, jobTitle);
        if (knownCompany && !matches.some(function (m) { return m.el === knownCard; })) {
          var knownClass = typeof knownCard.className === 'string' ? knownCard.className : '';
          matches.push({
            el: knownCard, company: knownCompany,
            salary: findSalaryIn(knownCard, null, true) || findSalaryAttribute(knownCard, null),
            matchScore: exact ? 1000 + candidateKey.length : candidateKey.length,
            selected: /selected|active|current/i.test(knownClass) ||
              knownCard.getAttribute('aria-selected') === 'true'
          });
        }
        continue;
      }

      var cur = el;
      for (var depth = 0; depth < 7 && cur && cur !== document.body; depth++, cur = cur.parentElement) {
        if (scope.contains(cur)) break;
        var whole = U.clean(cur.textContent);
        if (whole.length > 400) break;
        var company = companyFromCard(cur, jobTitle);
        if (!company) continue;
        var salary = findSalaryIn(cur, null, true) || findSalaryAttribute(cur, null);
        if (!matches.some(function (m) { return m.el === cur; })) {
          var cls = typeof cur.className === 'string' ? cur.className : '';
          matches.push({
            el: cur, company: company, salary: salary,
            matchScore: exact ? 1000 + candidateKey.length : candidateKey.length,
            selected: /selected|active|current/i.test(cls) ||
              cur.getAttribute('aria-selected') === 'true' ||
              cur.getAttribute('data-selected') === 'true'
          });
        }
        break;
      }
    }
    if (matches.length === 1) return matches[0];
    matches.sort(function (a, b) { return b.matchScore - a.matchScore; });
    if (matches.length > 1 && matches[0].matchScore > matches[1].matchScore) return matches[0];
    var selected = matches.filter(function (m) { return m.selected; });
    return selected.length === 1 ? selected[0] : null;
  }

  /* ---------- 正文清理：把页面控件从 JD 里摘出去 ----------
     现场问题：详情区容器（或启发式命中的祖先）把页头一起圈了进来，于是
     「取消收藏」「微信扫一扫」「举报」这类按钮文案混进 <jd>，模型会把它们
     当成岗位内容引用，甚至写进 risks（实测就出现过「页面混入招聘平台噪声文字」）。
     处理分三层：结构上跳过可交互子树 → 行级丢弃控件文案 → 兜底删除粘连片段。 */

  var PUA_RE = /[\uE000-\uF8FF\uFFFD]/;
  var PUA_ALL_RE = /[\uE000-\uF8FF]/g;

  /* 私有区数字 → 阿拉伯数字。映射由站点字体固定（实测 E031..E03A → 0..9）。
     万一站点换了映射，这里只会得到「未识别」，不会给出一个错数字——错数字比没有更糟。 */
  function decodeDigits(s) {
    return String(s == null ? '' : s).replace(/[\uE031-\uE03A]/g, function (c) {
      return String(c.charCodeAt(0) - 0xE031);
    });
  }

  function isZhipin() {
    try {
      return /(^|\.)zhipin\.com$/i.test(location.hostname || '');
    } catch (e) {
      return false;
    }
  }

  var UI_TAGS = {
    BUTTON: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, OPTGROUP: 1,
    LABEL: 1, SVG: 1, PATH: 1, IMG: 1, I: 1,
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1
  };

  var UI_CLASS_RE = /(^|[-_\s])(btn|button|toolbar|tool-bar|action|actionbar|action-bar|operate|operations|share|report|collect|favorite|qrcode|qr-code|wxtip|app-tip)([-_\s]|$)/i;

  var BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, SECTION: 1, ARTICLE: 1, HEADER: 1,
    FOOTER: 1, MAIN: 1, ASIDE: 1, NAV: 1, H1: 1, H2: 1, H3: 1, H4: 1,
    H5: 1, H6: 1, TR: 1, TD: 1, TH: 1, TABLE: 1, BLOCKQUOTE: 1, PRE: 1,
    DD: 1, DT: 1, DL: 1, FIGURE: 1, FIGCAPTION: 1, ADDRESS: 1, BR: 1
  };

  /* 整行只有这些字样，就是控件而不是岗位内容 */
  var UI_LABEL_RE = /^(取消收藏|已收藏|收藏|关注|已关注|分享|微信分享|QQ分享|微博分享|复制链接|复制|举报|投诉|反馈|立即沟通|继续沟通|马上沟通|沟通|投递简历|立即投递|立即申请|申请职位|不感兴趣|查看更多|查看全部|查看更多信息|展开|收起|展开全部|收起全部|微信扫一扫|微信扫码|扫码查看|扫码沟通|扫一扫|点击查看地图|查看地图|去查看|打开APP|APP内打开|下载APP|登录|注册|返回顶部|上一篇|下一篇|相似职位|公司介绍|工商信息|换一批|点赞|评论|转发|生成海报|海报|纠错|刷新|加载中)$/;

  /* 这些字样不会出现在岗位描述里，整段拼在一起时直接删掉 */
  var GLUED_UI_RE = /(取消收藏|已收藏|微信扫一扫|微信扫码|扫码查看|复制链接|生成海报|查看更多信息|点击查看地图)/g;

  /* 章节标题要保留：它们对模型理解结构有用，且同属「短行」容易被误删 */
  var JD_HEAD_RE = /^(岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|工作内容|职责描述|岗位描述|你需要做|你将负责|我们希望你|加分项|加分项：|薪资福利)$/;

  function isHiddenEl(el) {
    if (!el) return false;
    if (el.hidden) return true;
    var st = el.getAttribute && el.getAttribute('style');
    return !!(st && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st));
  }

  /* 可交互 / 装饰性节点：正文里几乎没有这类元素，跳过它们不会丢岗位内容。
     <a> 一律跳过——JD 里极少有链接，有也基本是导航或公司主页。 */
  function isUiNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isHiddenEl(el)) return true;
    if (UI_TAGS[el.tagName]) return true;
    if (el.tagName === 'A') return true;
    if (el.getAttribute) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      var role = el.getAttribute('role');
      if (role === 'button' || role === 'tab' || role === 'toolbar') return true;
      if (el.hasAttribute('onclick')) return true;
    }
    var cls = typeof el.className === 'string' ? el.className : '';
    return !!(cls && UI_CLASS_RE.test(cls));
  }

  function collectText(node, buf) {
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) {
        buf.push(n.nodeValue);
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (isUiNode(n)) continue;
      var block = !!BLOCK_TAGS[n.tagName];
      if (block) buf.push('\n');
      collectText(n, buf);
      if (block) buf.push('\n');
    }
    return buf;
  }

  /* 去掉行首的图标 / emoji / 序号符号，便于比对控件文案 */
  function labelOf(t) {
    return U.clean(t).replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').replace(/\s+/g, '');
  }

  function isUiLine(t, ctx) {
    var s = labelOf(t);
    if (!s) return true;
    if (UI_LABEL_RE.test(s)) return true;
    if (JD_HEAD_RE.test(s)) return false;
    /* 6 字以内、没有句读、不以序号或单词开头的短行：基本都是按钮 / 图标注释。
       正文条目普遍以「1.」「（1）」「-」开头，或带有句读。 */
    if (s.length <= 6 && !/[。，；：、！？,;:!?]/.test(s) &&
        !/^\d/.test(s) && !/[A-Za-z]{2,}/.test(s)) return true;
    if (ctx) {
      var keys = ['jobTitle', 'company', 'salaryText', 'experienceText', 'city'];
      for (var i = 0; i < keys.length; i++) {
        var v = ctx[keys[i]];
        if (v && labelOf(v) === s) return true;   // 页头的职位名 / 薪资 / 公司名
      }
    }
    return false;
  }

  /* 沿「单一大块」向下收窄：某子节点占七成以上文本才继续深入。
     这样能剥掉被一起圈进来的页头，又不会把「岗位职责 / 任职要求」两块拆散。 */
  function textLen(el) {
    try {
      return (el.textContent || '').length;
    } catch (e) {
      return 0;
    }
  }

  function narrowJd(el) {
    var cur = el;
    for (var i = 0; i < 6; i++) {
      if (!cur || !cur.children || !cur.children.length) break;
      var curLen = textLen(cur);
      if (curLen < 200) break;
      var best = null;
      var bestLen = 0;
      for (var j = 0; j < cur.children.length; j++) {
        var kid = cur.children[j];
        if (isUiNode(kid)) continue;
        var len = textLen(kid);
        if (len > bestLen) {
          bestLen = len;
          best = kid;
        }
      }
      if (!best || bestLen < curLen * 0.7) break;
      cur = best;
    }
    return cur;
  }

  /* 结构化取文：跳过可交互子树，再按行过滤控件文案。
     若结构过滤剥掉了太多（正文被套在 <a>/<label> 这类罕见结构里），
     退回纯文本过滤，宁可多留一点也不要把 JD 抽残。 */
  function jdTextOf(el, ctx) {
    if (!el) return { text: '', dropped: 0, glued: 0 };
    var structured = collectText(el, []).join('');
    var plain = nodeText(el);
    var base = structured;
    if (!U.clean(structured)) {
      base = plain;
    } else if (U.clean(structured).length < U.clean(plain).length * 0.6 &&
               U.clean(plain).length - U.clean(structured).length > 200) {
      base = plain;
    }
    return cleanJdText(base, ctx);
  }

  function cleanJdText(raw, ctx) {
    var s = String(raw == null ? '' : raw);
    var glued = 0;
    s = s.replace(GLUED_UI_RE, function () {
      glued++;
      return ' ';
    });
    if (isZhipin()) s = decodeDigits(s);
    s = s.replace(PUA_ALL_RE, ' ');   // 解不出的私有区字符：不可见噪声，留着只会污染引用核对

    var lines = s.split('\n');
    var out = [];
    var removed = [];
    var dropped = 0;
    var last = '';
    for (var i = 0; i < lines.length; i++) {
      var t = U.clean(lines[i]);
      if (!t) continue;
      var ui = isUiLine(t, ctx);
      if (ui || t === last) {
        dropped++;
        /* 留几行样本给诊断：用户能据此判断「被删掉的到底是不是控件」 */
        if (ui && removed.length < 6) removed.push(U.ellipsis(t, 40));
        continue;
      }
      out.push(t);
      last = t;
    }
    return { text: out.join('\n'), dropped: dropped + glued, glued: glued, removed: removed };
  }

  function extract(adapter) {
    if (!adapter) return null;
    var sel = adapter.selectors;
    var docTitle = document.title || '';
    var parsed = parseDocTitle(docTitle);

    /* ---- 第一步：先定位 JD，并以其为锚点圈定「详情区」 ----
       BOSS 搜索结果页是「左侧列表 + 右侧滑出详情」，两边的类名可能重复。
       全文档 querySelector 会抓到左侧卡片的职位名（实测抽成「FDE交付」，
       而那是左侧第三个列表项）。所以先拿 JD 元素，向上确定详情面板范围，
       后面所有字段都只在这个范围内找。 */
    var jdRes = pickText(sel.jd);
    var jdSource = jdRes.sel ? '选择器' : '未取到';
    if (!jdRes.text || jdRes.text.length < 120) {
      var h = heuristicJD();
      if (h.text && h.text.length > jdRes.text.length) {
        jdRes = { text: h.text, sel: null, el: h.el };
        jdSource = '启发式';
      }
    }
    var jdEl = narrowJd(jdRes.el);
    /* 详情列优先用几何判定（不依赖类名，抗改版），失败再退回结构推断 */
    var pane = findDetailPane(jdEl);
    var scope = pane || findDetailScope(jdRes.el, jdEl);
    var scopeTag = pane ? '详情区' : (scope ? '选择器·区' : '选择器');

    /* ---- 第二步：逐字段抽取，优先限定在详情区内 ---- */
    /* 收窄失败时退回全页，但依然走 pickIn —— 它会跳过重复卡片。
       旧实现退回 pickText（纯 querySelector），在「有详情但收窄失败」时
       会直接抓到左侧列表卡片的标题，把抽取失败伪装成成功。 */
    var pageRoot = scope || document.body || document.documentElement;
    var t = pickIn(pageRoot, sel.jobTitle);
    var jobTitle = validJobTitle(t.text) ? sanitizeJobTitle(t.text) : '';
    var jobTitleSource = (t.sel && jobTitle) ? scopeTag : '';
    if (!jobTitle && scope) {
      /* 类名失效时先按字号认标题，再退回 h1/h2/h3 */
      jobTitle = guessTitleBySize(scope, jdEl) || guessTitleIn(scope, jdEl);
      if (jobTitle) jobTitleSource = '结构推断';
    }
    if (!jobTitle) {
      jobTitle = sanitizeJobTitle(parsed.jobTitle);
      if (jobTitle) jobTitleSource = '标题推断';
    }
    if (!jobTitleSource) jobTitleSource = '未取到';

    var card = adapter.id === 'zhipin' && /\/web\/geek\/jobs?(\/|$)/.test(location.pathname)
      ? matchingListCard(jobTitle, scope) : null;

    /* 公司名的取值顺序：详情区里的证据优先，列表卡片最后用。
       旧顺序把「列表匹配」排在最前，结果详情区明明有招聘者所属公司，却先信了
       左侧卡片——同名岗位一多，就会把别家公司的名字发给模型。 */
    var c = pickIn(pageRoot, sel.company);
    var company = isCompanyText(U.clean(c.text), jobTitle) ? sanitizeCompany(c.text) : '';
    var companySource = (c.sel && company) ? scopeTag : '';
    if (!company && adapter.id === 'zhipin') {
      company = bossRecruiterCompany(scope, jobTitle);
      if (company) companySource = '招聘者信息';
    }
    if (!company && scope) {
      company = guessCompanyIn(scope, jdEl, jobTitle);
      if (company) companySource = '结构推断';
    }
    if (!company && card && card.company) {
      company = card.company;
      companySource = '列表匹配';
    }
    if (!company) {
      company = sanitizeCompany(parsed.company);
      if (company) companySource = '标题推断';
    }
    if (!companySource) companySource = '未取到';

    var sal = pickIn(pageRoot, sel.salary);
    var salaryText = SalClean(sal.text);
    var salarySource = (sal.sel && salaryText) ? scopeTag : '';
    if (!salaryText && scope) {
      var salEl = findLeafText(scope, SALARY_RE, 24, jdEl);
      if (salEl) {
        salaryText = SalClean(salEl.text);
        salarySource = '结构推断';
      }
    }
    if (!salaryText && scope) {
      salaryText = findSalaryIn(scope, jdEl, false);
      if (salaryText) salarySource = '结构推断';
    }
    if (!salaryText && scope) {
      salaryText = findSalaryAttribute(scope, jdEl);
      if (salaryText) salarySource = '页面属性';
    }
    if (!salaryText && card && card.salary) {
      salaryText = card.salary;
      salarySource = '列表匹配';
    }
    if (!salaryText && parsed.salary) {
      salaryText = parsed.salary;
      salarySource = '标题推断';
    }
    /* 站点用私有区字符替换了数字、而我们没能解码：绝不能把「-K」这种残缺文本
       当薪资发出去。只有 BOSS 有这套字形混淆，别站点按普通「未取到」处理。 */
    if (!salaryText && isZhipin() && PUA_RE.test(sal.text || '')) salarySource = '字形混淆';
    if (!salarySource) salarySource = '未取到';

    var meta = pickIn(pageRoot, sel.meta);
    // meta 选择器若误命中 JD 正文，整段文本都会变成噪声，直接弃用
    var metaText = (meta.el && jdEl && jdEl.contains && jdEl.contains(meta.el))
      ? '' : (meta.text || '');

    var city = findCity(metaText);
    var citySource = city ? scopeTag : '';
    if (!city && scope) {
      var cityEl = findLeafText(scope, CITY_RE, 30, jdEl);
      if (cityEl) {
        city = findCity(cityEl.text);
        if (city) citySource = '结构推断';
      }
    }
    if (!city && parsed.city) {
      city = parsed.city;
      citySource = '标题推断';
    }
    if (!citySource) citySource = '未取到';

    var experienceSource = '';
    var experienceText = '';
    // meta 行里可能同时有「1-3年」和「经验不限 / 在校」，优先取明确年限
    var expMatch = metaText.match(EXP_STRICT_RE) || metaText.match(EXP_RE);
    if (expMatch) {
      experienceText = expMatch[0];
      experienceSource = scopeTag || '页面';
    }
    if (!experienceText && scope) {
      var expEl = findLeafText(scope, EXP_STRICT_RE, 16, jdEl);
      if (expEl) {
        experienceText = expEl.text;
        experienceSource = '结构推断';
      }
    }
    if (!experienceText && parsed.experience) {
      experienceText = parsed.experience;
      experienceSource = '标题推断';
    }

    var eduMatch = metaText.match(EDU_RE);
    if (!eduMatch && scope) {
      var eduEl = findLeafText(scope, EDU_RE, 8, jdEl);
      if (eduEl) eduMatch = eduEl.text.match(EDU_RE);
    }

    var act = pickIn(pageRoot, sel.active);
    var activeText = U.ellipsis(act.text, 40);

    /* 正文必须在这里再过一遍：混进 JD 的按钮文案、页头字段、私有区噪声
       都会原样发给模型，模型也就会把它们当岗位内容引用。 */
    var jdClean = jdTextOf(jdEl || jdRes.el, {
      jobTitle: jobTitle,
      company: company,
      salaryText: salaryText,
      experienceText: experienceText,
      city: city
    });
    var jdText = jdClean.text.slice(0, 20000);

    if (!jobTitle && !company && !jdText) return null;

    return {
      platform: adapter.id,
      siteName: adapter.name,
      url: location.href,
      docTitle: docTitle,
      jobTitle: jobTitle,
      company: company,
      salaryText: salaryText,
      city: city,
      experienceText: experienceText,
      educationText: eduMatch ? eduMatch[0] : '',
      activeText: activeText,
      jdText: jdText,
      metaText: U.ellipsis(metaText, 80),
      /* 清理统计：面板与诊断都要能说清「正文被改过多少」，否则用户没法判断
         模型看到的到底是不是页面原文。rawJd 取同一个节点，前后可比。 */
      dirty: {
        ui: jdClean.dropped,
        glued: jdClean.glued,
        rawJd: nodeText(jdEl || jdRes.el).length,
        removed: jdClean.removed
      },
      sources: {
        jobTitle: jobTitleSource,
        company: companySource,
        salary: salarySource,
        city: citySource,
        experience: experienceSource || '未取到',
        jd: jdSource
      },
      extractedAt: Date.now()
    };
  }

  function SalClean(t) {
    var s = U.clean(t).replace(/[‐‑‒–—−－]/g, '-');
    var hadPua = PUA_RE.test(s);
    /* 私有区数字的映射是 BOSS 专有的：别的站点出现私有区字符说明不了它对应哪个数字，
       硬解只会给出一个看起来很正常的错数字，所以直接放弃这个字段。 */
    if (hadPua) {
      if (!isZhipin()) return '';
      s = decodeDigits(s);
    }
    var m = s.match(SALARY_RE);
    if (m) return m[0];
    /* 私有区字符解不出来就返回空：残缺的「-K」比「未取到」更容易误导人，
       模型看到「-K」会当成真实区间去推理。 */
    if (hadPua || PUA_RE.test(s)) return '';
    return s.length <= 24 ? s : '';
  }

  global.JR_EXTRACT = {
    extract: extract,
    hasDetailPane: hasDetailPane,
    parseDocTitle: parseDocTitle,
    findCity: findCity,
    /* 供诊断模块使用：把「定位到了哪一段 DOM」一并交代出来，便于远程校准 */
    findJdAnchor: findJdAnchor,
    findDetailPane: findDetailPane,
    pathOf: pathOf,
    rectOf: rectOf,
    fontPx: fontPx,
    /* 脏输入清理的零件：测试要能单独验证，诊断也要能引用同一套规则 */
    cleanJdText: cleanJdText,
    jdTextOf: jdTextOf,
    narrowJd: narrowJd,
    isUiLine: isUiLine,
    isUiNode: isUiNode,
    decodeDigits: decodeDigits,
    SalClean: SalClean,
    CITIES: CITIES
  };
})(typeof window !== 'undefined' ? window : globalThis);
