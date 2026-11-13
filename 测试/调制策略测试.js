const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../页面/电机控制/PWM实验/PWM模型.js');
const S = require('../页面/电机控制/PWM实验/空间投影视图.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('投影六边形来自六个非零角点，包含全部开关状态投影而非截面', () => {
  const hull = S.cubeProjectionHull();
  assert.equal(hull.length, 6);
  assert.equal(new Set(hull.map(JSON.stringify)).size, 6);
  for (let i = 0; i < 6; i++) {
    const a = hull[i], b = hull[(i + 1) % 6];
    close(a.reduce((x, y) => x + y, 0), 0);
    close(Math.hypot(...a), Math.sqrt(8 / 3));
    close(Math.hypot(...a.map((x, j) => x - b[j])), Math.sqrt(8 / 3));
    assert.ok(a.some(x => Math.abs(x) > 1));
    const u = S.projectState(a), v = S.projectState(b);
    for (const state of P.spaceStates(3).states) {
      assert.ok((v.alpha - u.alpha) * (state.beta - u.beta) - (v.beta - u.beta) * (state.alpha - u.alpha) >= -1e-10);
    }
  }
  for (const state of P.spaceStates(2).states) {
    const projected = S.projectState(state.abc).plane;
    assert.ok(Math.hypot(...projected) < 1e-10 || hull.some(v => v.every((x, i) => Math.abs(x - projected[i]) < 1e-10)));
  }
});

test('所有策略仅改变共同零序且覆盖零幅值、线性区与过调制', () => {
  for (const method of P.METHODS) for (const m of [0, .8, 1, 1.15, 1.3]) {
    for (let i = 0; i < 360; i++) {
      const theta = P.TAU * i / 360, ref = P.references(theta, m, method);
      const a = P.clarke(ref.sine), b = P.clarke(ref.injected);
      close(a.alpha, b.alpha); close(a.beta, b.beta);
      if (m <= (method === 'SPWM' ? 1 : 1.15)) assert.ok(ref.injected.every(x => Math.abs(x) <= 1 + 1e-10));
      if (method === 'THIPWM') close(ref.zero, m * Math.sin(3 * theta) / 6);
      if (method === 'DPWMMAX') close(Math.max(...ref.injected), 1);
      if (method === 'DPWMMIN') close(Math.min(...ref.injected), -1);
      if (method === 'DPWM5') assert.ok(ref.injected.some(x => Math.abs(Math.abs(x) - 1) < 1e-10));
    }
    for (const levels of method === 'DPWM5' ? [2] : [2, 3]) {
      const result = P.generate({ method, levels, m });
      assert.equal(result.samples.length, 8192);
      assert.ok(result.samples.every(s => s.abc.every(x => (levels === 2 ? [-1, 1] : [-1, 0, 1]).includes(x))));
      assert.equal(result.clippedSamples > 0, m > (method === 'SPWM' ? 1 : 1.15));
    }
  }
  assert.throws(() => P.generate({ method: 'DPWM5', levels: 3 }), RangeError);
});

test('DPWM自然采样参考逐点连续更新，与三维解析参考及实际载波比较一致', () => {
  for (const method of ['DPWM5', 'DPWMMAX', 'DPWMMIN']) {
    const result = P.generate({ method, levels: 2, m: .8, ratio: 24, samples: 24576 });
    for (const sample of result.samples) {
      const expected = P.references(sample.theta, .8, method);
      assert.deepEqual(sample.injected, expected.injected);
      assert.deepEqual(sample.reference, expected.sine);
      assert.deepEqual(sample.abc, expected.injected.map(v => P.carrierLevel(v, sample.carrier, 2)));
      assert.ok(sample.injected.some(v => Math.abs(Math.abs(v) - 1) < 1e-10));
    }
    const period = result.samples.slice(0, 1024);
    assert.ok(new Set(period.map(s => JSON.stringify(s.injected))).size > 1000, '不能按载波周期保持为阶梯');
    if (method !== 'DPWM5') {
      for (let i = 1; i < result.samples.length; i++) {
        assert.ok(result.samples[i].injected.every((v, j) => Math.abs(v - result.samples[i - 1].injected[j]) < .001));
      }
    }
  }
});

test('三电平格架54条邻接段含30条内部连接，两电平仅12条棱', () => {
  for (const [levels, count, interior] of [[2, 12, 0], [3, 54, 30]]) {
    const states = P.spaceStates(levels).states, edges = S.stateLatticeEdges(states);
    assert.equal(edges.length, count);
    assert.equal(edges.filter(([a, b]) => [0, 1, 2].some(i => a[i] === 0 && b[i] === 0)).length, interior);
    for (const [a, b] of edges) {
      assert.equal(a.filter((x, i) => x !== b[i]).length, 1);
      close(Math.hypot(...a.map((x, i) => x - b[i])), levels === 3 ? 1 : 2);
    }
  }
});

test('六种三维参考曲线和解析模型一致，均只沿共同零序方向偏移', () => {
  for (const m of [0, .8, 1.3]) {
    const curves = P.referenceTrajectories(m);
    for (const method of P.METHODS) {
      const curve = curves[method.toLowerCase()];
      assert.equal(curve.length, 721);
      for (const i of [0, 19, 120, 399, 720]) {
        const expected = P.references(P.TAU * i / 720, m, method);
        assert.deepEqual(curve[i], method === 'SPWM' ? expected.sine : expected.injected);
        const a = S.projectState(curve[i]).plane, b = S.projectState(curves.spwm[i]).plane;
        a.forEach((x, j) => close(x, b[j]));
      }
    }
  }
});
