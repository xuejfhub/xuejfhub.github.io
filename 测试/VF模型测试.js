const test = require('node:test');
const assert = require('node:assert/strict');
const VF = require('../页面/电机控制/同步电机/VF模型.js');
const Rotor = require('../页面/电机控制/同步电机/电机模型.js');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('VF页面直接指定电压，正反转及零速不再使用压频比补偿或限幅', () => {
  for (const speedPU of [-2, -.5, 0, .5, 2]) for (const voltageLimit of [0, .2, .8, 1.3]) {
    const model = VF.createOperatingModel({ speedPU, voltageLimit, voltageMode: 'vf', vfRatio: 10, voltageBoost: 10 });
    near(model.outputVoltage, voltageLimit);
    assert.equal(model.input.voltageMode, 'manual'); assert.equal(model.input.vfRatio, 0); assert.equal(model.input.voltageBoost, 0);
    const state = VF.atAngle(model);
    if (voltageLimit === 0) assert.equal(state, null);
    else { near(state.voltage, voltageLimit); near(state.vq, 0); }
  }
  near(VF.atAngle(VF.createOperatingModel()).torque, VF.atAngle(VF.createModel()).torque);
});

test('VF固定电压投影沿原轨迹移动，电压幅值保持且不写回电源给定', () => {
  for (const parameters of Object.values(Rotor.PRESETS).map(preset => preset.parameters)) for (const speedPU of [-1, 0, 1]) {
    const model = VF.createOperatingModel({ ...parameters, speedPU }), reference = VF.atAngle(model);
    const destination = VF.atAngle(model, 118), projected = VF.projectCurrent(model, destination, reference);
    assert.ok(projected); near(projected.direct, destination.direct, 1e-7); near(projected.quadrature, destination.quadrature, 1e-7);
    near(projected.voltage, .8); near(projected.vq, 0); assert.equal(model.input.voltageLimit, .8);
    const arbitrary = { direct: reference.direct + .2, quadrature: reference.quadrature + .2 };
    const result = VF.projectCurrent(model, arbitrary, reference);
    assert.ok(result); near(result.voltage, .8);
    assert.ok(Math.hypot(result.direct - arbitrary.direct, result.quadrature - arbitrary.quadrature) <= Math.hypot(reference.direct - arbitrary.direct, reference.quadrature - arbitrary.quadrature) + 1e-10);
  }
  assert.equal(VF.projectCurrent(VF.createOperatingModel({ voltageLimit: 0 }), { direct: 1, quadrature: 1 }), null);
});

test('VF转子方向以负δ旋转，d/q轴正交且奇异时不伪造方向', () => {
  for (const angleDeg of [-170, -90, 0, 70, 110, 180]) {
    const model = VF.createOperatingModel({ angleDeg }), axes = VF.rotorAxes(model, { x: [-4, 4], y: [-3, 3] });
    assert.equal(axes.length, 2);
    const direct = axes[0].labelPoint, quadrature = axes[1].labelPoint, angle = angleDeg * Math.PI / 180;
    near(direct.direct, .96 * Math.cos(angle)); near(direct.quadrature, -.96 * Math.sin(angle));
    near(direct.direct * quadrature.direct + direct.quadrature * quadrature.quadrature, 0);
    assert.ok(direct.direct * quadrature.quadrature - direct.quadrature * quadrature.direct > 0);
  }
  assert.deepEqual(VF.rotorAxes(VF.createOperatingModel({ voltageLimit: 0 }), { x: [-1, 1], y: [-1, 1] }), []);
});

