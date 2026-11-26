/* 面板预览驱动：用假页面跑真实的抽取 + 打分 + 渲染链路 */
(function () {
  'use strict';

  var A = window.JR_ADAPTERS;
  var E = window.JR_EXTRACT;
  var R = window.JR_RULES;
  var P = window.JR_PANEL;

  var SAMPLES = {
    infra: {
      label: 'AI Infra 强信号',
      title: 'AI Infra工程师-推理加速方向_深圳_40-70K·15薪-某智能科技股份有限公司-BOSS直聘',
      html: '<div class="job-banner">' +
        '<div class="name"><h1>AI Infra 工程师-推理加速方向</h1></div>' +
        '<div class="salary">40-70K·15薪</div>' +
        '<div class="info-primary"><p>深圳·南山区 5-10年 本科</p></div>' +
        '<div class="company-info"><a class="company-name">某智能科技股份有限公司</a></div>' +
        '</div>' +
        '<div class="job-boss-info"><span class="boss-active-time">今日活跃</span></div>' +
        '<div class="job-sec-text">岗位职责：\n' +
        '1. 负责大模型推理引擎的性能优化，基于 vLLM 与 SGLang 做源码级二次开发；\n' +
        '2. 改造 PD 分离架构，优化 KV Cache 与 Prefix Caching 命中率；\n' +
        '3. 主导算子融合与 CUDA 层面的性能调优，推动 FlashAttention 落地。\n\n' +
        '任职要求：\n' +
        '1. 熟悉 TensorRT-LLM，具备 NCCL 多机多卡调试经验；\n' +
        '2. 能围绕 TTFT 与 P99 延迟做系统性优化，把单位 Token 成本降低 30%；\n' +
        '3. 建立回归评测体系与监控告警，具备线上故障兜底能力；\n' +
        '4. 本科及以上，5 年以上相关经验。</div>'
    },

    agent: {
      label: 'Agent 应用',
      title: 'AI Agent工程师_杭州_30-50K-某数据科技有限公司-BOSS直聘',
      html: '<div class="job-banner">' +
        '<div class="name"><h1>AI Agent 工程师</h1></div>' +
        '<div class="salary">30-50K</div>' +
        '<div class="info-primary"><p>杭州·余杭区 3-5年 本科</p></div>' +
        '<div class="company-info"><a class="company-name">某数据科技有限公司</a></div>' +
        '</div>' +
        '<div class="job-boss-info"><span class="boss-active-time">今日活跃</span></div>' +
        '<div class="job-sec-text">岗位职责：\n' +
        '1. 负责企业知识库问答 Agent 的建设，从 0 到 1 搭建 RAG 检索链路；\n' +
        '2. 使用 LangGraph 做任务编排与状态管理，接入 MCP 协议对接内部系统；\n' +
        '3. 设计工具调用方案与记忆模块，建立评测体系对回答质量做回归验证。\n\n' +
        '任职要求：\n' +
        '1. 熟悉向量数据库与 LlamaIndex，有 GraphRAG 实践优先；\n' +
        '2. 能独立完成 POC 到上线的全流程，负责线上效果归因与成本优化；\n' +
        '3. 熟悉 Python，3-5 年开发经验。</div>'
    },

    fde: {
      label: 'FDE 交付',
      title: '政企-前沿部署工程师(FDE)-场景交付方向-某数字科技有限公司-国聘',
      html: '<div class="job-banner">' +
        '<div class="name"><h1>政企-前沿部署工程师(FDE)-场景交付方向</h1></div>' +
        '<div class="salary">15-25K</div>' +
        '<div class="info-primary"><p>北京·海淀区 5-10年 硕士</p></div>' +
        '<div class="company-info"><a class="company-name">某数字科技有限公司</a></div>' +
        '</div>' +
        '<div class="job-boss-info"><span class="boss-active-time">3 天前活跃</span></div>' +
        '<div class="job-sec-text">岗位职责：\n' +
        '1. 负责政企客户大模型项目的现场交付，完成 POC 设计与场景诊断；\n' +
        '2. 制定验收口径，推动数据不出域的私有化部署方案落地；\n' +
        '3. 负责客户现场联调，编写操作手册并完成用户培训，支持后续续约扩容。\n\n' +
        '任职要求：\n' +
        '1. 熟悉 vLLM 私有化部署与昇腾 910B / CANN 环境；\n' +
        '2. 具备信创合规与等保经验，了解数据脱敏流程；\n' +
        '3. 有较强的需求抽象能力，5-10 年相关经验。</div>'
    },

    outsource: {
      label: '外包换名',
      title: 'AI应用开发工程师_上海_12-15K-某人力服务有限公司-BOSS直聘',
      html: '<div class="job-banner">' +
        '<div class="name"><h1>AI 应用开发工程师（驻场）</h1></div>' +
        '<div class="salary">12-15K</div>' +
        '<div class="info-primary"><p>上海·浦东新区 5-10年 大专</p></div>' +
        '<div class="company-info"><a class="company-name">某人力服务有限公司</a></div>' +
        '</div>' +
        '<div class="job-boss-info"><span class="boss-active-time">本周活跃</span></div>' +
        '<div class="job-sec-text">岗位职责：\n' +
        '熟悉 ChatGPT、Copilot 等 AI 工具的使用，参与公司 AI 项目的落地工作。\n' +
        '参与需求沟通，参与方案讨论，参与客户现场支持。\n' +
        '配合完成日常文档整理与会议纪要。\n\n' +
        '任职要求：\n' +
        '1. 本岗位为劳务派遣性质，按人天计价，长期驻场客户现场；\n' +
        '2. 具备良好的沟通能力，能适应客户现场的工作节奏；\n' +
        '3. 5 年以上工作经验。</div>'
    },

    junior: {
      label: '收缩岗位',
      title: '初级前端开发工程师_广州_8-12K-某网络科技有限公司-BOSS直聘',
      html: '<div class="job-banner">' +
        '<div class="name"><h1>初级前端开发工程师</h1></div>' +
        '<div class="salary">8-12K</div>' +
        '<div class="info-primary"><p>广州·天河区 1-3年 本科</p></div>' +
        '<div class="company-info"><a class="company-name">某网络科技有限公司</a></div>' +
        '</div>' +
        '<div class="job-boss-info"><span class="boss-active-time">今日活跃</span></div>' +
        '<div class="job-sec-text">岗位职责：\n' +
        '负责公司官网页面开发，熟悉 HTML/CSS/JavaScript，会使用 Vue 或 React 完成页面组件开发。\n' +
        '配合设计完成页面切图与样式调整，参与日常需求开发与线上问题维护。\n\n' +
        '任职要求：\n' +
        '1. 1-3 年前端开发经验，本科及以上学历；\n' +
        '2. 具备良好的沟通能力与团队协作意识；\n' +
        '3. 能接受一定强度的迭代节奏。</div>'
    }
  };

  var order = ['infra', 'agent', 'fde', 'outsource', 'junior'];
  var current = 'infra';

  function renderButtons() {
    var wrap = document.getElementById('btns');
    wrap.innerHTML = order.map(function (k) {
      return '<button data-k="' + k + '"' + (k === current ? ' class="on"' : '') + '>' + SAMPLES[k].label + '</button>';
    }).join('');
  }

  function render(k) {
    current = k;
    renderButtons();

    var s = SAMPLES[k];
    document.getElementById('fake').innerHTML = s.html;
    document.title = s.title;

    var adapter = A.SITE_ADAPTERS[0]; // BOSS 直聘适配器
    var f = E.extract(adapter);
    if (!f) return;

    var ev = R.evaluate({
      jobTitle: f.jobTitle,
      jdText: f.jdText,
      salaryText: f.salaryText,
      experienceText: f.experienceText
    });

    var data = {
      key: R.makeKey(f.platform, f.company, f.jobTitle, f.salaryText),
      fields: f,
      ev: ev,
      saved: false,
      seenCount: 0,
      staleDays: 0
    };

    P.bind();
    P.show(data, {
      onSave: function () {
        P.markSaved({ seenCount: 1, staleDays: k === 'fde' ? 46 : 3 });
      },
      onCopy: function (d, btn) {
        var old = btn.textContent;
        btn.textContent = '已复制（预览）';
        setTimeout(function () { btn.textContent = old; }, 1200);
      },
      onReextract: function () { render(current); }
    });
  }

  document.getElementById('btns').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-k]') : null;
    if (!b) return;
    render(b.getAttribute('data-k'));
  });

  render('infra');
})();
