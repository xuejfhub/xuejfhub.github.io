(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./电机模型.js'));
  else root.VoltageMotor = factory(root.SynchronousMotor);
})(typeof globalThis === 'object' ? globalThis : this, function (Rotor) {
  'use strict';
  const DEFAULTS = Object.freeze({ ...Rotor.DEFAULTS, vfRatio: .8, voltageBoost: 0, angleDeg: 110 });

  function createModel(values = {}) {
    const input = { ...DEFAULTS, ...values };
    for (const key of ['vfRatio', 'voltageBoost']) if (!Number.isFinite(input[key]) || input[key] < 0) throw new RangeError(key);
    if (!Number.isFinite(input.angleDeg)) throw new RangeError('angleDeg');
    input.angleDeg = ((input.angleDeg % 360 + 540) % 360) - 180;
    const model = Rotor.createModel(input);
    model.outputVoltage = Math.min(input.voltageLimit, input.voltageBoost + input.vfRatio * Math.abs(input.speedPU));
    model.reason = model.outputVoltage === 0 ? 'zero-voltage' : !Rotor.currentAtVoltage(model, model.outputVoltage, 0) ? 'singular' : null;
    return model;
  }

  function rotatePoint(model, direct, quadrature, angle) {
    const point = Rotor.evaluate(model, direct, quadrature);
    if (!Object.values(point).every(value => typeof value !== 'number' || Number.isFinite(value))) throw new RangeError('numeric-range');
    return { ...point, rotorDirect: direct, rotorQuadrature: quadrature,
      direct: direct * Math.cos(angle) + quadrature * Math.sin(angle),
      quadrature: -direct * Math.sin(angle) + quadrature * Math.cos(angle),
      vd: point.vd * Math.cos(angle) + point.vq * Math.sin(angle),
      vq: -point.vd * Math.sin(angle) + point.vq * Math.cos(angle), angleDeg: angle * 180 / Math.PI };
  }

  function atAngle(model, angleDeg = model.input.angleDeg) {
    if (!Number.isFinite(angleDeg)) throw new RangeError('angleDeg');
    if (model.reason) return null;
    const angle = (angleDeg % 360) * Math.PI / 180;
    const point = Rotor.currentAtVoltage(model, model.outputVoltage, angle);
    return point ? rotatePoint(model, point.direct, point.quadrature, angle) : null;
  }

  function trajectory(model, count = 720) {
    if (model.reason) return [];
    return Array.from({ length: count + 1 }, (_, index) => atAngle(model, -180 + index * 360 / count));
  }

  function field(model, direct, quadrature) {
    const active = model.outputVoltage * direct, reactive = -model.outputVoltage * quadrature;
    const current = Math.hypot(direct, quadrature), apparent = model.outputVoltage * current;
    const copper = model.pu.resistance * current * current, mechanical = active - copper;
    return { active, reactive, apparent, copper, mechanical,
      torque: model.input.speedPU === 0 ? null : mechanical / model.input.speedPU,
      pf: apparent > 1e-12 ? active / apparent : null };
  }

  function grid(model, bounds, resolution = 161) {
    const axis = range => Array.from({ length: resolution }, (_, index) => range[0] + (range[1] - range[0]) * index / (resolution - 1));
    const direct = axis(bounds.x), quadrature = axis(bounds.y);
    const fields = Object.fromEntries(['torque', 'mechanical', 'active', 'reactive', 'apparent'].map(key => [key, []]));
    for (const vertical of quadrature) {
      const row = direct.map(horizontal => field(model, horizontal, vertical));
      for (const key of Object.keys(fields)) fields[key].push(row.map(point => point[key]));
    }
    return { x: direct, y: quadrature, fields };
  }

  function torqueCurves(model, level, bounds, count = 480) {
    const voltage = model.outputVoltage, resistance = model.pu.resistance, speed = model.input.speedPU;
    if (voltage === 0 || speed === 0) return [];
    if (resistance === 0) return [[{ direct: speed * level / voltage, quadrature: bounds.y[0] }, { direct: speed * level / voltage, quadrature: bounds.y[1] }]];
    const branches = [[], []];
    for (let index = 0; index <= count; index++) {
      const quadrature = bounds.y[0] + (bounds.y[1] - bounds.y[0]) * index / count;
      const constant = resistance * quadrature * quadrature + speed * level;
      const discriminant = voltage * voltage - 4 * resistance * constant;
      if (discriminant < 0) { branches[0].push(null); branches[1].push(null); continue; }
      const total = voltage + Math.sqrt(discriminant);
      branches[0].push({ direct: 2 * constant / total, quadrature });
      branches[1].push({ direct: total / (2 * resistance), quadrature });
    }
    return branches;
  }

  function geometry(scene, bounds) {
    const { model, visible, levels } = scene;
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const lines = [];
    const add = (kind, name, branches, width = 2, opacity = 1, dash = [], dots = false) => lines.push({ kind, name, branches, width, opacity, dash, dots });
    if (visible.voltage) add('boundary', 'VF 电压轨迹', [trajectory(model)], 2.5, 1, [], model.input.speedPU === 0);
    if (visible.current) add('boundary', '电流边界', [Array.from({ length: 361 }, (_, index) => ({ direct: model.input.currentLimit * Math.cos(index * Math.PI / 180), quadrature: model.input.currentLimit * Math.sin(index * Math.PI / 180) }))], 1.8, 1, [7, 6], model.input.currentLimit === 0);
    if (visible.torque) for (const level of levels) add('torque', `T = ${level} pu`, torqueCurves(model, level, bounds), level === 1 ? 2.5 : 1.3, level === 1 ? 1 : .45, level === 1 ? [] : [7, 6]);
    if (visible.pf && model.outputVoltage > 0) {
      add('pf', 'Iq = 0', [[{ direct: bounds.x[0], quadrature: 0 }, { direct: bounds.x[1], quadrature: 0 }]], 2.5);
      for (const factor of [-.9, -.7, -.5, .5, .7, .9]) for (const direction of [-1, 1]) {
        add('pf', `PF = ${factor}`, [[{ direct: 0, quadrature: 0 }, { direct: Math.sign(factor) * extent * 2, quadrature: direction * extent * 2 * Math.sqrt(1 / (factor * factor) - 1) }]], 1.2, .44, [7, 6]);
      }
    }
    for (const kind of ['mtpa', 'mtpv']) if (visible[kind]) {
      const source = Rotor.locus(model, kind, extent, 180);
      add(kind, kind.toUpperCase(), source.map(branch => branch.map(point => {
        if (!point) return null;
        const state = Rotor.evaluate(model, point.direct, point.quadrature);
        return state.voltage > 1e-12 ? rotatePoint(model, point.direct, point.quadrature, Math.atan2(state.vq, state.vd)) : null;
      })), 2.8);
    }
    return { bounds, extent, lines };
  }

  return { DEFAULTS, createModel, atAngle, trajectory, field, grid, torqueCurves, geometry };
});