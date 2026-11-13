const test = require('node:test');
const assert = require('node:assert/strict');
const VF = require('../页面/电机控制/同步电机/VF模型.js');
const Rotor = require('../页面/电机控制/同步电机/电机模型.js');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('VF参考电压独立于当前VF给定与限幅，零电压不伪造定向轨迹', () => {
  for (const speedPU of [-1, .5, 2]) {
    const model = VF.createModel({ speedPU, vfRatio: .1, voltageLimit: .5 });
    for (const voltage of Rotor.DEFAULT_VOLTAGES) {
      const points = VF.voltageTrajectory(model, voltage, 120);
      assert.equal(points.length, voltage === 0 ? 0 : 121);
      for (const point of points) {
        near(point.vd, voltage); near(point.vq, 0); near(point.voltage, voltage);
        near(Rotor.evaluate(model, point.rotorDirect, point.rotorQuadrature).voltage, voltage);
        if (voltage > model.input.voltageLimit) assert.equal(point.feasible, false);
      }
    }
  }
  const stopped = VF.createModel({ speedPU: 0 });
  const reference = VF.voltageTrajectory(stopped, .2, 30);
  assert.equal(reference.length, 31);
  for (const point of reference) { near(point.direct, 10); near(point.quadrature, 0); }
  assert.deepEqual(VF.voltageTrajectory(VF.createModel({ speedPU: 0, resistance: 0 }), 1), []);
  assert.throws(() => VF.voltageTrajectory(stopped, -1), RangeError);
});

test('VF电压幅值随频率绝对值变化，包含补偿与限幅', () => {
  for (const speedPU of [-2, -1, 0, .5, 2]) {
    const model = VF.createModel({ speedPU, vfRatio: .8, voltageBoost: .03, voltageLimit: 1 });
    near(model.outputVoltage, Math.min(1, .03 + .8 * Math.abs(speedPU)));
  }
  for (const input of [{ vfRatio: -1 }, { voltageBoost: Infinity }, { angleDeg: NaN }]) assert.throws(() => VF.createModel(input), RangeError);
  near(VF.createModel({ angleDeg: 470 }).input.angleDeg, 110);
});

test('电压定向Ud为输出电压且Uq为零，Iq通常不为零', () => {
  for (const speedPU of [-2, -.1, 0, .1, 2]) for (const ld of [0, .2, .4]) {
    const model = VF.createModel({ speedPU, ld, voltageBoost: .1 });
    for (let angle = -180; angle <= 180; angle += 15) {
      const point = VF.atAngle(model, angle);
      near(point.vd, model.outputVoltage); near(point.vq, 0);
      const rotor = Rotor.evaluate(model, point.rotorDirect, point.rotorQuadrature);
      near(point.current, Math.hypot(point.direct, point.quadrature));
      near(point.active, model.outputVoltage * point.direct); near(point.reactive, -model.outputVoltage * point.quadrature);
      near(point.torque, rotor.torque); near(point.active, point.mechanical + point.copper);
      if (speedPU !== 0) near(VF.field(model, point.direct, point.quadrature).torque, point.torque);
    }
  }
  assert.ok(Math.abs(VF.atAngle(VF.createModel()).quadrature) > .01);
});

test('SPMSM电压轨迹符合独立相量解的圆心和半径', () => {
  const model = VF.createModel({ ld: .3, lq: .3 });
  const impedanceSquared = model.pu.resistance ** 2 + (model.input.speedPU * .3) ** 2;
  const centerD = model.outputVoltage * model.pu.resistance / impedanceSquared;
  const centerQ = -model.outputVoltage * model.input.speedPU * .3 / impedanceSquared;
  const radius = Math.abs(model.input.speedPU * model.pu.flux) / Math.sqrt(impedanceSquared);
  for (const point of VF.trajectory(model)) near(Math.hypot(point.direct - centerD, point.quadrature - centerQ), radius);
});

test('VF恒转矩线与五种功率场满足同一功率平衡，零电阻退化为直线', () => {
  const bounds = { x: [-3, 3], y: [-2, 2] };
  for (const resistance of [0, .02, .5]) for (const speedPU of [-1, 1]) {
    const model = VF.createModel({ resistance, speedPU });
    for (const level of [-1, -.5, 0, .5, 1]) {
      const points = VF.torqueCurves(model, level, bounds).flat().filter(Boolean);
      if (resistance > 0 && speedPU * level > model.outputVoltage ** 2 / (4 * resistance)) assert.equal(points.length, 0);
      else assert.ok(points.length > 0);
      for (const point of points) near(VF.field(model, point.direct, point.quadrature).torque, level);
    }
    const grid = VF.grid(model, bounds, 11);
    for (let row = 0; row < 11; row++) for (let column = 0; column < 11; column++) {
      const expected = VF.field(model, grid.x[column], grid.y[row]);
      for (const key of Object.keys(grid.fields)) near(grid.fields[key][row][column], expected[key]);
    }
  }
});

