/* 新版 BOSS 版式回归测试：node tests/geom-test.js
 *
 * 复现现场：zhipin 把 /web/geek/jobs 的类名整体换掉（.job-banner / .job-sec-text
 * 全部失效），而且会拦截 F12，用户无法自己取 class 回来校准。
 * 修复思路是不再依赖类名：用「详情列的几何范围 + 计算字号」定位字段。
 *
 * 这里构造一个「一个既有选择器都命中不了」的双列页面，并把每块元素的
 * 位置写进 data-box 属性，用桩函数顶替 getBoundingClientRect（jsdom 恒返回 0）。
 * 同时覆盖：有布局信息（走几何）与没有布局信息（退回结构推断）两条路径。
 */
const { JSDOM } = require('jsdom');

require('../src/common/util.js');
require('../src/common/rules.js');
require('../src/content/adapters.js');
require('../src/content/extract.js');
require('../src/content/diagnose.js');

const U = globalThis.JR_UTIL;
const E = globalThis.JR_EXTRACT;
const A = globalThis.JR_ADAPTERS;
const DG = globalThis.JR_DIAGNOSE;

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

/* 用 data-box="left,top,width,height" 顶替布局：元素自身没有就继承最近祖先。
   真实浏览器里 getBoundingClientRect 会给真实值，这里只是把「双列」这件事表达出来。 */
function stubLayout(win) {
  win.Element.prototype.getBoundingClientRect = function () {
    let el = this;
    let hops = 0;
    let box = null;
    while (el && hops++ < 40) {
      const raw = el.getAttribute && el.getAttribute('data-box');
      if (raw) {
        box = raw.split(',').map(Number);
        break;
      }
      el = el.parentElement;
    }
    if (!box) box = [0, 0, 1440, 900];
    return {
      left: box[0], top: box[1], width: box[2], height: box[3],
      right: box[0] + box[2], bottom: box[1] + box[3],
      x: box[0], y: box[1]
    };
  };
}

const JD_TEXT =
  '负责持续集成、持续交付和软件部署的工具及流程；采用自动化工具开发加速交付流水线；' +
  '与开发人员、测试人员和管理人员协作，确保整个软件开发生命周期顺畅高效；' +
  '通过无缝采用持续测试能力，增强开发人员与测试人员体验，以实现有效的 CI/CD 构建工具，使部署自动化；' +
  '创建自动化工作流程，使企业软件工程团队在整个工程部门内测试和推广代码；' +
  '为前端和全栈工程师团队提供实际支持，实现站点与服务的迁移及安全团队协作；' +
  '对任何新的遗漏和安全隐患做出及时响应，推动监控告警与灰度发布能力建设，持续降低平均恢复时间。';

/* 一个所有适配器选择器都不命中、但版式与真实页面一致的双列结构 */
function pageHtml() {
  const card = (title, salary, exp) => `
    <div class="lcard" data-box="16,96,304,116">
      <div class="lt" data-box="32,104,220,24"><span>${title}</span></div>
      <div class="lm" data-box="32,132,260,20">
        <span class="ls" data-box="32,132,80,20">${salary}</span>
        <span>${exp}</span>
      </div>
    </div>`;

  return `
<div class="wrap" data-box="0,0,1440,900">
  <div class="left-col" data-box="0,60,320,840">
    ${card('Java开发工程师', '15-22K', '5-10年')}
    ${card('实施工程师', '9-14K', '3-5年')}
    ${card('运维工程师', '10-16K', '3-5年')}
  </div>
  <div class="right-col" data-box="340,60,1080,840">
    <div class="hd" data-box="360,80,1000,140">
      <div class="row1" data-box="360,90,1000,32">
        <span style="font-size:20px" data-box="360,90,220,30">高级devops工程师</span>
        <span style="font-size:18px" data-box="700,94,90,24">21-22K</span>
      </div>
      <div class="row2" data-box="360,130,1000,22">
        <span>广州</span><span>5-10年</span><span>本科</span>
      </div>
      <div class="row3" data-box="360,160,1000,24">
        <a href="/gongsi/abc.html" data-box="360,160,90,22">中电金信</a>
      </div>
    </div>
    <div class="bd" data-box="360,220,1000,600">
      <h3>职位描述</h3>
      <div class="txt">
        <p>${JD_TEXT}</p>
      </div>
    </div>
  </div>
</div>`;
}