test('VF仅锁定所选物理量，四种锁定均可移动且未锁电压时允许U变化', () => {
  const model = VF.createOperatingModel(), reference = VF.atAngle(model), destination = { direct: reference.direct + .2, quadrature: reference.quadrature + .2 };
  for (const kind of ['voltage', 'current', 'torque', 'pf']) {
    const lock = VF.capturePointLock(reference, kind), result = VF.projectLockedCurrent(model, destination, reference, lock);
    assert.ok(result && VF.matchesLock(result, lock), kind);
    assert.ok(Math.hypot(result.direct - reference.direct, result.quadrature - reference.quadrature) > .01, kind);
    if (kind === 'voltage') near(result.voltage, model.outputVoltage);
    else assert.ok(Math.abs(result.voltage - reference.voltage) > 1e-5, kind);
  }
  const free = VF.projectLockedCurrent(model, destination, reference, null);
  near(free.direct, destination.direct); near(free.quadrature, destination.quadrature);
  assert.ok(Math.abs(free.voltage - reference.voltage) > .01);
});

test('VF锁定拒绝不兼容模型及PF反向支，解锁恢复原轨迹拖动', () => {
  const model = VF.createOperatingModel(), reference = VF.atAngle(model), lock = VF.capturePointLock(reference, 'torque');
  assert.equal(VF.projectLockedCurrent(VF.createOperatingModel({ speedPU: 0, resistance: 0 }), reference, reference, lock), null);
  const phaseLock = VF.capturePointLock(reference, 'pf');
  assert.equal(VF.matchesLock({ ...reference, phaseAngle: -reference.phaseAngle }, phaseLock), false);
  assert.equal(VF.matchesLock(null, phaseLock), false);
  const destination = VF.atAngle(model, 118), unlocked = VF.projectLockedCurrent(model, destination, reference, null);
  near(unlocked.direct, destination.direct, 1e-7); near(unlocked.quadrature, destination.quadrature, 1e-7);
});

test('VF未定义工作点或坐标分量不能成为锁定项', () => {
  assert.equal(VF.capturePointLock(null, 'current'), null);
  const point = VF.atAngle(VF.createOperatingModel());
  for (const kind of ['direct', 'quadrature', 'vd', 'vq']) assert.equal(VF.capturePointLock(point, kind), null);
  assert.equal(VF.capturePointLock({ ...point, voltage: 0 }, 'voltage'), null);
});

test('VF自由逆解在精确零电流停止，但允许近零有效鼠标落点', () => {
  const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
  const model = VF.createOperatingModel(), reference = VF.atAngle(model);
  const scene = { frame: 'voltage', model, point: reference, solveCurrent: (position, previous) => VF.projectLockedCurrent(model, position, previous, null) };
  assert.equal(Preview.pointDragState(scene, 'current-vector', { direct: 0, quadrature: 0 }, reference), null);
  const held = Preview.advanceDrag((position, previous) => Preview.pointDragState(scene, 'current-vector', position, previous), reference, { direct: 0, quadrature: 0 }, reference);
  assert.equal(held.blocked, true); assert.ok(held.value.current > 0);
  assert.ok(Preview.pointDragState(scene, 'current-vector', { direct: .005, quadrature: .001 }, reference));
});

test('VF全平面四量使用完整逆解，多解不默认选支并保留无解空白', () => {
  const model = VF.createOperatingModel(), sampler = VF.createFieldSampler(), bounds = { x: [0, 1], y: [-5, 5] };
  const unique = sampler.sample(model, bounds, 3, 'unique'), low = sampler.sample(model, bounds, 3, '0'), high = sampler.sample(model, bounds, 3, '1');
  assert.equal(unique.counts[0][1], 2); assert.equal(unique.fields.torque[0][1], null); assert.equal(unique.ambiguous[0][1], 1);
  assert.equal(unique.counts[2][0], 0); assert.equal(unique.fields.voltage[2][0], null);
  assert.ok(low.fields.voltage[0][1] < high.fields.voltage[0][1]);
  assert.ok(low.fields.torque[0][1] < 0 && high.fields.torque[0][1] > 0);
  for (const result of [low, high]) {
    const voltage = result.fields.voltage[0][1], active = voltage * .5, reactive = voltage * 5;
    near(result.fields.active[0][1], active); near(result.fields.reactive[0][1], reactive);
    near(result.fields.torque[0][1], active - .02 * (25 + .25));
  }
  sampler.sample(VF.createOperatingModel({ voltageLimit: 2, angleDeg: 40 }), bounds, 3, '0');
  assert.equal(sampler.statistics.builds, 1); assert.equal(sampler.statistics.hits, 3);
});

