const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../页面/电机控制/PWM实验/PWM模型.js');
const S = require('../页面/电机控制/PWM实验/空间投影视图.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('半、一、两周期保持每周期采样密度，并生成完整三相输出', () => {
  for (const levels of [2, 3]) for (const method of ['SPWM', 'SVPWM']) for (const cycles of [.5, 1, 2]) {
    const result = P.generate({ levels, method, cycles });
    assert.equal(result.samples.length, 8192 * cycles);
    close(result.samples[0].theta, P.TAU * .5 / 8192);
    close(result.samples.at(-1).theta, P.TAU * (cycles - .5 / 8192));
    for (const sample of result.samples) {
      assert.ok(sample.abc.every(value => (levels === 2 ? [-1, 1] : [-1, 0, 1]).includes(value)));
      const phase = P.outputValues(sample, 'phase'), line = P.outputValues(sample, 'line');
      assert.equal(phase.length, 3); assert.equal(line.length, 3);
      assert.deepEqual(phase, sample.abc);
      assert.ok(phase.every(value => Number.isInteger(value)));
      close(sample.neutralPhase.reduce((a, b) => a + b, 0), 0); close(line.reduce((a, b) => a + b, 0), 0);
      for (let i = 0; i < 3; i++) close(line[i], phase[i] - phase[(i + 1) % 3]);
      const plane = S.projectState(sample.abc).plane;
      plane.forEach((value, i) => close(value, sample.neutralPhase[i]));
    }
  }
});

test('两周期真实延续载波与三相状态，半周期为完整数据的前半段', () => {
  const half = P.generate({ cycles: .5 }), full = P.generate(), double = P.generate({ cycles: 2 });
  assert.deepEqual(half.samples, full.samples.slice(0, 4096));
  assert.deepEqual(full.samples, double.samples.slice(0, 8192));
  for (let i = 0; i < full.samples.length; i++) {
    assert.deepEqual(double.samples[i + 8192].abc, full.samples[i].abc);
    close(double.samples[i + 8192].theta - full.samples[i].theta, P.TAU);
  }
});

test('共同零序不改变参考的二维投影和线电压', () => {
  for (const theta of [0, .23, 1.2, 3.8, 6.1]) {
    const { sine, injected } = P.references(theta, .8, 'SVPWM');
    const original = P.clarke(sine), modified = P.clarke(injected);
    close(original.alpha, modified.alpha); close(original.beta, modified.beta);
    for (let i = 0; i < 3; i++) close(sine[i] - sine[(i + 1) % 3], injected[i] - injected[(i + 1) % 3]);
  }
});

test('保留载波范围与过调制提示，拒绝已删除功能和非法窗口', () => {
  assert.equal(P.generate({ m: .8 }).clippedSamples, 0);
  assert.ok(P.generate({ m: 1.3 }).clippedSamples > 0);
  assert.throws(() => P.generate({ method: 'SHEPWM' }), RangeError);
  assert.throws(() => P.generate({ cycles: .25 }), RangeError);
  assert.throws(() => P.generate({ ratio: 0 }), RangeError);
  assert.throws(() => P.outputValues(P.generate().samples[0], 'pole'), RangeError);
  assert.equal(P.solveSHE, undefined); assert.equal(P.harmonics, undefined);
});

test('抓住模型向右/向下拖动，近侧点随鼠标方向移动', () => {
  const camera = { yaw: -.75, pitch: .5, zoom: 1 };
  const near = [Math.cos(camera.pitch) * Math.cos(camera.yaw), Math.cos(camera.pitch) * Math.sin(camera.yaw), Math.sin(camera.pitch)];
  const start = S.cameraPoint(near, camera, 800, 480);
  assert.ok(S.cameraPoint(near, S.dragCamera(camera, 25, 0), 800, 480).x > start.x);
  assert.ok(S.cameraPoint(near, S.dragCamera(camera, -25, 0), 800, 480).x < start.x);
  assert.ok(S.cameraPoint(near, S.dragCamera(camera, 0, 25), 800, 480).y > start.y);
  assert.equal(camera.yaw, -.75);
});

