const test = require('node:test');
const assert = require('node:assert/strict');
const Motor = require('../页面/电机控制/同步电机/电机模型.js');
const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('拖动预览色标保持原始端点、零点与饱和方向', () => {
  assert.deepEqual(Preview.colorFor(-2, 2), [57, 121, 172]);
  assert.deepEqual(Preview.colorFor(0, 2), [245, 247, 239]);
  assert.deepEqual(Preview.colorFor(2, 2), [203, 90, 79]);
  assert.deepEqual(Preview.colorFor(20, 2), [203, 90, 79]);
  assert.deepEqual(Preview.colorFor(0, 2, true), [245, 248, 244]);
  assert.deepEqual(Preview.colorFor(2, 2, true), [20, 108, 148]);
});

test('拖动预览扩大域覆盖新区域，隐藏图层不生成几何', () => {
  const view = { x: [-3, 2], y: [-1.5, 1.5] }, expanded = Preview.paddedBounds(view);
  assert.equal(Preview.covers(expanded, { x: [-4, 1], y: [-2, 1] }), true);
  assert.equal(Preview.covers(expanded, { x: [-20, -15], y: [-2, 1] }), false);
  const model = Motor.createModel();
  assert.deepEqual(Preview.geometryFor({ model, visible: {}, levels: [] }, expanded).lines, []);
  const geometry = Preview.geometryFor({ model, visible: { torque: true }, levels: [-.5, 1] }, expanded);
  assert.equal(geometry.lines.length, 2);
  for (let index = 0; index < geometry.lines.length; index++) for (const point of geometry.lines[index].branches.flat().filter(Boolean)) {
    near(Motor.evaluate(model, point.direct, point.quadrature).torque, [-.5, 1][index]);
  }
  assert.deepEqual(geometry.lines[0].dash, [7, 6]); assert.deepEqual(geometry.lines[1].dash, []);
});

test('恒转矩输入默认±0.5/±1，支持单值、多值、正负成对和去重', () => {
  assert.deepEqual(Motor.DEFAULT_TORQUES, [-1, -.5, .5, 1]);
  assert.deepEqual(Motor.parseTorqueLevels('-1,-0.5,0.5,1'), Motor.DEFAULT_TORQUES);
  assert.deepEqual(Motor.parseTorqueLevels('±0.5，±1'), Motor.DEFAULT_TORQUES);
  assert.deepEqual(Motor.parseTorqueLevels('-0.75'), [-.75]);
  assert.deepEqual(Motor.parseTorqueLevels('+.25; -2e0 0 0.25 -0'), [-2, 0, .25]);
  assert.deepEqual(Motor.parseTorqueLevels('1000'), [1000]);
});

test('恒转矩输入拒绝空值、表达式、非有限数与过多曲线', () => {
  for (const text of ['', ' , ', 'abc', '1/2', '1,NaN', 'Infinity', '1e309', '±-1', '0x10',
    Array.from({ length: 33 }, (_, index) => String(index)).join(',')]) assert.throws(() => Motor.parseTorqueLevels(text), RangeError);
});

test('自定义恒转矩列表逐条绘制对应的真实等值线', () => {
  const model = Motor.createModel();
  for (const level of Motor.parseTorqueLevels('-.75,0,.625,1.25')) {
    const points = Motor.torqueCurves(model, level, 4).flat().filter(Boolean);
    assert.ok(points.length > 0);
    for (const point of points) near(Motor.evaluate(model, point.direct, point.quadrature).torque, level);
  }
});

test('四个参数直接使用标幺值，无额定值或机型前置条件', () => {
  const model = Motor.createModel({ resistance: .1, ld: .4, lq: .8, flux: .6 });
  assert.deepEqual(model.pu, { resistance: .1, ld: .4, lq: .8, flux: .6 });
  assert.equal(model.base, undefined);
  assert.equal(model.input.powerKW, undefined);
});

test('演示默认电感较小，单位电流工作点在默认电压边界内', () => {
  const model = Motor.createModel();
  assert.deepEqual(model.pu, { resistance: .02, ld: .2, lq: .4, flux: .8 });
  const point = Motor.evaluate(model, 0, 1);
  assert.ok(point.voltage < 1);
  assert.equal(point.feasible, true);
});

