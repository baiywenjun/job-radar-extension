/* 岗位雷达 · 站点适配层
 * 招聘平台的前端类名经常改版，所以这里的每条字段都配了多个候选选择器，
 * 全部失败时由 extract.js 走「页面标题解析 → 文本启发」两级兜底，
 * 并在面板上标出每个字段的抽取来源，便于人工校准。
 */
(function (global) {
  'use strict';

  var SITE_ADAPTERS = [
    {
      id: 'zhipin',
      name: 'BOSS 直聘',
      hostPattern: /(^|\.)zhipin\.com$/i,
      // 只认标准的 /job_detail/ 详情路径；/web/geek/jobs 是搜索结果页，不能算详情
      detailPattern: /\/job_detail\/|job_detail\.html/,
      selectors: {
        jobTitle: [
          '.job-banner .name h1',
          '.job-primary .name h1',
          '.job-banner h1',
          'h1.job-name',
          '.job-title .name',
          '.job-detail-box .name'
        ],
        company: [
          '.job-banner .company-info a.company-name',
          '.company-info .company-name',
          '.sider-company .company-name',
          '.job-banner .company-info',
          '.company-name'
        ],
        salary: [
          '.job-banner .salary',
          '.job-primary .salary',
          '.job-detail-box .salary',
          '.salary'
        ],
        meta: [
          '.job-banner .info-primary p',
          '.job-primary .job-limit',
          '.job-banner .info-primary',
          '.job-primary .job-location'
        ],
        active: [
          '.job-boss-info .boss-active-time',
          '.boss-info .boss-active-time',
          '.job-boss-info .boss-name',
          '.job-boss-info'
        ],
        jd: [
          '.job-sec-text',
          '.job-detail-section .text',
          '.detail-content .job-sec-text',
          '.job-detail .job-sec-text',
          '.job-detail-section'
        ]
      }
    },
    {
      id: 'liepin',
      name: '猎聘',
      hostPattern: /(^|\.)liepin\.com$/i,
      // /job/1234567.shtml 是详情；/zhaopin/ 是搜索列表页，不能算详情
      detailPattern: /\/job\/[a-z0-9]+|\/a\/[a-z0-9]+/i,
      selectors: {
        jobTitle: [
          '.job-title-box .name',
          '.name-box .name',
          '.job-detail-box .name',
          '.title-info h1',
          'h1'
        ],
        company: [
          '.company-info .name',
          '.company-name',
          '.company-box .name',
          '.job-company-name'
        ],
        salary: [
          '.job-salary',
          '.salary',
          '.job-title-box .salary',
          '.name-box .salary'
        ],
        meta: [
          '.job-qualifications',
          '.job-requirements',
          '.condition-list',
          '.job-title-box .condition'
        ],
        active: [
          '.recruiter-info .active-time',
          '.contact-info .active',
          '.recruiter-info'
        ],
        jd: [
          '.job-description',
          '.job-intro-container',
          '.paragraph',
          '.job-detail-content',
          '.detail-content'
        ]
      }
    },
    {
      id: 'maimai',
      name: '脉脉',
      hostPattern: /(^|\.)maimai\.cn$/i,
      detailPattern: /\/job\/[a-z0-9_-]{6,}|\/jobinfo\/|\/jobs\/[a-z0-9_-]{6,}/i,
      selectors: {
        jobTitle: [
          '.job-title',
          '.job-detail-title',
          '[class*="jobDetail"] h1',
          '[class*="job-detail"] h1',
          'h1'
        ],
        company: [
          '.company-name',
          '.job-company-name',
          '[class*="companyName"]',
          '[class*="company-name"]'
        ],
        salary: [
          '.job-salary',
          '.salary',
          '[class*="salary"]'
        ],
        meta: [
          '.job-tags',
          '.job-info',
          '[class*="jobTags"]',
          '[class*="job-info"]'
        ],
        active: [
          '.recruiter-active',
          '.active-time',
          '[class*="activeTime"]'
        ],
        jd: [
          '.job-description',
          '.job-desc',
          '[class*="jobDescription"]',
          '[class*="job-desc"]',
          '.detail-content'
        ]
      }
    },
    {
      id: 'iguopin',
      name: '国聘',
      hostPattern: /(^|\.)iguopin\.com$/i,
      // 详情形如 /job/detail?id=xxx、/position/12345；/job/list 是列表页
      detailPattern: /\/job\/detail|\/position\/detail|\/job\/\d+|\/position\/\d+|\/recruit\/detail/i,
      selectors: {
        jobTitle: [
          '.job-name',
          '.position-name',
          '.job-title',
          '.detail-title',
          'h1'
        ],
        company: [
          '.company-name',
          '.unit-name',
          '.employer-name',
          '[class*="companyName"]'
        ],
        salary: [
          '.salary',
          '.job-salary',
          '.pay',
          '[class*="salary"]'
        ],
        meta: [
          '.job-require',
          '.job-condition',
          '.job-info',
          '.position-info'
        ],
        active: [
          '.publish-time',
          '.update-time',
          '.release-time'
        ],
        jd: [
          '.job-desc',
          '.job-description',
          '.position-desc',
          '.detail-content',
          '.content'
        ]
      }
    }
  ];

  function getAdapter(hostname) {
    for (var i = 0; i < SITE_ADAPTERS.length; i++) {
      if (SITE_ADAPTERS[i].hostPattern.test(hostname)) return SITE_ADAPTERS[i];
    }
    return null;
  }

  function isDetailPage(adapter, url) {
    if (!adapter) return false;
    try {
      var u = new URL(url);
      return adapter.detailPattern.test(u.pathname + u.search);
    } catch (e) {
      return false;
    }
  }

  /* 招聘平台列表页常见的「非详情页」特征，用于避免在搜索页误注入面板 */
  var LIST_PAGE_HINTS = /\/(web\/geek\/jobs|job\/list|jobslist|zhaopin|jobs|search|list)(\/|\?|$)/i;

  function looksLikeListPage(url) {
    try {
      var u = new URL(url);
      return LIST_PAGE_HINTS.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  global.JR_ADAPTERS = {
    SITE_ADAPTERS: SITE_ADAPTERS,
    getAdapter: getAdapter,
    isDetailPage: isDetailPage,
    looksLikeListPage: looksLikeListPage
  };
})(typeof window !== 'undefined' ? window : globalThis);
