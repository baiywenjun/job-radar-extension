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

/* ---------- 用例 3：截图中的选中卡片与详情错位 ----------
   详情列只有职位和拆分的薪资，没有公司；推荐岗位链接不能被猜成公司。
   左侧当前卡片与详情标题完全一致，卡片底部给出公司名。 */
const bugHtml = `
<div class="wrap" data-box="0,0,2476,1392">
  <div class="left-col" data-box="0,295,700,1097">
    <div class="lcard" data-box="39,304,662,240"><span>大模型网关开发工程师</span><span>15-22K</span><span>北京数务通科技</span></div>
    <div class="lcard" data-box="39,574,662,240"><span>资深后端开发工程师</span><span>18-35K</span><span>广州大娱网络科技</span></div>
    <div class="lcard" data-box="39,844,662,240"><span>高级java开发工程师</span><span>15-22K</span><span>晟能电子</span></div>
    <div class="lcard selected" data-box="39,1114,662,240">
      <div class="position" data-box="82,1146,440,36">资深Java开发工程师（跨境电商）</div>
      <div class="pay" data-box="543,1146,145,36">18–25K</div>
      <div class="tags" data-box="82,1215,300,35"><span>5-10年</span><span>本科</span></div>
      <div class="footer" data-box="82,1283,575,47">
        <span class="merchant" data-box="140,1305,75,28">衣媚</span>
        <span data-box="492,1305,165,28">广州·番禺区·南村</span>
      </div>
    </div>
  </div>
  <div class="right-col" data-box="730,324,1353,1068">
    <div class="head" data-box="763,347,1280,170">
      <div class="title-row" data-box="763,347,900,80">
        <span style="font-size:30px" data-box="763,350,541,54">资深Java开发工程师（跨境电商）</span>
        <span class="pay-row" data-box="1341,350,170,54"><b>18</b><b>–</b><b>25K</b></span>
      </div>
      <div class="requirements" data-box="774,437,500,40"><span>广州</span><span>5-10年</span><span>本科</span></div>
    </div>
    <div class="body" data-box="773,510,1280,820">
      <h3>职位描述</h3><p>${JD_TEXT}</p>
    </div>
    <a href="/job_detail/similar.html">广州数字技术专家</a>
    <a href="/job_detail/another.html">广州数字IC验证工程师</a>
  </div>
</div>`;

const bugDom = new JSDOM(bugHtml, {
  url: 'https://www.zhipin.com/web/geek/jobs?query=Java',
  pretendToBeVisual: true
});
bugDom.window.document.title = 'Java招聘 - BOSS直聘';
global.document = bugDom.window.document;
global.location = bugDom.window.location;
global.getComputedStyle = (el) => bugDom.window.getComputedStyle(el);
stubLayout(bugDom.window);
const bug = E.extract(adapter);
check('截图：职位对应当前卡片', bug && bug.jobTitle === '资深Java开发工程师（跨境电商）', bug && ('实际 ' + bug.jobTitle));
check('截图：公司取同名卡片的衣媚', bug && bug.company === '衣媚', bug && ('实际 ' + bug.company));
check('截图：公司来源可见', bug && bug.sources.company === '列表匹配', bug && ('实际 ' + bug.sources.company));
check('截图：不把推荐岗位误作公司', bug && bug.company !== '广州数字IC验证工程师', bug && ('实际 ' + bug.company));
check('截图：拆分的薪资取 18-25K', bug && bug.salaryText === '18-25K', bug && ('实际 ' + bug.salaryText));
check('截图：薪资可供打分规则解析', bug && U.parseSalary(bug.salaryText).max === 25,
  bug && ('实际 ' + JSON.stringify(U.parseSalary(bug.salaryText))));
check('截图：原始连接符也能解析', U.parseSalary('18–25K').max === 25);
bugDom.window.document.querySelector('.pay-row').remove();
const noDetailSalary = E.extract(adapter);
check('截图：详情薪资缺失时只从同名卡片补齐', noDetailSalary &&
  noDetailSalary.salaryText === '18-25K' && noDetailSalary.sources.salary === '列表匹配',
  noDetailSalary && ('实际 ' + noDetailSalary.salaryText + ' / ' + noDetailSalary.sources.salary));
