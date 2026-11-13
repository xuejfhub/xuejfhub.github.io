/* Deterministic seeding and finite-time trajectories; no normalized velocities. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./控制器模型.js'));
  else root.ControllerFlow = factory(root.ControllerModel);
})(typeof globalThis === 'object' ? globalThis : this, function (M) {
  'use strict';
  function seeds(p, bounds, columns, rows, mode = 'uniform') {
    const [vmin, vmax] = bounds.v, span = vmax - vmin, bins = 1024;
    // In this model div depends only on v. Include v=0 for the exact extrema.
    const values = [vmin, vmax, Math.max(vmin, Math.min(vmax, 0))].map(v => M.divergence({v}, p));
    const min = Math.min(...values), max = Math.max(...values), peak = Math.max(Math.abs(min), Math.abs(max));
    const weighted = mode !== 'uniform' && max - min > 1e-10 * Math.max(1, peak);
    const power = mode === 'square' ? 2 : 1, cdf = [0];
    if (weighted) {
      for (let i = 0; i < bins; i++) {
        const v = vmin + (i + .5) / bins * span, score = Math.abs(M.divergence({v}, p)) / peak;
        // Keep coverage even where div=0; cap the density ratio at 6:1.
        cdf.push(cdf[i] + 1 + 5 * score ** power);
      }
    }
    function quantile(u) {
      if (!weighted) return u;
      const target = u * cdf[bins]; let lo = 0, hi = bins;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] < target) lo = mid; else hi = mid; }
      return (lo + (target - cdf[lo]) / (cdf[hi] - cdf[lo])) / bins;
    }
    const jitter = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return (s - Math.floor(s) - .5) * .5; };
    const points = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const k = j * columns + i;
      const u = (i + .5 + jitter(2 * k)) / columns, v = quantile((j + .5 + jitter(2 * k + 1)) / rows);
      points.push({f: bounds.f[0] + u * (bounds.f[1] - bounds.f[0]), v: vmin + v * span});
    }
    return { points, min, max, weighted };
  }
  function trace(p, initial, horizon, count = 96, bounds = null) {
    if (!Number.isFinite(horizon) || horizon <= 0 || horizon > 5) throw new RangeError('短轨迹时长应在 0 至 5 秒之间');
    if (!Number.isInteger(count) || count < 12 || count > 1000) throw new RangeError('短轨迹采样数非法');
    if (![initial.f, initial.v].every(Number.isFinite)) throw new RangeError('短轨迹初值非法');
    const points = [{...initial, t: 0}], dt = horizon / count, substeps = Math.ceil(dt / M.maxStep(p)), h = dt / substeps;
    const outside = s => Math.max(Math.abs(s.f), Math.abs(s.v)) >= M.MAX_STATE || (bounds &&
      (s.f < bounds.f[0] || s.f > bounds.f[1] || s.v < bounds.v[0] || s.v > bounds.v[1]));
    let state = {...initial};
    if (outside(state)) return points;
    for (let i = 1; i <= count; i++) {
      for (let j = 0; j < substeps; j++) {
        const next = M.step(state, p, h), t = (i - 1) * dt + (j + 1) * h;
        if (![next.f, next.v].every(Number.isFinite)) return points;
        state = next;
        if (outside(state)) { points.push({...state, t}); return points; }
      }
      points.push({...state, t: i * dt});
    }
    return points;
  }
  return { seeds, trace };
});
