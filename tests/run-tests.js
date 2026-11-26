/* 规则引擎验证脚本：node tests/run-tests.js
 * 用构造的 JD 样本检验打分是否落在预期档位，避免上线后分数失真。
 */
require('../src/common/util.js');
require('../src/common/rules.js');
require('../src/content/extract.js');

var R = globalThis.JR_RULES;
var U = globalThis.JR_UTIL;
var E = globalThis.JR_EXTRACT;

var cases = [
  {
    name: 'AI Infra 推理优化（应 strong）',
    jobTitle: 'AI Infra 工程师-推理加速方向',
    expect: 'strong',
    jdText: '负责大模型推理引擎的性能优化。需要基于 vLLM 与 SGLang 做源码级二次开发，改造 PD 分离架构，' +
      '优化 KV Cache 与 Prefix Caching 命中率。要求熟悉 CUDA 编程与 FlashAttention，能独立完成算子融合。' +
      '当前线上日调用量 800 万次，主要问题是长上下文场景下 TTFT 抖动，需要把 P99 延迟压到 800ms 以内，' +
      '并把单位 Token 成本降低 30%。需要建立回归评测体系与监控告警，具备故障兜底能力。' +
      '有 NCCL 多机多卡调优与 TensorRT-LLM 落地经验优先。本科及以上，5 年以上相关经验。'
  },
  {
    name: 'AI Agent 应用（应 strong）',
    jobTitle: 'AI Agent 工程师',
    expect: 'strong',
    jdText: '负责企业知识库问答 Agent 的建设，从 0 到 1 搭建基于 RAG 的检索链路，使用 LangGraph 做任务编排与状态管理，' +
      '接入 MCP 协议对接内部业务系统。需要设计工具调用方案与记忆模块，并建立评测体系对回答质量做回归验证。' +
      '熟悉向量数据库与 LlamaIndex，有 GraphRAG 实践优先。负责线上效果归因与成本优化，' +
      '要求能独立完成 POC 到上线的全流程。3-5 年经验，本科及以上。'
  },
  {
    name: '外包驻场换名（应 poor）',
    jobTitle: 'AI 应用开发工程师（驻场）',
    expect: 'poor',
    jdText: '熟悉 ChatGPT、Copilot 等 AI 工具的使用，参与公司 AI 项目的落地工作。参与需求沟通，参与方案讨论，' +
      '参与客户现场支持。本岗位为劳务派遣性质，按人天计价，长期驻场客户现场。' +
      '需要配合完成日常文档整理与会议纪要。薪资 12-15K，要求 5 年以上经验。'
  },
  {
    name: '收缩岗位（应 poor）',
    jobTitle: '初级前端开发工程师',
    expect: 'poor',
    jdText: '负责公司官网页面开发，熟悉 HTML/CSS/JavaScript，会使用 Vue 或 React 完成页面组件开发。' +
      '配合设计完成页面切图与样式调整，参与日常需求开发与线上问题维护。' +
      '要求 1-3 年经验，能接受一定强度的迭代节奏，具备良好的沟通能力与团队协作意识。'
  },
  {
    name: 'JD 过短（应 insufficient）',
    jobTitle: '大模型算法工程师',
    expect: 'insufficient',
    jdText: '负责大模型相关算法研发。'
  },
  {
    name: '非目标岗位（应 irrelevant）',
    jobTitle: '区域销售经理',
    expect: 'irrelevant',
    jdText: '负责所辖区域的客户开发与维护，完成年度销售指标。需要定期拜访客户，建立并维护长期稳定的客户关系，' +
      '收集市场信息与竞品动态，形成区域市场分析报告。配合市场部完成产品推广活动，组织区域客户沙龙与行业展会，' +
      '跟进合同签署、订单交付与回款进度，协调内部资源解决客户问题。' +
      '负责区域内渠道伙伴的招募与培训，维护渠道价格体系，避免跨区窜货。' +
      '要求具备 3 年以上 ToB 销售经验，有制造业或能源行业客户资源优先，' +
      '具备较强的商务谈判能力与抗压能力，能适应每月 10 天以上的出差节奏。'
  },
  {
    name: 'FDE 政企交付（应 strong）',
    jobTitle: '政企-前沿部署工程师(FDE)-场景交付方向',
    expect: 'strong',
    jdText: '负责政企客户大模型项目的现场交付。需要完成 POC 设计、场景诊断与验收口径制定，' +
      '推动数据不出域的私有化部署方案落地。负责客户现场联调，编写操作手册并完成用户培训，支持后续续约扩容。' +
      '要求熟悉 vLLM 私有化部署与昇腾 910B / CANN 环境，具备信创合规与等保经验。5-10 年经验，薪资 15-25K。'
  },
  {
    name: '中等信息量（应 neutral）',
    jobTitle: '大模型应用开发工程师',
    expect: 'neutral',
    jdText: '负责公司内部知识库问答系统的开发与迭代，基于 RAG 搭建检索链路，使用 LangChain 对接现有业务系统。' +
      '要求熟悉向量数据库的使用与调优，能够借助 Dify 快速完成工作流编排，并搭建简单的评测体系验证回答质量。' +
      '参与需求分析、方案设计与代码评审，配合产品与测试同学完成上线。' +
      '3 年以上 Python 开发经验，本科及以上学历，具备良好的沟通与协作能力。'
  }
];