test('VF全平面分支正反转满足独立功率平衡，零速与奇异状态不伪造场', () => {
  const sampler = VF.createFieldSampler(), bounds = { x: [-2, 2], y: [-6, 2] };
  for (const speedPU of [-1, 1, 2]) {
    const model = VF.createOperatingModel({ speedPU }), result = sampler.sample(model, bounds, 17, '0');
    assert.ok(result.summary.shown > 20);
    result.y.forEach((quadrature, row) => result.x.forEach((direct, column) => {
      const voltage = result.fields.voltage[row][column];
      if (voltage === null) return;
      near(result.fields.active[row][column], voltage * direct, 1e-7);
      near(result.fields.reactive[row][column], -voltage * quadrature, 1e-7);
      near(result.fields.torque[row][column], (voltage * direct - model.pu.resistance * (direct ** 2 + quadrature ** 2)) / speedPU, 1e-7);
    }));
  }
  const zero = sampler.sample(VF.createOperatingModel({ speedPU: 0 }), bounds, 5);
  assert.equal(zero.status, 'zero-speed'); assert.ok(zero.fields.torque.flat().every(value => value === null));
  assert.equal(sampler.sample(VF.createOperatingModel({ resistance: 0, ld: 0 }), bounds, 5, '0').status, 'singular');
});

test('VF原点连续支从反电动势出发，不跳到多解区的低压支', () => {
  const model = VF.createOperatingModel(), origin = VF.originState(model, 0, 0);
  near(origin.voltage, .8); near(origin.torque, 0); near(origin.active, 0); near(origin.reactive, 0); near(origin.angleDeg, 90);
  let previous = origin;
  for (let index = 1; index <= 100; index++) {
    const state = VF.originState(model, .5 * index / 100, -5 * index / 100);
    assert.ok(state); assert.ok(state.inverseSlope < 0);
    assert.ok(Math.abs(Rotor.normalizePhaseAngle(state.angleDeg - previous.angleDeg)) < 5);
    near(state.active, state.voltage * .5 * index / 100, 1e-7);
    previous = state;
  }
  near(previous.voltage, 2.114960361631033, 1e-7);
  for (let angle = -Math.PI; angle < Math.PI; angle += Math.PI / 6) {
    const state = VF.originState(model, 1e-6 * Math.cos(angle), 1e-6 * Math.sin(angle));
    assert.ok(state); near(state.voltage, .8, 1e-5);
    for (const key of ['torque', 'active', 'reactive']) assert.ok(Math.abs(state[key]) < 1e-5);
  }
  assert.equal(VF.originState(model, 0, 5), null);
  near(VF.originState(VF.createOperatingModel({ speedPU: -1 }), 0, 0).angleDeg, -90);
  assert.equal(VF.originState(VF.createOperatingModel({ flux: 0 }), 0, 0), null);
  assert.equal(VF.originState(VF.createOperatingModel({ speedPU: 0 }), 0, 0), null);
});

