const test = require('node:test');
const assert = require('node:assert/strict');
const Motor = require('../页面/电机控制/同步电机/电机模型.js');
const Preview = require('../页面/电机控制/同步电机/拖动预览.js');
const Analysis = require('../页面/电机控制/同步电机/工作点分析.js');
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('电压坐标色图反算完整电流状态，六种量与正向模型一致', () => {
  for (const preset of Object.values(Motor.PRESETS)) for (const speedPU of [-2, 0, 1]) {
    const model = Motor.createModel({ ...preset.parameters, speedPU });
    for (const direct of [-2, -.5, .7]) for (const quadrature of [-1, .8]) {
      const original = Analysis.stateAt(model, direct, quadrature), inverse = Analysis.stateAt(model, original.vd, original.vq, 'voltage');
      for (const key of ['direct', 'quadrature', ...Object.keys(Analysis.quantities)]) if (original[key] !== null) near(inverse[key], original[key], 1e-8);
    }
  }
  const singular = Motor.createModel({ resistance: 0, speedPU: 0 });
  assert.equal(Analysis.stateAt(singular, 1, 1, 'voltage'), null);
  assert.ok(Analysis.grid(singular, { x: [-1, 1], y: [-1, 1] }, 5, 'voltage').fields.torque.flat().every(value => value === null));
});

test('两个角度使用闭合色环，零矢量保持未定义且色标不随极值变化', () => {
  assert.deepEqual(Analysis.angleColor(-180), Analysis.angleColor(180));
  assert.deepEqual(Analysis.angleColor(-179.999), Analysis.angleColor(179.999));
  assert.deepEqual(Analysis.angleColor(20), Analysis.angleColor(380));
  for (const key of ['phaseAngle', 'voltageAngle']) assert.deepEqual(Analysis.colorRange(key, 2), [-180, 180]);
  assert.equal(Analysis.stateAt(Motor.createModel(), 0, 0).phaseAngle, null);
  assert.equal(Analysis.stateAt(Motor.createModel(), 0, 0, 'voltage').voltageAngle, null);
});

test('单量锁定保留幅值转矩或PF，允许两个坐标分量同时变化', () => {
  const model = Motor.createModel(), reference = Motor.evaluate(model, -.5, .7);
  for (const key of ['current', 'voltage', 'torque', 'pf']) {
    const locks = { [key]: Analysis.captureLock(reference, key) };
    const candidate = Motor.evaluate(model, -.3, .9), result = Analysis.constrain(model, candidate, reference, locks);
    assert.ok(result, key); near(result[key], reference[key], 1e-8);
    assert.ok(Math.abs(result.direct - reference.direct) > 1e-4, key);
    assert.ok(Math.abs(result.quadrature - reference.quadrature) > 1e-4, key);
    if (key === 'pf') near(result.phaseAngle, reference.phaseAngle, 1e-8);
  }
});

test('多独立锁定不跳交点，冗余约束仍允许移动，不一致约束返回无解', () => {
  const model = Motor.createModel(), reference = Motor.evaluate(model, -.5, .7), candidate = Motor.evaluate(model, -.3, .9);
  const locks = Object.fromEntries(['current', 'voltage', 'torque', 'pf'].map(key => [key, Analysis.captureLock(reference, key)]));
  const held = Analysis.constrain(model, candidate, reference, locks);
  near(held.direct, reference.direct); near(held.quadrature, reference.quadrature);
  assert.equal(Analysis.constrain(model, candidate, reference, { ...locks, torque: { value: 100 } }), null);
  const zeroSpeed = Motor.createModel({ speedPU: 0 }), start = Motor.evaluate(zeroSpeed, -.5, .7);
  const redundant = Object.fromEntries(['current', 'voltage'].map(key => [key, Analysis.captureLock(start, key)]));
  const moved = Analysis.constrain(zeroSpeed, candidate, start, redundant);
  assert.ok(moved); near(moved.current, start.current); near(moved.voltage, start.voltage);
  assert.ok(Math.abs(moved.direct - start.direct) > .01);
});

test('恒转矩锁定拒绝相同转矩的另一条断开分支', () => {
  const model = Motor.createModel(), reference = Motor.evaluate(model, -.5, .7);
  const other = Motor.evaluate(model, 5, reference.torque / (model.pu.flux + (model.pu.ld - model.pu.lq) * 5));
  near(other.torque, reference.torque);
  assert.equal(Analysis.constrain(model, other, reference, { torque: Analysis.captureLock(reference, 'torque') }), null);
});

