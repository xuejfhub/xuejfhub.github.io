const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../页面/电机控制/PWM实验/PWM模型.js');
const S = require('../页面/电机控制/PWM实验/空间投影视图.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('零序平面与立方体的真实截面是六条棱的中点', () => {
  const vertices = S.cubePlaneSection();
  assert.equal(vertices.length, 6);
  assert.equal(new Set(vertices.map(vertex => JSON.stringify(vertex))).size, 6);
  for (let i = 0; i < vertices.length; i++) {
    const vertex = vertices[i], next = vertices[(i + 1) % vertices.length];
    close(vertex.reduce((sum, value) => sum + value, 0), 0);
    assert.deepEqual(vertex.slice().sort((a, b) => a - b), [-1, 0, 1]);
    assert.ok(vertex.every(value => Math.abs(value) <= 1));
    close(Math.hypot(...vertex.map((value, axis) => value - next[axis])), Math.sqrt(2));
  }
  const outside = S.projectState([1, -1, -1]).plane;
  assert.ok(outside.some(value => Math.abs(value) > 1), '正交投影的包络不能与立方体截面混淆');
  close(outside.reduce((a, b) => a + b, 0), 0);
});

test('SPWM正弦参考在平面内，SVPWM参考沿共同零序方向跨越平面', () => {
  const curves = P.referenceTrajectories(.8);
  assert.equal(curves.spwm.length, 721); assert.equal(curves.svpwm.length, 721);
  assert.ok(Math.min(...curves.zero) < -.1); assert.ok(Math.max(...curves.zero) > .1);
  for (let i = 0; i < curves.spwm.length; i++) {
    const spwm = curves.spwm[i], svpwm = curves.svpwm[i];
    close(spwm.reduce((a, b) => a + b, 0), 0);
    close(svpwm.reduce((a, b) => a + b, 0), 3 * curves.zero[i]);
    const projection = S.projectState(svpwm).plane;
    spwm.forEach((value, axis) => { close(value, projection[axis]); close(svpwm[axis] - value, curves.zero[i]); });
    const a = P.clarke(spwm), b = P.clarke(svpwm);
    close(a.alpha, b.alpha); close(a.beta, b.beta);
  }
  for (const key of ['spwm', 'svpwm']) curves[key][0].forEach((value, i) => close(value, curves[key].at(-1)[i]));
  assert.ok(P.generate({ method: 'SPWM' }).samples.some(sample => Math.abs(sample.zero) > .1), '连续参考不能误标为瞬时开关轨迹');
});

test('三维参考与探针取同一解析曲线，覆盖零幅值和过调制', () => {
  for (const m of [0, .8, 1.1, 1.3]) {
    const curves = P.referenceTrajectories(m, 120);
    for (const i of [0, 20, 63, 120]) {
      const pair = P.referencePair(P.TAU * i / 120, m);
      assert.deepEqual(pair.spwm, curves.spwm[i]); assert.deepEqual(pair.svpwm, curves.svpwm[i]);
    }
  }
  assert.ok(P.referenceTrajectories(1.1).spwm.some(point => point.some(value => Math.abs(value) > 1)));
  assert.ok(P.referenceTrajectories(1.1).svpwm.every(point => point.every(value => Math.abs(value) <= 1)));
  assert.deepEqual(P.referencePair(0, 0).spwm.map(value => Math.abs(value)), [0, 0, 0]);
  assert.throws(() => P.referenceTrajectories(NaN), RangeError);
  assert.throws(() => P.referencePair(NaN, .8), RangeError);
});