test('六个非负文本参数允许零和远超滑块范围的大值，拒绝非有限数', () => {
  for (const key of ['resistance', 'ld', 'lq', 'flux', 'currentLimit', 'voltageLimit']) {
    for (const value of [0, 20, 1e6]) {
      const model = Motor.createModel({ [key]: value });
      assert.equal(model.input[key], value);
      const point = Motor.evaluate(model, -.4, .7);
      for (const field of ['torque', 'voltage', 'active', 'reactive', 'apparent']) assert.ok(Number.isFinite(point[field]));
    }
    for (const value of [-.01, Infinity, NaN]) assert.throws(() => Motor.createModel({ [key]: value }), RangeError);
  }
});

test('电压预设与手动幅值生成对应边界，零幅值退化到零电压点', () => {
  for (const voltageLimit of [0, 1, 1.15, 1.5, 2, 7.25]) {
    const model = Motor.createModel({ voltageLimit });
    const points = Motor.voltageCurves(model, model.input.voltageLimit, 30).flat();
    assert.ok(points.length > 0);
    for (const point of points) near(Motor.evaluate(model, point.direct, point.quadrature).voltage, voltageLimit);
  }
});

test('可行域同时采用用户设置的电压和电流数值', () => {
  const direct = .3, quadrature = .4;
  assert.equal(Motor.evaluate(Motor.createModel({ currentLimit: .49, voltageLimit: 10 }), direct, quadrature).feasible, false);
  assert.equal(Motor.evaluate(Motor.createModel({ currentLimit: .5, voltageLimit: 10 }), direct, quadrature).feasible, true);
  const voltage = Motor.evaluate(Motor.createModel(), direct, quadrature).voltage;
  assert.equal(Motor.evaluate(Motor.createModel({ currentLimit: 10, voltageLimit: voltage - .01 }), direct, quadrature).feasible, false);
  assert.equal(Motor.evaluate(Motor.createModel({ currentLimit: 10, voltageLimit: voltage + .01 }), direct, quadrature).feasible, true);
});

test('正负转速全DQ平面功率守恒，零电感与零磁链均可计算', () => {
  for (const speedPU of [-2, -1, 0, .3, 1, 2]) for (const values of [{}, { ld: 0 }, { lq: 0 }, { ld: 0, lq: 0 }, { flux: 0 }]) {
    const model = Motor.createModel({ ...values, speedPU });
    for (const direct of [-2, -.4, 0, .7, 2]) for (const quadrature of [-2, -.5, 0, 1, 2]) {
      const point = Motor.evaluate(model, direct, quadrature);
      near(point.active, point.mechanical + point.copper);
      near(point.apparent ** 2, point.active ** 2 + point.reactive ** 2);
      near(point.torque, (model.pu.flux + (model.pu.ld - model.pu.lq) * direct) * quadrature);
      assert.ok(Object.values(point).every(value => value === null || typeof value !== 'number' || Number.isFinite(value)));
      if (point.pf !== null) assert.ok(Math.abs(point.pf) <= 1);
    }
  }
});

test('零电流或零电压时功率因数未定义，发电不伪装为正有功', () => {
  assert.equal(Motor.evaluate(Motor.createModel(), 0, 0).pf, null);
  const model = Motor.createModel({ resistance: 0, speedPU: 0 });
  assert.equal(Motor.evaluate(model, 1, 1).pf, null);
  const generation = Motor.evaluate(Motor.createModel(), -.5, -1);
  assert.ok(generation.active < 0);
  assert.ok(generation.mechanical < 0);
  assert.ok(generation.copper >= 0);
  assert.ok(generation.pf < 0);
});

test('零磁链与等电感可用，负参数、越界转速和NaN被拒绝', () => {
  assert.equal(Motor.evaluate(Motor.createModel({ flux: 0, ld: .7, lq: .7 }), 1, 1).torque, 0);
  for (const input of [{ resistance: -.01 }, { ld: -.1 }, { lq: NaN }, { flux: -1 }, { speedPU: -2.01 }, { speedPU: 2.01 }]) {
    assert.throws(() => Motor.createModel(input), RangeError);
  }
});