test('四类电压轨迹逐点来自对应电流状态，正反转及零速均保持等值关系', () => {
  const bounds = { x: [-2, 2], y: [-2, 2] };
  for (const speedPU of [-1, 0, 1]) {
    const model = Motor.createModel({ speedPU });
    for (const [kind, value] of [['current', 1], ['voltage', 1], ['torque', .5], ['phase', speedPU === 0 ? 0 : 30]]) {
      const pair = Analysis.trajectoryPair(model, kind, value, bounds);
      let count = 0;
      pair.current.forEach((branch, branchIndex) => branch.forEach((point, index) => {
        const mapped = pair.voltage[branchIndex][index];
        if (!point) { assert.equal(mapped, null); return; }
        const state = Motor.evaluate(model, point.direct, point.quadrature);
        near(mapped.direct, state.vd); near(mapped.quadrature, state.vq);
        near(state[kind === 'phase' ? 'phaseAngle' : kind], value, 1e-7); count++;
      }));
      if (speedPU !== 0 || kind !== 'phase') assert.ok(count > 0, kind);
    }
  }
});

test('电压映射按电压视窗反算采样范围，不漏掉屏外电流对应的可见电压', () => {
  const model = Motor.createModel(), pair = Analysis.trajectoryPair(model, 'torque', .5, { x: [-1, 1], y: [-1, 1] }, 1600);
  assert.ok(pair.current.some((branch, branchIndex) => branch.some((point, index) => {
    const mapped = pair.voltage[branchIndex][index];
    return point && (Math.abs(point.direct) > 1 || Math.abs(point.quadrature) > 1) && Math.abs(mapped.direct) < 1 && Math.abs(mapped.quadrature) < 1;
  })));
  const empty = Analysis.voltageGeometry(model, { current: 1 }, {}, { x: [-1, 1], y: [-1, 1] });
  assert.deepEqual(empty, []);
  const singular = Motor.createModel({ resistance: 0, speedPU: 0 });
  const collapsed = Analysis.voltageGeometry(singular, { current: 1 }, { current: true }, { x: [-1, 1], y: [-1, 1] });
  assert.equal(collapsed[0].dots, true); assert.equal(collapsed[0].draggable, false);
});

test('矢量电压电流互逆，零矢量和穿越方向奇点的移动被拒绝', () => {
  const model = Motor.createModel(), reference = Motor.evaluate(model, -.5, .7), scene = { model, point: reference };
  const current = Preview.pointDragState(scene, 'current-vector', { direct: -.4, quadrature: .6 });
  assert.ok(Preview.interactivePoint(current)); near(current.direct, -.4); near(current.quadrature, .6);
  const voltage = Preview.pointDragState(scene, 'voltage-vector', { direct: current.vd, quadrature: current.vq });
  near(voltage.direct, current.direct); near(voltage.quadrature, current.quadrature);
  assert.equal(Preview.pointDragState(scene, 'current-vector', { direct: 0, quadrature: 0 }), null);
  assert.equal(Preview.pointDragState(scene, 'voltage-vector', { direct: 0, quadrature: 0 }), null);
  const held = Preview.advanceDrag((point, previous) => Preview.pointDragState(scene, 'current-vector', point, previous),
    { direct: reference.direct, quadrature: reference.quadrature }, { direct: -reference.direct, quadrature: -reference.quadrature }, reference);
  assert.equal(held.blocked, true); assert.ok(Preview.interactivePoint(held.value)); assert.ok(held.value.quadrature > 0);
});

test('无解和异常停止在最后有效位置，返回有效域后可继续拖动', () => {
  const solve = point => { if (point.direct >= 1) throw new RangeError('singular'); return point.direct; };
  const held = Preview.advanceDrag(solve, { direct: 0, quadrature: 0 }, { direct: 2, quadrature: 0 }, 0);
  assert.equal(held.blocked, true); assert.ok(held.value < 1 && held.value > .99);
  const resumed = Preview.advanceDrag(solve, held.point, { direct: .3, quadrature: 0 }, held.value);
  assert.equal(resumed.blocked, false); near(resumed.value, .3);
});