bugDom.window.document.querySelector('.merchant').remove();
const noCardCompany = E.extract(adapter);
check('截图：无可信公司时不借用推荐岗位', noCardCompany &&
  noCardCompany.company === '' && noCardCompany.sources.company === '未取到',
  noCardCompany && ('实际 ' + noCardCompany.company + ' / ' + noCardCompany.sources.company));

/* ---------- 用例 4：站点字体把薪资数字编码成私有区字符 ----------
   视觉上是 6-7K，DOM 文本却是两个专用字形和 K；薪资字号甚至比标题更大。
   左侧标题被省略号截断，公司仍应与右侧完整标题关联。 */
const encodedHtml = `
<div class="wrap" data-box="0,0,2450,1200">
  <div class="left" data-box="0,280,705,920">
    <div class="lcard selected" data-box="43,281,661,239">
      <div class="position" data-box="85,316,480,40">FDE（前线部署工程师 / AI 交付工…</div>
      <div class="pay" data-box="580,316,86,40">\uE101-\uE102K</div>
      <div class="footer" data-box="85,450,570,60"><span class="merchant" data-box="143,468,200,35">百蕴启辰/信息安全</span></div>
    </div>
  </div>
  <div class="right" data-box="735,280,1200,920">
    <div class="head" data-box="777,310,1050,130">
      <span style="font-size:28px" data-box="777,317,650,45">FDE（前线部署工程师 / AI 交付工程师）</span>
      <span class="encoded-pay" style="font-size:32px;font-family:BossCipher" data-box="1460,317,100,45">\uE101-\uE102K</span>
      <div class="meta" data-box="777,395,430,30"><span>广州</span><span>1-3年</span><span>本科</span></div>
    </div>
    <div class="bd" data-box="777,470,1050,700"><h3>职位描述</h3><p>${JD_TEXT}</p></div>
  </div>
</div>`;
const encodedDom = new JSDOM(encodedHtml, {
  url: 'https://www.zhipin.com/web/geek/jobs?city=101280100&query=FDE',
  pretendToBeVisual: true
});
encodedDom.window.document.title = 'FDE招聘 - BOSS直聘';
global.document = encodedDom.window.document;
global.location = encodedDom.window.location;
global.getComputedStyle = (el) => encodedDom.window.getComputedStyle(el);
global.innerWidth = 2450;
stubLayout(encodedDom.window);
const encoded = E.extract(adapter);
check('编码薪资：职位仍取完整 FDE 标题', encoded &&
  encoded.jobTitle === 'FDE（前线部署工程师 / AI 交付工程师）', encoded && ('实际 ' + encoded.jobTitle));
check('截断卡片：公司与完整标题匹配', encoded && encoded.company === '百蕴启辰/信息安全',
  encoded && ('实际 ' + encoded.company));
check('编码薪资：无法解码时不冒充职位或薪资', encoded &&
  encoded.salaryText === '' && encoded.sources.salary === '未取到',
  encoded && ('实际 ' + encoded.salaryText + ' / ' + encoded.sources.salary));
const glyphReport = DG.report(adapter);
check('编码薪资：诊断含字形编码和字体', glyphReport.includes('U+E101') &&
  glyphReport.includes('BossCipher'), glyphReport.slice(-800));
encodedDom.window.document.querySelector('.encoded-pay').setAttribute('data-salary', '6-7K');
const accessibleSalary = E.extract(adapter);
check('编码薪资：可访问属性有明文时使用它', accessibleSalary &&
  accessibleSalary.salaryText === '6-7K' && accessibleSalary.sources.salary === '页面属性',
  accessibleSalary && ('实际 ' + accessibleSalary.salaryText + ' / ' + accessibleSalary.sources.salary));