test('MTPA在同一电流圆上达到最大/最小转矩，覆盖正反凸极与纯磁阻', () => {
  for (const values of [{}, { ld: 1.4, lq: .7 }, { ld: .7, lq: .7 }, { ld: 0, lq: 0 }, { flux: 0 }]) {
    const model = Motor.createModel(values);
    for (const current of [.02, .5, 1.5, 3]) for (const direction of [1, -1]) {
      const optimal = Motor.mtpa(model, current, direction);
      near(optimal.current, current);
      for (let index = 0; index < 2000; index++) {
        const angle = index * Math.PI / 1000;
        const point = Motor.evaluate(model, current * Math.cos(angle), current * Math.sin(angle));
        assert.ok(direction * optimal.torque + 1e-9 >= direction * point.torque);
      }
    }
  }
  assert.equal(Motor.mtpa(Motor.createModel({ flux: 0, ld: .7, lq: .7 }), 1), null);
});

test('含Rs的MTPV满足电压约束且胜过独立全角扫描', () => {
  for (const values of [{}, { speedPU: -2 }, { resistance: .7, speedPU: -.3 }, { ld: 1.4, lq: .7 }, { flux: 0 }, { speedPU: 0 }, { ld: 0, lq: 0 }]) {
    const model = Motor.createModel(values);
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
    const determinant = resistance ** 2 + speed ** 2 * ld * lq;
    for (const voltage of [.05, .5, 1, 3]) for (const direction of [1, -1]) {
      const optimal = Motor.mtpv(model, voltage, direction);
      near(optimal.voltage, voltage);
      for (let index = 0; index < 2400; index++) {
        const angle = index * 2 * Math.PI / 2400;
        const vd = voltage * Math.cos(angle), vq = voltage * Math.sin(angle);
        const direct = (resistance * vd + speed * lq * (vq - speed * flux)) / determinant;
        const quadrature = (-speed * ld * vd + resistance * (vq - speed * flux)) / determinant;
        const torque = (flux + (ld - lq) * direct) * quadrature;
        assert.ok(direction * optimal.torque + 1e-8 >= direction * torque, JSON.stringify({ values, voltage, optimal, torque }));
      }
    }
  }
});

test('SPMSM的MTPA为id=0；无Rs时MTPV为id=-磁链/Ld；有Rs时匹配解析中心', () => {
  for (const resistance of [0, .12, 1]) for (const speedPU of [-2, -.3, .3, 2]) {
    const model = Motor.createModel({ ld: .7, lq: .7, resistance, speedPU });
    near(Motor.mtpa(model, 2).direct, 0);
    const { ld, flux } = model.pu;
    const expected = -(speedPU ** 2) * ld * flux / (resistance ** 2 + speedPU ** 2 * ld ** 2);
    for (const voltage of [.1, 1, 2]) near(Motor.mtpv(model, voltage).direct, expected, 1e-6);
  }
  assert.equal(Motor.mtpv(Motor.createModel({ resistance: 0, speedPU: 0 }), 1), null);
});

test('恒转矩与有符号功率因数曲线逐点符合定义，不连过奇点或填充零电流', () => {
  for (const values of [{}, { speedPU: -1 }, { resistance: .7 }, { resistance: 0 }, { ld: 1.4, lq: .7 }, { ld: 0 }, { lq: 0 }, { ld: 0, lq: 0 }]) {
    const model = Motor.createModel(values);
    for (const torque of [-2, -1, -.5, .5, 1, 2]) {
      const points = Motor.torqueCurves(model, torque, 3).flat().filter(Boolean);
      assert.ok(points.length > 10);
      for (const point of points) near(Motor.evaluate(model, point.direct, point.quadrature).torque, torque);
    }
    for (const factor of [-1, -.9, -.5, .5, .9, 1]) {
      const points = Motor.powerFactorCurves(model, factor, 3).flat().filter(Boolean);
      if (factor === 1) assert.ok(points.length > 0);
      for (const point of points) near(Motor.evaluate(model, point.direct, point.quadrature).pf, factor, 1e-7);
    }
  }
  assert.deepEqual(Motor.powerFactorCurves(Motor.createModel({ speedPU: 0 }), 1, 3), []);
});