test('功角拖动不会跨过零电流或零电压的方向奇点', () => {
  const model = Motor.createModel(), scene = { model }, hit = { kind: 'phase' };
  assert.equal(Preview.curveDragValue(scene, hit, { direct: .5, quadrature: -.7 }, { direct: -.5, quadrature: .7 }), null);
  const center = Motor.currentAtVoltage(model, 0, 0);
  assert.equal(Preview.curveDragValue(scene, hit, { direct: center.direct + .1, quadrature: center.quadrature }, { direct: center.direct - .1, quadrature: center.quadrature }), null);
  const start = { direct: -.5, quadrature: .7 }, target = { direct: .5, quadrature: -.7 };
  const result = Preview.advanceDrag((point, value, previous) => Preview.curveDragValue(scene, hit, point, previous), start, target, Motor.evaluate(model, start.direct, start.quadrature).phaseAngle);
  assert.equal(result.blocked, true); assert.ok(Number.isFinite(result.value)); assert.ok(result.point.quadrature > 0);
});

test('屏幕精度保护拒绝趋近零矢量，但允许从微小有效值向外恢复', () => {
  const model = Motor.createModel(), scene = { model, minimumVector: .01 };
  assert.equal(Preview.pointDragState(scene, 'current-vector', { direct: 0, quadrature: .005 }, Motor.evaluate(model, 0, .02)), null);
  assert.ok(Preview.pointDragState(scene, 'current-vector', { direct: 0, quadrature: .02 }, Motor.evaluate(model, 0, .005)));
  assert.equal(Preview.pointDragState(scene, 'current-vector', { direct: 0, quadrature: -.02 }, Motor.evaluate(model, 0, .005)), null);
});

test('三类预设只填充标幺参数，继续使用同一个可编辑模型', () => {
  assert.deepEqual(Object.keys(Motor.PRESETS), ['spm', 'ipm', 'synrm']);
  const { spm, ipm, synrm } = Motor.PRESETS;
  assert.equal(spm.parameters.ld, spm.parameters.lq); assert.ok(spm.parameters.flux > 0);
  assert.ok(ipm.parameters.ld < ipm.parameters.lq && ipm.parameters.flux > 0);
  assert.ok(synrm.parameters.ld > synrm.parameters.lq); assert.equal(synrm.parameters.flux, 0);
  for (const preset of Object.values(Motor.PRESETS)) {
    const model = Motor.createModel(preset.parameters);
    assert.deepEqual(model.pu, preset.parameters);
    for (const kind of ['mtpa', 'mtpv']) assert.ok(Number.isFinite(Motor[kind](model, 1).torque));
    assert.equal(Motor.createModel({ ...preset.parameters, resistance: .123 }).pu.resistance, .123);
  }
  for (const [key, value] of Object.entries(ipm.parameters)) assert.equal(Motor.DEFAULTS[key], value);
});

test('转子约束域同时满足电压电流上限，改变边界复用电压场', () => {
  const sampler = Preview.createConstraintSampler(), view = { x: [-3, 2], y: [-2, 2] };
  const model = Motor.createModel(), region = sampler.sample(model, view, 41);
  assert.equal(region.dimension, 2);
  for (let row = 0; row < region.y.length; row++) for (let column = 0; column < region.x.length; column++) {
    assert.equal(region.z[row][column] === 1, Motor.evaluate(model, region.x[column], region.y[row]).feasible);
  }
  const builds = sampler.statistics.builds;
  sampler.sample(Motor.createModel({ voltageLimit: .8, currentLimit: 1.2 }), view, 41);
  assert.equal(sampler.statistics.builds, builds);
  sampler.sample(Motor.createModel({ speedPU: -1 }), view, 41);
  assert.equal(sampler.statistics.builds, builds + 1);
  assert.equal(Preview.constraintTrace(region).opacity, .22);
  const tiny = sampler.sample(Motor.createModel({ ld: 1e8, lq: 1e8 }), view, 41);
  assert.ok(tiny.bounds.x[1] - tiny.bounds.x[0] < 1e-6);
  assert.ok(tiny.bounds.y[1] - tiny.bounds.y[0] < 1e-6);
});

