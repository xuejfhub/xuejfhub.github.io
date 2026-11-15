(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SynchronousMotor = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({ resistance: .02, ld: .2, lq: .4, flux: .8,
    speedPU: 1, currentLimit: 1, voltageLimit: 1 });
  const PRESETS = Object.freeze({
    spm: Object.freeze({ label: '表贴式', parameters: Object.freeze({ resistance: .02, ld: .3, lq: .3, flux: .8 }) }),
    ipm: Object.freeze({ label: '内嵌式', parameters: Object.freeze({ resistance: .02, ld: .2, lq: .4, flux: .8 }) }),
    synrm: Object.freeze({ label: '同步磁阻', parameters: Object.freeze({ resistance: .02, ld: 1.2, lq: .4, flux: 0 }) })
  });
  const LIMITS = Object.freeze({ resistance: [0, Infinity], ld: [0, Infinity], lq: [0, Infinity], flux: [0, Infinity],
    speedPU: [-2, 2], currentLimit: [0, Infinity], voltageLimit: [0, Infinity] });
  const DEFAULT_TORQUES = Object.freeze(Array.from({ length: 31 }, (_, index) => (index - 15) / 5));
  const DEFAULT_VOLTAGES = Object.freeze(Array.from({ length: 11 }, (_, index) => index / 5));
  const DEFAULT_FACTORS = Object.freeze([-1, -.9, -.7, -.5, .5, .7, .9, .95, 1]);
  const DEFAULT_PHASE_ANGLES = Object.freeze(Array.from({ length: 12 }, (_, index) => -180 + index * 30));

  function normalizePhaseAngle(value) {
    if (!Number.isFinite(value)) throw new RangeError('phase-angle');
    return ((value % 360) + 540) % 360 - 180;
  }

  function phaseAngle(voltageD, voltageQ, currentD, currentQ) {
    if (![voltageD, voltageQ, currentD, currentQ].every(Number.isFinite) || (voltageD === 0 && voltageQ === 0) || (currentD === 0 && currentQ === 0)) return null;
    return normalizePhaseAngle((Math.atan2(voltageQ, voltageD) - Math.atan2(currentQ, currentD)) * 180 / Math.PI);
  }

  function parseTorqueLevels(text) {
    if (typeof text !== 'string' || !text.trim()) throw new RangeError('torque-values');
    const levels = [];
    for (const token of text.trim().split(/[,，;；\s]+/).filter(Boolean)) {
      const paired = token.startsWith('\u00b1');
      const number = paired ? token.slice(1) : token;
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(number)) throw new RangeError('torque-values');
      const value = Number(number);
      if (!Number.isFinite(value) || (paired && value < 0)) throw new RangeError('torque-values');
      levels.push(...(paired ? [-value, value] : [value]));
    }
    const unique = [...new Set(levels)].sort((first, second) => first - second);
    if (unique.length === 0 || unique.length > 32) throw new RangeError('torque-values');
    return unique;
  }

  function parameters(values = {}) {
    const input = { ...DEFAULTS, ...values };
    for (const [key, [minimum, maximum]] of Object.entries(LIMITS)) {
      if (!Number.isFinite(input[key]) || input[key] < minimum || input[key] > maximum) throw new RangeError(key);
    }
    return input;
  }

  function parseVoltageLevels(text) {
    try {
      const levels = parseTorqueLevels(text);
      if (levels.some(value => value < 0)) throw new RangeError('voltage-values');
      return levels;
    } catch { throw new RangeError('voltage-values'); }
  }

  function createModel(values = {}) {
    const input = parameters(values);
    const { resistance, ld, lq, flux } = input;
    return { input, pu: { resistance, ld, lq, flux } };
  }

  function evaluate(model, direct, quadrature) {
    const { resistance, ld, lq, flux } = model.pu;
    const speed = model.input.speedPU;
    const vd = resistance * direct - speed * lq * quadrature;
    const vq = resistance * quadrature + speed * (ld * direct + flux);
    const torque = (flux + (ld - lq) * direct) * quadrature;
    const mechanical = speed * torque;
    const active = vd * direct + vq * quadrature;
    const reactive = vq * direct - vd * quadrature;
    const current = Math.hypot(direct, quadrature);
    const voltage = Math.hypot(vd, vq);
    const apparent = voltage * current;
    const copper = resistance * current * current;
    const pf = apparent > 1e-12 ? Math.max(-1, Math.min(1, active / apparent)) : null;
    return { direct, quadrature, vd, vq, torque, mechanical, active, reactive, apparent, copper,
      current, voltage, pf, phaseAngle: phaseAngle(vd, vq, direct, quadrature), feasible: current <= model.input.currentLimit + 1e-10 && voltage <= model.input.voltageLimit + 1e-10 };
  }

  function optimumAtQuadrature(model, kind, quadrature) {
    if (!['mtpa', 'mtpv'].includes(kind) || !Number.isFinite(quadrature)) return null;
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU, difference = ld - lq;
    if (flux === 0 && difference === 0) return null;
    let shift = 0, effectiveFlux = flux, scaledQ = quadrature, direction = quadrature >= 0 ? 1 : -1;
    if (kind === 'mtpv') {
      const scale = Math.max(resistance, Math.abs(speed * ld), Math.abs(speed * lq));
      if (!(scale > 0) || !Number.isFinite(scale)) return null;
      const scaledR = resistance / scale, scaledD = speed * ld / scale, scaledLq = speed * lq / scale, emf = speed * flux / scale;
      const directMetric = scaledR * scaledR + scaledD * scaledD, quadratureMetric = scaledR * scaledR + scaledLq * scaledLq;
      const determinant = scaledR * scaledR + scaledD * scaledLq;
      if (!(directMetric > 0 && determinant > 0)) return null;
      shift = scaledD * emf / directMetric;
      effectiveFlux = flux * determinant / directMetric;
      scaledQ *= Math.sqrt(quadratureMetric / directMetric);
      const centerQ = -scaledR * emf / determinant;
      if (![shift, effectiveFlux, scaledQ, centerQ].every(Number.isFinite)) return null;
      direction = quadrature >= centerQ ? 1 : -1;
    }
    const product = 2 * difference * scaledQ, denominator = effectiveFlux + Math.hypot(effectiveFlux, product);
    const direct = -shift + (denominator === 0 ? 0 : product / denominator * scaledQ);
    const state = evaluate(model, direct, quadrature);
    if (!Object.values(state).every(value => typeof value !== 'number' || Number.isFinite(value))) return null;
    return { ...state, direction, amplitude: kind === 'mtpa' ? state.current : state.voltage };
  }

  function mtpa(model, current, direction = 1) {
    const { ld, lq, flux } = model.pu;
    const difference = ld - lq;
    if (flux === 0 && difference === 0) return null;
    const denominator = flux + Math.hypot(flux, Math.sqrt(8) * difference * current);
    const direct = denominator === 0 ? 0 : 2 * difference * current * current / denominator;
    return evaluate(model, direct, direction * Math.sqrt(Math.max(0, current * current - direct * direct)));
  }

  function currentAtVoltage(model, voltage, angle) {
    const { resistance, ld, lq, flux } = model.pu;
    const speed = model.input.speedPU;
    const determinant = resistance * resistance + speed * speed * ld * lq;
    if (determinant === 0) return null;
    const vd = voltage * Math.cos(angle), shiftedVq = voltage * Math.sin(angle) - speed * flux;
    return { direct: (resistance * vd + speed * lq * shiftedVq) / determinant,
      quadrature: (-speed * ld * vd + resistance * shiftedVq) / determinant };
  }

  function mtpv(model, voltage, direction = 1) {
    if ((model.pu.flux === 0 && model.pu.ld === model.pu.lq) || !currentAtVoltage(model, voltage, 0)) return null;
    const count = 96, step = 2 * Math.PI / count;
    const objective = angle => {
      const point = currentAtVoltage(model, voltage, angle);
      return direction * (model.pu.flux + (model.pu.ld - model.pu.lq) * point.direct) * point.quadrature;
    };
    if (voltage === 0) {
      const point = currentAtVoltage(model, 0, 0);
      return { ...evaluate(model, point.direct, point.quadrature), angle: 0 };
    }
    const samples = Array.from({ length: count }, (_, index) => objective(index * step));
    let bestAngle = 0, bestValue = -Infinity;
    const ratio = (Math.sqrt(5) - 1) / 2;
    for (let index = 0; index < count; index++) {
      if (samples[index] < samples[(index + count - 1) % count] || samples[index] < samples[(index + 1) % count]) continue;
      let left = (index - 1) * step, right = (index + 1) * step;
      let lower = right - ratio * (right - left), upper = left + ratio * (right - left);
      let lowerValue = objective(lower), upperValue = objective(upper);
      for (let iteration = 0; iteration < 42; iteration++) {
        if (lowerValue < upperValue) {
          left = lower; lower = upper; lowerValue = upperValue;
          upper = left + ratio * (right - left); upperValue = objective(upper);
        } else {
          right = upper; upper = lower; upperValue = lowerValue;
          lower = right - ratio * (right - left); lowerValue = objective(lower);
        }
      }
      const angle = (left + right) / 2, value = objective(angle);
      const tolerance = 1e-12 * Math.max(1, Math.abs(value), Math.abs(bestValue));
      const preferred = direction * currentAtVoltage(model, voltage, angle).quadrature;
      const previous = direction * currentAtVoltage(model, voltage, bestAngle).quadrature;
      if (!Number.isFinite(bestValue) || value > bestValue + tolerance || (Math.abs(value - bestValue) <= tolerance && preferred > previous)) {
        bestValue = value; bestAngle = angle;
      }
    }
    const point = currentAtVoltage(model, voltage, bestAngle);
    return { ...evaluate(model, point.direct, point.quadrature), angle: bestAngle };
  }

  function locus(model, type, extent, count = 160) {
    const maximum = type === 'mtpa' ? Math.SQRT2 * extent : Math.max(...[-extent, extent].flatMap(direct =>
      [-extent, extent].map(quadrature => evaluate(model, direct, quadrature).voltage)));
    return [1, -1].map(direction => Array.from({ length: count + 1 }, (_, index) =>
      (type === 'mtpa' ? mtpa : mtpv)(model, maximum * index / count, direction)));
  }

  function torqueCurves(model, torque, extent, count = 600, bounds = null) {
    const { flux, ld, lq } = model.pu;
    const difference = ld - lq;
    const [minimumD, maximumD] = bounds?.x || [-extent, extent];
    const [minimumQ, maximumQ] = bounds?.y || [-extent, extent];
    if (flux === 0 && difference === 0) return [];
    if (torque === 0) {
      const lines = [[{ direct: minimumD, quadrature: 0 }, { direct: maximumD, quadrature: 0 }]];
      if (difference !== 0 && -flux / difference >= minimumD && -flux / difference <= maximumD) lines.push([
        { direct: -flux / difference, quadrature: minimumQ }, { direct: -flux / difference, quadrature: maximumQ }]);
      return lines;
    }
    return [Array.from({ length: count + 1 }, (_, index) => {
      const direct = minimumD + (maximumD - minimumD) * index / count;
      const denominator = flux + difference * direct;
      if (denominator === 0) return null;
      const quadrature = torque / denominator;
      return quadrature >= minimumQ && quadrature <= maximumQ ? { direct, quadrature } : null;
    })];
  }

  function quadraticRoots(square, linear, constant) {
    const scale = Math.max(Math.abs(square), Math.abs(linear), Math.abs(constant), 1e-30);
    if (Math.abs(square) < 1e-12 * scale) return Math.abs(linear) < 1e-12 * scale ? [] : [-constant / linear];
    const discriminant = linear * linear - 4 * square * constant;
    if (discriminant < 0) return [];
    if (discriminant === 0) return [-linear / (2 * square)];
    const numerator = -.5 * (linear + (linear < 0 ? -1 : 1) * Math.sqrt(discriminant));
    return [numerator / square, constant / numerator].sort((first, second) => first - second);
  }

  function powerFactorCurves(model, factor, extent, count = 800, bounds = null) {
    if (!Number.isFinite(factor) || Math.abs(factor) > 1) throw new RangeError('factor');
    const { resistance, ld, lq, flux } = model.pu;
    const speed = model.input.speedPU;
    if (speed === 0 || (flux === 0 && ld === lq)) return [];
    const [minimumD, maximumD] = bounds?.x || [-extent, extent];
    const [minimumQ, maximumQ] = bounds?.y || [-extent, extent];
    const slopes = Math.abs(factor) === 1 ? [0] : [1, -1].map(sign => sign * Math.sqrt(1 - factor * factor) / Math.abs(factor));
    const valid = (direct, quadrature) => {
      if (!Number.isFinite(quadrature) || quadrature < minimumQ || quadrature > maximumQ) return null;
      const point = evaluate(model, direct, quadrature);
      return point.pf !== null && Math.abs(point.pf - factor) < 1e-7 ? { direct, quadrature } : null;
    };
    if (factor === 0) {
      if (resistance === 0) return torqueCurves(model, 0, extent, count, bounds).map(branch => branch.map(point => point ? valid(point.direct, point.quadrature) : null));
      const branches = [[], []];
      for (let index = 0; index <= count; index++) {
        const direct = minimumD + (maximumD - minimumD) * index / count;
        const roots = quadraticRoots(resistance, speed * (flux + (ld - lq) * direct), resistance * direct * direct);
        branches[0].push(valid(direct, roots[0])); branches[1].push(valid(direct, roots[1]));
      }
      return branches;
    }
    return slopes.flatMap(slope => {
      const square = speed * lq - slope * resistance;
      const branches = [[], []];
      for (let index = 0; index <= count; index++) {
        const direct = minimumD + (maximumD - minimumD) * index / count;
        const linear = -slope * speed * (flux + (ld - lq) * direct);
        const constant = (speed * ld - slope * resistance) * direct * direct + speed * flux * direct;
        const roots = quadraticRoots(square, linear, constant);
        branches[0].push(valid(direct, roots[0]));
        branches[1].push(valid(direct, roots[1]));
      }
      if (Math.abs(square) < 1e-12 * Math.max(Math.abs(speed * lq), Math.abs(slope * resistance), 1e-30)) {
        for (const direct of quadraticRoots(speed * ld - slope * resistance, speed * flux, 0)) {
          const linear = -slope * speed * (flux + (ld - lq) * direct);
          if (direct >= minimumD && direct <= maximumD && Math.abs(linear) < 1e-12) branches.push(
            Array.from({ length: count + 1 }, (_, index) => valid(direct, minimumQ + (maximumQ - minimumQ) * index / count)));
        }
      }
      return branches;
    });
  }

  function voltageCurves(model, voltage, extent, count = 720) {
    const { resistance, ld, lq, flux } = model.pu;
    const speed = Math.abs(model.input.speedPU);
    if (resistance * resistance + speed * speed * ld * lq > 0) return [Array.from({ length: count + 1 }, (_, index) =>
      currentAtVoltage(model, voltage, index * 2 * Math.PI / count))];
    if (speed === 0 || (ld === 0 && lq === 0)) return [];
    if (lq === 0) return [-1, 1].map(sign => {
      const direct = (sign * voltage / speed - flux) / ld;
      return [{ direct, quadrature: -extent }, { direct, quadrature: extent }];
    });
    const square = ((voltage / speed) ** 2 - flux * flux) / (lq * lq);
    if (square < 0) return [];
    return (square === 0 ? [0] : [-Math.sqrt(square), Math.sqrt(square)]).map(quadrature =>
      [{ direct: -extent, quadrature }, { direct: extent, quadrature }]);
  }

  function phaseAngleCurves(model, angleDeg, extent, count = 800, bounds = null) {
    const target = normalizePhaseAngle(angleDeg), angle = target * Math.PI / 180;
    const cosine = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
    const sine = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
    if (speed === 0 || (flux === 0 && ld === lq)) return [];
    const [minimumD, maximumD] = bounds?.x || [-extent, extent];
    const [minimumQ, maximumQ] = bounds?.y || [-extent, extent];
    const square = speed * lq * cosine - resistance * sine;
    const directSquare = speed * ld * cosine - resistance * sine, directLinear = speed * flux * cosine;
    const valid = (direct, quadrature) => {
      if (!Number.isFinite(quadrature) || quadrature < minimumQ || quadrature > maximumQ) return null;
      const point = evaluate(model, direct, quadrature);
      return point.phaseAngle !== null && Math.abs(normalizePhaseAngle(point.phaseAngle - target)) < 1e-6 ? { direct, quadrature } : null;
    };
    const branches = [[], []];
    for (let index = 0; index <= count; index++) {
      const direct = minimumD + (maximumD - minimumD) * index / count;
      const linear = -speed * (flux + (ld - lq) * direct) * sine;
      const roots = quadraticRoots(square, linear, directSquare * direct * direct + directLinear * direct);
      branches[0].push(valid(direct, roots[0])); branches[1].push(valid(direct, roots[1]));
    }
    if (Math.abs(square) < 1e-12 * Math.max(Math.abs(speed * lq * cosine), Math.abs(resistance * sine), 1e-30)) {
      const candidates = directSquare === 0 && directLinear === 0 ? quadraticRoots(0, -speed * (ld - lq) * sine, -speed * flux * sine) : quadraticRoots(directSquare, directLinear, 0);
      for (const direct of new Set(candidates)) {
        const linear = -speed * (flux + (ld - lq) * direct) * sine;
        const scale = Math.max(Math.abs(speed * flux * sine), Math.abs(speed * (ld - lq) * direct * sine), 1e-30);
        if (direct >= minimumD && direct <= maximumD && Math.abs(linear) < 1e-12 * scale) branches.push(
          Array.from({ length: count + 1 }, (_, index) => valid(direct, minimumQ + (maximumQ - minimumQ) * index / count)));
      }
    }
    return branches;
  }

  function grid(model, extent, resolution = 101, bounds = null) {
    const makeAxis = range => Array.from({ length: resolution }, (_, index) => range[0] + (range[1] - range[0]) * index / (resolution - 1));
    const directAxis = makeAxis(bounds?.x || [-extent, extent]);
    const quadratureAxis = makeAxis(bounds?.y || [-extent, extent]);
    const keys = ['torque', 'mechanical', 'active', 'reactive', 'apparent'];
    const fields = Object.fromEntries(keys.map(key => [key, []]));
    const feasible = [];
    const { resistance, ld, lq, flux } = model.pu;
    const { speedPU, currentLimit, voltageLimit } = model.input;
    for (const quadrature of quadratureAxis) {
      const rows = Object.fromEntries(keys.map(key => [key, new Array(resolution)]));
      const allowed = new Array(resolution);
      for (let index = 0; index < resolution; index++) {
        const direct = directAxis[index];
        const vd = resistance * direct - speedPU * lq * quadrature;
        const vq = resistance * quadrature + speedPU * (ld * direct + flux);
        const torque = (flux + (ld - lq) * direct) * quadrature;
        const current = Math.hypot(direct, quadrature), voltage = Math.hypot(vd, vq);
        rows.torque[index] = torque;
        rows.mechanical[index] = speedPU * torque;
        rows.active[index] = vd * direct + vq * quadrature;
        rows.reactive[index] = vq * direct - vd * quadrature;
        rows.apparent[index] = voltage * current;
        allowed[index] = current <= currentLimit + 1e-10 && voltage <= voltageLimit + 1e-10;
      }
      for (const key of keys) fields[key].push(rows[key]);
      feasible.push(allowed);
    }
    return { x: directAxis, y: quadratureAxis, fields, feasible };
  }

  return { DEFAULTS, PRESETS, LIMITS, DEFAULT_TORQUES, DEFAULT_VOLTAGES, DEFAULT_FACTORS, DEFAULT_PHASE_ANGLES, normalizePhaseAngle, phaseAngle, parseTorqueLevels, parseVoltageLevels, parameters, createModel, evaluate,
    mtpa, currentAtVoltage, mtpv, optimumAtQuadrature, locus, torqueCurves, powerFactorCurves, phaseAngleCurves, voltageCurves, grid };
});