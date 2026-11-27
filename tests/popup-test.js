/* popup 三视图测试：node tests/popup-test.js
 * 两类检查：
 *   1. 静态：脚本里 getElementById 的每个 id 都必须在 popup.html 里存在
 *      —— 这是"点了按钮没反应"最常见的原因，且在浏览器里只能靠肉眼发现
 *   2. 行为：脚本求值不抛错、初始视图正确、tab 与齿轮能切、返回能回到上一个视图
 * IndexedDB 在 jsdom 里不存在，岗位库视图会显示读取失败，这不影响本测试的断言范围。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const popupDir = path.join(root, 'src/popup');
const html = fs.readFileSync(path.join(popupDir, 'popup.html'), 'utf8');

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

/* ---------- 1. 静态 id 完整性 ---------- */
const JS_FILES = ['popup.js', 'export.js', 'view-library.js', 'view-profiles.js', 'view-settings.js'];
const allJs = JS_FILES.map((f) => fs.readFileSync(path.join(popupDir, f), 'utf8')).join('\n');

const ids = [];
const re = /getElementById\(\s*'([^']+)'\s*\)/g;
let m;
while ((m = re.exec(allJs))) {
  if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
}
check('扫描到足够多的元素引用', ids.length >= 25, String(ids.length));

const missing = ids.filter((id) => html.indexOf('id="' + id + '"') === -1);
check('脚本引用的 id 全部存在于 html', missing.length === 0, '缺失：' + missing.join(', '));

/* data-view 与 section id 必须对得上，否则切换 tab 会静默失败 */
const viewNames = [];
const vre = /data-view="([^"]+)"/g;
while ((m = vre.exec(html))) viewNames.push(m[1]);
check('顶部 tab 为两个（设置走齿轮）', viewNames.length === 2, viewNames.join(','));
['profiles', 'library', 'settings'].forEach((v) => {
  check('视图容器存在：#view-' + v, html.indexOf('id="view-' + v + '"') !== -1);
});

/* ---------- 2. 行为测试 ---------- */
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'chrome-extension://test/src/popup/popup.html'
});
const win = dom.window;

const PROFILES = [{
  id: 'p_demo',
  name: 'FDE',
  requirement: '面向客户的交付岗，能独立完成 POC 与部署联调。',
  mustHave: '私有化部署',
  redFlags: '纯外包',
  version: 2,
  createdAt: 1,
  updatedAt: 2
}];

const SETTINGS = {
  schemaVersion: 1,
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: 'sk-demodemodemodemo1234',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxOutputTokens: 1200,
  timeoutMs: 30000,
  stream: true,
  priceInPerM: 0,
  priceOutPerM: 0,
  autoJudge: true,
  dailyLimit: 100,
  monthlyBudgetWarn: 20,
  keyMode: 'local',
  lastProfileId: 'p_demo',
  promptVersion: 1,
  jsonModeSupported: true,
  disclosureAccepted: false
};

function makeArea(store) {
  return {
    get(keys, cb) {
      const out = {};
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
      list.forEach((k) => { if (k in store) out[k] = store[k]; });
      setImmediate(() => cb(out));
    },
    set(obj, cb) {
      Object.keys(obj).forEach((k) => { store[k] = obj[k]; });
      setImmediate(() => cb && cb());
    },
    remove(keys, cb) {
      const list = typeof keys === 'string' ? [keys] : keys;
      list.forEach((k) => { delete store[k]; });
      setImmediate(() => cb && cb());
    }
  };
}

const sent = [];
let payloadReply = { ok: true, payload: null };

win.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sent.push(msg.type);
      setImmediate(() => {
        if (msg.type === 'PROFILE_ACTIVE') {
          cb({ ok: true, list: PROFILES, profile: PROFILES[0], fellBack: false });
        } else if (msg.type === 'SETTINGS_GET') {
          cb({ ok: true, settings: SETTINGS });
        } else if (msg.type === 'STATS') {
          cb({
            ok: true, jobs: 4, profiles: 1, verdicts: 2,
            usageToday: { calls: 5, cost: 0.0021 },
            usageMonth: { calls: 12, cost: 0.0386 },
            budgetWarn: 20
          });
        } else if (msg.type === 'PROFILES_SAVE') {
          cb({ ok: true, record: Object.assign({}, PROFILES[0], { version: 3 }) });
        } else if (msg.type === 'PAYLOAD_GET') {
          cb(payloadReply);
        } else {
          cb({ ok: true });
        }
      });
    }
  },
  storage: { local: makeArea({}), session: makeArea({}) },
  permissions: {
    contains(q, cb) { setImmediate(() => cb(true)); },
    request(q, cb) { setImmediate(() => cb(true)); }
  },
  tabs: { create() {} }
};