test('零电压或零电流约束按真实点线退化，不铺假面积', () => {
  const sampler = Preview.createConstraintSampler(), view = { x: [-6, 6], y: [-6, 6] };
  assert.equal(sampler.sample(Motor.createModel({ currentLimit: 0 }), view, 21).dimension, 0);
  assert.equal(sampler.sample(Motor.createModel({ voltageLimit: 0, currentLimit: 6 }), view, 21).dimension, 0);
  const line = sampler.sample(Motor.createModel({ resistance: 0, lq: 0, voltageLimit: 0, currentLimit: 6 }), view, 21);
  assert.equal(line.dimension, 1);
  for (const point of line.segments.flat()) near(Motor.evaluate(Motor.createModel({ resistance: 0, lq: 0 }), point.direct, point.quadrature).voltage, 0);
  assert.equal(sampler.sample(Motor.createModel({ resistance: 0, speedPU: 0, voltageLimit: 0 }), view, 21).dimension, 2);
});

test('电压电流有向夹角每30度取样，区分超前滞后且端点不重复', () => {
  assert.deepEqual(Motor.DEFAULT_PHASE_ANGLES, [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]);
  assert.equal(Motor.normalizePhaseAngle(180), -180); assert.equal(Motor.normalizePhaseAngle(390), 30);
  assert.equal(Motor.phaseAngle(0, 0, 1, 0), null); assert.equal(Motor.phaseAngle(1, 0, 0, 0), null);
  near(Motor.phaseAngle(1e-200, 0, 1e-200, 0), 0);
  for (const speedPU of [-1, .5, 2]) {
    const model = Motor.createModel({ speedPU });
    for (const [direct, quadrature] of [[-.7, .4], [.4, -.7], [-2, -1], [1, 2]]) {
      const state = Motor.evaluate(model, direct, quadrature);
      near(Math.cos(state.phaseAngle * Math.PI / 180), state.pf);
      near(Motor.normalizePhaseAngle(state.phaseAngle - Math.atan2(state.reactive, state.active) * 180 / Math.PI), 0);
    }
  }
});

test('转子等夹角线逐点满足有向相位，正负90度保留正确退化分支', () => {
  let total = 0;
  for (const speedPU of [-1, 1]) for (const resistance of [0, .02]) {
    const model = Motor.createModel({ speedPU, resistance });
    for (const angle of Motor.DEFAULT_PHASE_ANGLES) {
      const points = Motor.phaseAngleCurves(model, angle, 8, 400).flat().filter(Boolean);
      total += points.length;
      for (const point of points) {
        const state = Motor.evaluate(model, point.direct, point.quadrature);
        near(Motor.normalizePhaseAngle(state.phaseAngle - angle), 0, 1e-6);
        assert.ok(state.current > 0 && state.voltage > 0);
      }
    }
  }
  assert.ok(total > 1000);
  const lossless = Motor.createModel({ resistance: 0 });
  assert.ok(Motor.phaseAngleCurves(lossless, 90, 8).flat().filter(Boolean).some(point => Math.abs(point.direct - 4) < 1e-9 && Math.abs(point.quadrature) > 1));
  assert.ok(Motor.phaseAngleCurves(lossless, -90, 8).flat().filter(Boolean).every(point => Math.abs(point.direct - 4) > 1e-9));
  assert.deepEqual(Motor.phaseAngleCurves(Motor.createModel({ speedPU: 0 }), 0, 8), []);
  assert.throws(() => Motor.phaseAngleCurves(lossless, NaN, 8), RangeError);
});

