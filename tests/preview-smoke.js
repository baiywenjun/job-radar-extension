/* 自包含预览页冒烟测试：node tests/preview-smoke.js
 * 确认 preview.html 内联脚本能独立跑通（预览服务只暴露单个目录，外部相对路径会 404）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const file = path.join(__dirname, '..', 'preview.html');
const html = fs.readFileSync(file, 'utf8');
const popup = fs.readFileSync(path.join(__dirname, '..', 'src/popup/popup.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

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
check('弹窗显示白橙版及橙色主题', popup.includes('白橙版 v0.1.5') && popup.includes('--accent:#e86b0a'));
check('扩展清单版本为 0.1.5', manifest.version === '0.1.5');

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
  check('预览页：显示白橙版标记', text.indexOf('白橙版 v0.1.5') !== -1);
  check('预览页：抽出职位名', text.indexOf('AI Infra 工程师') !== -1, text.slice(0, 120));
  check('预览页：列出技术栈词', text.indexOf('vLLM') !== -1);
  check('预览页：样本切换按钮已生成', doc.querySelectorAll('#btns [data-k]').length === 5);

  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}, 400);
