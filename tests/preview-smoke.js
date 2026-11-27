/* 自包含预览页冒烟测试：node tests/preview-smoke.js
 * 确认 preview.html 内联脚本能独立跑通（预览服务只暴露单个目录，外部相对路径会 404）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const file = path.join(__dirname, '..', 'preview.html');
const html = fs.readFileSync(file, 'utf8');
const popup = fs.readFileSync(path.join(__dirname, '..', 'src/popup/popup.html'), 'utf8');
const popupCss = fs.readFileSync(path.join(__dirname, '..', 'src/popup/popup.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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

check('preview.html 无外部脚本引用', html.indexOf('../src/') === -1);
check('preview.html 已内联打分引擎', html.indexOf('JR_RULES') !== -1);
check('preview.html 已内联面板', html.indexOf('jr-panel') !== -1);
check('弹窗引用独立样式且保留橙色主题',
  popup.indexOf('popup.css') !== -1 && popupCss.indexOf('--accent:#e86b0a') !== -1);
check('弹窗版本号与清单一致', popup.indexOf('v' + manifest.version) !== -1,
  '清单 ' + manifest.version);
check('清单版本与 package.json 一致', manifest.version === pkg.version,
  manifest.version + ' vs ' + pkg.version);
check('弹窗含三视图骨架',
  popup.indexOf('view-profiles') !== -1 && popup.indexOf('view-library') !== -1 && popup.indexOf('view-settings') !== -1);

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://www.zhipin.com/job_detail/abc123.html'
});

setTimeout(() => {
  const doc = dom.window.document;
  const host = doc.getElementById('jr-radar-host');

  check('预览页：面板宿主已创建', !!host);
  check('预览页：Shadow DOM 已创建', !!(host && host.shadowRoot));

  const root = host && host.shadowRoot;
  check('预览页：渲染出面板', !!(root && root.querySelector('.jr-panel')));

  const text = root ? root.textContent : '';
  check('预览页：显示分数与档位', text.indexOf('强信号') !== -1, text.slice(0, 80));
  check('预览页：显示与清单一致的版本',
    text.indexOf('白橙版 v' + manifest.version) !== -1,
    '期待 白橙版 v' + manifest.version);
  check('预览页：抽出职位名', text.indexOf('AI Infra 工程师') !== -1, text.slice(0, 120));
  check('预览页：列出技术栈词', text.indexOf('vLLM') !== -1);
  check('预览页：样本切换按钮已生成', doc.querySelectorAll('#btns [data-k]').length === 5);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}, 400);