let evalError = null;
try {
  [
    '../common/util.js',
    '../common/rules.js',
    '../common/db.js',
    '../common/settings.js',
    '../common/profiles.js',
    'export.js',
    'view-library.js',
    'view-profiles.js',
    'view-settings.js',
    'popup.js'
  ].forEach((f) => {
    win.eval(fs.readFileSync(path.join(popupDir, f), 'utf8'));
  });
} catch (e) {
  evalError = e;
}
check('十个脚本求值不抛错', evalError === null, evalError && evalError.message);

const $ = (sel) => win.document.querySelector(sel);
const viewOf = (name) => win.document.getElementById('view-' + name);

check('三个视图容器都渲染出来', win.document.querySelectorAll('.view').length === 3,
  String(win.document.querySelectorAll('.view').length));
check('初始进入判定标准视图', viewOf('profiles').classList.contains('active'));
check('初始不显示岗位库', !viewOf('library').classList.contains('active'));
check('初始不显示设置', !viewOf('settings').classList.contains('active'));

/* 等一次异步 load 完成 */
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async function () {
  await wait(20);

  check('初始化时请求了当前标准', sent.indexOf('PROFILE_ACTIVE') !== -1, sent.join(','));
  check('标准列表渲染出一条', win.document.querySelectorAll('.pf-item').length === 1,
    String(win.document.querySelectorAll('.pf-item').length));
  check('列表项显示名称', $('.pf-item-name') && $('.pf-item-name').textContent === 'FDE',
    $('.pf-item-name') && $('.pf-item-name').textContent);
  check('列表项标出当前生效', $('.pf-item-meta') && $('.pf-item-meta').textContent.indexOf('当前生效') !== -1,
    $('.pf-item-meta') && $('.pf-item-meta').textContent);
  check('表单已填充岗位名', win.document.getElementById('pfName').value === 'FDE',
    win.document.getElementById('pfName').value);
  check('表单显示版本号 v2', win.document.getElementById('pfVer').textContent === 'v2',
    win.document.getElementById('pfVer').textContent);
  check('编辑态不显示空态', win.document.getElementById('pfEmpty').style.display === 'none',
    win.document.getElementById('pfEmpty').style.display);
  check('高级区里带出一票否决', win.document.getElementById('pfRed').value === '纯外包',
    win.document.getElementById('pfRed').value);
  check('编辑已有标准时显示删除按钮',
    win.document.getElementById('pfDelete').style.display !== 'none');

  /* ---- 切到岗位库 ---- */
  win.document.querySelector('.tab[data-view="library"]').click();
  check('点 tab 切到岗位库', viewOf('library').classList.contains('active'));
  check('切走后判定标准不再激活', !viewOf('profiles').classList.contains('active'));
  check('tab 高亮跟着走',
    win.document.querySelector('.tab[data-view="library"]').classList.contains('active'));

  await wait(20);
  check('岗位库视图没有把页面搞崩', !!viewOf('library'));

  /* ---- 齿轮进设置 ---- */
  win.document.getElementById('btnSettings').click();
  check('齿轮打开设置', viewOf('settings').classList.contains('active'));
  check('设置视图隐藏 tab 条',
    win.document.querySelector('.tab[data-view="profiles"]').style.visibility === 'hidden');

  await wait(20);
  check('设置页请求了设置', sent.indexOf('SETTINGS_GET') !== -1, sent.join(','));
  check('设置页请求了统计', sent.indexOf('STATS') !== -1, sent.join(','));
  check('baseURL 已填充',
    win.document.getElementById('stBase').value === 'https://api.deepseek.com/v1',
    win.document.getElementById('stBase').value);
  check('Key 填进密码框',
    win.document.getElementById('stKey').value === 'sk-demodemodemodemo1234');
  check('Key 输入框类型是 password',
    win.document.getElementById('stKey').type === 'password');
  check('统计渲染出六个格子（含今日/本月花费）',
    win.document.querySelectorAll('#stStats .cell').length === 6,
    String(win.document.querySelectorAll('#stStats .cell').length));
  check('统计里出现今日花费 ¥0.0021',
    win.document.getElementById('stStats').textContent.indexOf('¥0.0021') !== -1,
    win.document.getElementById('stStats').textContent);
  check('统计里出现本月花费 ¥0.04',
    win.document.getElementById('stStats').textContent.indexOf('¥0.04') !== -1,
    win.document.getElementById('stStats').textContent);
  check('统计里出现今日调用 5',
    win.document.getElementById('stStats').textContent.indexOf('5') !== -1,
    win.document.getElementById('stStats').textContent);

  /* ---- 发给模型的内容（S4） ---- */
  check('payload 空态给出「去哪儿产生一条」',
    win.document.getElementById('stPayloadMsg').textContent.indexOf('还没有发送过请求') !== -1,
    win.document.getElementById('stPayloadMsg').textContent);
  check('payload 元信息区在空态下为空',
    win.document.getElementById('stPayloadMeta').innerHTML === '');

  /* ---- 有 payload 时的展示 ---- */
  payloadReply = {
    ok: true,
    payload: {
      at: Date.now(),
      dryRun: true,
      model: 'deepseek-chat',
      baseOrigin: 'https://api.deepseek.com',
      keyMasked: 'sk-****1234',
      promptVersion: 2,
      meta: { jdChars: 1234, jdTruncated: true, cacheKey: 'k|p|2|2|deepseek-chat|abc' },
      messages: [
        { role: 'system', content: 'SYS-TEXT-角色与契约' },
        { role: 'user', content: 'USER-TEXT-标准与正文' }
      ]
    }
  };
  win.JR_VIEW_SETTINGS.onShow();
  await wait(20);
  const pmeta = win.document.getElementById('stPayloadMeta').textContent;
  check('payload 元信息显示模型名', pmeta.indexOf('deepseek-chat') !== -1, pmeta);
  check('payload 元信息显示掩码 Key', pmeta.indexOf('sk-****1234') !== -1, pmeta);
  check('payload 元信息显示正文长度与截断', pmeta.indexOf('1234 字') !== -1 && pmeta.indexOf('已截断') !== -1, pmeta);
  check('payload 标出来源是试跑', pmeta.indexOf('试跑') !== -1, pmeta);
  check('payload 全文：system 段',
    win.document.getElementById('stPayloadSystem').textContent === 'SYS-TEXT-角色与契约',
    win.document.getElementById('stPayloadSystem').textContent);
  check('payload 全文：user 段',
    win.document.getElementById('stPayloadUser').textContent === 'USER-TEXT-标准与正文',
    win.document.getElementById('stPayloadUser').textContent);

  /* ---- 显示/隐藏 Key ---- */
  win.document.getElementById('stEye').click();
  check('点「显示」后 Key 变明文',
    win.document.getElementById('stKey').type === 'text');
  win.document.getElementById('stEye').click();
  check('再点一次变回密码', win.document.getElementById('stKey').type === 'password');

  /* ---- 返回 ---- */
  win.document.getElementById('stBack').click();
  check('从设置返回上一个视图（岗位库）', viewOf('library').classList.contains('active'));
  check('返回后 tab 重新可见',
    win.document.querySelector('.tab[data-view="profiles"]').style.visibility === 'visible');

  /* ---- 新建标准 ---- */
  win.document.querySelector('.tab[data-view="profiles"]').click();
  await wait(10);
  win.document.getElementById('pfNew').click();
  check('新建时清空岗位名', win.document.getElementById('pfName').value === '');
  check('新建时标题改为「新建标准」',
    win.document.getElementById('pfTitle').textContent === '新建标准',
    win.document.getElementById('pfTitle').textContent);
  check('新建时隐藏删除按钮',
    win.document.getElementById('pfDelete').style.display === 'none');
  check('新建时版本标签显示未保存',
    win.document.getElementById('pfVer').textContent === '未保存',
    win.document.getElementById('pfVer').textContent);

  /* ---- 试跑区（S4） ---- */
  check('有标准时显示试跑区',
    win.document.getElementById('pfDry').style.display === 'block',
    win.document.getElementById('pfDry').style.display);
  check('试跑按钮初始可点', win.document.getElementById('pfDryRun').disabled === false);

  win.document.getElementById('pfDryJd').value = '';
  win.document.getElementById('pfDryRun').click();
  check('试跑空正文时只提示、不发请求',
    win.document.getElementById('pfDryMsg').textContent.indexOf('先把岗位正文粘进来') !== -1,
    win.document.getElementById('pfDryMsg').textContent);
  check('空正文不会把按钮变成取消',
    win.document.getElementById('pfDryRun').textContent === '开始试跑',
    win.document.getElementById('pfDryRun').textContent);

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