test('VF连续支不依赖视窗或采样顺序，原点在奇异逆矩阵下仍按已知电流计算', () => {
  const sampler = VF.createFieldSampler(), model = VF.createOperatingModel();
  const first = sampler.sample(model, { x: [0, 1], y: [-5, 5] }, 3);
  const second = sampler.sample(model, { x: [-.5, 1.5], y: [-10, 0] }, 5);
  for (const key of Object.keys(VF.FIELD_QUANTITIES)) near(first.fields[key][0][1], second.fields[key][2][2]);
  let neighbors = 0;
  for (let row = 0; row < 17; row++) for (let column = 0; column < 17; column++) {
    const direct = -2 + column / 4, quadrature = -3 + row / 4, state = VF.originState(model, direct, quadrature);
    if (!state || state.inverseSlope > -.1) continue;
    for (const [nextD, nextQ] of [[direct + .25, quadrature], [direct, quadrature + .25]]) {
      const expected = VF.originState(model, nextD, nextQ);
      if (!expected || expected.inverseSlope > -.1) continue;
      const continued = VF.currentState(model, nextD, nextQ, state);
      assert.ok(continued); near(continued.voltage, expected.voltage, 1e-7); near(continued.torque, expected.torque, 1e-7); neighbors++;
    }
  }
  assert.ok(neighbors > 200);
  near(VF.originState(VF.createOperatingModel({ resistance: 0, ld: 0 }), 0, 0).voltage, .8);
  assert.equal(sampler.sample(VF.createOperatingModel({ flux: 0 }), { x: [-1, 1], y: [-1, 1] }, 3).status, 'zero-flux');
});

test('VF电流逆解保留原电压分支，不默认跳到最低电压', () => {
  for (const parameters of Object.values(Rotor.PRESETS).map(preset => preset.parameters)) for (const speedPU of [-1, .5, 2]) {
    const model = VF.createModel({ ...parameters, speedPU });
    for (const angle of [-150, -70, 10, 110, 170]) {
      const reference = VF.atVoltage(model, .8, angle), solutions = VF.voltageSolutions(model, reference.direct, reference.quadrature);
      assert.ok(solutions.some(state => Math.abs(Rotor.normalizePhaseAngle(state.angleDeg - angle)) < 1e-5));
      const state = VF.currentState(model, reference.direct, reference.quadrature, reference);
      assert.ok(state); near(state.voltage, .8, 1e-7); near(state.torque, reference.torque, 1e-7);
      const destination = VF.atVoltage(model, .81, angle + .5);
      const moved = VF.currentState(model, destination.direct, destination.quadrature, reference);
      assert.ok(moved); near(moved.voltage, .81, 1e-7); near(moved.torque, destination.torque, 1e-7);
      near(Rotor.normalizePhaseAngle(moved.angleDeg - angle - .5), 0, 1e-5);
    }
  }
  const model = VF.createModel({ resistance: 0, ld: .2, lq: .2 });
  const solutions = VF.voltageSolutions(model, .5, -5).sort((first, second) => first.voltage - second.voltage);
  assert.equal(solutions.length, 2); assert.ok(solutions[0].voltage < .5 && solutions[1].voltage > 1);
  for (const reference of solutions) {
    const moved = VF.currentState(model, .51, -5, reference);
    assert.ok(moved && moved.inverseSlope * reference.inverseSlope > 0);
    assert.ok(Math.abs(moved.voltage - reference.voltage) < .01);
  }
  assert.equal(VF.currentState(model, 0, 5, solutions[0]), null);
  assert.equal(VF.currentState(model, 4, -5, solutions[0]), null);
});

test('VF拖动遇到逆解折点停止，返回有效域后保持原支', () => {
  const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
  const model = VF.createModel({ resistance: 0, ld: .2, lq: .2 });
  const reference = VF.voltageSolutions(model, 3.8, -5)[0];
  const solve = (point, previous) => VF.currentState(model, point.direct, point.quadrature, previous);
  const held = Preview.advanceDrag(solve, { direct: 3.8, quadrature: -5 }, { direct: 4.2, quadrature: -5 }, reference);
  assert.equal(held.blocked, true); assert.ok(held.point.direct < 4 && held.point.direct > 3.99);
  const resumed = Preview.advanceDrag(solve, held.point, { direct: 3.6, quadrature: -5 }, held.value);
  assert.equal(resumed.blocked, false); near(resumed.value.direct, 3.6, 1e-7);
  assert.ok(resumed.value.inverseSlope * reference.inverseSlope > 0);
});

