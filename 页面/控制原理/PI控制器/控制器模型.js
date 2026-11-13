/* Parallel PI in (F,v): F=Kp(r-v)+I, I'=Ki(r-v), for constant r. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ControllerModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({ mass: 1, damping: .6, friction: .4, epsilon: .12, kp: 1.4, ki: 2.4, target: 1, load: 0, force0: 1.4, speed0: 0, duration: 12 });
  const LIMITS = Object.freeze({ mass: [.2, 5], damping: [-4, 4], friction: [0, 3], epsilon: [.04, .8], kp: [0, 8], ki: [0, 12], target: [-3, 3], load: [-3, 3], force0: [-20, 20], speed0: [-5, 5], duration: [4, 30] });
  const MAX_STATE = 1000;
  function parameters(values = {}) {
    const p = { ...DEFAULTS, ...values };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      if (!Number.isFinite(p[key]) || p[key] < min || p[key] > max) throw new RangeError(key + ' 必须在 ' + min + ' 至 ' + max + ' 之间');
    }
    return p;
  }
  function resistance(v, p) { return p.damping * v + p.friction * Math.tanh(v / p.epsilon) + p.load; }
  function field(state, p) {
    const dv = (state.f - resistance(state.v, p)) / p.mass;
    return { f: p.ki * (p.target - state.v) - p.kp * dv, v: dv };
  }
  function integral(state, p) { return state.f - p.kp * (p.target - state.v); }
  function divergence(state, p) {
    return -(p.kp + p.damping + p.friction / p.epsilon * (1 - Math.tanh(state.v / p.epsilon) ** 2)) / p.mass;
  }
  function maxStep(p) {
    const rate = (Math.abs(p.damping) + p.friction / p.epsilon + p.kp) / p.mass + Math.sqrt(p.ki / p.mass);
    return Math.min(.012, .65 / Math.max(1, rate));
  }
  function step(state, p, h) {
    const add = (s, k, t) => ({ f: s.f + k.f * t, v: s.v + k.v * t });
    const a = field(state, p), b = field(add(state, a, h / 2), p), c = field(add(state, b, h / 2), p), d = field(add(state, c, h), p);
    return { f: state.f + h / 6 * (a.f + 2 * b.f + 2 * c.f + d.f), v: state.v + h / 6 * (a.v + 2 * b.v + 2 * c.v + d.v) };
  }
  function simulate(values, initial = null, count = 720) {
    const p = parameters(values);
    if (!Number.isInteger(count) || count < 20 || count > 10000) throw new RangeError('采样数非法');
    let state = initial ? { f: initial.f, v: initial.v } : { f: p.force0, v: p.speed0 };
    if (![state.f, state.v].every(Number.isFinite)) throw new RangeError('初始状态非法');
    // Use |b|: negative damping can produce fast exponential growth too.
    const dt = p.duration / count, n = Math.max(1, Math.ceil(dt / maxStep(p)));
    const h = dt / n, points = [{ ...state, t: 0 }];
    const exceeded = s => Math.max(Math.abs(s.f), Math.abs(s.v)) >= MAX_STATE;
    const finish = (reason, t) => { points.termination = { reason, time: t, limit: MAX_STATE }; return points; };
    if (exceeded(state)) return finish('state-limit', 0);
    for (let i = 1; i <= count; i++) {
      for (let j = 0; j < n; j++) {
        const next = step(state, p, h), t = (i - 1) * dt + (j + 1) * h;
        if (![next.f, next.v].every(Number.isFinite)) return finish('non-finite', points.at(-1).t);
        state = next;
        if (exceeded(state)) {
          // Keep the actual last state and time, without clamping or extending it.
          points.push({ ...state, t });
          return finish('state-limit', t);
        }
      }
      points.push({ ...state, t: i * dt });
    }
    return points;
  }
  function equilibrium(p) { return p.ki === 0 ? null : { f: resistance(p.target, p), v: p.target }; }
  function effectiveDamping(p) {
    return p.damping + p.friction / p.epsilon * (1 - Math.tanh(p.target / p.epsilon) ** 2);
  }
  function stability(p) {
    const beff = effectiveDamping(p), margin = p.kp + beff;
    const result = { beff, margin, kpCritical: -beff, globalSufficient: p.ki > 0 && p.kp + p.damping > 0 };
    // Ki=0 freezes I. The target point need not be on the reachable equilibrium.
    if (p.ki === 0) return { ...result, label: '积分关闭 · 需单独分析', type: 'p', regime: 'off', poles: null, maxReal: null };
    const a = margin / p.mass, b = p.ki / p.mass, d = a * a - 4 * b;
    const poles = d < 0 ? [{ re: -a / 2, im: Math.sqrt(-d) / 2 }, { re: -a / 2, im: -Math.sqrt(-d) / 2 }]
      : [{ re: (-a + Math.sqrt(d)) / 2, im: 0 }, { re: (-a - Math.sqrt(d)) / 2, im: 0 }];
    Object.assign(result, { poles, maxReal: Math.max(...poles.map(s => s.re)) });
    const roundoff = 16 * Number.EPSILON * Math.max(1, Math.abs(p.kp), Math.abs(beff), Math.abs(p.damping), p.friction / p.epsilon);
    if (Math.abs(margin) <= roundoff) return { ...result, label: p.friction === 0 ? '稳定边界 · 等幅振荡' : '线性化临界 · 非线性待判', type: p.friction === 0 ? 'center' : 'nonhyperbolic', regime: 'boundary' };
    if (margin < 0) return { ...result, label: d < 0 ? '不稳定 · 振荡发散' : '不稳定 · 实极点发散', type: d < 0 ? 'unstable-focus' : 'unstable-node', regime: 'unstable' };
    return { ...result, label: Math.abs(d) < 1e-8 ? '局部稳定 · 临界阻尼' : d < 0 ? '局部稳定 · 衰减振荡' : '局部稳定 · 非振荡模态', type: Math.abs(d) < 1e-8 ? 'critical' : d < 0 ? 'focus' : 'node', regime: 'stable' };
  }
  function sample(points, time) {
    const t = Math.max(0, Math.min(points.at(-1).t, time));
    if (t <= points[0].t) return { ...points[0] };
    if (t >= points.at(-1).t) return { ...points.at(-1) };
    // The final sample can be an irregular substep after a divergence stop.
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].t <= t) lo = mid; else hi = mid; }
    const a = points[lo], b = points[hi], w = (t - a.t) / (b.t - a.t);
    return { t, f: a.f + (b.f - a.f) * w, v: a.v + (b.v - a.v) * w };
  }
  return { DEFAULTS, LIMITS, MAX_STATE, parameters, resistance, field, integral, divergence, maxStep, step, simulate, equilibrium, effectiveDamping, stability, sample };
});
