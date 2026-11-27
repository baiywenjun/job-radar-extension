/* 面板在模型模式下的渲染测试：node tests/panel-model-test.js
 *
 * 这类问题只在浏览器里才暴露，肉眼还容易漏：
 *   - 模型不给权重，减分项 chip 拼出「词␣␣」两个空格
 *   - 模型不产出「建设动作」，空态却还写「未命中建设动作或工程指标」
 *   - 底部没写清结论是模型给的还是本地规则给的
 * 所以这里逐个断言渲染后的文本与节点。
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('✓ ' + name);
  } else {
    fail++;
    console.log('✗ ' + name + (detail ? '\n    ' + detail : ''));
  }
}

const JD = '负责客户现场的大模型应用与智能体项目交付，基于 vLLM 搭建私有化推理服务，' +
  '使用 LangGraph 编排多智能体流程，建设评测回归体系与监控告警，需要 3-5 年经验并能驻场。';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.zhipin.com/web/geek/job?query=FDE',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const w = dom.window;

w.eval(fs.readFileSync(path.join(__dirname, '../src/common/util.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, '../src/content/panel.js'), 'utf8'));
const P = w.JR_PANEL;

function baseFields() {
  return {
    jobTitle: 'AI部署工程师（FDE）',
    company: '广东保伦电子',
    salaryText: '12-15K',
    city: '广州',
    experienceText: '3-5年',
    activeText: '',
    jdText: JD,
    platform: 'zhipin',
    siteName: 'BOSS直聘',
    url: 'https://www.zhipin.com/job_detail/x.html',
    sources: {
      jobTitle: '选择器·区', company: '列表匹配', salary: '选择器·区',
      city: '选择器·区', experience: '选择器·区', jd: '选择器'
    }
  };
}

function modelEv(over) {
  return Object.assign({
    group: 'AI_APP',
    groupLabel: 'AI 应用',
    groupShort: 'AI应用',
    score: 92,
    grade: 'strong',
    gradeLabel: '强信号',
    gradeDesc: '有具体技术栈与建设项目，值得优先投',
    strong: [
      { term: '私有化推理', note: '原文：基于 vLLM 搭建私有化推理服务', type: 'must' },
      { term: '智能体编排', note: '原文：LangGraph 编排多智能体流程', type: 'nice' }
    ],
    actions: [],
    metrics: [],
    weak: [],
    excludes: [],
    flags: [],
    evidenceCount: 2,
    jdLength: JD.length,
    missing: ['客户现场沟通'],
    modelMode: true
  }, over || {});
}

function makeData(over) {
  return Object.assign({
    key: 'k1',
    fields: baseFields(),
    ev: modelEv(),
    verdict: {
      grade: 'strong', score: 92, confidence: 0.8,
      oneLine: '私有化推理与智能体交付都在做，值得投',
      model: 'deepseek-chat', ms: 4200,
      usage: { in: 1500, out: 200, total: 1700 },
      profileName: 'FDE'
    },
    judge: { status: 'done', model: 'deepseek-chat', ms: 4200, usage: { total: 1700 } },
    profiles: [{ id: 'p1', name: 'FDE', version: 3 }, { id: 'p2', name: 'AI应用', version: 1 }],
    activeProfileId: 'p1',
    activeVersion: 3,
    saved: false,
    seenCount: 0,
    staleDays: 0
  }, over || {});
}

function shadow() {
  const host = w.document.getElementById('jr-radar-host');
  return host && host.shadowRoot;
}
function panelText() {
  const s = shadow();
  return s ? s.textContent : '';
}
function chipTexts() {
  const s = shadow();
  if (!s) return [];
  return Array.prototype.map.call(s.querySelectorAll('.jr-chip'), (el) => el.textContent);
}

let switched = null;
const handlers = {
  onSave: () => {},
  onCopy: () => {},
  onDiag: () => {},
  onReextract: () => {},
  onSwitchProfile: (id) => { switched = id; }
};

/* ---------- 1. 模型结论的正常态 ---------- */
const d1 = makeData();
P.bind();
P.show(d1, handlers);

const t1 = panelText();
check('显示模型的一句话结论',
  t1.indexOf('私有化推理与智能体交付都在做') !== -1);
check('不再显示规则引擎的套话描述',
  t1.indexOf('有具体技术栈与建设项目，值得优先投') === -1);
check('底部写明判定来源是模型',
  /判定：模型 deepseek-chat/.test(t1), t1.slice(-120));
check('底部带 token 数（千位换算）', /1\.7k tokens/.test(t1), t1.slice(-120));
check('底部带耗时', /4\.2s/.test(t1), t1.slice(-120));
check('底部仍保留 JD 来源', /JD 来源：选择器/.test(t1));

/* ---------- 2. 标准切换条 ---------- */
const sel = shadow().querySelector('select[data-act="profile"]');
check('两条标准时出现下拉', !!sel);
check('下拉包含两条标准', sel && sel.options.length === 2,
  sel ? String(sel.options.length) : '无');
check('下拉默认选中当前标准', sel && sel.value === 'p1', sel ? sel.value : '无');
check('显示标准版本号', /v3/.test(panelText()));

if (sel) {
  sel.value = 'p2';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
}
check('切换标准触发回调', switched === 'p2', String(switched));

/* 单标准：不该出现只有一个选项的下拉 */
switched = null;
const d2 = makeData({ profiles: [{ id: 'p1', name: 'FDE', version: 3 }] });
P.show(d2, handlers);
check('只有一条标准时不出现下拉',
  !shadow().querySelector('select[data-act="profile"]'));