test('VF三类演示预设在默认频率电压和相角下具有未超流的有限工作点', () => {
  for (const preset of Object.values(Rotor.PRESETS)) {
    const model = VF.createModel(preset.parameters), point = VF.atAngle(model);
    assert.ok(point && Number.isFinite(point.torque));
    near(point.vd, model.outputVoltage); near(point.vq, 0);
    assert.ok(point.current <= model.input.currentLimit);
  }
});

test('VF当前实线与背景虚线组分别显隐，隐藏当前电压仍保留同值参考线', () => {
  const model = VF.createModel(), bounds = { x: [-6, 6], y: [-6, 6] };
  for (const kind of ['torque', 'voltage', 'phase']) for (const selected of [false, true]) for (const group of [false, true]) {
    const lines = VF.geometry({ model, levels: Rotor.DEFAULT_TORQUES, torqueTarget: 1, phaseTarget: 30,
      visible: { [kind]: selected, [kind + 'Group']: group } }, bounds).lines;
    assert.equal(lines.some(line => line.kind === kind), selected);
    assert.equal(lines.some(line => line.kind === kind + '-level'), group);
    for (const line of lines) assert.deepEqual(line.dash, line.kind.endsWith('-level') ? [7, 6] : []);
    if (kind === 'voltage' && group && !selected) assert.ok(lines.some(line => line.value === model.outputVoltage));
  }
});

test('VF最低正电压不能简单按闭合曲线内外判定', () => {
  const model = VF.createModel({ resistance: 0, ld: .2, lq: .2, flux: .8 });
  near(VF.requiredVoltage(model, .5, -5), 1 - Math.sqrt(.63));
  assert.ok(VF.requiredVoltage(model, .5, -5) < .5);
  assert.equal(VF.requiredVoltage(model, 0, 5), Infinity);
  near(VF.requiredVoltage(model, 0, .5), .7);
  near(VF.requiredVoltage(VF.createModel(), .5, -5), .20876806879147064, 1e-8);
  near(VF.requiredVoltage(VF.createModel(), 4, 0), .08, 1e-8);
});

test('VF逆向电压判定包含正反转和退化电机的所有抽样前向状态', () => {
  for (const input of [{}, { resistance: 0 }, { ld: 0 }, { lq: 0 }, { resistance: 0, ld: 0 },
    { resistance: 0, lq: 0 }, { flux: 0 }, { resistance: 0, flux: 0 }, { resistance: 0, ld: 0, lq: 0 }, { flux: 0, ld: .2, lq: .2 }]) {
    for (const speedPU of [-1, .5, 2]) {
      const model = VF.createModel({ ...input, speedPU });
      for (const rotorD of [-4, -1, 0, .5, 3]) for (const rotorQ of [-2, -.5, 0, .7, 2]) {
        const point = Rotor.evaluate(model, rotorD, rotorQ);
        if (point.voltage < 1e-8) continue;
        const direct = point.active / point.voltage, quadrature = -point.reactive / point.voltage;
        const required = VF.requiredVoltage(model, direct, quadrature);
        assert.ok(Number.isFinite(required) && required > 0 && required <= point.voltage + 1e-7, JSON.stringify({ input, speedPU, rotorD, rotorQ, required, voltage: point.voltage }));
      }
    }
  }
  const stopped = VF.createModel({ speedPU: 0 });
  near(VF.requiredVoltage(stopped, 1, 0), .02);
  assert.equal(VF.requiredVoltage(stopped, -1, 0), Infinity);
  assert.equal(VF.requiredVoltage(stopped, 1, .1), Infinity);
  assert.equal(VF.requiredVoltage(VF.createModel({ speedPU: 0, resistance: 0 }), 1, 0), Infinity);
});

