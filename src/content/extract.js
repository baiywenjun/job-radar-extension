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

  var SALARY_RE = /\d+(?:\.\d+)?\s*[-~至]\s*\d+(?:\.\d+)?\s*(?:[Kk]|千|万)(?:\s*[·・]\s*\d+\s*薪)?/;
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
    if (sm) out.salary = sm[0];

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

  /* 招聘者信息常被宽泛的 `.name` 选择器命中（实测抽成「李润葳 刚刚活跃」），
     这里做一次合理性校验，不通过就交给标题推断。 */
  var TITLE_NOISE = /刚刚活跃|今日活跃|在线|回复率|招聘者|HR|猎头|职位详情|立即沟通|收藏|BOSS直聘/;

  function validJobTitle(t) {
    if (!t || t.length < 2 || t.length > 40) return false;
    if (TITLE_NOISE.test(t)) return false;
    if (SALARY_RE.test(t) || EXP_RE.test(t)) return false;
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

  /* 详情区内的公司名兜底：靠工商后缀识别，比类名稳 */
  function guessCompanyIn(scope, jdEl) {
    if (!scope) return '';
    var nodes = scope.querySelectorAll('a, span, h3, h4, div');
    var limit = Math.min(nodes.length, 2500);
    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (el.children.length > 1) continue;
      if (jdEl && jdEl.contains && jdEl.contains(el)) continue;
      if (looksLikeListItem(el)) continue;
      var t = U.clean(el.textContent);
      if (!t || t.length < 4 || t.length > 30) continue;
      if (INDUSTRY_NOISE.test(t)) continue;
      if (COMPANY_SUFFIX.test(t)) return sanitizeCompany(t);
    }
    return '';
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
    var jdEl = jdRes.el;
    var scope = findDetailScope(jdRes.el, jdEl);
    var scopeTag = scope ? '选择器·区' : '选择器';

    /* ---- 第二步：逐字段抽取，优先限定在详情区内 ---- */
    /* 收窄失败时退回全页，但依然走 pickIn —— 它会跳过重复卡片。
       旧实现退回 pickText（纯 querySelector），在「有详情但收窄失败」时
       会直接抓到左侧列表卡片的标题，把抽取失败伪装成成功。 */
    var pageRoot = scope || document.body || document.documentElement;
    var t = pickIn(pageRoot, sel.jobTitle);
    var jobTitle = validJobTitle(t.text) ? sanitizeJobTitle(t.text) : '';
    var jobTitleSource = (t.sel && jobTitle) ? scopeTag : '';
    if (!jobTitle && scope) {
      jobTitle = guessTitleIn(scope, jdEl);
      if (jobTitle) jobTitleSource = '结构推断';
    }
    if (!jobTitle) {
      jobTitle = sanitizeJobTitle(parsed.jobTitle);
      if (jobTitle) jobTitleSource = '标题推断';
    }
    if (!jobTitleSource) jobTitleSource = '未取到';

    var c = pickIn(pageRoot, sel.company);
    var company = sanitizeCompany(c.text);
    var companySource = c.sel ? scopeTag : '';
    if (!company && scope) {
      company = guessCompanyIn(scope, jdEl);
      if (company) companySource = '结构推断';
    }
    if (!company) {
      company = sanitizeCompany(parsed.company);
      if (company) companySource = '标题推断';
    }
    if (!companySource) companySource = '未取到';

    var sal = pickIn(pageRoot, sel.salary);
    var salaryText = SalClean(sal.text);
    var salarySource = sal.sel ? scopeTag : '';
    if (!salaryText && scope) {
      var salEl = findLeafText(scope, SALARY_RE, 24, jdEl);
      if (salEl) {
        salaryText = salEl.text;
        salarySource = '结构推断';
      }
    }
    if (!salaryText && parsed.salary) {
      salaryText = parsed.salary;
      salarySource = '标题推断';
    }
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

    var jdText = U.clean(jdRes.text).slice(0, 20000);

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
    var s = U.clean(t);
    var m = s.match(SALARY_RE);
    return m ? m[0] : (s.length <= 24 ? s : '');
  }

  global.JR_EXTRACT = {
    extract: extract,
    hasDetailPane: hasDetailPane,
    parseDocTitle: parseDocTitle,
    findCity: findCity,
    CITIES: CITIES
  };
})(typeof window !== 'undefined' ? window : globalThis);