test('三类背景渐变保持近等亮度，正负转矩使用相同宽度与透明度', () => {
  const luminance = color => {
    const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  for (const dark of [false, true]) {
    const colors = [];
    for (const [kind, levels] of [['torque-level', Motor.DEFAULT_TORQUES], ['voltage-level', Motor.DEFAULT_VOLTAGES], ['phase-level', Motor.DEFAULT_PHASE_ANGLES]]) {
      const styles = levels.map(value => Preview.curveAppearance(kind, value, { dark }));
      assert.ok(styles.every(style => style.width === 1 && style.opacity === .45));
      for (const style of styles) assert.deepEqual(style.dash, [7, 6]);
      assert.deepEqual(Preview.curveAppearance(kind.replace('-level', ''), 0, { dark }).dash, []);
      assert.equal(new Set(styles.map(style => style.color)).size, levels.length);
      colors.push(...styles.map(style => luminance(style.color)));
    }
    assert.ok(Math.max(...colors) - Math.min(...colors) < .008, JSON.stringify(colors));
    assert.equal(Preview.curveColor('phase', -180, dark), Preview.curveColor('phase', 180, dark));
  }
});

test('曲线命中只选择当前实线，拖动在转子坐标反算真实电压电流转矩', () => {
  const bounds = { x: [-2, 2], y: [-1, 1] }, size = { width: 800, height: 400 };
  const line = { kind: 'torque', value: 1, branches: [[{ direct: -1, quadrature: 0 }, { direct: 1, quadrature: 0 }]] };
  assert.equal(Preview.pickCurve([line], bounds, size, { x: 400, y: 205 }).kind, 'torque');
  assert.equal(Preview.pickCurve([line], bounds, size, { x: 400, y: 220 }), null);
  assert.equal(Preview.pickCurve([{ ...line, kind: 'torque-level' }], bounds, size, { x: 400, y: 200 }), null);
  const model = Motor.createModel(), point = { direct: -.6, quadrature: -.7 }, state = Motor.evaluate(model, point.direct, point.quadrature);
  for (const kind of ['torque', 'voltage', 'current']) near(Preview.curveDragValue({ model }, { kind }, point), state[kind]);
  near(Preview.curveDragValue({ model }, { kind: 'phase' }, point), state.phaseAngle);
  assert.equal(Preview.curveDragValue({ model }, { kind: 'phase' }, { direct: 0, quadrature: 0 }), null);
  assert.equal(Preview.pickCurve([{ ...line, kind: 'phase' }], bounds, size, { x: 400, y: 205 }).kind, 'phase');
});

test('隐藏背景组保留当前实线，优化曲线分别受开关控制', () => {
  const model = Motor.createModel(), bounds = { x: [-6, 6], y: [-6, 6] };
  const scene = { model, levels: Motor.DEFAULT_TORQUES, torqueTarget: 1, phaseTarget: 30,
    visible: { torque: true, voltage: true, phase: true, torqueGroup: false, voltageGroup: false, phaseGroup: false, mtpa: false, mtpv: true } };
  assert.deepEqual(Preview.geometryFor(scene, bounds).lines.map(line => line.kind).sort(), ['torque', 'phase', 'voltage', 'mtpv'].sort());
  scene.visible.mtpa = true; scene.visible.mtpv = false;
  assert.ok(Preview.geometryFor(scene, bounds).lines.some(line => line.kind === 'mtpa'));
  assert.ok(!Preview.geometryFor(scene, bounds).lines.some(line => line.kind === 'mtpv'));
  for (const kind of ['torque', 'voltage', 'phase']) for (const selected of [false, true]) for (const group of [false, true]) {
    const visible = { [kind]: selected, [kind + 'Group']: group };
    const lines = Preview.geometryFor({ ...scene, visible }, bounds).lines;
    assert.equal(lines.some(line => line.kind === kind), selected);
    assert.equal(lines.some(line => line.kind === kind + '-level'), group);
    for (const line of lines) assert.deepEqual(line.dash, line.kind.endsWith('-level') ? [7, 6] : []);
    if (kind === 'voltage' && group && !selected) assert.ok(lines.some(line => line.value === model.input.voltageLimit));
  }
});

test('参考电压默认0至2间隔0.2，允许非负自定义值并拒绝无效幅值', () => {
  assert.deepEqual(Motor.DEFAULT_VOLTAGES, [0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2]);
  assert.deepEqual(Motor.parseVoltageLevels('2,0,.4,.2,.4'), [0, .2, .4, 2]);
  assert.deepEqual(Motor.parseVoltageLevels('10'), [10]);
  for (const text of ['', '-.2', '±.2', 'NaN', '1e309', Array.from({ length: 33 }, (_, index) => index).join(',')]) assert.throws(() => Motor.parseVoltageLevels(text), /voltage-values/);
});

test('不同参考电压的转子轨迹逐点满足电压幅值，覆盖正反转及退化', () => {
  for (const input of [{ speedPU: -2 }, { speedPU: .5 }, { speedPU: 0 }, { resistance: 0, lq: 0 }, { resistance: 0, ld: 0 }]) {
    const model = Motor.createModel(input);
    for (const voltage of Motor.DEFAULT_VOLTAGES) for (const point of Motor.voltageCurves(model, voltage, 12, 120).flat().filter(Boolean)) {
      near(Motor.evaluate(model, point.direct, point.quadrature).voltage, voltage);
    }
  }
});

test('拖动预览同步参考电压族，当前边界不重复且可独立超出参考范围', () => {
  const model = Motor.createModel({ voltageLimit: 2.3 });
  const scene = { model, visible: { voltage: true }, levels: [], voltageLevels: [0, .4, 2] };
  const geometry = Preview.geometryFor(scene, { x: [-12, 12], y: [-12, 12] });
  assert.equal(geometry.lines.length, 4);
  for (const [index, line] of geometry.lines.entries()) for (const point of line.branches.flat().filter(Boolean)) near(Motor.evaluate(model, point.direct, point.quadrature).voltage, [0, .4, 2, 2.3][index]);
  assert.equal(geometry.lines[0].dots, true);
  assert.equal(geometry.lines.at(-1).kind, 'voltage');
  scene.model = Motor.createModel({ voltageLimit: .4 });
  assert.equal(Preview.geometryFor(scene, geometry.bounds).lines.length, 3);
});

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
  assert.ok(geometry.lines.every(line => line.kind === 'torque-level' && line.width === 1 && line.opacity === .45));
});

