(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motor-model.js'));
  else root.VoltageMotor = factory(root.SynchronousMotor);
})(typeof globalThis === 'object' ? globalThis : this, function (Rotor) {
  'use strict';
  const DEFAULTS = Object.freeze({ ...Rotor.DEFAULTS, vfRatio: .8, voltageBoost: 0, voltageMode: 'vf', angleDeg: 110 });
  const OPERATING_DEFAULTS = Object.freeze({ ...DEFAULTS, voltageMode: 'manual', voltageLimit: .8, vfRatio: 0, voltageBoost: 0 });

  function createOperatingModel(values = {}) {
    return createModel({ ...OPERATING_DEFAULTS, ...values, voltageMode: 'manual', vfRatio: 0, voltageBoost: 0 });
  }

  function createModel(values = {}) {
    const input = { ...DEFAULTS, ...values };
    if (!['vf', 'manual'].includes(input.voltageMode)) throw new RangeError('voltageMode');
    for (const key of ['vfRatio', 'voltageBoost']) if (!Number.isFinite(input[key]) || input[key] < 0) throw new RangeError(key);
    if (!Number.isFinite(input.angleDeg)) throw new RangeError('angleDeg');
    input.angleDeg = ((input.angleDeg % 360 + 540) % 360) - 180;
    const model = Rotor.createModel(input);
    model.outputVoltage = input.voltageMode === 'manual' ? input.voltageLimit : Math.min(input.voltageLimit, input.voltageBoost + input.vfRatio * Math.abs(input.speedPU));
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

  function atVoltage(model, voltage, angleDeg = model.input.angleDeg) {
    if (!Number.isFinite(angleDeg)) throw new RangeError('angleDeg');
    if (!Number.isFinite(voltage) || voltage < 0) throw new RangeError('voltage');
    if (voltage === 0) return null;
    const angle = (angleDeg % 360) * Math.PI / 180;
    const point = Rotor.currentAtVoltage(model, voltage, angle);
    return point ? rotatePoint(model, point.direct, point.quadrature, angle) : null;
  }

  function atAngle(model, angleDeg = model.input.angleDeg) {
    return atVoltage(model, model.outputVoltage, angleDeg);
  }

  function voltageTrajectory(model, voltage, count = 720) {
    if (!Number.isFinite(voltage) || voltage < 0) throw new RangeError('voltage');
    if (voltage === 0 || !Rotor.currentAtVoltage(model, voltage, 0)) return [];
    return Array.from({ length: count + 1 }, (_, index) => atVoltage(model, voltage, -180 + index * 360 / count));
  }

  function trajectory(model, count = 720) {
    return voltageTrajectory(model, model.outputVoltage, count);
  }

  function projectCurrent(model, position, reference) {
    if (model.reason || ![position.direct, position.quadrature].every(Number.isFinite)) return null;
    const origin = reference?.angleDeg ?? model.input.angleDeg;
    const distance = state => (state.direct - position.direct) ** 2 + (state.quadrature - position.quadrature) ** 2;
    let angle = origin, state = atVoltage(model, model.outputVoltage, angle), error = state && distance(state);
    if (!state || !Number.isFinite(error)) return null;
    for (let iteration = 0; iteration < 32; iteration++) {
      const epsilon = .001, lower = atVoltage(model, model.outputVoltage, angle - epsilon), upper = atVoltage(model, model.outputVoltage, angle + epsilon);
      const directSlope = (upper.direct - lower.direct) / (2 * epsilon), quadratureSlope = (upper.quadrature - lower.quadrature) / (2 * epsilon);
      const norm = directSlope ** 2 + quadratureSlope ** 2;
      if (!(norm > 1e-20)) break;
      let step = -((state.direct - position.direct) * directSlope + (state.quadrature - position.quadrature) * quadratureSlope) / norm;
      step = Math.max(-8, Math.min(8, step));
      if (Math.abs(step) < 1e-9) break;
      let accepted = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidateAngle = Math.max(origin - 45, Math.min(origin + 45, angle + step));
        const candidate = atVoltage(model, model.outputVoltage, candidateAngle), candidateError = distance(candidate);
        if (candidateError < error) { state = candidate; angle = candidateAngle; error = candidateError; accepted = true; break; }
        step *= .5;
      }
      if (!accepted) break;
    }
    return state;
  }

  function capturePointLock(point, kind) {
    if (!['voltage', 'current', 'torque', 'pf'].includes(kind) || !point || !(point.current > 1e-10 && point.voltage > 1e-10) || !Number.isFinite(point[kind])) return null;
    return { kind, value: point[kind], phaseAngle: point.phaseAngle };
  }

  function matchesLock(point, lock) {
    if (!lock) return true;
    if (!point || !Number.isFinite(point[lock.kind]) || !Number.isFinite(lock.value)) return false;
    if (Math.abs(point[lock.kind] - lock.value) > 1e-8 * Math.max(1, Math.abs(lock.value))) return false;
    return lock.kind !== 'pf' || (Number.isFinite(point.phaseAngle) && Number.isFinite(lock.phaseAngle) && Math.abs(Rotor.normalizePhaseAngle(point.phaseAngle - lock.phaseAngle)) <= 1e-6);
  }

  function projectLockedCurrent(model, position, reference, lock) {
    if (![position.direct, position.quadrature].every(Number.isFinite)) return null;
    if (!lock) return currentState(model, position.direct, position.quadrature, reference);
    if (lock.kind === 'voltage') return projectCurrent(createOperatingModel({ ...model.input, voltageLimit: lock.value }), position, reference);
    if (lock.kind === 'current') {
      const amplitude = Math.hypot(position.direct, position.quadrature);
      if (!(amplitude > 1e-10 && lock.value > 1e-10)) return null;
      const candidate = currentState(model, position.direct * lock.value / amplitude, position.quadrature * lock.value / amplitude, reference);
      return matchesLock(candidate, lock) ? candidate : null;
    }
    if (lock.kind === 'pf') {
      const angle = -lock.phaseAngle * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
      const amplitude = position.direct * cosine + position.quadrature * sine;
      if (!(amplitude > 1e-10)) return null;
      const candidate = currentState(model, amplitude * cosine, amplitude * sine, reference);
      return matchesLock(candidate, lock) ? candidate : null;
    }
    if (lock.kind !== 'torque') return null;
    let candidate = currentState(model, position.direct, position.quadrature, reference);
    for (let iteration = 0; iteration < 32 && candidate; iteration++) {
      if (matchesLock(candidate, lock)) return candidate;
      const step = 1e-5 * Math.max(1, candidate.current), gradient = [];
      for (const axis of ['direct', 'quadrature']) {
        const lower = { direct: candidate.direct, quadrature: candidate.quadrature }, upper = { ...lower };
        lower[axis] -= step; upper[axis] += step;
        const first = currentState(model, lower.direct, lower.quadrature, candidate), last = currentState(model, upper.direct, upper.quadrature, candidate);
        if (!first || !last) return null;
        gradient.push((last.torque - first.torque) / (2 * step));
      }
      const norm = gradient[0] ** 2 + gradient[1] ** 2;
      if (!(norm > 1e-20)) return null;
      const factor = (candidate.torque - lock.value) / norm;
      const scale = Math.min(1, .5 * Math.max(1, candidate.current) / Math.max(1e-30, Math.abs(factor) * Math.sqrt(norm)));
      candidate = currentState(model, candidate.direct - scale * factor * gradient[0], candidate.quadrature - scale * factor * gradient[1], candidate);
    }
    return null;
  }

  function rotorAxes(model, bounds) {
    if (model.reason) return [];
    const angle = model.input.angleDeg * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    const length = .16 * Math.min(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]);
    if (!(length > 0) || !Number.isFinite(length)) return [];
    return [['d', cosine, -sine], ['q', sine, cosine]].map(([axis, direct, quadrature]) => {
      const endpoint = { direct: length * direct, quadrature: length * quadrature }, wing = length * .08;
      return { kind: 'rotor-axis-' + axis, name: '转子 ' + axis + ' 轴', axisLabel: axis + 'ᵣ', labelPoint: endpoint, draggable: true, value: model.input.angleDeg,
        branches: [[{ direct: 0, quadrature: 0 }, endpoint], [
          { direct: endpoint.direct - wing * direct - wing * quadrature, quadrature: endpoint.quadrature - wing * quadrature + wing * direct }, endpoint,
          { direct: endpoint.direct - wing * direct + wing * quadrature, quadrature: endpoint.quadrature - wing * quadrature - wing * direct }]] };
    });
  }

  function field(model, direct, quadrature) {
    const active = model.outputVoltage * direct, reactive = -model.outputVoltage * quadrature;
    const current = Math.hypot(direct, quadrature), apparent = model.outputVoltage * current;
    const copper = model.pu.resistance * current * current, mechanical = active - copper;
    return { active, reactive, apparent, copper, mechanical,
      torque: model.input.speedPU === 0 ? null : mechanical / model.input.speedPU,
      pf: apparent > 1e-12 ? active / apparent : null, phaseAngle: Rotor.phaseAngle(model.outputVoltage, 0, direct, quadrature) };
  }

  function phaseAngleCurves(model, angleDeg, bounds) {
    const angle = Rotor.normalizePhaseAngle(angleDeg) * Math.PI / 180;
    if (model.outputVoltage === 0) return [];
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const cosine = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
    const sine = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
    return [[{ direct: cosine * 1e-8, quadrature: -sine * 1e-8 }, { direct: cosine * extent * 3, quadrature: -sine * extent * 3 }]];
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

  function boundedRoots(coefficients) {
    const scale = Math.max(...coefficients.map(Math.abs));
    if (!(scale > 0) || !Number.isFinite(scale)) return [];
    const normalized = coefficients.map(value => value / scale);
    while (normalized.length > 1 && Math.abs(normalized.at(-1)) < 1e-14) normalized.pop();
    if (normalized.length === 1) return [];
    if (normalized.length === 2) {
      const root = -normalized[0] / normalized[1];
      return root >= -1 - 1e-12 && root <= 1 + 1e-12 ? [Math.max(-1, Math.min(1, root))] : [];
    }
    const evaluate = value => normalized.reduceRight((result, coefficient) => result * value + coefficient, 0);
    const stationary = boundedRoots(normalized.slice(1).map((coefficient, index) => coefficient * (index + 1)));
    const knots = [-1, ...stationary.filter(value => value > -1 && value < 1), 1].sort((first, second) => first - second);
    const roots = [];
    const add = value => { if (!roots.some(previous => Math.abs(previous - value) < 1e-10)) roots.push(value); };
    for (const knot of knots) if (Math.abs(evaluate(knot)) <= 1e-12) add(knot);
    for (let index = 1; index < knots.length; index++) {
      let lower = knots[index - 1], upper = knots[index], lowerValue = evaluate(lower);
      if (lowerValue * evaluate(upper) >= 0) continue;
      for (let iteration = 0; iteration < 44; iteration++) {
        const middle = (lower + upper) / 2, value = evaluate(middle);
        if (lowerValue * value <= 0) upper = middle;
        else { lower = middle; lowerValue = value; }
      }
      add((lower + upper) / 2);
    }
    return roots.sort((first, second) => first - second);
  }

  function requiredVoltage(model, direct, quadrature, visit) {
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
    if (![direct, quadrature].every(Number.isFinite)) return NaN;
    const current = Math.hypot(direct, quadrature);
    const scale = Math.max(resistance * current, Math.abs(speed) * Math.max(ld, lq) * current, Math.abs(speed * flux), 1e-300);
    if (!Number.isFinite(scale)) return NaN;
    const positive = value => Number.isFinite(value) && value > scale * 1e-12;
    if (speed === 0 || (flux === 0 && ld === lq)) {
      const voltage = resistance * direct - speed * ld * quadrature;
      const cross = resistance * quadrature + speed * ld * direct;
      return positive(voltage) && Math.abs(cross) <= 1e-9 * voltage ? voltage : Infinity;
    }
    if (ld === lq) {
      const offset = resistance * direct - speed * ld * quadrature;
      const cross = resistance * quadrature + speed * ld * direct;
      const emf = Math.abs(speed * flux), ratio = cross / emf;
      if (Math.abs(ratio) > 1 + 1e-12) return Infinity;
      const span = emf * Math.sqrt(Math.max(0, 1 - ratio * ratio));
      const candidates = [offset - span, offset + span].filter(positive);
      if (visit) {
        const cosine = Math.max(-1, Math.min(1, -cross / (speed * flux))), sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
        for (const sign of [-1, 1]) {
          const voltage = offset + speed * flux * sign * sine;
          if (positive(voltage)) visit(voltage, cosine, sign * sine);
        }
      }
      return candidates.length ? Math.min(...candidates) : Infinity;
    }
    const average = ld / 2 + lq / 2, difference = ld / 2 - lq / 2;
    const constant = resistance * quadrature + speed * average * direct;
    const fundamental = speed * flux, cosineSecond = speed * difference * direct, sineSecond = -speed * difference * quadrature;
    const coefficientScale = Math.max(Math.abs(constant), Math.abs(fundamental), Math.abs(cosineSecond), Math.abs(sineSecond));
    if (!Number.isFinite(coefficientScale)) return NaN;
    if (coefficientScale === 0) return Infinity;
    let minimum = Infinity;
    const consider = (cosine, sine) => {
      const rotorD = direct * cosine - quadrature * sine, rotorQ = direct * sine + quadrature * cosine;
      const voltageD = resistance * rotorD - speed * lq * rotorQ;
      const voltageQ = resistance * rotorQ + speed * (ld * rotorD + flux);
      const voltage = voltageD * cosine + voltageQ * sine, cross = -voltageD * sine + voltageQ * cosine;
      if (positive(voltage) && Math.abs(cross) <= 1e-8 * voltage) { minimum = Math.min(minimum, voltage); visit?.(voltage, cosine, sine); }
    };
    const normalizedConstant = constant / coefficientScale, normalizedFundamental = fundamental / coefficientScale;
    const normalizedCosine = cosineSecond / coefficientScale, normalizedSine = sineSecond / coefficientScale;
    if (flux === 0) {
      const radius = Math.hypot(normalizedCosine, normalizedSine), ratio = -normalizedConstant / radius;
      if (!(radius > 0) || Math.abs(ratio) > 1 + 1e-12) return Infinity;
      const center = Math.atan2(normalizedSine, normalizedCosine), offset = Math.acos(Math.max(-1, Math.min(1, ratio)));
      for (const angle of [(center + offset) / 2, (center - offset) / 2]) {
        consider(Math.cos(angle), Math.sin(angle));
        if (visit) consider(-Math.cos(angle), -Math.sin(angle));
      }
    } else {
      for (const hemisphere of [1, -1]) {
        const first = normalizedFundamental * hemisphere;
        const coefficients = [normalizedConstant + first + normalizedCosine, 4 * normalizedSine,
          2 * normalizedConstant - 6 * normalizedCosine, -4 * normalizedSine, normalizedConstant - first + normalizedCosine];
        for (const tangent of boundedRoots(coefficients)) {
          const denominator = 1 + tangent * tangent;
          consider(hemisphere * (1 - tangent * tangent) / denominator, hemisphere * 2 * tangent / denominator);
        }
      }
    }
    return minimum;
  }

  function inverseSlope(model, direct, quadrature, angleDeg) {
    const speed = model.input.speedPU, difference = model.pu.ld - model.pu.lq, angle = angleDeg * Math.PI / 180;
    const fundamental = speed * model.pu.flux, secondD = speed * difference * direct, secondQ = speed * difference * quadrature;
    const scale = Math.max(Math.abs(fundamental), Math.abs(secondD), Math.abs(secondQ), 1e-300);
    return -fundamental / scale * Math.sin(angle) - secondD / scale * Math.sin(2 * angle) - secondQ / scale * Math.cos(2 * angle);
  }

  function voltageSolutions(model, direct, quadrature) {
    const origin = Rotor.currentAtVoltage(model, 0, 0), solutions = [];
    if (!origin || !Object.values(origin).every(Number.isFinite)) return solutions;
    requiredVoltage(model, direct, quadrature, (voltage, cosine, sine) => {
      try {
        const angle = Math.atan2(sine, cosine);
        const state = rotatePoint(model, direct * cosine - quadrature * sine, direct * sine + quadrature * cosine, angle);
        if (!(state.vd > 0) || Math.abs(state.vq) > 1e-8 * state.voltage) return;
        const slope = inverseSlope(model, direct, quadrature, state.angleDeg);
        if (!Number.isFinite(slope) || solutions.some(previous => Math.abs(Rotor.normalizePhaseAngle(previous.angleDeg - state.angleDeg)) < 1e-7)) return;
        solutions.push({ ...state, inverseSlope: slope });
      } catch { }
    });
    return solutions;
  }

  const FIELD_QUANTITIES = Object.freeze({ voltage: '电压 U', torque: '转矩 T', active: '有功 P', reactive: '无功 Q' });

  function originState(model, direct, quadrature) {
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU, fundamental = speed * flux;
    if (![direct, quadrature, fundamental].every(Number.isFinite) || fundamental === 0) return null;
    const average = (ld + lq) / 2, difference = (ld - lq) / 2;
    let angle = Math.sign(fundamental) * Math.PI / 2, progress = 0, step = .125;
    let state = { ...rotatePoint(model, 0, 0, angle), inverseSlope: -1 };
    if (direct === 0 && quadrature === 0) return state;
    const solve = (fraction, previousAngle) => {
      const currentD = direct * fraction, currentQ = quadrature * fraction;
      const scale = Math.max(Math.abs(fundamental), Math.abs(resistance * currentQ), Math.abs(speed) * Math.max(ld, lq) * Math.hypot(currentD, currentQ), 1e-300);
      if (!Number.isFinite(scale)) return null;
      let candidateAngle = previousAngle;
      for (let iteration = 0; iteration < 16; iteration++) {
        const cosine = Math.cos(candidateAngle), sine = Math.sin(candidateAngle);
        const residual = (resistance * currentQ + speed * (average * currentD + difference * currentD * Math.cos(2 * candidateAngle) - difference * currentQ * Math.sin(2 * candidateAngle) + flux * cosine)) / scale;
        const derivative = (-fundamental * sine - 2 * speed * difference * (currentD * Math.sin(2 * candidateAngle) + currentQ * Math.cos(2 * candidateAngle))) / scale;
        if (!(derivative < -1e-8)) return null;
        if (Math.abs(residual) <= 1e-12) {
          const result = rotatePoint(model, currentD * cosine - currentQ * sine, currentD * sine + currentQ * cosine, candidateAngle);
          if (!(result.vd > scale * 1e-10) || Math.abs(result.vq) > scale * 1e-9 || !Object.values(result).every(value => typeof value !== 'number' || Number.isFinite(value))) return null;
          return { state: { ...result, inverseSlope: inverseSlope(model, currentD, currentQ, result.angleDeg) }, angle: candidateAngle };
        }
        candidateAngle -= Math.max(-.15, Math.min(.15, residual / derivative));
        if (Math.abs(candidateAngle - previousAngle) > Math.PI / 6) return null;
      }
      return null;
    };
    for (let attempt = 0; attempt < 512 && progress < 1; attempt++) {
      const destination = Math.min(1, progress + step), next = solve(destination, angle);
      if (!next) { step *= .5; if (step < 1e-5) return null; continue; }
      progress = destination; angle = next.angle; state = next.state; step = Math.min(.125, step * 1.5);
    }
    return progress === 1 ? state : null;
  }

  function createFieldSampler() {
    const caches = new Map(), statistics = { builds: 0, hits: 0 };
    function sample(model, bounds, resolution = 81, branch = 'origin') {
      if (!['origin', 'unique', '0', '1', '2', '3'].includes(branch)) throw new RangeError('field-branch');
      const status = model.input.speedPU === 0 ? 'zero-speed' : branch === 'origin' ? model.pu.flux > 0 ? 'ok' : 'zero-flux' : Rotor.currentAtVoltage(model, 1, 0) ? 'ok' : 'singular';
      const key = JSON.stringify([model.pu, model.input.speedPU, bounds, resolution, branch === 'origin']);
      let cached = caches.get(resolution);
      if (!cached || cached.key !== key) {
        const axis = range => Array.from({ length: resolution }, (_, index) => range[0] + (range[1] - range[0]) * index / (resolution - 1));
        const x = axis(bounds.x), y = axis(bounds.y);
        const solutions = y.map(quadrature => x.map(direct => {
          if (status !== 'ok') return [];
          if (branch === 'origin') { const state = originState(model, direct, quadrature); return state ? [state] : []; }
          return voltageSolutions(model, direct, quadrature).filter(state => Object.keys(FIELD_QUANTITIES).every(quantity => Number.isFinite(state[quantity])))
            .sort((first, second) => first.voltage - second.voltage);
        }));
        cached = { key, x, y, solutions }; caches.set(resolution, cached); statistics.builds++;
      } else statistics.hits++;
      const fields = Object.fromEntries(Object.keys(FIELD_QUANTITIES).map(quantity => [quantity, []]));
      const counts = [], ambiguous = [];
      const summary = { unique: 0, multiple: 0, empty: 0, shown: 0, maxSolutions: 0 };
      for (const row of cached.solutions) {
        const selected = row.map(solutions => {
          summary[solutions.length === 0 ? 'empty' : solutions.length === 1 ? 'unique' : 'multiple']++;
          summary.maxSolutions = Math.max(summary.maxSolutions, solutions.length);
          const state = branch === 'origin' ? solutions[0] || null : branch === 'unique' ? solutions.length === 1 ? solutions[0] : null : solutions[Number(branch)] || null;
          if (state) summary.shown++;
          return state;
        });
        counts.push(row.map(solutions => solutions.length));
        ambiguous.push(row.map(solutions => branch === 'unique' && solutions.length > 1 ? 1 : null));
        for (const quantity of Object.keys(fields)) fields[quantity].push(selected.map(state => state?.[quantity] ?? null));
      }
      return { x: cached.x, y: cached.y, fields, counts, ambiguous, summary, status, branch };
    }
    return { sample, statistics };
  }

  function currentState(model, direct, quadrature, reference) {
    const candidates = voltageSolutions(model, direct, quadrature).filter(state => Math.abs(state.inverseSlope) > 1e-8);
    if (!reference) return candidates.length === 1 ? candidates[0] : null;
    const slope = inverseSlope(model, reference.direct, reference.quadrature, reference.angleDeg);
    if (!Number.isFinite(slope) || Math.abs(slope) <= 1e-8) return null;
    const distance = state => Math.abs(Rotor.normalizePhaseAngle(state.angleDeg - reference.angleDeg));
    return candidates.filter(state => state.inverseSlope * slope > 0 && distance(state) < 45).sort((first, second) => distance(first) - distance(second))[0] || null;
  }

  function torqueCurves(model, level, bounds, count = 960) {
    if (!Number.isFinite(level)) throw new RangeError('torque');
    if (model.input.speedPU === 0 || model.pu.flux === 0) return [];
    const radius = Math.hypot(Math.max(...bounds.x.map(Math.abs)), Math.max(...bounds.y.map(Math.abs)));
    const source = Rotor.torqueCurves(model, level, radius, count, { x: [-radius, radius], y: [-radius, radius] });
    return source.map(branch => {
      const samples = branch.length === 2 ? Array.from({ length: count + 1 }, (_, index) => ({
        direct: branch[0].direct + (branch[1].direct - branch[0].direct) * index / count,
        quadrature: branch[0].quadrature + (branch[1].quadrature - branch[0].quadrature) * index / count })) : branch;
      return samples.map(point => {
        if (!point) return null;
        const state = Rotor.evaluate(model, point.direct, point.quadrature);
        if (!(state.voltage > 1e-10)) return null;
        const direct = state.active / state.voltage, quadrature = -state.reactive / state.voltage;
        const connected = originState(model, direct, quadrature);
        if (!connected || Math.abs(connected.voltage - state.voltage) > 1e-7 * Math.max(1, state.voltage) || Math.abs(connected.torque - level) > 1e-7 * Math.max(1, Math.abs(level))) return null;
        return { direct, quadrature };
      });
    });
  }

  function mtpaAtCurrent(model, current, direction = 1) {
    const optimum = Rotor.mtpa(model, current, direction);
    if (!optimum || !(optimum.voltage > 1e-10) || !(current > 1e-10)) return null;
    const state = rotatePoint(model, optimum.direct, optimum.quadrature, Math.atan2(optimum.vq, optimum.vd));
    const connected = originState(model, state.direct, state.quadrature);
    if (!connected || Math.abs(connected.voltage - state.voltage) > 1e-7 * Math.max(1, state.voltage)) return null;
    return { ...state, direction, amplitude: state.current };
  }

  function branchBoundary(model, bounds, count = 1440) {
    const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
    if (speed === 0 || flux === 0) return { fold: [], zero: [] };
    const radius = Math.hypot(Math.max(...bounds.x.map(Math.abs)), Math.max(...bounds.y.map(Math.abs)));
    const average = (ld + lq) / 2, difference = (ld - lq) / 2;
    const accept = (direct, quadrature, angle, zero = false) => {
      if (!Number.isFinite(direct) || !Number.isFinite(quadrature) || Math.hypot(direct, quadrature) > radius * 1.1) return null;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      const state = Rotor.evaluate(model, direct * cosine - quadrature * sine, direct * sine + quadrature * cosine);
      const voltage = state.vd * cosine + state.vq * sine;
      if (!zero && !(voltage > 1e-10)) return null;
      const inside = originState(model, direct * (1 - 1e-5), quadrature * (1 - 1e-5));
      if (!inside || Math.abs(Rotor.normalizePhaseAngle(inside.angleDeg - angle * 180 / Math.PI)) > 2) return null;
      return { direct, quadrature, angleDeg: angle * 180 / Math.PI, voltage };
    };
    const fold = [];
    if (difference === 0) {
      const coefficientD = speed * average, coefficientQ = resistance, norm = Math.hypot(coefficientD, coefficientQ);
      if (norm > 0) for (const angle of [0, Math.PI]) {
        const offset = -speed * flux * Math.cos(angle) / norm;
        fold.push(Array.from({ length: count + 1 }, (_, index) => {
          const along = radius * (2 * index / count - 1);
          return accept((offset * coefficientD - along * coefficientQ) / norm, (offset * coefficientQ + along * coefficientD) / norm, angle);
        }));
      }
    } else {
      fold.push(Array.from({ length: count + 1 }, (_, index) => {
        const angle = 2 * Math.PI * index / count;
        const coefficientD = speed * (average + difference * Math.cos(2 * angle));
        const coefficientQ = resistance - speed * difference * Math.sin(2 * angle);
        const constant = speed * flux * Math.cos(angle);
        const derivativeD = -2 * speed * difference * Math.sin(2 * angle);
        const derivativeQ = -2 * speed * difference * Math.cos(2 * angle);
        const derivativeConstant = -speed * flux * Math.sin(angle);
        const determinant = coefficientD * derivativeQ - coefficientQ * derivativeD;
        if (Math.abs(determinant) <= 1e-12 * Math.max(Math.hypot(coefficientD, coefficientQ) * Math.hypot(derivativeD, derivativeQ), 1e-300)) return null;
        return accept((coefficientQ * derivativeConstant - constant * derivativeQ) / determinant,
          (constant * derivativeD - coefficientD * derivativeConstant) / determinant, angle);
      }));
    }
    const zeroCurrent = Rotor.currentAtVoltage(model, 0, 0);
    const zero = zeroCurrent ? [Array.from({ length: count + 1 }, (_, index) => {
      const angle = 2 * Math.PI * index / count, cosine = Math.cos(angle), sine = Math.sin(angle);
      return accept(zeroCurrent.direct * cosine + zeroCurrent.quadrature * sine,
        -zeroCurrent.direct * sine + zeroCurrent.quadrature * cosine, angle, true);
    })] : [];
    return { fold, zero };
  }

  function createTorqueSampler() {
    const caches = new Map(), statistics = { builds: 0, hits: 0 };
    function sample(model, level, bounds, count = 960) {
      const key = JSON.stringify([model.pu, model.input.speedPU, bounds, count]);
      let curves = caches.get(key);
      if (!curves) { curves = new Map(); caches.set(key, curves); if (caches.size > 2) caches.delete(caches.keys().next().value); }
      if (curves.has(level)) { const value = curves.get(level); curves.delete(level); curves.set(level, value); statistics.hits++; return value; }
      const value = torqueCurves(model, level, bounds, count); curves.set(level, value); statistics.builds++;
      if (curves.size > 96) curves.delete(curves.keys().next().value);
      return value;
    }
    return { sample, statistics };
  }

  function geometry(scene, bounds) {
    const { model, visible, levels } = scene;
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const lines = [];
    const add = (kind, name, branches, width = 2, opacity = 1, dash = [], dots = false, value) => lines.push({ kind, name, branches, width, opacity, dash, dots, value, voltage: kind.startsWith('voltage') ? value : undefined });
    if (visible.voltageGroup ?? visible.voltage) for (const voltage of scene.voltageLevels || Rotor.DEFAULT_VOLTAGES) {
      if (visible.voltage && voltage === model.outputVoltage) continue;
      const points = voltageTrajectory(model, voltage);
      if (points.length) add('voltage-level', `参考 |U| = ${voltage} pu`, [points], 1, .45, [7, 6], model.input.speedPU === 0, voltage);
    }
    if (visible.voltage) {
      add('voltage', `当前电压 |U| = ${model.outputVoltage} pu`, [trajectory(model)], 1.8, .95, [], model.input.speedPU === 0, model.outputVoltage);
    }
    if (visible.current) add('current', '电流边界', [Array.from({ length: 361 }, (_, index) => ({ direct: model.input.currentLimit * Math.cos(index * Math.PI / 180), quadrature: model.input.currentLimit * Math.sin(index * Math.PI / 180) }))], 1.8, 1, [], model.input.currentLimit === 0, model.input.currentLimit);
    const torque = level => scene.torqueCurves ? scene.torqueCurves(level, bounds) : torqueCurves(model, level, bounds);
    if (visible.torqueGroup ?? visible.torque) for (const level of levels) add('torque-level', `T = ${level} pu`, torque(level), 1, .45, [7, 6], false, level);
    if (visible.torque && Number.isFinite(scene.torqueTarget)) add('torque', `当前 T = ${scene.torqueTarget} pu`, torque(scene.torqueTarget), 1.8, .95, [], false, scene.torqueTarget);
    if ((visible.phaseGroup ?? visible.phase) && model.outputVoltage > 0) for (const angle of Rotor.DEFAULT_PHASE_ANGLES) add('phase-level', `φ = ${angle}°`, phaseAngleCurves(model, angle, bounds), 1, .45, [7, 6], false, angle);
    if (visible.phase && model.outputVoltage > 0 && Number.isFinite(scene.phaseTarget)) add('phase', `当前 φ = ${scene.phaseTarget}°`, phaseAngleCurves(model, scene.phaseTarget, bounds), 1.8, .95, [], false, scene.phaseTarget);
    for (const kind of ['mtpa', 'mtpv']) if (visible[kind]) {
      const source = Rotor.locus(model, kind, extent, 180);
      add(kind, kind.toUpperCase(), source.map(branch => branch.map(point => {
        if (!point) return null;
        const state = Rotor.evaluate(model, point.direct, point.quadrature);
        return state.voltage > 1e-12 ? rotatePoint(model, point.direct, point.quadrature, Math.atan2(state.vq, state.vd)) : null;
      })), 2.8);
      lines.at(-1).draggable = kind === 'mtpa';
    }
    if (visible.branchBoundary) {
      const boundary = scene.branchBoundary ? scene.branchBoundary(bounds) : branchBoundary(model, bounds);
      add('branch-fold', '电流边界 · 逆解折点', boundary.fold, 2.4);
      add('branch-zero', '电流边界 · 零电压极限', boundary.zero, 2.4, 1, [6, 4]);
    }
    return { bounds, extent, lines };
  }

  return { DEFAULTS, OPERATING_DEFAULTS, FIELD_QUANTITIES, originState, mtpaAtCurrent, branchBoundary, createFieldSampler, createTorqueSampler, createModel, createOperatingModel, atVoltage, atAngle, voltageTrajectory, trajectory, projectCurrent, capturePointLock, matchesLock, projectLockedCurrent, rotorAxes, field, grid, requiredVoltage, voltageSolutions, currentState, inverseSlope, torqueCurves, phaseAngleCurves, geometry };
});