/* 生成自包含预览页：node tests/build-preview.js
 * 预览服务只暴露 demo.html 所在目录，../src/ 的相对引用会 404，
 * 所以把全部脚本内联成单文件 preview.html。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const pairs = [
  ['../src/common/util.js', 'src/common/util.js'],
  ['../src/common/rules.js', 'src/common/rules.js'],
  ['../src/content/adapters.js', 'src/content/adapters.js'],
  ['../src/content/extract.js', 'src/content/extract.js'],
  ['../src/content/panel.js', 'src/content/panel.js'],
  ['demo.js', 'tests/demo.js']
];

let html = fs.readFileSync(path.join(root, 'tests/demo.html'), 'utf8');

for (const [src, rel] of pairs) {
  const tag = `<script src="${src}"></script>`;
  if (!html.includes(tag)) {
    throw new Error('未找到脚本标签：' + tag);
  }
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  if (/<\/script>/i.test(code)) {
    throw new Error('脚本内含 </script>，需要转义：' + rel);
  }
  // 必须用函数式替换：源码里存在 '$&' 这类序列，
  // 如果作为字符串替换值会被当成「匹配到的子串」展开，导致内容错位。
  html = html.replace(tag, function () {
    return '<script>\n' + code + '\n</script>';
  });
}

html = html.replace(
  '<title>岗位雷达 · 面板预览</title>',
  '<title>岗位雷达 · 面板预览（自包含）</title>'
);
html = html.replace(
  '<span class="hint">用假数据演示「抽取 → 打分 → 渲染」，不需要安装扩展</span>',
  '<span class="hint">用假数据演示「抽取 → 打分 → 渲染」 · 本文件已内联全部脚本，可单独双击打开</span>'
);

const out = path.join(root, 'preview.html');
fs.writeFileSync(out, html, 'utf8');

if (html.indexOf('../src/') !== -1) {
  throw new Error('仍存在外部相对引用，生成失败');
}

console.log('已生成 preview.html（' + (fs.statSync(out).size / 1024).toFixed(1) + ' KB，无外部依赖）');