test('零电压无定向，奇异方程不伪造工作点；零速转矩场不能由功率反推', () => {
  const stopped = VF.createModel({ speedPU: 0 });
  assert.equal(stopped.reason, 'zero-voltage'); assert.equal(VF.atAngle(stopped), null);
  const singular = VF.createModel({ speedPU: 0, resistance: 0, voltageBoost: .1 });
  assert.equal(singular.reason, 'singular'); assert.deepEqual(VF.trajectory(singular), []);
  const energized = VF.createModel({ speedPU: 0, voltageBoost: .02 });
  const point = VF.atAngle(energized);
  near(point.direct, 1); near(point.quadrature, 0);
  assert.equal(VF.field(energized, 1, 0).torque, null);
  assert.ok(Number.isFinite(point.torque));
});

test('VF显隐几何保留独立轨迹和电流边界，隐藏图层为空', () => {
  const model = VF.createModel(), bounds = { x: [-3, 3], y: [-2, 2] };
  const visible = { voltage: true, current: true, torque: true, pf: true, mtpa: true, mtpv: true };
  const result = VF.geometry({ model, visible, levels: [-1, 1] }, bounds);
  assert.equal(result.lines.find(line => line.name === 'T = -1 pu').width, .85);
  assert.equal(result.lines.find(line => line.name === 'T = -1 pu').opacity, .3);
  assert.ok(result.lines.filter(line => line.kind === 'voltage-level').every(line => line.width === .85 && line.opacity === .35));
  const voltageLines = result.lines.filter(line => ['voltage', 'voltage-level'].includes(line.kind));
  assert.deepEqual(voltageLines.map(line => line.voltage).sort((first, second) => first - second), Rotor.DEFAULT_VOLTAGES.filter(voltage => voltage > 0));
  for (const line of voltageLines) for (const point of line.branches.flat()) { near(point.voltage, line.voltage); near(point.vd, line.voltage); near(point.vq, 0); }
  assert.equal(voltageLines.find(line => line.kind === 'voltage').voltage, model.outputVoltage);
  const custom = VF.geometry({ model, visible: { voltage: true }, levels: [], voltageLevels: [0, .35, 2.4] }, bounds);
  assert.deepEqual(custom.lines.map(line => line.voltage), [.35, 2.4, .8]);
  for (const kind of ['boundary', 'torque', 'pf', 'mtpa', 'mtpv']) assert.ok(result.lines.some(line => line.kind === kind));
  assert.deepEqual(VF.geometry({ model, visible: {}, levels: [] }, bounds).lines, []);
});

test('电压坐标MTPA/MTPV使用当前转速，保留转子极值与电压定向不变量', () => {
  const bounds = { x: [-6, 6], y: [-6, 6] }, samples = [];
  for (const speedPU of [-1, .5, 1, 2]) {
    const model = VF.createModel({ speedPU });
    const lines = VF.geometry({ model, visible: { mtpa: true, mtpv: true }, levels: [] }, bounds).lines;
    samples.push(lines.map(line => line.branches[0][90]));
    for (const line of lines) for (const [branchIndex, branch] of line.branches.entries()) for (const index of [30, 90, 150]) {
      const point = branch[index], direction = branchIndex === 0 ? 1 : -1;
      assert.ok(point);
      near(point.vq, 0); near(point.vd, point.voltage);
      near(point.current, Math.hypot(point.direct, point.quadrature));
      near(point.active, point.voltage * point.direct); near(point.reactive, -point.voltage * point.quadrature);
      const rotor = Rotor.evaluate(model, point.rotorDirect, point.rotorQuadrature);
      near(point.torque, rotor.torque);
      for (let angleIndex = 0; angleIndex < 720; angleIndex++) {
        const angle = angleIndex * 2 * Math.PI / 720;
        const candidate = line.kind === 'mtpa' ? { direct: point.current * Math.cos(angle), quadrature: point.current * Math.sin(angle) } : Rotor.currentAtVoltage(model, point.voltage, angle);
        const torque = (model.pu.flux + (model.pu.ld - model.pu.lq) * candidate.direct) * candidate.quadrature;
        assert.ok(direction * point.torque >= direction * torque - 1e-7, line.kind + ' extremum');
      }
    }
  }
  for (const sample of samples.slice(1)) {
    near(sample[0].rotorDirect, samples[0][0].rotorDirect);
    near(sample[0].rotorQuadrature, samples[0][0].rotorQuadrature);
  }
  for (const index of [0, 1]) assert.ok(Math.hypot(samples[1][index].direct - samples[3][index].direct, samples[1][index].quadrature - samples[3][index].quadrature) > 1e-4);
});

test('无唯一转矩极值或奇异电压约束时不伪造VF优化曲线', () => {
  const bounds = { x: [-3, 3], y: [-3, 3] };
  const noTorque = VF.createModel({ flux: 0, ld: .2, lq: .2 });
  const lines = VF.geometry({ model: noTorque, visible: { mtpa: true, mtpv: true }, levels: [] }, bounds).lines;
  assert.ok(lines.every(line => line.branches.flat().every(point => point === null)));
  const singular = VF.createModel({ resistance: 0, ld: 0 });
  const line = VF.geometry({ model: singular, visible: { mtpv: true }, levels: [] }, bounds).lines[0];
  assert.ok(line.branches.flat().every(point => point === null));
});