/* ---------- 3. 三处空态文案 ---------- */
const d3 = makeData({
  ev: modelEv({ strong: [], weak: [], missing: [] })
});
P.show(d3, handlers);
const t3 = panelText();
check('强信号空态改为"模型未给出支持证据"',
  t3.indexOf('模型未给出支持证据') !== -1, t3);
check('模型模式下不再出现规则的空态文案',
  t3.indexOf('未命中具体技术栈词') === -1);
check('减分项空态改为"模型未指出减分项"',
  t3.indexOf('模型未指出减分项') !== -1);
check('动作区空态不再写"未命中建设动作"',
  t3.indexOf('未命中建设动作或工程指标') === -1);

/* 模型点出未提及项时，用 missing 填充第二块 */
const d4 = makeData({
  ev: modelEv({ missing: ['客户现场沟通', '私有化部署经验'] })
});
P.show(d4, handlers);
const t4 = panelText();
check('未提及项以「未提及 ·」呈现',
  t4.indexOf('未提及 · 客户现场沟通') !== -1, t4);
check('第二块标题在模型模式改名为未提及',
  t4.indexOf('标准要求但原文未提及') !== -1);

/* ---------- 4. 减分项 chip 不能拼出空权重 ---------- */
const d5 = makeData({
  ev: modelEv({
    grade: 'weak', score: 45, gradeLabel: '偏弱',
    weak: [{ term: '纯外包派遣', note: '原文：本岗位为人力外包', type: 'red' }]
  })
});
P.show(d5, handlers);
const weakChip = shadow().querySelector('.jr-chip.b');
check('模型模式减分项 chip 存在', !!weakChip);
check('无权重时不拼出多余空格',
  weakChip && weakChip.textContent === '纯外包派遣',
  weakChip ? JSON.stringify(weakChip.textContent) : '无');
check('减分项的 title 是原文引用',
  weakChip && /原文：本岗位为人力外包/.test(weakChip.getAttribute('title') || ''),
  weakChip ? weakChip.getAttribute('title') : '无');

/* 规则模式仍要带权重数字，别把老行为改坏 */
const dRules = makeData({
  verdict: null,
  judge: { status: 'off', error: '未配置模型 API' },
  profiles: [],
  ev: {
    group: 'AI_APP', groupLabel: 'AI 应用', groupShort: 'AI应用',
    score: 42, grade: 'weak', gradeLabel: '偏弱', gradeDesc: '信号偏弱或存在减分项，需人工核验',
    strong: [{ term: 'vLLM' }], actions: [], metrics: [],
    weak: [{ term: '纯外包派遣', w: -26, note: '外包' }], excludes: [],
    flags: [], evidenceCount: 1, jdLength: JD.length
  }
});
P.show(dRules, handlers);
const rulesChip = shadow().querySelector('.jr-chip.b');
check('规则模式减分项仍带权重',
  rulesChip && rulesChip.textContent === '纯外包派遣 -26',
  rulesChip ? JSON.stringify(rulesChip.textContent) : '无');
check('规则模式底部写明是本地规则',
  /判定：本地规则（未配置模型 API）/.test(panelText()), panelText().slice(-120));
check('规则模式出现规则的空态文案',
  panelText().indexOf('未命中建设动作或工程指标') !== -1);

/* ---------- 5. 分歧黄条 ---------- */
const d6 = makeData({
  divergence: { delta: -2, rulesGrade: 'strong', modelGrade: 'weak', rulesLabel: '强信号', modelLabel: '偏弱' }
});
P.show(d6, handlers);
const t6 = panelText();
check('档位差 2 级时出现分歧提示',
  t6.indexOf('规则与模型分歧') !== -1, t6);
check('分歧提示写明两个档位',
  t6.indexOf('强信号') !== -1 && t6.indexOf('偏弱') !== -1);
check('分歧提示给出相差级数', t6.indexOf('相差 2 级') !== -1, t6);

const d7 = makeData({ divergence: null });
P.show(d7, handlers);
check('无分歧时不出现黄条', panelText().indexOf('规则与模型分歧') === -1);

/* ---------- 6. 判定中 / 失败态 ---------- */
const d8 = makeData({
  verdict: null,
  judge: { status: 'running', chars: 620, model: 'deepseek-chat' },
  ev: modelEv({ modelMode: false })
});
P.show(d8, handlers);
check('判定中显示进度字数',
  /判定：模型判定中… 已收 620 字/.test(panelText()), panelText().slice(-120));

const d9 = makeData({
  verdict: null,
  judge: { status: 'failed', code: 'E_AUTH', error: 'API Key 无效或权限不足' },
  ev: modelEv({ modelMode: false })
});
P.show(d9, handlers);
check('判定失败写明错误码与原因',
  /判定：本地规则（模型失败：API Key 无效或权限不足）/.test(panelText()),
  panelText().slice(-140));
check('判定失败不弹诊断卡（仍显示岗位面板）',
  shadow().querySelector('.jr-grade') !== null);

/* ---------- 7. 局部刷新不重建宿主 ---------- */
const hostBefore = w.document.getElementById('jr-radar-host');
const d10 = makeData();
P.show(d10, handlers);
P.update((data) => {
  data.judge = { status: 'done', model: 'deepseek-chat', ms: 900, usage: { total: 300 } };
  data.verdict.oneLine = '刷新后的结论';
});
const hostAfter = w.document.getElementById('jr-radar-host');
check('重绘复用同一个宿主节点', hostBefore === hostAfter);
check('update 后内容已更新',
  panelText().indexOf('刷新后的结论') !== -1, panelText().slice(0, 200));
check('宿主被移出文档后 update 不抛错',
  (function () {
    hostAfter.parentNode.removeChild(hostAfter);
    try { P.update(() => {}); return true; } catch (e) { return false; }
  })());

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
dom.window.close();
process.exit(fail ? 1 : 0);