test('热力网格四象限、原点与可行域逐点对应同一模型', () => {
  const model = Motor.createModel(), grid = Motor.grid(model, 2, 21);
  near(grid.x[10], 0);
  assert.equal(grid.fields.torque.length, 21);
  for (let row = 0; row < 21; row++) for (let column = 0; column < 21; column++) {
    const point = Motor.evaluate(model, grid.x[column], grid.y[row]);
    for (const key of Object.keys(grid.fields)) near(grid.fields[key][row][column], point[key]);
    assert.equal(grid.feasible[row][column], point.feasible);
  }
  assert.equal(grid.fields.torque[10][10], 0);
  assert.ok(grid.fields.torque[20][0] > 0);
  assert.ok(grid.fields.torque[0][0] < 0);
});

test('优化网格在反转、退化和大参数下仍逐点等价于工作点计算', () => {
  for (const input of [{ speedPU: -2 }, { resistance: 0, ld: 0, lq: 0 }, { flux: 0 },
    { resistance: 50, ld: 500, lq: 1e6, flux: 100 }, { speedPU: 0, currentLimit: 0, voltageLimit: 0 }]) {
    const model = Motor.createModel(input), grid = Motor.grid(model, 3, 33, { x: [-4, 2], y: [-2, 4] });
    for (let row = 0; row < 33; row++) for (let column = 0; column < 33; column++) {
      const expected = Motor.evaluate(model, grid.x[column], grid.y[row]);
      for (const key of Object.keys(grid.fields)) near(grid.fields[key][row][column], expected[key]);
      assert.equal(grid.feasible[row][column], expected.feasible);
    }
  }
});

test('奇异电压模型不伪造MTPV，单轴零电感边界退化为真实直线', () => {
  for (const values of [{ resistance: 0, speedPU: 0 }, { resistance: 0, ld: 0 }, { resistance: 0, lq: 0 }, { resistance: 0, ld: 0, lq: 0 }]) assert.equal(Motor.mtpv(Motor.createModel(values), 1), null);
  for (const values of [{ resistance: 0, ld: 0 }, { resistance: 0, lq: 0 }, { resistance: 0, lq: 0, speedPU: -2 }]) {
    const model = Motor.createModel(values), curves = Motor.voltageCurves(model, 1, 3);
    assert.equal(curves.length, 2);
    for (const point of curves.flat()) near(Motor.evaluate(model, point.direct, point.quadrature).voltage, 1);
  }
});

test('零磁链MTPV的等价最优解保持在同一连续分支', () => {
  for (const values of [{ flux: 0 }, { flux: 0, ld: 1.4, lq: .7 }, { flux: 0, speedPU: -1 }]) {
    const model = Motor.createModel(values);
    for (const direction of [1, -1]) for (let index = 1; index <= 80; index++) assert.ok(direction * Motor.mtpv(model, index / 40, direction).quadrature > 0);
  }
});

test('局部放大重新采样热力图和曲线，坐标与当前视窗一致', () => {
  const model = Motor.createModel(), bounds = { x: [-.8, -.2], y: [.1, .8] };
  const grid = Motor.grid(model, 2, 21, bounds);
  near(grid.x[0], -.8); near(grid.x[20], -.2); near(grid.y[0], .1); near(grid.y[20], .8);
  for (let row = 0; row < 21; row++) for (let column = 0; column < 21; column++) {
    const point = Motor.evaluate(model, grid.x[column], grid.y[row]);
    for (const key of Object.keys(grid.fields)) near(grid.fields[key][row][column], point[key]);
  }
  const points = Motor.torqueCurves(model, .5, 2, 600, bounds).flat().filter(Boolean);
  assert.ok(points.length > 100);
  for (const point of points) assert.ok(point.direct >= -.8 && point.direct <= -.2 + 1e-12 && point.quadrature >= .1 && point.quadrature <= .8);
});