test('对直流中点的相电压和线电压具有明确的整数电平', () => {
  for (const levels of [2, 3]) {
    const phases = new Set(), lines = new Set();
    for (const state of P.spaceStates(levels).states) {
      const sample = { abc: state.abc, neutralPhase: S.projectState(state.abc).plane };
      P.outputValues(sample, 'phase').forEach(value => phases.add(value));
      P.outputValues(sample, 'line').forEach(value => lines.add(value));
    }
    assert.deepEqual([...phases].sort((a, b) => a - b), levels === 3 ? [-1, 0, 1] : [-1, 1]);
    assert.deepEqual([...lines].sort((a, b) => a - b), levels === 3 ? [-2, -1, 0, 1, 2] : [-2, 0, 2]);
  }
  const example = { abc: [1, 0, 0], neutralPhase: [2 / 3, -1 / 3, -1 / 3] };
  assert.deepEqual(P.outputValues(example, 'phase'), [1, 0, 0]);
  assert.deepEqual(P.outputValues(example, 'line'), [1, 0, -1]);
});

test('正交成像不随深度改变大小，透视成像保留近大远小', () => {
  const camera = { yaw: -.75, pitch: .5, zoom: 1 };
  const right = [-Math.sin(camera.yaw), Math.cos(camera.yaw), 0];
  const normal = [Math.cos(camera.pitch) * Math.cos(camera.yaw), Math.cos(camera.pitch) * Math.sin(camera.yaw), Math.sin(camera.pitch)];
  const shifted = right.map((value, i) => value + normal[i]);
  const orthographic = { ...camera, projection: 'orthographic' };
  const a = S.cameraPoint(right, orthographic, 800, 480), b = S.cameraPoint(shifted, orthographic, 800, 480);
  close(a.x, b.x); close(a.y, b.y);
  const perspective = { ...camera, projection: 'perspective' };
  const c = S.cameraPoint(right, perspective, 800, 480), d = S.cameraPoint(shifted, perspective, 800, 480);
  assert.ok(d.x - 400 > c.x - 400);
  S.projectState([1, 0, 0]).plane.forEach((value, i) => close(value, [2 / 3, -1 / 3, -1 / 3][i]));
});

test('七种视角沿指定轴观察，Zero视角α向右β向上且不改变数学映射', () => {
  const directions = { A: [1, 0, 0], B: [0, 1, 0], C: [0, 0, 1], alpha: [1, -.5, -.5], beta: [0, 1, -1], zero: [1, 1, 1] };
  assert.equal(S.viewCamera('default').projection, 'orthographic');
  for (const [view, direction] of Object.entries(directions)) {
    const camera = S.viewCamera(view, { projection: 'orthographic', zoom: 1.2 });
    const origin = S.cameraPoint([0, 0, 0], camera, 800, 620);
    const axis = S.cameraPoint(direction, camera, 800, 620);
    close(axis.x, origin.x); close(axis.y, origin.y); assert.ok(axis.depth > 0);
    assert.equal(camera.zoom, 1.2);
  }
  for (const projection of ['orthographic', 'perspective']) {
    const camera = S.viewCamera('zero', { projection, zoom: 1 });
    const origin = S.cameraPoint([0, 0, 0], camera, 800, 620);
    const alpha = S.cameraPoint([1, -.5, -.5], camera, 800, 620);
    const beta = S.cameraPoint([0, 1, -1], camera, 800, 620);
    assert.ok(alpha.x > origin.x); close(alpha.y, origin.y);
    assert.ok(beta.y < origin.y); close(beta.x, origin.x);
    const near = [1, 1, 1].map(v => v / Math.sqrt(3));
    const before = S.cameraPoint(near, camera, 800, 620);
    assert.ok(S.cameraPoint(near, S.dragCamera(camera, 15, 0), 800, 620).x > before.x);
    assert.ok(S.cameraPoint(near, S.dragCamera(camera, 0, 15), 800, 620).y > before.y);
  }
  assert.throws(() => S.viewCamera('invalid'), RangeError);
});

test('默认载波比为40且覆盖完整三相采样', () => {
  const result = P.generate();
  assert.equal(result.config.ratio, 40);
  assert.equal(result.samples.length, 8192);
  for (const i of [0, 100, 4096, 8191]) {
    close(result.samples[i].carrier, P.triangle(40 * result.samples[i].theta / P.TAU));
  }
});