test('恒转矩默认负3至3、间隔0.2，保留自定义单值、多值、正负成对和去重', () => {
  const expected = [-3, -2.8, -2.6, -2.4, -2.2, -2, -1.8, -1.6, -1.4, -1.2, -1, -.8, -.6, -.4, -.2, 0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3];
  assert.deepEqual(Motor.DEFAULT_TORQUES, expected);
  assert.deepEqual(Motor.parseTorqueLevels(Motor.DEFAULT_TORQUES.join(',')), expected);
  for (let index = 1; index < expected.length; index++) near(Motor.DEFAULT_TORQUES[index] - Motor.DEFAULT_TORQUES[index - 1], .2);
  assert.deepEqual(Motor.parseTorqueLevels('-1,-0.5,0.5,1'), [-1, -.5, .5, 1]);
  assert.deepEqual(Motor.parseTorqueLevels('±0.5，±1'), [-1, -.5, .5, 1]);
  assert.deepEqual(Motor.parseTorqueLevels('-0.75'), [-.75]);
  assert.deepEqual(Motor.parseTorqueLevels('+.25; -2e0 0 0.25 -0'), [-2, 0, .25]);
  assert.deepEqual(Motor.parseTorqueLevels('1000'), [1000]);
  const geometry = Preview.geometryFor({ model: Motor.createModel(), levels: expected, visible: { torque: true, voltage: true } }, { x: [-6, 4], y: [-4, 4] });
  const torqueLines = geometry.lines.filter(line => line.kind === 'torque-level');
  assert.equal(torqueLines.length, 31);
  assert.ok(torqueLines.every(line => line.width === 1 && line.opacity === .45));
  assert.ok(geometry.lines.filter(line => line.kind === 'voltage-level').every(line => line.width === 1 && line.opacity === .45));
});