test('VF等夹角参考线是每30度的有向射线，夹角与转子相角delta独立', () => {
  const bounds = { x: [-5, 5], y: [-5, 5] }, model = VF.createModel();
  for (const angle of Rotor.DEFAULT_PHASE_ANGLES) {
    const branches = VF.phaseAngleCurves(model, angle, bounds);
    assert.equal(branches.length, 1);
    for (const point of branches.flat()) {
      const state = VF.field(model, point.direct, point.quadrature);
      near(Rotor.normalizePhaseAngle(state.phaseAngle - angle), 0);
      near(Math.cos(state.phaseAngle * Math.PI / 180), state.pf);
    }
  }
  const point = VF.atAngle(model);
  near(point.phaseAngle, VF.field(model, point.direct, point.quadrature).phaseAngle);
  assert.ok(Math.abs(point.phaseAngle - model.input.angleDeg) > 1);
  assert.deepEqual(VF.phaseAngleCurves(VF.createModel({ voltageLimit: 0 }), 30, bounds), []);
});

test('VF拖动沿选中相角反算电压，转矩与电流采用电压坐标功率平衡', () => {
  const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
  for (const speedPU of [-1, .5, 2]) {
    const model = VF.createModel({ speedPU }), scene = { model, frame: 'voltage' };
    for (const angleDeg of [-150, -60, 0, 55, 110, 170]) for (const voltage of [.2, .8, 1.6, 3]) {
      const point = VF.atVoltage(model, voltage, angleDeg);
      near(Preview.curveDragValue(scene, { kind: 'voltage', angleDeg }, point), voltage);
      near(Preview.curveDragValue(scene, { kind: 'current' }, point), point.current);
      near(Preview.curveDragValue(scene, { kind: 'phase' }, point), VF.field(model, point.direct, point.quadrature).phaseAngle);
      near(Preview.curveDragValue(scene, { kind: 'torque' }, point), VF.field(model, point.direct, point.quadrature).torque);
    }
  }
  assert.equal(Preview.curveDragValue({ model: VF.createModel({ speedPU: 0 }), frame: 'voltage' }, { kind: 'torque' }, { direct: 1, quadrature: 0 }), null);
});

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
  const visible = { voltage: true, current: true, torque: true, phase: true, mtpa: true, mtpv: true };
  const result = VF.geometry({ model, visible, levels: [-1, 1] }, bounds);
  assert.equal(result.lines.find(line => line.name === 'T = -1 pu').width, 1);
  assert.equal(result.lines.find(line => line.name === 'T = -1 pu').opacity, .45);
  assert.ok(result.lines.filter(line => line.kind === 'voltage-level').every(line => line.width === 1 && line.opacity === .45));
  const voltageLines = result.lines.filter(line => ['voltage', 'voltage-level'].includes(line.kind));
  assert.deepEqual(voltageLines.map(line => line.voltage).sort((first, second) => first - second), Rotor.DEFAULT_VOLTAGES.filter(voltage => voltage > 0));
  for (const line of voltageLines) for (const point of line.branches.flat()) { near(point.voltage, line.voltage); near(point.vd, line.voltage); near(point.vq, 0); }
  assert.equal(voltageLines.find(line => line.kind === 'voltage').voltage, model.outputVoltage);
  const custom = VF.geometry({ model, visible: { voltage: true }, levels: [], voltageLevels: [0, .35, 2.4] }, bounds);
  assert.deepEqual(custom.lines.map(line => line.voltage), [.35, 2.4, .8]);
  for (const kind of ['current', 'torque-level', 'phase-level', 'mtpa', 'mtpv']) assert.ok(result.lines.some(line => line.kind === kind));
  assert.deepEqual(result.lines.filter(line => line.kind === 'phase-level').map(line => line.value), Rotor.DEFAULT_PHASE_ANGLES);
  assert.deepEqual(VF.geometry({ model, visible: {}, levels: [] }, bounds).lines, []);
  const selected = VF.geometry({ model, visible, levels: Rotor.DEFAULT_TORQUES, torqueTarget: -.7, phaseTarget: 90 }, bounds);
  const selectedTorque = selected.lines.find(line => line.kind === 'torque');
  for (const point of selectedTorque.branches.flat().filter(Boolean)) near(VF.field(model, point.direct, point.quadrature).torque, -.7);
  for (const point of selected.lines.find(line => line.kind === 'phase').branches.flat()) near(VF.field(model, point.direct, point.quadrature).phaseAngle, 90);
  const hidden = VF.geometry({ model, visible: { ...visible, torqueGroup: false, voltageGroup: false, phaseGroup: false, mtpa: false, mtpv: false }, levels: Rotor.DEFAULT_TORQUES, torqueTarget: 1, phaseTarget: 30 }, bounds);
  assert.deepEqual(hidden.lines.map(line => line.kind).sort(), ['voltage', 'current', 'torque', 'phase'].sort());
});

