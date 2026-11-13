const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../页面/电机控制/PWM实验/PWM模型.js');
const S = require('../页面/电机控制/PWM实验/空间投影视图.js');
const { createServer } = require('../脚本/开发/预览服务.js');
const root = path.resolve(__dirname, '..');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('全部ABC状态沿零序法线正交映射到A+B+C=0平面', () => {
  for (const levels of [2, 3]) {
    const all = P.spaceStates(levels);
    assert.equal(all.states.length, levels === 2 ? 8 : 27);
    assert.equal(all.positions.length, levels === 2 ? 7 : 19);
    for (const state of all.states) {
      const projected = S.projectState(state.abc);
      close(projected.plane.reduce((a, b) => a + b, 0), 0);
      const inverse = P.inverseClarke({ alpha: projected.alpha, beta: projected.beta });
      inverse.forEach((value, i) => close(value, projected.plane[i]));
      projected.plane.forEach((value, i) => close(state.abc[i] - value, projected.zero));
      close(P.clarke(projected.plane).alpha, state.alpha);
      close(P.clarke(projected.plane).beta, state.beta);
    }
  }
});

test('同一二维位置保留不同三维状态，而不是抹掉零序', () => {
  const projected = [[-1, -1, -1], [0, 0, 0], [1, 1, 1]].map(S.projectState);
  projected.forEach(state => { close(state.alpha, 0); close(state.beta, 0); });
  assert.deepEqual(projected.map(state => state.zero), [-1, 0, 1]);
  assert.notDeepEqual(projected[0].abc, projected[2].abc);
});

test('三维相机旋转改变屏幕位置，模型投影关系保持不变', () => {
  const before = S.projectState([1, 0, -1]);
  const initial = S.cameraPoint([1, 0, -1], { yaw: -.75, pitch: .5, zoom: 1 }, 800, 480);
  const rotated = S.cameraPoint([1, 0, -1], { yaw: .75, pitch: .7, zoom: 1 }, 800, 480);
  assert.notEqual(initial.x, rotated.x);
  assert.notEqual(initial.y, rotated.y);
  assert.deepEqual(S.projectState([1, 0, -1]), before);
});

test('中文命名覆盖自由命名目录文件，固定平台入口除外', () => {
  const fixed = new Set(['index.html', '404.html', 'README.md', '_config.yml']);
  function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '临时测试') continue;
      if (directory === root && fixed.has(entry.name)) continue;
      assert.match(entry.name, /[\u4e00-\u9fff]/, path.join(directory, entry.name));
      if (entry.isDirectory()) check(path.join(directory, entry.name));
    }
  }
  check(root);
});

test('旧址映射只包含公开资源，全部新目标存在', () => {
  const mappings = require('../配置/旧址映射.json');
  for (const [oldPath, newPath] of Object.entries(mappings)) {
    assert.ok(!oldPath.startsWith('scripts/desktop/') && !oldPath.startsWith('scripts/dev/'));
    assert.ok(fs.existsSync(path.join(root, newPath)), newPath);
  }
});

test('GitHub Pages保留实验的旧HTML跳转保持子路径、查询参数和锚点', () => {
  const html = fs.readFileSync(path.join(root, '404.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const mappings = require('../配置/旧址映射.json');
  for (const [oldPath, newPath] of Object.entries(mappings).filter(([key]) => key.endsWith('.html'))) {
    let destination;
    vm.runInNewContext(script, {
      location: { pathname: '/personal/' + oldPath, search: '?id=reading_response', hash: '#model', replace: value => { destination = value; } },
      document: { getElementById: () => ({}) }
    });
    assert.equal(decodeURI(destination), '/personal/' + newPath + '?id=reading_response#model');
  }
});

test('本地中文路径和旧PWM入口可打开，旧静态资源可解析', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(origin + '/projects/web/visualization/tlspwm_graph.html?test=1', { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(decodeURI(page.headers.get('location')), '/页面/电机控制/PWM实验/PWM教学实验.html?test=1');
    const redirected = await fetch(origin + '/projects/web/visualization/tlspwm_graph.html');
    assert.equal(redirected.status, 200);
    assert.match(await redirected.text(), /id="space-3d"/);
    assert.equal((await fetch(origin + encodeURI('/页面/电机控制/PWM实验/空间投影视图.js'))).status, 200);
    assert.equal((await fetch(origin + '/assets/js/theme.js')).status, 200);
    assert.equal((await fetch(origin + encodeURI('/脚本/桌面/后坐力/Python脚本/配置/武器参数.json'))).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
