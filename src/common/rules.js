/* 岗位雷达 · 规则库与打分引擎
 * 词库直接来自《热门紧缺岗位投递关键词速查表》，五类岗位族群 + 强/弱/排除信号词。
 * 设计原则：
 *   1. 证据不足不判伪——JD 太短时只标「信息不足」，不下结论。
 *   2. 排除词只看标题，不看正文——避免误伤正文里的正常职责描述。
 *   3. 每一条加减分都给出可读理由，分数必须能被人工复核。
 */
(function (global) {
  'use strict';

  var U = global.JR_UTIL;

  /* ---------- 五类岗位族群 ---------- */
  var GROUPS = [
    {
      id: 'A',
      label: 'AI 应用 / Agent 开发',
      short: 'AI应用',
      title: [
        'AI Agent', '智能体', 'LLM 应用', 'LLM应用', '大模型应用', 'AI 应用', 'AI应用',
        'Applied AI', 'Agentic', '数字员工', 'Multi-Agent', 'AI 解决方案', 'AI 产品'
      ],
      tech: [
        'RAG', 'GraphRAG', 'LangGraph', 'LangChain', 'LlamaIndex', 'AutoGen', 'CrewAI',
        'Dify', 'n8n', 'MCP', 'Function Calling', '工具调用', '任务编排', '记忆模块',
        'Skill Library', '向量数据库', '评测体系', 'LoRA', 'SFT'
      ]
    },
    {
      id: 'B',
      label: 'FDE / 现场交付与部署',
      short: 'FDE交付',
      title: [
        'FDE', 'Forward Deployed', '前沿部署', '前线部署', '前向部署', '前置部署',
        '现场部署', '解决方案部署', '交付工程师', '实施工程师', '解决方案工程师',
        '场景交付', 'AI 应用交付', '政企交付', '部署工程师', 'AI 转型'
      ],
      tech: [
        'POC', '场景诊断', '验收口径', '数据不出域', '数据脱敏', '信创', '私有化部署',
        '客户现场联调', '需求抽象', '操作手册', '续约扩容', '昇腾', 'CANN', 'Harness', '驻场'
      ]
    },
    {
      id: 'C',
      label: 'AI Infra / 推理优化 / HPC',
      short: 'AI Infra',
      title: [
        '推理优化', '推理引擎', '大模型推理', '算子开发', '模型部署', 'AI Infra',
        '高性能计算', 'HPC', 'GPU 调度', '智算', '推理加速', '算子加速', 'MLOps',
        'LLMOps', 'AI 编译器', '端侧 infra'
      ],
      tech: [
        'vLLM', 'SGLang', 'TensorRT-LLM', 'Triton', 'TGI', 'LMCache', 'CUDA',
        'Ascend C', 'CANN', 'PD 分离', 'KV Cache', 'Prefix Caching', 'Chunked Prefill',
        '投机解码', 'AWQ', 'GPTQ', 'FP8', 'INT4', 'MoE', 'NCCL', 'HCCL',
        'InfiniBand', 'RDMA', 'Ray Serve', 'Slurm', 'TTFT', 'TPOT', 'Prefill',
        'Decode', 'Profiling', 'FlashAttention', '算子融合', 'Megatron-LM',
        'DeepSpeed', 'verl', '单位 Token 成本', '有效吞吐'
      ]
    },
    {
      id: 'D',
      label: '智能驾驶 / 具身智能',
      short: '智驾具身',
      title: [
        '端到端', 'VLA', '世界模型', '规控', 'PNC', 'SLAM', '感知算法', 'BEV',
        '运动控制', '强化学习', '数据闭环', '闭环仿真', '自动驾驶', '智驾',
        '具身智能', '机器人', 'VLM', '三维重建', '自动标注', '灵巧手', 'VLN'
      ],
      tech: [
        'VLA', 'VLM', 'World Model', 'BEV', 'OCC', 'ORB-SLAM', 'VINS', 'MPC',
        'RRT', 'ROS2', 'Sim2Real', '闭环仿真', '三维渲染', 'TensorRT', 'Orin',
        'CLIP', 'BLIP', 'PPO', 'GRPO', 'AUTOSAR', 'SOME/IP', 'DDS', 'QNX',
        'EtherCAT', 'BSP', '功能安全', '车规级'
      ]
    },
    {
      id: 'E',
      label: '政企 / 国央企 / 私有化落地',
      short: '政企',
      title: [
        '人工智能岗', '政务 AI', '政务AI', '语料治理', '垂类智能体', 'AI 策略训练师',
        'AI策略训练师', '数智化', '国央企', '事业单位', '平台工程师岗'
      ],
      tech: [
        '私有化部署', '数据不出域', '数据不出省', '信创', '国产化适配', '鲲鹏',
        '麒麟', '昇腾', '等保', '分级权限', '日志审计', '语料治理', '标注标准',
        '知识库', 'Text2SQL', 'Text2Chart', '公文辅助', '政策解读', '上线验收', '驻场交付'
      ]
    }
  ];

  /* ---------- 建设动作与工程指标：代表「有预算、真在建设项目」 ---------- */
  var ACTION_TERMS = [
    '迁移', '替换', '重构', '从 0 到 1', '从0到1', '二次开发', '源码级',
    '自研', '建设', '改造', '调优', '压测', '灰度', '上线'
  ];

  var METRIC_TERMS = [
    'QPS', 'P99', '准确率', '召回率', '回归评测', 'eval', '监控告警',
    '故障兜底', 'SLA', 'A/B 测试', 'Token 预算', '模型分级路由', '成本优化'
  ];

  /* ---------- 弱信号：试点岗 / 伪岗位 / 外包 ---------- */
  var WEAK_TERMS = [
    { t: '熟悉 ChatGPT', w: -12, note: '只要求会用工具，非工程能力' },
    { t: '熟悉 Copilot', w: -10, note: '只要求会用工具' },
    { t: '提示词优化', w: -8, note: '纯提示词职责，已被工具替代' },
    { t: '提示词工程', w: -8, note: '纯提示词职责' },
    { t: 'Prompt 工程师', w: -14, note: '纯 Prompt 专职岗' },
    { t: '数据标注', w: -10, note: '标注类职责，非工程岗' },
    { t: '包就业', w: -30, note: '培训招生话术', flag: 'training' },
    { t: '零基础', w: -30, note: '培训招生话术', flag: 'training' },
    { t: '招生', w: -22, note: '疑似培训机构', flag: 'training' },
    { t: '培训生', w: -18, note: '培训性质', flag: 'training' },
    { t: '劳务派遣', w: -18, note: '劳务派遣，非甲方编制', flag: 'outsourcing' },
    { t: '人力外包', w: -18, note: '人力外包', flag: 'outsourcing' },
    { t: '人天', w: -12, note: '人天计价，按人头结算', flag: 'outsourcing' },
    { t: '外派', w: -12, note: '外派驻场', flag: 'outsourcing' }
  ];

  /* ---------- 反向排除词：正在收缩的岗位名，只看标题 ---------- */
  var EXCLUDE_TERMS = [
    '初级前端', '初级后端', '手工测试', '功能测试', '软件测试',
    'NLP 算法', '语音合成', '语音算法', '数据标注',
    'Prompt 工程师', '提示词工程师', '通用算法'
  ];

  /* ---------- 模型名堆砌检测 ---------- */
  var MODEL_TERMS = ['GPT', 'Claude', 'Llama', 'Qwen', 'DeepSeek', 'Gemini', '文心一言', '通义千问', '豆包'];

  /* 预编译匹配器 */
  var compiledGroups = GROUPS.map(function (g) {
    return {
      id: g.id,
      label: g.label,
      short: g.short,
      title: g.title.map(U.matcher).filter(Boolean),
      tech: g.tech.map(U.matcher).filter(Boolean)
    };
  });

  /* 全局技术词索引：term -> 归属族群集合 */
  var techIndex = [];
  (function buildTechIndex() {
    var seen = Object.create(null);
    compiledGroups.forEach(function (g) {
      g.tech.forEach(function (m) {
        if (seen[m.term]) {
          if (seen[m.term].indexOf(g.id) === -1) seen[m.term].push(g.id);
          return;
        }
        seen[m.term] = [g.id];
        techIndex.push({ matcher: m, groups: seen[m.term] });
      });
    });
  })();

  var compiledActions = ACTION_TERMS.map(U.matcher).filter(Boolean);
  var compiledMetrics = METRIC_TERMS.map(U.matcher).filter(Boolean);
  var compiledWeak = WEAK_TERMS.map(function (w) {
    var m = U.matcher(w.t);
    return m ? { matcher: m, w: w.w, note: w.note, flag: w.flag || null } : null;
  }).filter(Boolean);
  var compiledExclude = EXCLUDE_TERMS.map(U.matcher).filter(Boolean);
  var compiledModels = MODEL_TERMS.map(U.matcher).filter(Boolean);

  var GRADE_INFO = {
    strong: { label: '强信号', desc: '有具体技术栈与建设项目，值得优先投', level: 4 },
    neutral: { label: '中性', desc: '方向对得上，但证据不足以判断真假', level: 3 },
    weak: { label: '偏弱', desc: '信号偏弱或存在减分项，需人工核验', level: 2 },
    poor: { label: '高概率伪岗', desc: '命中多项减分项，建议直接跳过', level: 1 },
    insufficient: { label: '信息不足', desc: 'JD 太短或抽取失败，不下结论', level: 0 },
    irrelevant: { label: '非目标岗位', desc: '未命中任何目标族群词，可能是别类岗位', level: 0 }
  };

  /* 判定岗位族群：标题优先，其次 JD 前 800 字，最后技术词兜底。
   * 两轮分开算分，避免「标题命中数」与「技术词命中数」两个不同尺度的分数直接比较。
   */
  function detectGroup(jobTitle, jdText) {
    var title = U.clean(jobTitle);
    var head = U.clean(jdText).slice(0, 800);
    var best = null;
    var bestScore = 0;

    // 第一轮：标题命中（权重高），JD 开头命中（权重低）
    compiledGroups.forEach(function (g) {
      var s = 0;
      g.title.forEach(function (m) {
        if (title && m.test(title)) s += 3;
        else if (head && m.test(head)) s += 1;
      });
      if (s > bestScore) {
        bestScore = s;
        best = g;
      }
    });
    if (best && bestScore > 0) {
      return { id: best.id, label: best.label, short: best.short };
    }

    // 第二轮：标题没线索时，用 JD 里的技术词归属判断（至少命中 2 个才算）
    compiledGroups.forEach(function (g) {
      var ts = 0;
      g.tech.forEach(function (m) {
        if (head && m.test(head)) ts += 1;
      });
      if (ts >= 2 && ts > bestScore) {
        bestScore = ts;
        best = g;
      }
    });

    if (!best || bestScore === 0) {
      return { id: 'OTHER', label: '未归类', short: '未归类' };
    }
    return { id: best.id, label: best.label, short: best.short };
  }

  /* 主评分函数
   * input: { jobTitle, jdText, salaryText, experienceText }
   */
  function evaluate(input) {
    input = input || {};
    var title = U.clean(input.jobTitle);
    var jd = U.clean(input.jdText);
    var salaryText = U.clean(input.salaryText);
    var expText = U.clean(input.experienceText);

    var group = detectGroup(title, jd);
    var text = title + '\n' + jd;

    var strong = [];
    var actions = [];
    var metrics = [];
    var weak = [];
    var excludes = [];
    var flags = Object.create(null);

    techIndex.forEach(function (item) {
      if (item.matcher.test(text)) {
        strong.push({ term: item.matcher.term, groups: item.groups });
      }
    });

    compiledActions.forEach(function (m) {
      if (m.test(text)) actions.push({ term: m.term });
    });

    compiledMetrics.forEach(function (m) {
      if (m.test(text)) metrics.push({ term: m.term });
    });

    compiledWeak.forEach(function (item) {
      if (item.matcher.test(text)) {
        weak.push({ term: item.matcher.term, w: item.w, note: item.note });
        if (item.flag) flags[item.flag] = true;
      }
    });

    // 排除词只扫标题 + JD 前 120 字，避免误伤正文职责描述
    var titleZone = title + '\n' + jd.slice(0, 120);
    compiledExclude.forEach(function (m) {
      if (m.test(titleZone)) excludes.push({ term: m.term });
    });
    if (excludes.length) flags.shrinking = true;

    // 模型名堆砌：出现 ≥2 个模型名却没有任何技术栈证据
    if (strong.length === 0) {
      var modelHits = compiledModels.filter(function (m) {
        return m.test(text);
      });
      if (modelHits.length >= 2) {
        weak.push({
          term: '模型名堆砌（' + modelHits.map(function (m) { return m.term; }).join('/') + '）',
          w: -10,
          note: '只罗列模型名，无具体技术栈'
        });
        flags.modelPile = true;
      }
    }

    // 通篇「参与」而无「负责/主导/交付」
    var participateCount = (text.match(/参与/g) || []).length;
    if (participateCount >= 3 && !/负责|主导|牵头|交付/.test(text)) {
      weak.push({ term: '通篇「参与」', w: -8, note: '无负责/主导/交付表述，权责模糊' });
      flags.participateOnly = true;
    }

    // 经验与薪资倒挂：5 年以上却 ≤15K
    var exp = U.parseExperience(expText || text.slice(0, 400));
    var sal = U.parseSalary(salaryText);
    if (exp.min !== null && exp.min >= 5 && sal.max !== null && sal.max > 0 && sal.max <= 15) {
      flags.salaryMismatch = true;
      weak.push({
        term: '经验与薪资倒挂（' + exp.min + ' 年以上 / 上限 ' + sal.max + 'K）',
        w: -12,
        note: '权责与薪资明显不匹配'
      });
    }

    /* ---- 计分 ----
     * 曲线设计目标：技术词 4 个≈中性、6 个≈中上、8 个以上才够强信号，
     * 避免「沾两个技术名词就给高分」，也给建设动作与工程指标留下增量空间。
     */
    var evTech = Math.min(strong.length, 10) * 6;
    var evAction = Math.min(actions.length, 2) * 6;
    var evMetric = Math.min(metrics.length, 3) * 5;
    var groupBonus = group.id === 'OTHER' ? -8 : 4;

    var weakSum = weak.reduce(function (s, w) { return s + w.w; }, 0);
    var excludePen = excludes.length ? -25 : 0;

    var raw = 26 + evTech + evAction + evMetric + groupBonus + weakSum + excludePen;
    var score = U.clamp(Math.round(raw), 0, 100);

    /* ---- 分级 ----
     * 判定顺序有讲究：
     *   1) 命中外包/培训/收缩这类硬性风险项，直接按分数定档，不因文本短而回避；
     *   2) 文本过短说明抽取失败，不下结论；
     *   3) 抽到了文本但一个目标词都没有，判为非目标岗位；
     *   4) 其余按分数分档。
     */
    var evidence = strong.length + actions.length + metrics.length;
    var hardFlag = flags.shrinking || flags.training || flags.outsourcing;
    var grade;

    function byScore(s) {
      if (s >= 80) return 'strong';
      if (s >= 55) return 'neutral';
      if (s >= 35) return 'weak';
      return 'poor';
    }

    if (hardFlag) {
      grade = byScore(score);
    } else if (jd.length < 120) {
      grade = 'insufficient';
    } else if (group.id === 'OTHER' && evidence === 0) {
      grade = 'irrelevant';
    } else {
      grade = byScore(score);
    }

    return {
      group: group.id,
      groupLabel: group.label,
      groupShort: group.short,
      score: score,
      grade: grade,
      gradeLabel: GRADE_INFO[grade].label,
      gradeDesc: GRADE_INFO[grade].desc,
      strong: strong,
      actions: actions,
      metrics: metrics,
      weak: weak,
      excludes: excludes,
      flags: Object.keys(flags),
      evidenceCount: strong.length + actions.length + metrics.length,
      jdLength: jd.length,
      experience: exp,
      salary: sal
    };
  }

  /* 由抽取字段计算记录主键：平台 + 公司 + 职位 + 薪资 归一化 */
  function makeKey(platform, company, jobTitle, salaryText) {
    return U.hash([
      U.squeeze(platform),
      U.squeeze(company),
      U.squeeze(jobTitle),
      U.squeeze(salaryText)
    ].join('|'));
  }

  global.JR_RULES = {
    GROUPS: GROUPS,
    GRADE_INFO: GRADE_INFO,
    ACTION_TERMS: ACTION_TERMS,
    METRIC_TERMS: METRIC_TERMS,
    WEAK_TERMS: WEAK_TERMS,
    EXCLUDE_TERMS: EXCLUDE_TERMS,
    evaluate: evaluate,
    detectGroup: detectGroup,
    makeKey: makeKey
  };
})(typeof window !== 'undefined' ? window : globalThis);