var titleCases = [
  {
    input: '「AI Agent工程师」_深圳_30-50K_3-5年_本科-某某科技有限公司-BOSS直聘',
    check: { jobTitle: 'AI Agent', company: '某某科技有限公司', salary: '30-50K', city: '深圳' }
  },
  {
    input: '大模型推理工程师-北京-40-70K·15薪-猎聘',
    check: { jobTitle: '大模型推理工程师', salary: '40-70K', city: '北京' }
  }
];

var pass = 0;
var fail = 0;

console.log('=== 打分用例 ===');
cases.forEach(function (c) {
  var ev = R.evaluate({
    jobTitle: c.jobTitle,
    jdText: c.jdText,
    salaryText: '',
    experienceText: ''
  });
  var ok = ev.grade === c.expect;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '✓' : '✗') + ' ' + c.name +
    '\n    期望 ' + c.expect + ' / 实际 ' + ev.grade + '（' + ev.score + ' 分，族群 ' + ev.groupShort + '）' +
    '\n    强信号 ' + ev.strong.length + '：' + ev.strong.map(function (x) { return x.term; }).slice(0, 8).join('、') +
    (ev.weak.length ? '\n    减分：' + ev.weak.map(function (x) { return x.term + '(' + x.w + ')'; }).join('、') : '')
  );
});

console.log('\n=== 页面标题解析用例 ===');
titleCases.forEach(function (t, i) {
  var r = E.parseDocTitle(t.input);
  var fails = [];
  Object.keys(t.check).forEach(function (k) {
    if (String(r[k] || '').indexOf(t.check[k]) === -1) {
      fails.push(k + ' 期望含 "' + t.check[k] + '" 实际 "' + r[k] + '"');
    }
  });
  if (fails.length) {
    fail++;
    console.log('✗ 用例 ' + (i + 1) + '\n    ' + fails.join('\n    ') + '\n    解析结果：' + JSON.stringify(r));
  } else {
    pass++;
    console.log('✓ 用例 ' + (i + 1) + ' → ' + JSON.stringify(r));
  }
});

console.log('\n=== 工具函数 ===');
var sal = U.parseSalary('30-60K·15薪');
console.log((sal.min === 30 && sal.max === 60 ? '✓' : '✗') + ' 薪资解析 30-60K·15薪 → ' + JSON.stringify(sal));
var sal2 = U.parseSalary('8000-12000元/月');
console.log((sal2.min === 8 && sal2.max === 12 ? '✓' : '✗') + ' 薪资解析 8000-12000元/月 → ' + JSON.stringify(sal2));
var exp = U.parseExperience('3-5年');
console.log((exp.min === 3 && exp.max === 5 ? '✓' : '✗') + ' 经验解析 3-5年 → ' + JSON.stringify(exp));

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
