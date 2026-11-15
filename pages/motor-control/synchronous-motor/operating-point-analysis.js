(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motor-model.js'));
  else root.MotorAnalysis = factory(root.SynchronousMotor);
})(typeof globalThis === 'object' ? globalThis : this, function (Motor) {
  'use strict';
  const quantities = Object.freeze({
    torque: { label: '转矩 T', unit: 'pu' },
    active: { label: '有功 P', unit: 'pu' },
    reactive: { label: '无功 Q', unit: 'pu' },
    apparent: { label: '视在 S', unit: 'pu', positive: true },
    phaseAngle: { label: '电压电流夹角 φ', unit: '°', cyclic: true },
    voltageAngle: { label: '电压与转子d轴夹角 δ', unit: '°', cyclic: true }
  });
  const cyclicScale = Object.freeze(['#d74b4b', '#ba981e', '#49aa60', '#269fa8', '#526ad0', '#aa51b0', '#d74b4b'].map((color, index) => [index / 6, color]));

  function stateAt(model, direct, quadrature, coordinate = 'current') {
    if (![direct, quadrature].every(Number.isFinite)) return null;
    let current = { direct, quadrature };
    if (coordinate === 'voltage') current = Motor.currentAtVoltage(model, Math.hypot(direct, quadrature), Math.atan2(quadrature, direct));
    else if (coordinate !== 'current') throw new RangeError('coordinate');
    if (!current) return null;
    const state = Motor.evaluate(model, current.direct, current.quadrature);
    if (coordinate === 'voltage') {
      state.vd = direct; state.vq = quadrature; state.voltage = Math.hypot(direct, quadrature);
      state.active = direct * state.direct + quadrature * state.quadrature;
      state.reactive = quadrature * state.direct - direct * state.quadrature;
      state.apparent = state.voltage * state.current;
      state.pf = state.apparent > 1e-12 ? Math.max(-1, Math.min(1, state.active / state.apparent)) : null;
      state.phaseAngle = Motor.phaseAngle(direct, quadrature, state.direct, state.quadrature);
    }
    if (!Object.values(state).every(value => typeof value !== 'number' || Number.isFinite(value))) return null;
    return { ...state, voltageAngle: state.voltage > 0 ? Motor.normalizePhaseAngle(Math.atan2(state.vq, state.vd) * 180 / Math.PI) : null };
  }

  function grid(model, bounds, count = 161, coordinate = 'current') {
    const axis = range => Array.from({ length: count }, (_, index) => range[0] + (range[1] - range[0]) * index / (count - 1));
    const x = axis(bounds.x), y = axis(bounds.y);
    const fields = Object.fromEntries(Object.keys(quantities).map(key => [key, []]));
    for (const quadrature of y) {
      const rows = Object.fromEntries(Object.keys(fields).map(key => [key, []]));
      for (const direct of x) {
        const state = stateAt(model, direct, quadrature, coordinate);
        for (const key of Object.keys(fields)) rows[key].push(state?.[key] ?? null);
      }
      for (const key of Object.keys(fields)) fields[key].push(rows[key]);
    }
    return { x, y, fields };
  }

  function colorRange(kind, maximum) {
    return quantities[kind]?.cyclic ? [-180, 180] : [quantities[kind]?.positive ? 0 : -maximum, maximum];
  }

  function angleColor(value) {
    if (!Number.isFinite(value)) return null;
    const position = (Motor.normalizePhaseAngle(value) + 180) / 60;
    const lower = Math.min(5, Math.floor(position)), weight = position - lower;
    const channels = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
    const first = channels(cyclicScale[lower][1]), last = channels(cyclicScale[lower + 1][1]);
    return first.map((channel, index) => Math.round(channel + (last[index] - channel) * weight));
  }

  function trajectoryPair(model, kind, value, voltageBounds, count = 720) {
    const corners = voltageBounds.x.flatMap(direct => voltageBounds.y.map(quadrature => Motor.currentAtVoltage(model, Math.hypot(direct, quadrature), Math.atan2(quadrature, direct))));
    const invertible = corners.every(point => point && Number.isFinite(point.direct) && Number.isFinite(point.quadrature));
    const bounds = invertible ? { x: [Math.min(...corners.map(point => point.direct)), Math.max(...corners.map(point => point.direct))],
      y: [Math.min(...corners.map(point => point.quadrature)), Math.max(...corners.map(point => point.quadrature))] } : voltageBounds;
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    let current;
    if (kind === 'current') current = [Array.from({ length: count + 1 }, (_, index) => {
      const angle = 2 * Math.PI * index / count;
      return { direct: value * Math.cos(angle), quadrature: value * Math.sin(angle) };
    })];
    else if (kind === 'voltage') current = Motor.voltageCurves(model, value, extent, count);
    else if (kind === 'torque') current = Motor.torqueCurves(model, value, extent, count, bounds);
    else if (kind === 'phase') current = Motor.phaseAngleCurves(model, value, extent, count, bounds);
    else throw new RangeError('trajectory-kind');
    const voltage = current.map(branch => branch.map(point => {
      if (!point) return null;
      const state = Motor.evaluate(model, point.direct, point.quadrature);
      return [state.vd, state.vq].every(Number.isFinite) ? { direct: state.vd, quadrature: state.vq } : null;
    }));
    return { current, voltage };
  }

  function voltageGeometry(model, values, visible, bounds, count = 720) {
    return ['voltage', 'current', 'torque', 'phase'].filter(kind => visible[kind]).map(kind => {
      const branches = trajectoryPair(model, kind, values[kind], bounds, count).voltage;
      const points = branches.flat().filter(Boolean), first = points[0];
      const dots = Boolean(first && points.every(point => Math.hypot(point.direct - first.direct, point.quadrature - first.quadrature) < 1e-12));
      return { kind: 'mapped-' + kind, sourceKind: kind, value: values[kind], branches, dots, draggable: false };
    });
  }

  function captureLock(state, key) {
    if (!['current', 'voltage', 'torque', 'pf'].includes(key) || !Number.isFinite(state?.[key])) return null;
    if (key === 'pf' && !Number.isFinite(state.phaseAngle)) return null;
    return { value: state[key], phaseAngle: state.phaseAngle };
  }

  function residual(state, key, lock) {
    if (!state || !Number.isFinite(state[key])) return NaN;
    return key === 'pf' ? Motor.normalizePhaseAngle(state.phaseAngle - lock.phaseAngle) / 180 : (state[key] - lock.value) / Math.max(1, Math.abs(lock.value));
  }

  function satisfies(state, locks, tolerance = 1e-8) {
    return Object.entries(locks).every(([key, lock]) => Math.abs(residual(state, key, lock)) <= tolerance);
  }

  function gradient(model, state, key, lock) {
    const step = 1e-5 * Math.max(1, state.current);
    return ['direct', 'quadrature'].map(axis => {
      const first = { direct: state.direct, quadrature: state.quadrature }, last = { ...first };
      first[axis] -= step; last[axis] += step;
      const low = Motor.evaluate(model, first.direct, first.quadrature), high = Motor.evaluate(model, last.direct, last.quadrature);
      const difference = key === 'pf' ? Motor.normalizePhaseAngle(high.phaseAngle - low.phaseAngle) / 180 : residual(high, key, lock) - residual(low, key, lock);
      return difference / (2 * step);
    });
  }

  function constrain(model, candidate, reference, locks = {}) {
    const entries = Object.entries(locks);
    if (!entries.length) return candidate;
    if (!candidate || !reference) return null;
    const base = Motor.evaluate(model, reference.direct, reference.quadrature);
    const torqueFactor = state => model.pu.flux + (model.pu.ld - model.pu.lq) * state.direct;
    const sameBranch = state => !locks.torque || locks.torque.value === 0 || Math.sign(torqueFactor(state)) === Math.sign(torqueFactor(base));
    const gradients = entries.map(([key, lock]) => gradient(model, base, key, lock)).filter(value => Math.hypot(...value) > 1e-10);
    for (let first = 0; first < gradients.length; first++) for (let second = first + 1; second < gradients.length; second++) {
      const cross = gradients[first][0] * gradients[second][1] - gradients[first][1] * gradients[second][0];
      if (Math.abs(cross) > 1e-5 * Math.hypot(...gradients[first]) * Math.hypot(...gradients[second])) return satisfies(base, locks) ? base : null;
    }
    let state = Motor.evaluate(model, candidate.direct, candidate.quadrature);
    for (let iteration = 0; iteration < 32; iteration++) {
      if (!(state.current > 1e-10 && state.voltage > 1e-10)) return null;
      if (satisfies(state, locks, 1e-10)) return sameBranch(state) ? state : null;
      const rows = entries.map(([key, lock]) => ({ value: residual(state, key, lock), gradient: gradient(model, state, key, lock) }));
      const row = rows.sort((first, second) => Math.abs(second.value) - Math.abs(first.value))[0];
      const norm = row.gradient[0] ** 2 + row.gradient[1] ** 2;
      if (!(norm > 1e-20) || !Number.isFinite(row.value)) return null;
      const direct = state.direct - row.value * row.gradient[0] / norm;
      const quadrature = state.quadrature - row.value * row.gradient[1] / norm;
      if (![direct, quadrature].every(Number.isFinite)) return null;
      state = Motor.evaluate(model, direct, quadrature);
    }
    return null;
  }

  return { quantities, cyclicScale, stateAt, grid, colorRange, angleColor, trajectoryPair, voltageGeometry, captureLock, satisfies, constrain };
});