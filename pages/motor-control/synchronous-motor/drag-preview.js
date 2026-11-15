(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motor-model.js'));
  else root.MotorPreview = factory(root.SynchronousMotor);
})(typeof globalThis === 'object' ? globalThis : this, function (Motor) {
  'use strict';
  const HEAT_KEYS = ['torque', 'mechanical', 'active', 'reactive', 'apparent'];
  const SIGNED = [[0, [57, 121, 172]], [.25, [162, 201, 221]], [.5, [245, 247, 239]], [.75, [239, 197, 159]], [1, [203, 90, 79]]];
  const POSITIVE = [[0, [245, 248, 244]], [.35, [143, 204, 195]], [.7, [54, 169, 172]], [1, [20, 108, 148]]];

  function colorFor(value, maximum, positive = false, asinh = false) {
    if (asinh) { value = Math.asinh(value); maximum = Math.asinh(maximum); }
    const fraction = Math.max(0, Math.min(1, positive ? value / maximum : (value / maximum + 1) / 2));
    const stops = positive ? POSITIVE : SIGNED;
    let upper = 1;
    while (upper < stops.length - 1 && fraction > stops[upper][0]) upper++;
    const lower = stops[upper - 1], higher = stops[upper];
    const weight = (fraction - lower[0]) / (higher[0] - lower[0]);
    return lower[1].map((channel, index) => Math.round(channel + weight * (higher[1][index] - channel)));
  }

  function paddedBounds(view) {
    const expand = range => { const padding = (range[1] - range[0]) * .65; return [range[0] - padding, range[1] + padding]; };
    return { x: expand(view.x), y: expand(view.y) };
  }

  function plotTopMargin() {
    return globalThis.matchMedia('(pointer: coarse), (max-width: 600px)').matches ? 56 : 40;
  }

  function plotConfig(restoreView) {
    return { responsive: false, displayModeBar: true, displaylogo: false, scrollZoom: true, doubleClick: false,
      modeBarButtons: [['zoomIn2d', 'zoomOut2d', { name: '恢复初始视图', icon: globalThis.Plotly.Icons.home, click: restoreView }]] };
  }

  function decorateViewTools(plot) {
    const tools = [['Zoom in', '放大', 'zoom-in'], ['Zoom out', '缩小', 'zoom-out'], ['恢复初始视图', '恢复初始视图', 'reset-view']];
    for (const [original, label, id] of tools) {
      const button = [...plot.querySelectorAll('.modebar-btn')].find(element => [original, label].includes(element.getAttribute('data-title')));
      if (!button) continue;
      button.id = id; button.setAttribute('data-title', label); button.setAttribute('aria-label', label); button.setAttribute('role', 'button'); button.tabIndex = 0;
      button.onkeydown = event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) { event.preventDefault(); event.stopPropagation(); button.click(); }
      };
    }
  }

  function curveColor(kind, value, dark = false) {
    const family = kind.replace('-level', '');
    const fraction = Math.max(0, Math.min(1, family === 'torque' ? (value + 3) / 6 : family === 'pf' ? (value + 1) / 2 : value / 2));
    const phase = family === 'phase' ? Motor.normalizePhaseAngle(value) * Math.PI / 180 : 0;
    const hue = (family === 'phase' ? 160 + 25 * Math.sin(phase) : family === 'torque' ? 340 + fraction * 90 : family === 'pf' ? 135 + fraction * 50 : 230 + fraction * 55) * Math.PI / 180;
    const lightness = dark ? 76 : 54, chroma = (dark ? 28 : 32) + (family === 'phase' ? (dark ? 3 : 5) * Math.cos(phase) : 0);
    const middle = (lightness + 16) / 116;
    const inverse = value => value > 6 / 29 ? value ** 3 : 3 * (6 / 29) ** 2 * (value - 4 / 29);
    const tristimulusX = .95047 * inverse(middle + chroma * Math.cos(hue) / 500);
    const tristimulusY = inverse(middle);
    const tristimulusZ = 1.08883 * inverse(middle - chroma * Math.sin(hue) / 200);
    const channels = [3.2404542 * tristimulusX - 1.5371385 * tristimulusY - .4985314 * tristimulusZ,
      -.969266 * tristimulusX + 1.8760108 * tristimulusY + .041556 * tristimulusZ,
      .0556434 * tristimulusX - .2040259 * tristimulusY + 1.0572252 * tristimulusZ];
    return '#' + channels.map(channel => {
      const encoded = channel <= .0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - .055;
      return Math.round(255 * Math.max(0, Math.min(1, encoded))).toString(16).padStart(2, '0');
    }).join('');
  }

  function curveAppearance(kind, value, scene = {}) {
    if (kind.startsWith('branch-')) return { color: scene.dark ? '#ffbb66' : '#a85200', width: 2.4, opacity: 1, dash: kind === 'branch-zero' ? [6, 4] : [] };
    if (kind.startsWith('rotor-axis-')) return { color: scene.colors?.muted || '#657477', width: 1.5, opacity: .9, dash: [4, 3] };
    if (kind.startsWith('mapped-')) return { ...curveAppearance(kind.slice(7), value, scene), width: 2.2, opacity: .62, dash: [] };
    const family = kind.replace('-level', '');
    if (kind === 'current-vector' || kind === 'voltage-vector') return { color: scene.colors?.[kind === 'current-vector' ? 'boundary' : 'voltage'] || '#465464', width: 2, opacity: 1, dash: [] };
    if (['torque', 'voltage', 'pf', 'phase'].includes(family)) return { color: curveColor(family, value, scene.dark), width: kind.endsWith('-level') ? 1 : 1.8, opacity: kind.endsWith('-level') ? .45 : .95, dash: kind.endsWith('-level') ? [7, 6] : [] };
    return { color: scene.colors?.[kind] || scene.colors?.boundary || '#465464', width: kind === 'current' ? 1.8 : 2.8, opacity: 1, dash: [] };
  }

  function pickCurve(lines, bounds, size, position, tolerance = 8) {
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const screen = point => ({ x: (point.direct - bounds.x[0]) / (bounds.x[1] - bounds.x[0]) * size.width, y: (bounds.y[1] - point.quadrature) / (bounds.y[1] - bounds.y[0]) * size.height });
    let endpoint = null, endpointDistance = tolerance + 4;
    for (const line of lines) if (line.vector && line.visible !== false) {
      const point = line.branches[0]?.at(-1);
      if (!point) continue;
      const rendered = screen(point), distance = Math.hypot(rendered.x - position.x, rendered.y - position.y);
      if (distance < endpointDistance) { endpointDistance = distance; endpoint = { kind: line.kind, value: line.value, point: { ...point } }; }
    }
    if (endpoint) return endpoint;
    let nearest = null, distance = tolerance;
    for (const line of lines) {
      if (line.vector || line.visible === false) continue;
      if (!['torque', 'voltage', 'current', 'phase'].includes(line.kind) && !line.draggable) continue;
      for (const [branchIndex, branch] of line.branches.entries()) {
        let previous = null;
        for (const point of branch) {
          if (!point || !Number.isFinite(point.direct) || !Number.isFinite(point.quadrature)) { previous = null; continue; }
          if (previous && branch.length > 2 && Math.hypot(point.direct - previous.direct, point.quadrature - previous.quadrature) > extent * .35) previous = null;
          const first = screen(previous || point), last = screen(point), deltaX = last.x - first.x, deltaY = last.y - first.y;
          const lengthSquared = deltaX * deltaX + deltaY * deltaY;
          const fraction = lengthSquared > 0 && !line.dots ? Math.max(0, Math.min(1, ((position.x - first.x) * deltaX + (position.y - first.y) * deltaY) / lengthSquared)) : 1;
          const gap = Math.hypot(position.x - first.x - fraction * deltaX, position.y - first.y - fraction * deltaY);
          if (gap < distance) {
            distance = gap;
            const origin = previous || point;
            nearest = { kind: line.kind, value: line.value ?? line.voltage,
              point: { direct: origin.direct + fraction * (point.direct - origin.direct), quadrature: origin.quadrature + fraction * (point.quadrature - origin.quadrature) },
              direction: ['mtpa', 'mtpv'].includes(line.kind) ? (branchIndex === 0 ? 1 : -1) : undefined,
              angleDeg: previous && Number.isFinite(previous.angleDeg) ? previous.angleDeg + fraction * (point.angleDeg - previous.angleDeg) : point.angleDeg };
          }
          previous = point;
        }
      }
    }
    return nearest;
  }

  function curveDragValue(scene, hit, point, previousPoint) {
    if (![point.direct, point.quadrature].every(Number.isFinite)) return null;
    const model = scene.model;
    if (hit.kind.startsWith('rotor-axis-')) {
      const angleAt = position => Motor.normalizePhaseAngle((hit.kind === 'rotor-axis-q' ? 90 : 0) - Math.atan2(position.quadrature, position.direct) * 180 / Math.PI);
      if (Math.hypot(point.direct, point.quadrature) <= (scene.minimumVector || 1e-10)) return null;
      const angle = angleAt(point), state = scene.axisState?.(angle);
      if (!interactivePoint(state, scene.minimumVector)) return null;
      if (previousPoint && !connectedDirections(scene.axisState?.(angleAt(previousPoint)), state, scene.minimumVector)) return null;
      return angle;
    }
    if (hit.kind === 'phase') {
      const direction = position => scene.frame === 'voltage' ? { ...position, vd: model.outputVoltage, vq: 0, voltage: model.outputVoltage,
        current: Math.hypot(position.direct, position.quadrature), torque: 0, phaseAngle: Motor.phaseAngle(model.outputVoltage, 0, position.direct, position.quadrature) } : Motor.evaluate(model, position.direct, position.quadrature);
      const state = direction(point);
      if (!interactivePoint(state, scene.minimumVector) || (previousPoint && !connectedDirections(direction(previousPoint), state, scene.minimumVector))) return null;
      return state.phaseAngle;
    }
    if (hit.kind === 'current') return Math.hypot(point.direct, point.quadrature);
    if (scene.frame !== 'voltage') {
      const state = Motor.evaluate(model, point.direct, point.quadrature);
      const value = hit.kind === 'phase' ? state.phaseAngle : hit.kind === 'torque' ? state.torque : state.voltage;
      return Number.isFinite(value) ? value : null;
    }
    if (hit.kind === 'torque') {
      const value = scene.torqueAt?.(point);
      return Number.isFinite(value) ? value : null;
    }
    if (!Number.isFinite(hit.angleDeg)) return null;
    const angle = hit.angleDeg * Math.PI / 180;
    const zero = Motor.currentAtVoltage(model, 0, angle), unit = Motor.currentAtVoltage(model, 1, angle);
    if (!zero || !unit) return null;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const directOffset = zero.direct * cosine + zero.quadrature * sine, quadratureOffset = -zero.direct * sine + zero.quadrature * cosine;
    const directSlope = (unit.direct - zero.direct) * cosine + (unit.quadrature - zero.quadrature) * sine;
    const quadratureSlope = -(unit.direct - zero.direct) * sine + (unit.quadrature - zero.quadrature) * cosine;
    const denominator = directSlope ** 2 + quadratureSlope ** 2;
    const value = ((point.direct - directOffset) * directSlope + (point.quadrature - quadratureOffset) * quadratureSlope) / denominator;
    return denominator > 0 && Number.isFinite(value) ? Math.max(0, value) : null;
  }

  function optimumDragState(scene, hit, point) {
    if (!['mtpa', 'mtpv'].includes(hit.kind)) return null;
    if (scene.frame === 'voltage') return scene.solveOptimum?.(hit.kind, point, hit.direction) ?? null;
    return Motor.optimumAtQuadrature(scene.model, hit.kind, point.quadrature);
  }

  function interactivePoint(state, minimum = 1e-10) {
    return Boolean(state && ['direct', 'quadrature', 'vd', 'vq', 'current', 'voltage', 'torque', 'phaseAngle'].every(key => Number.isFinite(state[key])) && state.current > minimum && state.voltage > minimum);
  }

  function connectedDirections(reference, state, threshold = 1e-10) {
    if (!interactivePoint(reference) || !interactivePoint(state, threshold)) return false;
    for (const [horizontal, vertical] of [['direct', 'quadrature'], ['vd', 'vq']]) {
      const deltaD = state[horizontal] - reference[horizontal], deltaQ = state[vertical] - reference[vertical];
      const denominator = deltaD * deltaD + deltaQ * deltaQ;
      const fraction = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(reference[horizontal] * deltaD + reference[vertical] * deltaQ) / denominator));
      const minimum = Math.hypot(reference[horizontal] + fraction * deltaD, reference[vertical] + fraction * deltaQ);
      const scale = Math.max(Math.hypot(reference[horizontal], reference[vertical]), Math.hypot(state[horizontal], state[vertical]), 1e-10);
      if (fraction !== 0 && !(minimum > Math.max(threshold, scale * 1e-9))) return false;
    }
    return true;
  }

  function pointDragState(scene, kind, point, reference = scene.point) {
    if (![point.direct, point.quadrature].every(Number.isFinite)) return null;
    try {
      let state;
      if (kind === 'current-vector') state = scene.frame === 'voltage' ? scene.solveCurrent?.(point, reference) : Motor.evaluate(scene.model, point.direct, point.quadrature);
      else if (kind === 'voltage-vector') {
        if (scene.frame === 'voltage') state = point.direct > 1e-10 ? scene.solveVoltage?.(point.direct, reference) : null;
        else {
          const current = Motor.currentAtVoltage(scene.model, Math.hypot(point.direct, point.quadrature), Math.atan2(point.quadrature, point.direct));
          state = current && Motor.evaluate(scene.model, current.direct, current.quadrature);
        }
      } else state = optimumDragState(scene, { kind, direction: reference?.direction }, point);
      if (scene.constrainPoint) state = scene.constrainPoint(state, reference, kind);
      if (!interactivePoint(state, scene.minimumVector)) return null;
      if (reference) {
        if (!connectedDirections(reference, state, scene.minimumVector)) return null;
        if (['mtpa', 'mtpv'].includes(kind) && reference.direction !== undefined && state.direction !== reference.direction) return null;
      }
      return state;
    } catch { return null; }
  }

  function advanceDrag(solve, start, target, reference, steps = 16) {
    let point = { ...start }, value = reference, moved = false;
    const valid = candidate => typeof candidate === 'number' ? Number.isFinite(candidate) : candidate && typeof candidate === 'object' && Object.values(candidate).every(entry => typeof entry !== 'number' || Number.isFinite(entry));
    const attempt = position => { try { const candidate = solve(position, value, point); return valid(candidate) ? candidate : null; } catch { return null; } };
    const interpolate = (first, last, fraction) => ({ direct: first.direct + (last.direct - first.direct) * fraction, quadrature: first.quadrature + (last.quadrature - first.quadrature) * fraction });
    if (![start.direct, start.quadrature, target.direct, target.quadrature].every(Number.isFinite)) return { point, value, moved, blocked: true };
    const count = Math.max(1, Math.min(64, Math.ceil(steps)));
    for (let index = 1; index <= count; index++) {
      const next = interpolate(start, target, index / count), candidate = attempt(next);
      if (candidate === null) {
        let invalid = next;
        for (let iteration = 0; iteration < 16; iteration++) {
          const middle = interpolate(point, invalid, .5), refined = attempt(middle);
          if (refined === null) invalid = middle;
          else { point = middle; value = refined; moved = true; }
        }
        return { point, value, moved, blocked: true };
      }
      point = next; value = candidate; moved = true;
    }
    return { point, value, moved, blocked: false };
  }

  function vectorGeometry(scene, includeHidden = false) {
    const point = interactivePoint(scene.point) ? scene.point : null;
    return ['current', 'voltage'].map(kind => {
      const visible = Boolean(point && scene.vectorVisibility?.[kind]);
      const endpoint = point && (kind === 'current' ? { direct: point.direct, quadrature: point.quadrature } : { direct: point.vd, quadrature: scene.frame === 'voltage' ? 0 : point.vq });
      return { kind: kind + '-vector', vector: true, draggable: true, dots: true, visible, value: point?.[kind], branches: endpoint ? [[endpoint]] : [] };
    }).filter(line => includeHidden || line.visible);
  }

  function vectorTraces(scene) {
    return vectorGeometry(scene, true).map(line => {
      const point = line.branches[0]?.[0], appearance = curveAppearance(line.kind, line.value, scene);
      return { type: 'scatter', mode: 'lines+markers', name: line.kind === 'current-vector' ? '电流矢量' : '电压矢量',
        x: point ? [0, point.direct] : [], y: point ? [0, point.quadrature] : [], visible: line.visible,
        meta: { kind: line.kind, vector: true, draggable: true, pointOnly: true, value: line.value },
        line: { color: appearance.color, width: appearance.width, dash: 'solid' },
        marker: { size: [0, 11], color: appearance.color, symbol: line.kind === 'current-vector' ? 'circle' : 'diamond', line: { color: scene.colors?.surface || '#fff', width: 2 } }, hoverinfo: 'skip' };
    });
  }

  function covers(outer, inner) {
    return ['x', 'y'].every(axis => outer[axis][0] <= inner[axis][0] && outer[axis][1] >= inner[axis][1]);
  }

  function createConstraintSampler(options = {}) {
    const voltageFrame = options.frame === 'voltage', caches = new Map();
    const statistics = { builds: 0, hits: 0 };
    const requiredVoltage = options.requiredVoltage || ((model, direct, quadrature) => {
      const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
      return Math.hypot(resistance * direct - speed * lq * quadrature, resistance * quadrature + speed * (ld * direct + flux));
    });
    function sample(model, view, resolution = 161) {
      const currentLimit = model.input.currentLimit, voltageLimit = voltageFrame ? model.outputVoltage : model.input.voltageLimit;
      const { resistance, ld, lq, flux } = model.pu, speed = model.input.speedPU;
      const result = { x: [], y: [], z: [], required: [], bounds: view, segments: [], dimension: -1, status: 'empty', currentLimit, voltageLimit };
      const inside = point => point.direct >= view.x[0] && point.direct <= view.x[1] && point.quadrature >= view.y[0] && point.quadrature <= view.y[1];
      const pointResult = point => {
        if (point && inside(point) && Math.hypot(point.direct, point.quadrature) <= currentLimit + 1e-10) Object.assign(result, { dimension: 0, status: 'point', segments: [[point]] });
        return result;
      };
      if (voltageFrame && voltageLimit <= 0) return result;
      if (currentLimit === 0) return requiredVoltage(model, 0, 0) <= voltageLimit + 1e-10 ? pointResult({ direct: 0, quadrature: 0 }) : result;
      if (voltageFrame && (speed === 0 || (flux === 0 && ld === lq))) {
        const impedance = Math.hypot(resistance, speed * ld);
        if (!(impedance > 0) || !Number.isFinite(impedance)) return result;
        const direction = { direct: resistance / impedance, quadrature: -speed * ld / impedance };
        let lower = 0, upper = Math.min(currentLimit, voltageLimit / impedance);
        for (const [component, range] of [[direction.direct, view.x], [direction.quadrature, view.y]]) {
          if (component === 0) { if (range[0] > 0 || range[1] < 0) return result; }
          else { lower = Math.max(lower, Math.min(range[0] / component, range[1] / component)); upper = Math.min(upper, Math.max(range[0] / component, range[1] / component)); }
        }
        if (upper > lower) Object.assign(result, { dimension: 1, status: 'line', segments: [[
          { direct: direction.direct * lower, quadrature: direction.quadrature * lower },
          { direct: direction.direct * upper, quadrature: direction.quadrature * upper }]] });
        return result;
      }
      if (!voltageFrame && voltageLimit === 0 && (resistance !== 0 || (speed !== 0 && (ld !== 0 || lq !== 0)))) {
        const point = Motor.currentAtVoltage(model, 0, 0);
        if (point) return pointResult(point);
        if (lq === 0 && ld > 0) {
          const direct = -flux / ld;
          if (Math.abs(direct) > currentLimit || direct < view.x[0] || direct > view.x[1]) return result;
          const half = currentLimit * Math.sqrt(Math.max(0, 1 - (direct / currentLimit) ** 2));
          const lower = Math.max(view.y[0], -half), upper = Math.min(view.y[1], half);
          if (upper > lower) Object.assign(result, { dimension: 1, status: 'line', segments: [[{ direct, quadrature: lower }, { direct, quadrature: upper }]] });
          else if (upper === lower) return pointResult({ direct, quadrature: lower });
        } else if (ld === 0 && flux === 0 && view.y[0] <= 0 && view.y[1] >= 0) {
          const lower = Math.max(view.x[0], -currentLimit), upper = Math.min(view.x[1], currentLimit);
          if (upper > lower) Object.assign(result, { dimension: 1, status: 'line', segments: [[{ direct: lower, quadrature: 0 }, { direct: upper, quadrature: 0 }]] });
        }
        return result;
      }
      const limits = { x: [-currentLimit, currentLimit], y: [-currentLimit, currentLimit] };
      const determinant = resistance * resistance + speed * speed * ld * lq;
      if (!Number.isFinite(determinant)) return { ...result, status: 'numeric' };
      if (determinant > 0) {
        const center = Motor.currentAtVoltage(model, 0, 0);
        if (![center.direct, center.quadrature].every(Number.isFinite)) return { ...result, status: 'numeric' };
        const radiusD = Math.hypot(resistance, speed * lq) / determinant * voltageLimit;
        const radiusQ = Math.hypot(resistance, speed * ld) / determinant * voltageLimit;
        if (voltageFrame) {
          const maximumCurrent = Math.min(currentLimit, Math.hypot(center.direct, center.quadrature) + Math.hypot(radiusD, radiusQ));
          limits.x = [-maximumCurrent, maximumCurrent]; limits.y = [-maximumCurrent, maximumCurrent];
        } else {
          limits.x = [Math.max(-currentLimit, center.direct - radiusD), Math.min(currentLimit, center.direct + radiusD)];
          limits.y = [Math.max(-currentLimit, center.quadrature - radiusQ), Math.min(currentLimit, center.quadrature + radiusQ)];
        }
      } else if (!voltageFrame && speed !== 0) {
        if (lq === 0 && ld > 0) {
          const center = -flux / ld, radius = voltageLimit / Math.abs(speed) / ld;
          limits.x = [Math.max(-currentLimit, center - radius), Math.min(currentLimit, center + radius)];
        } else if (ld === 0 && lq > 0) {
          if (voltageLimit < Math.abs(speed * flux)) return result;
          const radius = Math.sqrt(Math.max(0, (voltageLimit / Math.abs(speed)) ** 2 - flux * flux)) / lq;
          limits.y = [-Math.min(currentLimit, radius), Math.min(currentLimit, radius)];
        }
      }
      const focus = { x: [Math.max(view.x[0], limits.x[0]), Math.min(view.x[1], limits.x[1])], y: [Math.max(view.y[0], limits.y[0]), Math.min(view.y[1], limits.y[1])] };
      if (focus.x[0] > focus.x[1] || focus.y[0] > focus.y[1]) return result;
      if (focus.x[0] === focus.x[1] || focus.y[0] === focus.y[1]) {
        const first = { direct: focus.x[0], quadrature: focus.y[0] }, last = { direct: focus.x[1], quadrature: focus.y[1] };
        if ([first, last].every(point => Math.hypot(point.direct, point.quadrature) <= currentLimit + 1e-10 && requiredVoltage(model, point.direct, point.quadrature) <= voltageLimit + 1e-10)) Object.assign(result, { dimension: 1, status: 'line', segments: [[first, last]] });
        return result;
      }
      const closest = range => Math.max(range[0], Math.min(range[1], 0));
      if (Math.hypot(closest(focus.x), closest(focus.y)) > currentLimit) return result;
      const farthest = bounds => Math.hypot(Math.max(...bounds.x.map(Math.abs)), Math.max(...bounds.y.map(Math.abs)));
      const key = JSON.stringify([model.pu, speed]), requestedRadius = Math.min(currentLimit, farthest(focus));
      let cached = caches.get(resolution);
      if (!cached || cached.key !== key || !covers(cached.bounds, focus) || requestedRadius > cached.radius + 1e-10 || ['x', 'y'].some(axis => focus[axis][1] - focus[axis][0] < (cached.bounds[axis][1] - cached.bounds[axis][0]) / 4)) {
        const expanded = paddedBounds(focus), radius = Math.min(currentLimit * 1.5, farthest(expanded));
        const bounds = { x: [Math.max(expanded.x[0], -radius), Math.min(expanded.x[1], radius)], y: [Math.max(expanded.y[0], -radius), Math.min(expanded.y[1], radius)] };
        const axis = range => Array.from({ length: resolution }, (_, index) => range[0] + (range[1] - range[0]) * index / (resolution - 1));
        const direct = axis(bounds.x), quadrature = axis(bounds.y);
        const required = quadrature.map(vertical => direct.map(horizontal => Math.hypot(horizontal, vertical) <= radius ? requiredVoltage(model, horizontal, vertical) : Infinity));
        cached = { key, bounds, radius, x: direct, y: quadrature, required, invalid: required.some(row => row.some(Number.isNaN)) };
        caches.set(resolution, cached); statistics.builds++;
      } else statistics.hits++;
      if (cached.invalid) return { ...result, status: 'numeric' };
      const mask = cached.y.map((quadrature, row) => cached.x.map((direct, column) => Math.hypot(direct, quadrature) <= currentLimit + 1e-10 && cached.required[row][column] <= voltageLimit + 1e-10 ? 1 : null));
      return { ...result, x: cached.x, y: cached.y, z: mask, required: cached.required, bounds: cached.bounds, dimension: 2, status: 'area' };
    }
    return { sample, statistics };
  }

  function constraintTrace(region, color = '#159b86') {
    const meta = { kind: 'feasible', dimension: region.dimension, status: region.status, voltageLimit: region.voltageLimit, currentLimit: region.currentLimit };
    if (region.dimension === 2) return { type: 'heatmap', x: region.x, y: region.y, z: region.z, zmin: 0, zmax: 1, zsmooth: false,
      colorscale: [[0, color], [1, color]], opacity: .22, showscale: false, hoverongaps: false, hoverinfo: 'skip', meta, name: '约束域' };
    const direct = [], quadrature = [];
    for (const branch of region.segments) { for (const point of branch) { direct.push(point.direct); quadrature.push(point.quadrature); } direct.push(null); quadrature.push(null); }
    return { type: 'scatter', x: direct, y: quadrature, mode: region.dimension === 0 ? 'markers' : 'lines', line: { color, width: 4 }, marker: { color, size: 9 }, opacity: .3, hoverinfo: 'skip', meta, name: '退化约束域' };
  }

  function geometryFor(scene, bounds) {
    if (scene.geometry) return scene.geometry(bounds);
    const { model, visible, levels } = scene;
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const lines = [];
    const add = (kind, branches, width, opacity = 1, dash = [], dots = false, value) => lines.push({ kind, branches, width, opacity, dash, dots, value });
    if (visible.torqueGroup ?? visible.torque) for (const level of levels) add('torque-level', Motor.torqueCurves(model, level, extent, 480, bounds), 1, .45, [7, 6], false, level);
    if (visible.torque && Number.isFinite(scene.torqueTarget)) add('torque', Motor.torqueCurves(model, scene.torqueTarget, extent, 480, bounds), 1.8, .95, [], false, scene.torqueTarget);
    if (visible.phaseGroup ?? visible.phase) for (const angle of Motor.DEFAULT_PHASE_ANGLES) add('phase-level', Motor.phaseAngleCurves(model, angle, extent, 480, bounds), 1, .45, [7, 6], false, angle);
    if (visible.phase && Number.isFinite(scene.phaseTarget)) add('phase', Motor.phaseAngleCurves(model, scene.phaseTarget, extent, 480, bounds), 1.8, .95, [], false, scene.phaseTarget);
    if (visible.mtpa) { add('mtpa', Motor.locus(model, 'mtpa', extent, 160), 2.8); lines.at(-1).draggable = true; }
    if (visible.mtpv) { add('mtpv', Motor.locus(model, 'mtpv', extent, 160), 2.8); lines.at(-1).draggable = true; }
    if (visible.current) add('current', [Array.from({ length: 361 }, (_, index) => {
      const angle = index * Math.PI / 180;
      return { direct: model.input.currentLimit * Math.cos(angle), quadrature: model.input.currentLimit * Math.sin(angle) };
    })], 1.8, 1, [], model.input.currentLimit === 0, model.input.currentLimit);
    if (visible.voltageGroup ?? visible.voltage) for (const voltage of scene.voltageLevels || Motor.DEFAULT_VOLTAGES) {
      if (visible.voltage && voltage === model.input.voltageLimit) continue;
      add('voltage-level', Motor.voltageCurves(model, voltage, extent, 480), 1, .45, [7, 6], voltage === 0 && Boolean(Motor.currentAtVoltage(model, 0, 0)), voltage);
    }
    if (visible.voltage) {
      add('voltage', Motor.voltageCurves(model, model.input.voltageLimit, extent, 480), 1.8, .95, [], model.input.voltageLimit === 0 && Boolean(Motor.currentAtVoltage(model, 0, 0)), model.input.voltageLimit);
    }
    if (scene.extraGeometry) lines.push(...scene.extraGeometry(bounds));
    return { bounds, extent, lines };
  }

  const VERTEX_SHADER = `attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }`;
  const FRAGMENT_SHADER = `precision highp float;
varying vec2 uv;
uniform vec2 minimumView;
uniform vec2 maximumView;
uniform vec4 motor;
uniform float speed;
uniform float colorMaximum;
uniform int quantity;
uniform int referenceFrame;
uniform float outputVoltage;
vec3 palette(float fraction, bool positive) {
  if (positive) {
    if (fraction < .35) return mix(vec3(245.,248.,244.),vec3(143.,204.,195.),fraction/.35)/255.;
    if (fraction < .7) return mix(vec3(143.,204.,195.),vec3(54.,169.,172.),(fraction-.35)/.35)/255.;
    return mix(vec3(54.,169.,172.),vec3(20.,108.,148.),(fraction-.7)/.3)/255.;
  }
  if (fraction < .25) return mix(vec3(57.,121.,172.),vec3(162.,201.,221.),fraction*4.)/255.;
  if (fraction < .5) return mix(vec3(162.,201.,221.),vec3(245.,247.,239.),(fraction-.25)*4.)/255.;
  if (fraction < .75) return mix(vec3(245.,247.,239.),vec3(239.,197.,159.),(fraction-.5)*4.)/255.;
  return mix(vec3(239.,197.,159.),vec3(203.,90.,79.),(fraction-.75)*4.)/255.;
}
void main() {
  vec2 current = mix(minimumView, maximumView, uv);
  vec2 voltage = vec2(motor.x*current.x-speed*motor.z*current.y, motor.x*current.y+speed*(motor.y*current.x+motor.w));
  float torque = (motor.w+(motor.y-motor.z)*current.x)*current.y;
  float value = torque;
  if (quantity == 1) value = speed*torque;
  if (quantity == 2) value = dot(voltage,current);
  if (quantity == 3) value = voltage.y*current.x-voltage.x*current.y;
  if (quantity == 4) value = length(voltage)*length(current);
  if (referenceFrame == 1) {
    float active = outputVoltage*current.x;
    float mechanical = active-motor.x*dot(current,current);
    value = speed == 0. ? 0. : mechanical/speed;
    if (quantity == 1) value = mechanical;
    if (quantity == 2) value = active;
    if (quantity == 3) value = -outputVoltage*current.y;
    if (quantity == 4) value = outputVoltage*length(current);
  }
  bool positive = quantity == 4;
  float fraction = clamp(positive ? value/colorMaximum : (value/colorMaximum+1.)*.5,0.,1.);
  gl_FragColor = vec4(palette(fraction,positive),.72);
}`;

  function create(plot, callbacks = {}) {
    const heatCanvas = document.createElement('canvas'), lineCanvas = document.createElement('canvas'), raster = document.createElement('canvas'), constraintCanvas = document.createElement('canvas');
    heatCanvas.id = 'drag-heat'; lineCanvas.id = 'drag-curves';
    raster.id = 'drag-heat-cpu';
    constraintCanvas.id = 'drag-feasible';
    for (const canvas of [heatCanvas, raster, constraintCanvas, lineCanvas]) { canvas.className = 'pan-preview'; canvas.setAttribute('aria-hidden', 'true'); plot.append(canvas); }
    const dragCursor = document.createElement('span'), dragReadout = document.createElement('output');
    dragCursor.id = 'curve-cursor'; dragCursor.className = 'curve-cursor'; dragCursor.hidden = true; dragCursor.setAttribute('aria-hidden', 'true');
    dragReadout.id = 'curve-drag-readout'; dragReadout.className = 'curve-drag-readout'; dragReadout.hidden = true; dragReadout.setAttribute('aria-live', 'off');
    const pointerCursor = document.createElement('span');
    pointerCursor.id = 'pointer-cursor'; pointerCursor.className = 'pointer-cursor'; pointerCursor.hidden = true; pointerCursor.setAttribute('aria-hidden', 'true');
    plot.append(dragCursor, dragReadout, pointerCursor);
    const context = lineCanvas.getContext('2d');
    const constraintContext = constraintCanvas.getContext('2d'), constraintRaster = document.createElement('canvas');
    constraintRaster.width = 61; constraintRaster.height = 61;
    const constraintRasterContext = constraintRaster.getContext('2d'), constraintPixels = constraintRasterContext.createImageData(61, 61);
    raster.width = 81; raster.height = 81;
    const rasterContext = raster.getContext('2d');
    let pixels = rasterContext.createImageData(81, 81);
    let scene = null, cache = null, active = false, frame = null, frameKind = '', pendingView = null, lastView = null;
    let gpu = null, program = null, uniforms = {}, gpuAttempted = false, gpuLost = false, gpuPrecision = 0;
    const stats = { frames: 0, geometryBuilds: 0, drawMs: [], backend: 'canvas2d', renderer: null, fallback: null };
    let curveGesture = null, hitCache = null;

    function pointerCoordinates(event, clamp = false) {
      const layout = plot._fullLayout;
      if (!layout || event.target.closest?.('.modebar')) return null;
      const rectangle = plot.getBoundingClientRect();
      const width = layout.xaxis._length, height = layout.yaxis._length;
      let horizontal = event.clientX - rectangle.left - plot.clientLeft - layout.xaxis._offset;
      let vertical = event.clientY - rectangle.top - plot.clientTop - layout.yaxis._offset;
      if (!clamp && (horizontal < 0 || vertical < 0 || horizontal > width || vertical > height)) return null;
      horizontal = Math.max(0, Math.min(width, horizontal)); vertical = Math.max(0, Math.min(height, vertical));
      const bounds = curveGesture?.bounds || { x: [...layout.xaxis.range], y: [...layout.yaxis.range] };
      return { bounds, size: { width, height }, position: { x: horizontal, y: vertical },
        point: { direct: bounds.x[0] + horizontal / width * (bounds.x[1] - bounds.x[0]), quadrature: bounds.y[1] - vertical / height * (bounds.y[1] - bounds.y[0]) } };
    }

    function hoverHit(event) {
      if (!scene || !callbacks.change || active || plot.dataset.stale === 'true') return null;
      const pointer = pointerCoordinates(event);
      if (!pointer) return null;
      const key = JSON.stringify([scene.model.input, scene.visible, scene.torqueTarget, scene.phaseTarget, pointer.bounds]);
      if (!hitCache || hitCache.key !== key) hitCache = { key, lines: geometryFor(scene, pointer.bounds).lines };
      const axes = scene.axesGeometry ? scene.axesGeometry(pointer.bounds) : [];
      const hit = pickCurve([...hitCache.lines, ...axes, ...vectorGeometry(scene)], pointer.bounds, pointer.size, pointer.position, event.pointerType === 'touch' ? 12 : 8);
      return hit ? { hit, ...pointer } : null;
    }

    function clearHover() {
      delete plot.dataset.curveHover; delete plot.dataset.dragPointer; delete plot.dataset.dragAnchor;
      plot.removeAttribute('title'); dragCursor.hidden = true; dragReadout.hidden = true; pointerCursor.hidden = true;
    }

    function showReadout(event, kind, value, anchor) {
      if (value === null || value === undefined || plot.dataset.stale === 'true') { clearHover(); return; }
      const format = number => String(Number(number.toPrecision(4)));
      const labels = { torque: 'T', voltage: '|U|', current: '|I|', phase: 'φ' };
      dragReadout.textContent = kind.startsWith('rotor-axis-') ? `δ=${format(value)}°` : kind === 'mtpa' ? `MTPA · |I|=${format(value.current)} pu · T=${format(value.torque)} pu` :
        kind === 'mtpv' ? `MTPV · |U|=${format(value.voltage)} pu · T=${format(value.torque)} pu` :
          kind.endsWith('-vector') ? `${kind === 'current-vector' ? 'I' : 'U'} · |I|=${format(value.current)} · |U|=${format(value.voltage)} · T=${format(value.torque)} pu` :
          `${labels[kind]}=${format(value)}${kind === 'phase' ? '°' : ' pu'}`;
      if (curveGesture && plot.dataset.dragBlocked === 'true') dragReadout.textContent += ' · 已停在有效边界';
      const bounds = plot.getBoundingClientRect();
      if (!dragCursor.isConnected) plot.append(dragCursor);
      if (!dragReadout.isConnected) plot.append(dragReadout);
      const linked = ['mtpa', 'mtpv', 'current-vector', 'voltage-vector'].includes(kind), layout = plot._fullLayout;
      const position = scene.frame === 'voltage' && kind === 'mtpa' ? null : linked ? kind === 'voltage-vector' ? { direct: value.vd, quadrature: scene.frame === 'voltage' ? 0 : value.vq } : value : anchor;
      const horizontal = Math.max(8, Math.min(plot.clientWidth - 8, position ? layout.xaxis._offset + layout.xaxis.d2p(position.direct) : event.clientX - bounds.left - plot.clientLeft));
      const vertical = Math.max(8, Math.min(plot.clientHeight - 8, position ? layout.yaxis._offset + layout.yaxis.d2p(position.quadrature) : event.clientY - bounds.top - plot.clientTop));
      dragCursor.style.left = horizontal + 'px'; dragCursor.style.top = vertical + 'px'; dragCursor.hidden = false;
      pointerCursor.hidden = !curveGesture?.started;
      if (!pointerCursor.hidden) {
        if (!pointerCursor.isConnected) plot.append(pointerCursor);
        const pointerX = event.clientX - bounds.left - plot.clientLeft, pointerY = event.clientY - bounds.top - plot.clientTop;
        pointerCursor.style.left = pointerX + 'px'; pointerCursor.style.top = pointerY + 'px';
        plot.dataset.dragPointer = JSON.stringify({ x: pointerX, y: pointerY, direct: layout.xaxis.p2d(pointerX - layout.xaxis._offset), quadrature: layout.yaxis.p2d(pointerY - layout.yaxis._offset) });
        plot.dataset.dragAnchor = JSON.stringify({ x: horizontal, y: vertical });
      }
      dragReadout.hidden = false;
      const preferredTop = event.pointerType === 'touch' ? vertical - dragReadout.offsetHeight - 18 : vertical + 18;
      dragReadout.style.left = Math.max(8, Math.min(plot.clientWidth - dragReadout.offsetWidth - 8, horizontal + 14)) + 'px';
      dragReadout.style.top = Math.max(8, Math.min(plot.clientHeight - dragReadout.offsetHeight - 8, preferredTop)) + 'px';
      plot.removeAttribute('title');
    }

    function endCurveGesture(event) {
      if (!curveGesture || (event?.pointerId !== undefined && event.pointerId !== curveGesture.pointerId)) return;
      const previous = curveGesture; curveGesture = null;
      if (plot.hasPointerCapture(previous.pointerId)) plot.releasePointerCapture(previous.pointerId);
      plot.dataset.curveDragging = 'false'; clearHover();
      if (previous.started) callbacks.end?.();
    }

    plot.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      if (event.shiftKey || event.altKey || event.ctrlKey) { clearHover(); return; }
      const selected = hoverHit(event);
      if (!selected) return;
      const linked = ['mtpa', 'mtpv', 'current-vector', 'voltage-vector'].includes(selected.hit.kind);
      const reference = selected.hit.kind.endsWith('-vector') ? scene.point : linked ? optimumDragState(scene, selected.hit, selected.hit.point) : selected.hit.value;
      if (linked && !interactivePoint(reference)) return;
      const start = linked ? selected.hit.point : selected.point;
      const minimumVector = Math.max(1e-10, (selected.bounds.x[1] - selected.bounds.x[0]) / selected.size.width * .001, (selected.bounds.y[1] - selected.bounds.y[0]) / selected.size.height * .001);
      curveGesture = { ...selected, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false, scene: { ...scene, minimumVector },
        acceptedPoint: { ...start }, reference, offset: { direct: start.direct - selected.point.direct, quadrature: start.quadrature - selected.point.quadrature } };
      plot.dataset.dragBlocked = 'false';
      plot.setPointerCapture(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    plot.addEventListener('pointermove', event => {
      if (curveGesture?.pointerId === event.pointerId) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!curveGesture.started && Math.hypot(event.clientX - curveGesture.startX, event.clientY - curveGesture.startY) < 5) return;
        const pointer = pointerCoordinates(event, true);
        if (!pointer) return;
        const kind = curveGesture.hit.kind, coupled = ['mtpa', 'mtpv', 'current-vector', 'voltage-vector'].includes(kind);
        const target = { direct: pointer.point.direct + curveGesture.offset.direct, quadrature: pointer.point.quadrature + curveGesture.offset.quadrature };
        if (kind === 'voltage-vector' && curveGesture.scene.frame === 'voltage') target.quadrature = 0;
        const solve = (position, previous, previousPosition) => {
          if (coupled) return pointDragState(curveGesture.scene, kind, position, previous);
          const value = curveDragValue(curveGesture.scene, curveGesture.hit, position, previousPosition);
          if (kind === 'voltage' && curveGesture.scene.frame === 'voltage' &&
              (!(value > 1e-10) || (curveGesture.scene.solveVoltage && !pointDragState(curveGesture.scene, 'voltage-vector', { direct: value, quadrature: 0 }, curveGesture.scene.point)))) return null;
          return value;
        };
        const next = advanceDrag(solve, curveGesture.acceptedPoint, target, curveGesture.reference);
        curveGesture.started = true;
        plot.dataset.curveDragging = 'true'; plot.dataset.curveDragKind = kind;
        let blocked = next.blocked;
        if (next.moved) {
          let applied;
          try { applied = callbacks.change(kind, next.value); } catch { applied = null; }
          if (applied === null || applied === false) blocked = true;
          else {
            curveGesture.acceptedPoint = next.point;
            curveGesture.reference = coupled ? { ...next.value, ...(applied || {}) } : applied ?? next.value;
          }
        }
        const value = curveGesture.reference;
        plot.dataset.dragBlocked = String(blocked);
        plot.dataset.curveDragValue = String(coupled ? kind === 'current-vector' ? value.current : kind === 'voltage-vector' ? value.voltage : value.amplitude : value);
        plot.dataset.curveDragValues = JSON.stringify(value);
        showReadout(event, kind, value, curveGesture.acceptedPoint);
      } else if (event.buttons === 0 && event.pointerType !== 'touch') {
        if (event.shiftKey || event.altKey || event.ctrlKey) { clearHover(); return; }
        const selected = hoverHit(event);
        if (!selected) { clearHover(); return; }
        const value = selected.hit.kind.endsWith('-vector') ? scene.point : ['mtpa', 'mtpv'].includes(selected.hit.kind) ? optimumDragState(scene, selected.hit, selected.hit.point) : selected.hit.value;
        if (value === null) { clearHover(); return; }
        plot.dataset.curveHover = selected.hit.kind;
        showReadout(event, selected.hit.kind, value);
      }
    }, true);
    plot.addEventListener('pointerup', endCurveGesture, true);
    plot.addEventListener('pointercancel', endCurveGesture, true);
    plot.addEventListener('lostpointercapture', endCurveGesture, true);
    plot.addEventListener('pointerleave', () => { if (!curveGesture) clearHover(); });
    plot.addEventListener('mousedown', event => { if (curveGesture) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    for (const type of ['touchstart', 'touchmove']) plot.addEventListener(type, event => {
      if (curveGesture) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, passive: false });
    plot.addEventListener('wheel', event => { if (curveGesture?.started) { event.preventDefault(); event.stopImmediatePropagation(); } }, { capture: true, passive: false });
    plot.addEventListener('keydown', event => { if (event.key === 'Escape' && curveGesture) { event.preventDefault(); endCurveGesture(); } }, true);
    window.addEventListener('blur', () => endCurveGesture());

    function initGpu() {
      if (gpuAttempted) return;
      gpuAttempted = true;
      try {
        gpu = heatCanvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false,
          premultipliedAlpha: false, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: true });
        if (!gpu) { stats.fallback = 'webgl-unavailable'; return; }
        gpuPrecision = Math.min(23, gpu.getShaderPrecisionFormat(gpu.FRAGMENT_SHADER, gpu.HIGH_FLOAT).precision);
        if (!gpuPrecision) throw new Error('fragment-highp-unavailable');
        const compile = (type, source) => {
          const shader = gpu.createShader(type); gpu.shaderSource(shader, source); gpu.compileShader(shader);
          if (!gpu.getShaderParameter(shader, gpu.COMPILE_STATUS)) { const message = gpu.getShaderInfoLog(shader); gpu.deleteShader(shader); throw new Error(message); }
          return shader;
        };
        const vertex = compile(gpu.VERTEX_SHADER, VERTEX_SHADER), fragment = compile(gpu.FRAGMENT_SHADER, FRAGMENT_SHADER);
        program = gpu.createProgram(); gpu.attachShader(program, vertex); gpu.attachShader(program, fragment); gpu.linkProgram(program);
        gpu.deleteShader(vertex); gpu.deleteShader(fragment);
        if (!gpu.getProgramParameter(program, gpu.LINK_STATUS)) throw new Error(gpu.getProgramInfoLog(program));
        gpu.useProgram(program);
        const buffer = gpu.createBuffer(); gpu.bindBuffer(gpu.ARRAY_BUFFER, buffer);
        gpu.bufferData(gpu.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gpu.STATIC_DRAW);
        const position = gpu.getAttribLocation(program, 'position'); gpu.enableVertexAttribArray(position); gpu.vertexAttribPointer(position, 2, gpu.FLOAT, false, 0, 0);
        uniforms = Object.fromEntries(['minimumView', 'maximumView', 'motor', 'speed', 'colorMaximum', 'quantity', 'referenceFrame', 'outputVoltage'].map(name => [name, gpu.getUniformLocation(program, name)]));
        const info = gpu.getExtension('WEBGL_debug_renderer_info');
        stats.renderer = gpu.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gpu.RENDERER);
      } catch (error) { gpuLost = true; stats.fallback = error.message; }
    }

    function gpuSuitable(view) {
      if (scene.forceCpu || scene.asinhColor) return false;
      if (!gpu || !program || gpuLost || gpu.isContextLost()) return false;
      const values = [...Object.values(scene.model.pu), ...view.x, ...view.y];
      if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= 1e8) || scene.maximum > 1e30) return false;
      const { resistance, ld, lq, flux } = scene.model.pu;
      const currentMagnitude = Math.max(1, ...view.x.map(Math.abs), ...view.y.map(Math.abs));
      const roundoffScale = 2 * currentMagnitude * (resistance * currentMagnitude + Math.max(1, Math.abs(scene.model.input.speedPU)) * ((ld + lq) * currentMagnitude + flux));
      if (roundoffScale * 2 ** (3 - gpuPrecision) > scene.maximum * .002) return false;
      if (scene.frame === 'voltage') {
        if (!Number.isFinite(scene.model.outputVoltage) || scene.model.outputVoltage > 1e8) return false;
        const divisor = scene.heat === 'torque' ? Math.abs(scene.model.input.speedPU) : 1;
        if (divisor < 1e-5) return false;
        const fieldScale = 2 * (scene.model.outputVoltage * currentMagnitude + resistance * currentMagnitude * currentMagnitude) / divisor;
        if (fieldScale * 2 ** (3 - gpuPrecision) > scene.maximum * .002) return false;
      }
      return ['x', 'y'].every(axis => (view[axis][1] - view[axis][0]) / Math.max(1, ...view[axis].map(Math.abs)) >= .002);
    }

    function drawHeat(view, width, height, density) {
      heatCanvas.style.display = 'none';
      raster.style.display = 'none';
      stats.backend = 'canvas2d';
      if (!scene.heat) return;
      if (scene.heatPoints) {
        rasterContext.setTransform(density, 0, 0, density, 0, 0);
        rasterContext.clearRect(0, 0, width, height);
        rasterContext.lineWidth = 8; rasterContext.lineCap = 'round';
        let previous = null;
        for (const point of scene.heatPoints) {
          const current = { x: (point.direct - view.x[0]) / (view.x[1] - view.x[0]) * width,
            y: (view.y[1] - point.quadrature) / (view.y[1] - view.y[0]) * height, color: colorFor(point.torque, scene.maximum) };
          if (previous && [previous.x, previous.y, current.x, current.y].every(Number.isFinite) &&
              !((previous.x < -4 && current.x < -4) || (previous.x > width + 4 && current.x > width + 4) ||
                (previous.y < -4 && current.y < -4) || (previous.y > height + 4 && current.y > height + 4))) {
            const gradient = rasterContext.createLinearGradient(previous.x, previous.y, current.x, current.y);
            gradient.addColorStop(0, `rgb(${previous.color.join(',')})`); gradient.addColorStop(1, `rgb(${current.color.join(',')})`);
            rasterContext.strokeStyle = gradient; rasterContext.beginPath(); rasterContext.moveTo(previous.x, previous.y); rasterContext.lineTo(current.x, current.y); rasterContext.stroke();
          }
          previous = current;
        }
        raster.style.opacity = '.85'; raster.style.zIndex = '4'; raster.style.display = 'block';
        stats.backend = 'trajectory-canvas'; stats.fallback = null; return;
      }
      raster.style.opacity = '1'; raster.style.zIndex = '';
      rasterContext.setTransform(1, 0, 0, 1, 0, 0);
      if (gpuSuitable(view)) {
        gpu.viewport(0, 0, heatCanvas.width, heatCanvas.height); gpu.useProgram(program);
        gpu.uniform2f(uniforms.minimumView, view.x[0], view.y[0]); gpu.uniform2f(uniforms.maximumView, view.x[1], view.y[1]);
        const { resistance, ld, lq, flux } = scene.model.pu;
        gpu.uniform4f(uniforms.motor, resistance, ld, lq, flux); gpu.uniform1f(uniforms.speed, scene.model.input.speedPU);
        gpu.uniform1f(uniforms.colorMaximum, scene.maximum); gpu.uniform1i(uniforms.quantity, HEAT_KEYS.indexOf(scene.heat));
        gpu.uniform1i(uniforms.referenceFrame, scene.frame === 'voltage' ? 1 : 0); gpu.uniform1f(uniforms.outputVoltage, scene.model.outputVoltage || 0);
        gpu.drawArrays(gpu.TRIANGLES, 0, 3); heatCanvas.style.display = 'block'; stats.backend = 'webgl'; stats.fallback = null; return;
      }
      if (gpu && program && !gpuLost && !gpu.isContextLost()) stats.fallback = 'numeric-precision';
      const resolution = scene.rasterResolution || 81;
      if (pixels.width !== resolution) pixels = rasterContext.createImageData(resolution, resolution);
      const grid = scene.grid ? scene.grid(view, resolution) : Motor.grid(scene.model, 1, resolution, view), field = grid.fields[scene.heat];
      for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
        const value = field[resolution - 1 - row][column];
        const color = scene.heatColor ? scene.heatColor(value) : colorFor(value, scene.maximum, scene.heat === 'apparent', scene.asinhColor);
        const offset = (row * resolution + column) * 4;
        pixels.data[offset] = color?.[0] || 0; pixels.data[offset + 1] = color?.[1] || 0; pixels.data[offset + 2] = color?.[2] || 0; pixels.data[offset + 3] = Number.isFinite(value) ? 184 : 0;
      }
      rasterContext.putImageData(pixels, 0, 0); raster.style.display = 'block';
    }

    function draw(view) {
      if (!scene || !plot._fullLayout) return;
      const started = performance.now(), layout = plot._fullLayout;
      const width = layout.xaxis._length, height = layout.yaxis._length;
      if (width <= 0 || height <= 0) return;
      const density = Math.min(2, devicePixelRatio || 1);
      for (const canvas of [heatCanvas, raster, constraintCanvas, lineCanvas]) {
        if (!canvas.isConnected) plot.append(canvas);
        Object.assign(canvas.style, { left: layout.xaxis._offset + 'px', top: layout.yaxis._offset + 'px', width: width + 'px', height: height + 'px' });
        const pixelWidth = Math.max(1, Math.round(width * density)), pixelHeight = Math.max(1, Math.round(height * density));
        if ((canvas !== raster || scene.heatPoints) && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
        const resolution = scene.rasterResolution || 81;
        if (canvas === raster && !scene.heatPoints && (canvas.width !== resolution || canvas.height !== resolution)) { canvas.width = resolution; canvas.height = resolution; }
      }
      context.setTransform(density, 0, 0, density, 0, 0); context.clearRect(0, 0, width, height);
      drawHeat(view, width, height, density);
      constraintCanvas.style.display = 'none';
      if (scene.showFeasible && scene.constraintSampler) {
        const region = scene.constraintSampler.sample(scene.model, view, 61), color = scene.colors.feasible || '#159b86';
        const screenX = value => (value - view.x[0]) / (view.x[1] - view.x[0]) * width;
        const screenY = value => (view.y[1] - value) / (view.y[1] - view.y[0]) * height;
        constraintContext.setTransform(density, 0, 0, density, 0, 0); constraintContext.globalAlpha = 1;
        constraintContext.clearRect(0, 0, width, height);
        if (region.dimension === 2) {
          const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16));
          for (let row = 0; row < 61; row++) for (let column = 0; column < 61; column++) {
            const offset = (row * 61 + column) * 4;
            constraintPixels.data[offset] = channels[0]; constraintPixels.data[offset + 1] = channels[1]; constraintPixels.data[offset + 2] = channels[2];
            constraintPixels.data[offset + 3] = region.z[60 - row][column] === 1 ? 56 : 0;
          }
          constraintRasterContext.putImageData(constraintPixels, 0, 0);
          constraintContext.imageSmoothingEnabled = true;
          constraintContext.drawImage(constraintRaster, screenX(region.bounds.x[0]), screenY(region.bounds.y[1]),
            (region.bounds.x[1] - region.bounds.x[0]) / (view.x[1] - view.x[0]) * width, (region.bounds.y[1] - region.bounds.y[0]) / (view.y[1] - view.y[0]) * height);
        } else if (region.dimension >= 0) {
          constraintContext.strokeStyle = color; constraintContext.fillStyle = color; constraintContext.globalAlpha = .3; constraintContext.lineWidth = 4;
          for (const branch of region.segments) {
            constraintContext.beginPath();
            if (region.dimension === 0) { const point = branch[0]; constraintContext.arc(screenX(point.direct), screenY(point.quadrature), 4.5, 0, 2 * Math.PI); constraintContext.fill(); }
            else { branch.forEach((point, index) => constraintContext[index === 0 ? 'moveTo' : 'lineTo'](screenX(point.direct), screenY(point.quadrature))); constraintContext.stroke(); }
          }
          constraintContext.globalAlpha = 1;
        }
        constraintCanvas.style.display = 'block';
        plot.dataset.previewConstraint = JSON.stringify({ visible: true, dimension: region.dimension, status: region.status, voltageLimit: region.voltageLimit, currentLimit: region.currentLimit, ...scene.constraintSampler.statistics });
      } else plot.dataset.previewConstraint = JSON.stringify({ visible: false });
      const key = JSON.stringify(scene.geometryKey || [scene.model.input, scene.visible, scene.levels, scene.voltageLevels, scene.torqueTarget, scene.phaseTarget]);
      if (!cache || cache.key !== key || !covers(cache.bounds, view) || (view.x[1] - view.x[0]) < (cache.bounds.x[1] - cache.bounds.x[0]) / 5) {
        cache = { key, ...geometryFor(scene, paddedBounds(view)) }; stats.geometryBuilds++;
      }
      const screenX = value => (value - view.x[0]) / (view.x[1] - view.x[0]) * width;
      const screenY = value => (view.y[1] - value) / (view.y[1] - view.y[0]) * height;
      const axes = scene.axesGeometry ? scene.axesGeometry(view) : [];
      for (const line of [...cache.lines, ...axes, ...vectorGeometry(scene)]) {
        const appearance = curveAppearance(line.kind, line.value, scene);
        context.strokeStyle = appearance.color; context.fillStyle = appearance.color;
        context.lineWidth = appearance.width; context.globalAlpha = appearance.opacity; context.setLineDash(appearance.dash); context.beginPath();
        if (line.vector) {
          const point = line.branches[0][0], horizontal = screenX(point.direct), vertical = screenY(point.quadrature);
          context.moveTo(screenX(0), screenY(0)); context.lineTo(horizontal, vertical); context.stroke(); context.beginPath();
          if (line.kind === 'voltage-vector') {
            context.moveTo(horizontal, vertical - 6); context.lineTo(horizontal + 6, vertical); context.lineTo(horizontal, vertical + 6); context.lineTo(horizontal - 6, vertical); context.closePath();
          } else context.arc(horizontal, vertical, 5.5, 0, 2 * Math.PI);
          context.fill(); context.strokeStyle = scene.colors.surface; context.lineWidth = 2; context.stroke(); continue;
        }
        const drawnDots = new Set();
        for (const branch of line.branches) {
          let previous = null;
          for (const point of branch) {
            if (!point || !Number.isFinite(point.direct) || !Number.isFinite(point.quadrature)) { previous = null; continue; }
            if (line.dots) {
              const dotKey = point.direct + ',' + point.quadrature;
              if (!drawnDots.has(dotKey)) { context.moveTo(screenX(point.direct) + 3.5, screenY(point.quadrature)); context.arc(screenX(point.direct), screenY(point.quadrature), 3.5, 0, 2 * Math.PI); drawnDots.add(dotKey); }
              continue;
            }
            if (previous && branch.length > 2 && Math.hypot(point.direct - previous.direct, point.quadrature - previous.quadrature) > cache.extent * .35) previous = null;
            if (previous) context.lineTo(screenX(point.direct), screenY(point.quadrature));
            else context.moveTo(screenX(point.direct), screenY(point.quadrature));
            previous = point;
          }
        }
        if (line.dots) context.fill(); else context.stroke();
        if (line.axisLabel && line.labelPoint) {
          context.font = '11px sans-serif'; context.textAlign = 'left'; context.textBaseline = 'bottom';
          context.fillText(line.axisLabel, screenX(line.labelPoint.direct) + 5, screenY(line.labelPoint.quadrature) - 5);
        }
      }
      context.globalAlpha = 1; context.setLineDash([]);
      lineCanvas.style.display = 'block'; plot.dataset.previewActive = 'true';
      lastView = { x: [...view.x], y: [...view.y] };
      stats.frames++; stats.drawMs.push(performance.now() - started); if (stats.drawMs.length > 180) stats.drawMs.shift();
      plot.dataset.previewFrameCount = String(stats.frames); plot.dataset.previewBackend = stats.backend;
      plot.dataset.previewModel = JSON.stringify(scene.model.input);
      plot.dataset.previewTargets = JSON.stringify({ torque: scene.torqueTarget, phase: scene.phaseTarget });
      plot.dataset.previewVectors = JSON.stringify(vectorGeometry(scene).map(line => ({ kind: line.kind, point: line.branches[0][0] })));
      plot.dataset.previewAxes = JSON.stringify(axes.map(line => ({ kind: line.kind, point: line.labelPoint })));
      plot.dataset.previewMapped = JSON.stringify(cache.lines.filter(line => line.kind.startsWith('mapped-')).map(line => ({ kind: line.kind, value: line.value,
        sample: line.branches.flat().find(point => point && screenX(point.direct) > 8 && screenX(point.direct) < width - 8 && screenY(point.quadrature) > 8 && screenY(point.quadrature) < height - 8) || null })));
      plot.dataset.previewView = JSON.stringify(lastView); plot.dataset.previewMetrics = JSON.stringify(stats);
    }

    function cancelFrame() {
      if (frame !== null) { if (frameKind === 'animation') cancelAnimationFrame(frame); else clearTimeout(frame); frame = null; }
    }

    function request(view) {
      active = true; pendingView = { x: [...view.x], y: [...view.y] };
      if (frame !== null) return;
      const paint = () => { frame = null; if (active && pendingView) { const next = pendingView; pendingView = null; draw(next); } };
      frameKind = document.visibilityState === 'visible' ? 'animation' : 'timer';
      frame = frameKind === 'animation' ? requestAnimationFrame(paint) : setTimeout(paint, 16);
    }

    heatCanvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); gpuLost = true; stats.fallback = 'context-lost';
      if (active && (pendingView || lastView)) request(pendingView || lastView);
    });

    return {
      get active() { return active; },
      get dragging() { return Boolean(curveGesture?.started); },
      setScene(next) {
        scene = next; if (scene.heat && !scene.heatPoints) initGpu();
        if (!curveGesture) clearHover();
        const workbench = plot.closest('.motor-workbench');
        for (const [family, values] of [['torque', [-3, 0, 3]], ['voltage', [0, 1, 2]], ['phase', [-180, -90, 0, 90, 180]]]) workbench?.style.setProperty('--' + family + '-ramp', `linear-gradient(90deg,${values.map(value => curveColor(family, value, scene.dark)).join(',')})`);
      },
      request,
      settle() { active = false; pendingView = null; cancelFrame(); },
      hide() { active = false; pendingView = null; cancelFrame(); for (const canvas of [heatCanvas, raster, constraintCanvas, lineCanvas]) canvas.style.display = 'none'; plot.dataset.previewActive = 'false'; }
    };
  }

  return { create, colorFor, curveColor, curveAppearance, pickCurve, curveDragValue, optimumDragState, interactivePoint, pointDragState, advanceDrag, vectorGeometry, vectorTraces, createConstraintSampler, constraintTrace, paddedBounds, covers, geometryFor, plotTopMargin, plotConfig, decorateViewTools };
});