test('指定电压模式可独立调幅且不伪装成V/f联动', () => {
  const manual = VF.createModel({ voltageMode: 'manual', voltageLimit: 1.3, speedPU: .5 });
  near(manual.outputVoltage, 1.3);
  near(VF.atAngle(manual).vd, 1.3);
  near(VF.createModel({ ...manual.input, voltageMode: 'vf' }).outputVoltage, .4);
  assert.throws(() => VF.createModel({ voltageMode: 'unknown' }), RangeError);
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

test('VF约束网格采用存在正电压解，限值变化不重算逆解', () => {
  const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
  const sampler = Preview.createConstraintSampler({ frame: 'voltage', requiredVoltage: VF.requiredVoltage });
  const view = { x: [-3, 3], y: [-3, 3] }, model = VF.createModel();
  const region = sampler.sample(model, view, 31);
  assert.equal(region.dimension, 2);
  for (let row = 0; row < region.y.length; row++) for (let column = 0; column < region.x.length; column++) {
    const direct = region.x[column], quadrature = region.y[row];
    assert.equal(region.z[row][column] === 1, Math.hypot(direct, quadrature) <= 1 + 1e-10 && VF.requiredVoltage(model, direct, quadrature) <= .8 + 1e-10);
  }
  const builds = sampler.statistics.builds;
  sampler.sample(VF.createModel({ voltageMode: 'manual', voltageLimit: .6, currentLimit: 1.2 }), view, 31);
  assert.equal(sampler.statistics.builds, builds);
  assert.equal(sampler.sample(VF.createModel({ voltageLimit: 0 }), view, 31).dimension, -1);
  const stopped = sampler.sample(VF.createModel({ speedPU: 0, voltageBoost: .02 }), view, 31);
  assert.equal(stopped.dimension, 1);
  near(stopped.segments[0].at(-1).direct, 1); near(stopped.segments[0].at(-1).quadrature, 0);
  const uniform = VF.createModel({ flux: 0, ld: .2, lq: .2 });
  assert.equal(sampler.sample(uniform, view, 31).dimension, 1);
});

test('VF逆解最低电压满足独立的转子角单位圆约束', () => {
  for (const speedPU of [-1, 1]) {
    const model = VF.createModel({ speedPU }), { resistance, ld, lq, flux } = model.pu;
    for (let row = -8; row <= 8; row++) for (let column = -8; column <= 8; column++) {
      const direct = column / 4, quadrature = row / 4, voltage = VF.requiredVoltage(model, direct, quadrature);
      assert.ok(Number.isFinite(voltage));
      const firstD = voltage - resistance * direct + speedPU * lq * quadrature;
      const firstQ = resistance * quadrature + speedPU * lq * direct;
      const secondD = -resistance * quadrature - speedPU * ld * direct;
      const secondQ = voltage - resistance * direct + speedPU * ld * quadrature;
      const determinant = firstD * secondQ - firstQ * secondD;
      const cosine = -firstQ * speedPU * flux / determinant, sine = firstD * speedPU * flux / determinant;
      near(cosine * cosine + sine * sine, 1, 1e-6);
      const point = Rotor.evaluate(model, direct * cosine - quadrature * sine, direct * sine + quadrature * cosine);
      near(point.vd * cosine + point.vq * sine, voltage, 1e-6);
      near(-point.vd * sine + point.vq * cosine, 0, 1e-6);
    }
  }
});