function setup(withLayout) {
  const dom = new JSDOM(pageHtml(), {
    url: 'https://www.zhipin.com/web/geek/jobs?query=devops&city=101280100',
    pretendToBeVisual: true
  });
  // 故意给一个无法解析出职位名的站点标题，确保字体/几何路径真的被走到
  dom.window.document.title = 'BOSS直聘-互联网招聘';
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.getComputedStyle = (el) => dom.window.getComputedStyle(el);
  global.innerWidth = 1440;
  global.innerHeight = 900;
  if (withLayout) stubLayout(dom.window);
  return dom;
}

const adapter = A.SITE_ADAPTERS[0]; // zhipin

/* ---------- 用例 1：有布局信息，走几何判定详情列 ---------- */
setup(true);
let f = E.extract(adapter);

check('几何：抽出职位名', f && f.jobTitle === '高级devops工程师', f && ('实际 ' + f.jobTitle));
check('几何：没抓到左侧列表的岗位名', f && f.jobTitle !== 'Java开发工程师', f && ('实际 ' + f.jobTitle));
check('几何：职位名来源标为结构推断', f && f.sources.jobTitle === '结构推断', f && ('实际 ' + f.sources.jobTitle));
check('几何：抽出公司名（无工商后缀，靠链接识别）', f && f.company === '中电金信', f && ('实际 ' + f.company));
check('几何：抽出薪资', f && f.salaryText === '21-22K', f && ('实际 ' + f.salaryText));
check('几何：薪资没被左侧卡片串掉', f && !/15-22K/.test(f.salaryText), f && ('实际 ' + f.salaryText));
check('几何：城市', f && f.city === '广州', f && ('实际 ' + f.city));
check('几何：经验', f && f.experienceText === '5-10年', f && ('实际 ' + f.experienceText));
check('几何：学历', f && f.educationText === '本科', f && ('实际 ' + f.educationText));
check('几何：JD 字数足够', f && f.jdText.length >= 250, f && ('实际 ' + (f && f.jdText.length)));

/* ---------- 用例 2：没有布局信息（零尺寸），应退回结构推断 ---------- */
setup(false);
let f2 = E.extract(adapter);

check('无布局：仍能抽出职位名', f2 && f2.jobTitle === '高级devops工程师', f2 && ('实际 ' + f2.jobTitle));
check('无布局：仍能抽出公司名', f2 && f2.company === '中电金信', f2 && ('实际 ' + f2.company));
check('无布局：仍能抽出薪资', f2 && f2.salaryText === '21-22K', f2 && ('实际 ' + f2.salaryText));

/* ---------- 用例 3：诊断报告要能让维护者远程校准 ---------- */
setup(true);
const rep = DG.report(adapter);

check('诊断：含 URL', rep.indexOf('https://www.zhipin.com/web/geek/jobs') >= 0);
check('诊断：含抽取结果段', rep.indexOf('【抽取结果】') >= 0);
check('诊断：含选择器命中段', rep.indexOf('【选择器命中】') >= 0);
check('诊断：报告了已失效的选择器命中数为 0', /\.job-sec-text → 0/.test(rep), rep.split('\n').filter((l) => l.indexOf('.job-sec-text') >= 0).join(' / '));
check('诊断：定位到 JD 锚点', rep.indexOf('【JD 锚点】') >= 0 && rep.indexOf('.bd') >= 0);
check('诊断：判定出详情列', /【详情列】\s*#?\.?right-col/.test(rep) || rep.indexOf('right-col') >= 0);
check('诊断：输出详情列 DOM 骨架', rep.indexOf('【详情列结构骨架') >= 0);
check('诊断：骨架里能看到真实职位名', rep.indexOf('高级devops工程师') >= 0);
check('诊断：列出大字号元素', rep.indexOf('【全页大字号元素') >= 0 && /20px "高级devops工程师"/.test(rep));
check('诊断：体量可控（< 40KB）', rep.length < 40000, '实际 ' + rep.length + ' 字符');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
