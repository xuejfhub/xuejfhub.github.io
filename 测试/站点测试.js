const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../脚本/开发/预览服务.js');
const root = path.resolve(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('首页只有三个指定分类和五个可用实验，两种同步分析指向真实页面', () => {
  const headings = [...home.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map(match => match[1]);
  assert.deepEqual(headings, ['电机控制', '控制原理', '数学原理']);
  const entries = [...home.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map(match => match[1]);
  assert.deepEqual(entries, ['同步电机转子定向工作点分析', '同步电机VF定子电压定向工作点分析', '异步电机分析', 'PWM', 'PI 控制器可视化']);
  const pageLinks = [...home.matchAll(/href="(页面\/[^"]+\.html)"/g)].map(match => match[1]);
  assert.deepEqual(pageLinks, ['页面/电机控制/同步电机/同步电机分析.html', '页面/电机控制/同步电机/VF工作点分析.html', '页面/电机控制/异步电机/异步电机分析.html', '页面/电机控制/PWM实验/PWM教学实验.html', '页面/控制原理/PI控制器/控制器可视化.html']);
  assert.doesNotMatch(home, /pending-card|尚未添加分析页面/);
  for (const id of ['math']) {
    const section = home.match(new RegExp(`<section id="${id}"[\\s\\S]*?<\\/section>`))[0];
    assert.match(section, /暂无内容/); assert.doesNotMatch(section, /<a\b|<article\b/);
  }
  assert.doesNotMatch(home, /id="(?:search|sort|tags|saved-only|featured-grid|pagination|about)"|data-save=|内容目录\.js|网站交互\.js|软件项目|GitHub ↗/);
});

function htmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['临时测试', '文档', '脚本'].includes(entry.name)) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(full) : entry.name.endsWith('.html') ? [full] : [];
  });
}

test('公开页面只含首页、404与五项实验，所有相对引用有效', () => {
  const files = htmlFiles(root);
  assert.deepEqual(files.map(file => path.relative(root, file).split(path.sep).join('/')).sort(), ['404.html', 'index.html', '页面/电机控制/PWM实验/PWM教学实验.html', '页面/电机控制/同步电机/同步电机分析.html', '页面/电机控制/同步电机/VF工作点分析.html', '页面/电机控制/异步电机/异步电机分析.html', '页面/控制原理/PI控制器/控制器可视化.html'].sort());
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = match[1].replace(/&amp;/g, '&');
      if (/^(https?:|data:|mailto:|#)/.test(url)) continue;
      const target = decodeURIComponent(url.split(/[?#]/)[0]);
      if (target) assert.ok(fs.existsSync(target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(file), target)), `${path.relative(root, file)} -> ${target}`);
    }
  }
});

test('无关界面、内容索引与专用资源已移除，开发与电机资源按层组织', () => {
  for (const relative of ['作品', '内容', '页面/文章.html', '资源/交互', '资源/样式', '脚本/网页']) assert.ok(!fs.existsSync(path.join(root, relative)), relative);
  for (const relative of ['资源/公共/主题设置.js', '页面/首页/首页样式.css', '页面/电机控制/PWM实验/PWM实验.js', '页面/电机控制/异步电机/异步电机交互.js', '脚本/开发', '测试', '配置/旧址映射.json']) assert.ok(fs.existsSync(path.join(root, relative)), relative);
  const motor = fs.readFileSync(path.join(root, '页面/电机控制/异步电机/异步电机分析.html'), 'utf8');
  assert.match(motor, /plotly\.js\/2\.27\.0\/plotly\.min\.js/);
  assert.doesNotMatch(motor, /plotly\.交互/);
});

test('预览只提供保留页面，已删除内容和私有配置不可访问', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const resource of ['/', '/页面/电机控制/PWM实验/PWM教学实验.html', '/页面/电机控制/同步电机/同步电机分析.html', '/页面/电机控制/异步电机/异步电机分析.html', '/页面/首页/首页样式.css', '/页面/控制原理/PI控制器/控制器可视化.html']) assert.equal((await fetch(origin + encodeURI(resource))).status, 200, resource);
    for (const resource of ['/.git/config', '/脚本/开发/预览服务.js', '/脚本/桌面/后坐力/Python脚本/配置/武器参数.json', '/配置/旧址映射.json', '/文档/改版历史.md', '/临时测试/2026-10-14-首页整理/PWM保护校验.json', '/页面/文章.html', '/作品/网页/可视化/二阶响应实验.html', '/projects/web/games/cha_fang.html', '/作品/网页/可视化/视觉后坐力演示.html', '/missing.html', '/资源/%2e%2e%5c.git%5cconfig']) assert.equal((await fetch(origin + resource)).status, 404, resource);
    const head = await fetch(origin + '/index.html', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