/* ---------- 用例 5：真实诊断给出的 BOSS 类名与私有字体编码 ---------- */
const realShapeHtml = `
<div class="wrap" data-box="0,0,1600,806">
  <ul class="job-list" data-box="0,200,590,600">
    <li class="job-card-box selected" data-box="0,200,590,140">
      <div class="job-info" data-box="24,210,550,80">
        <div class="job-title clearfix" data-box="24,215,550,29">
          <span class="job-name" data-box="24,215,100,28">FDE工程师</span>
          <span class="job-salary" style="font-family:kanzhun-mix" data-box="500,215,70,28">\uE032\uE031-\uE032\uE032K</span>
        </div>
        <div class="tags" data-box="24,260,220,24"><span data-box="48,260,80,24">经验不限</span><span>学历不限</span></div>
      </div>
      <div class="footer" data-box="24,295,550,40"><span class="employer" data-box="90,305,180,28">广州羽淼白品牌管理</span></div>
    </li>
  </ul>
  <div class="job-detail-container" data-box="608,200,752,599">
    <div class="job-detail-box" data-box="608,200,752,718">
      <div class="job-detail-header" data-box="608,200,752,105">
        <div class="job-header-info" data-box="632,216,484,65">
          <div class="job-detail-info" data-box="632,216,476,29">
            <span class="job-name" data-box="632,216,100,28">FDE工程师</span>
            <span class="job-salary" style="font-family:kanzhun-mix" data-box="752,216,66,29">\uE032\uE031-\uE032\uE032K</span>
          </div>
          <ul class="tag-list"><li>广州</li><li>经验不限</li><li>学历不限</li></ul>
        </div>
      </div>
      <div class="job-detail-body" data-box="608,305,752,613">
        <h3>职位描述</h3><p>${JD_TEXT}</p>
        <div class="job-boss-info"><div class="boss-info-attr">广州羽淼白品牌管理 · 联合创始人</div></div>
      </div>
    </div>
  </div>
</div>`;
const realShapeDom = new JSDOM(realShapeHtml, {
  url: 'https://www.zhipin.com/web/geek/jobs?city=101280100&query=FDE',
  pretendToBeVisual: true
});
realShapeDom.window.document.title = '广州招聘 - BOSS直聘';
global.document = realShapeDom.window.document;
global.location = realShapeDom.window.location;
global.getComputedStyle = (el) => realShapeDom.window.getComputedStyle(el);
stubLayout(realShapeDom.window);
const realShape = E.extract(adapter);
check('真实结构：详情标题由页面类名取得', realShape && realShape.jobTitle === 'FDE工程师' &&
  realShape.sources.jobTitle === '详情区', realShape && ('实际 ' + realShape.jobTitle));
check('真实结构：私有字体薪资解码成 10-11K', realShape && realShape.salaryText === '10-11K',
  realShape && ('实际 ' + realShape.salaryText));
check('真实结构：公司取卡片底部而非经验不限', realShape &&
  realShape.company === '广州羽淼白品牌管理', realShape && ('实际 ' + realShape.company));
check('真实结构：经验不限正常提取', realShape && realShape.experienceText === '经验不限',
  realShape && ('实际 ' + realShape.experienceText));
realShapeDom.window.document.querySelector('.job-detail-header .job-salary').textContent = '\uE037-\uE038K';
const shape67 = E.extract(adapter);
check('真实结构：另一组字形解码 6-7K', shape67 && shape67.salaryText === '6-7K',
  shape67 && ('实际 ' + shape67.salaryText));
realShapeDom.window.document.querySelector('.employer').remove();
const recruiterFallback = E.extract(adapter);
check('真实结构：卡片缺公司时取招聘者所属公司', recruiterFallback &&
  recruiterFallback.company === '广州羽淼白品牌管理' &&
  recruiterFallback.sources.company === '招聘者信息',
  recruiterFallback && ('实际 ' + recruiterFallback.company + ' / ' + recruiterFallback.sources.company));

/* ---------- 用例 6：诊断报告要能让维护者远程校准 ---------- */
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
