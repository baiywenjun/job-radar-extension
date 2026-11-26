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
  var EDU_RE = /(本科|硕士|博士|大专|中专|学历不限|高中)/;

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
    if (!selectors || !selectors.length) return { text: '', sel: null };
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try {
        el = document.querySelector(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (!el) continue;
      var t = nodeText(el);
      if (t && t.length >= 2) return { text: t, sel: selectors[i] };
    }
    return { text: '', sel: null };
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

    var companyIdx = -1;
    for (var i = 0; i < parts.length; i++) {
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
    return U.clean(t)
      .replace(/^(急聘|急招|高薪招聘|诚聘)[:：\s]*/, '')
      .replace(/\s*[-_|]\s*招聘$/, '')
      .replace(/^【[^】]*】\s*/, '')
      .slice(0, 80);
  }

  function sanitizeCompany(t) {
    return U.clean(t)
      .replace(/^(公司|企业)[:：]\s*/, '')
      .replace(/\s*(招聘|正在招聘|查看全部)$/, '')
      .slice(0, 60);
  }

  /* JD 启发式：找包含职责/要求关键词、文本量最大的块 */
  var JD_KEY = /岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|工作内容|职责描述|岗位描述|你将负责|我们希望你/;

  function heuristicJD() {
    var nodes = document.querySelectorAll('div, section, article, main');
    var best = null;
    var bestLen = 0;
    var limit = Math.min(nodes.length, 2000);

    for (var i = 0; i < limit; i++) {
      var el = nodes[i];
      if (!el || el.children.length > 30) continue;
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
    if (best) return nodeText(best);

    var main = document.querySelector('main, article, [class*="job-detail"], [class*="jobDetail"]');
    return main ? nodeText(main).slice(0, 20000) : '';
  }

  function extract(adapter) {
    if (!adapter) return null;
    var sel = adapter.selectors;
    var docTitle = document.title || '';
    var parsed = parseDocTitle(docTitle);

    var t = pickText(sel.jobTitle);
    var jobTitle = sanitizeJobTitle(t.text) || sanitizeJobTitle(parsed.jobTitle);
    var jobTitleSource = t.sel ? '选择器' : (parsed.jobTitle ? '标题推断' : '未取到');

    var c = pickText(sel.company);
    var company = sanitizeCompany(c.text) || sanitizeCompany(parsed.company);
    var companySource = c.sel ? '选择器' : (parsed.company ? '标题推断' : '未取到');

    var sal = pickText(sel.salary);
    var salaryText = SalClean(sal.text) || parsed.salary;
    var salarySource = sal.sel ? '选择器' : (parsed.salary ? '标题推断' : '未取到');

    var meta = pickText(sel.meta);
    var metaText = meta.text || '';

    var city = findCity(metaText) || parsed.city;
    var citySource = metaText && findCity(metaText) ? '选择器' : (parsed.city ? '标题推断' : '未取到');

    var expMatch = metaText.match(EXP_RE) || parsed.experience;
    var experienceText = typeof expMatch === 'string' ? expMatch : (expMatch ? expMatch[0] : '');
    var eduMatch = metaText.match(EDU_RE);

    var act = pickText(sel.active);
    var activeText = U.ellipsis(act.text, 40);

    var j = pickText(sel.jd);
    var jdText = j.text;
    var jdSource = j.sel ? '选择器' : '未取到';
    if (!jdText || jdText.length < 120) {
      var h = heuristicJD();
      if (h && h.length > jdText.length) {
        jdText = h;
        jdSource = '启发式';
      }
    }
    jdText = U.clean(jdText).slice(0, 20000);

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
    parseDocTitle: parseDocTitle,
    findCity: findCity,
    CITIES: CITIES
  };
})(typeof window !== 'undefined' ? window : globalThis);