test('PF零值等值线满足零有功，含电阻MTPV不被错误冻结', () => {
  for (const resistance of [0, .02]) for (const speedPU of [-1, 1]) {
    const model = Motor.createModel({ resistance, speedPU });
    const points = Motor.powerFactorCurves(model, 0, 8).flat().filter(Boolean);
    assert.ok(points.length >= 2);
    for (const point of points) near(Motor.evaluate(model, point.direct, point.quadrature).pf, 0, 1e-7);
  }
  const slow = Motor.createModel({ resistance: .2, ld: .2, lq: .2, speedPU: .5 });
  const fast = Motor.createModel({ ...slow.input, speedPU: 2 });
  near(Motor.mtpa(slow, 1).direct, Motor.mtpa(fast, 1).direct);
  assert.ok(Math.abs(Motor.mtpv(slow, 2).direct - Motor.mtpv(fast, 2).direct) > 1e-3);
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

test('优化轨迹以Iq跟随鼠标且与独立幅值极值算法一致', () => {
  for (const parameters of [...Object.values(Motor.PRESETS).map(preset => preset.parameters), { resistance: .2, ld: 1.4, lq: .4, flux: .8 }]) {
    for (const speedPU of [-1, 0, 1, 2]) for (const quadrature of [-2, -.9, -.15, .15, .9, 2]) for (const kind of ['mtpa', 'mtpv']) {
      const model = Motor.createModel({ ...parameters, speedPU });
      const state = Motor.optimumAtQuadrature(model, kind, quadrature);
      assert.ok(state); near(state.quadrature, quadrature);
      const expected = Motor[kind](model, state.amplitude, state.direction);
      near(state.torque, expected.torque, 1e-7); near(state.direct, expected.direct, 1e-6); near(state.quadrature, expected.quadrature, 1e-6);
      const movedHorizontally = Preview.optimumDragState({ model }, { kind, direction: -state.direction }, { direct: 100, quadrature });
      near(movedHorizontally.direct, state.direct); near(movedHorizontally.quadrature, state.quadrature);
    }
  }
  assert.equal(Motor.optimumAtQuadrature(Motor.createModel({ resistance: 0, ld: 0 }), 'mtpv', 1), null);
  assert.equal(Motor.optimumAtQuadrature(Motor.createModel(), 'mtpv', NaN), null);
});

test('MTPA与MTPV联动点保持电流或电压约束及切点条件', () => {
  const model = Motor.createModel(), scene = { model };
  for (const direction of [1, -1]) {
    const mtpa = Preview.optimumDragState(scene, { kind: 'mtpa', direction }, { direct: -.4, quadrature: direction * .9 });
    near(mtpa.quadrature, direction * .9);
    const gradientD = (model.pu.ld - model.pu.lq) * mtpa.quadrature, gradientQ = model.pu.flux + (model.pu.ld - model.pu.lq) * mtpa.direct;
    near(gradientD * mtpa.quadrature - gradientQ * mtpa.direct, 0);
    assert.equal(Math.sign(mtpa.torque), direction);
    const cursor = Motor.mtpv(model, 1.2, direction);
    const mtpv = Preview.optimumDragState(scene, { kind: 'mtpv', direction }, cursor);
    near(mtpv.quadrature, cursor.quadrature);
    near(mtpv.voltage, 1.2, 1e-7);
    const torqueD = (model.pu.ld - model.pu.lq) * mtpv.quadrature, torqueQ = model.pu.flux + (model.pu.ld - model.pu.lq) * mtpv.direct;
    const voltageD = model.pu.resistance * mtpv.vd + model.input.speedPU * model.pu.ld * mtpv.vq;
    const voltageQ = -model.input.speedPU * model.pu.lq * mtpv.vd + model.pu.resistance * mtpv.vq;
    near(torqueD * voltageQ - torqueQ * voltageD, 0, 1e-6);
  }
  const cursor = Motor.mtpv(model, .02, 1);
  const maximum = Preview.optimumDragState(scene, { kind: 'mtpv', direction: 1 }, cursor);
  const minimum = Preview.optimumDragState(scene, { kind: 'mtpv', direction: -1 }, Motor.mtpv(model, .02, -1));
  assert.ok(maximum.torque < 0 && maximum.torque > minimum.torque);
  assert.equal(Preview.optimumDragState({ model, frame: 'voltage' }, { kind: 'mtpa' }, cursor), null);
  assert.deepEqual(Preview.curveAppearance('phase-level', 30).dash, [7, 6]);
  assert.deepEqual(Preview.curveAppearance('phase', 30).dash, []);
});

test('矢量只在端点命中并优先于相交曲线，显隐不改变计算点', () => {
  const model = Motor.createModel(), point = Motor.evaluate(model, .4, .6);
  const scene = { model, point, vectorVisibility: { current: true, voltage: false }, colors: { boundary: '#222222', voltage: '#2266aa', surface: '#ffffff' } };
  const vectors = Preview.vectorGeometry(scene), traces = Preview.vectorTraces(scene);
  assert.deepEqual(vectors.map(line => line.kind), ['current-vector']);
  assert.deepEqual(traces[0].x, [0, point.direct]); assert.deepEqual(traces[0].y, [0, point.quadrature]);
  assert.equal(traces[0].visible, true); assert.equal(traces[1].visible, false);
  const line = { kind: 'phase', branches: [[{ direct: -1, quadrature: .6 }, { direct: 1, quadrature: .6 }]] };
  assert.equal(Preview.pickCurve([line, ...vectors], { x: [-1, 1], y: [-1, 1] }, { width: 400, height: 400 }, { x: 280, y: 80 }).kind, 'current-vector');
  assert.equal(Preview.pickCurve(vectors, { x: [-1, 1], y: [-1, 1] }, { width: 400, height: 400 }, { x: 240, y: 140 }), null);
});