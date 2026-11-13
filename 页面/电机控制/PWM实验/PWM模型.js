/* Voltages are normalized by Vdc/2. Displayed phase voltages use the DC
 * midpoint O; neutralPhase separately retains the floating-neutral projection.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PWMModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const PI = Math.PI, TAU = 2 * PI;
  const mod = (x, n) => ((x % n) + n) % n;
  function levelsCheck(levels) {
    if (levels !== 2 && levels !== 3) throw new RangeError('电平数必须为2或3');
  }
  function clarke([a, b, c]) {
    return { alpha: (2 * a - b - c) / 3, beta: (b - c) / Math.sqrt(3), zero: (a + b + c) / 3 };
  }
  function inverseClarke({ alpha, beta, zero = 0 }) {
    return [alpha + zero, -alpha / 2 + Math.sqrt(3) * beta / 2 + zero, -alpha / 2 - Math.sqrt(3) * beta / 2 + zero];
  }
  function spaceStates(levels) {
    levelsCheck(levels);
    const values = levels === 2 ? [-1, 1] : [-1, 0, 1];
    const states = [], map = new Map();
    for (const a of values) for (const b of values) for (const c of values) {
      const abc = [a, b, c], vector = clarke(abc);
      const state = { abc, ...vector };
      states.push(state);
      const key = vector.alpha.toFixed(9) + ',' + vector.beta.toFixed(9);
      if (!map.has(key)) map.set(key, { alpha: vector.alpha, beta: vector.beta, states: [] });
      map.get(key).states.push(abc);
    }
    return { states, positions: [...map.values()] };
  }
  function triangle(cycles) {
    const p = mod(cycles, 1);
    return 1 - Math.abs(2 * p - 1); // [0,1], common phase for both PD carriers
  }
  function carrierLevel(reference, carrier, levels) {
    levelsCheck(levels);
    if (levels === 2) return reference >= 2 * carrier - 1 ? 1 : -1;
    return (reference >= carrier ? 1 : 0) + (reference >= carrier - 1 ? 1 : 0) - 1;
  }
  const METHODS = ['SPWM', 'SVPWM', 'THIPWM', 'DPWM5', 'DPWMMAX', 'DPWMMIN'];
  function references(theta, m, method = 'SPWM') {
    if (!METHODS.includes(method)) throw new RangeError('未知调制策略');
    const sine = [0, -TAU / 3, TAU / 3].map(shift => m * Math.sin(theta + shift));
    const maximum = Math.max(...sine), minimum = Math.min(...sine);
    let zero = 0;
    if (method === 'SVPWM') zero = -(maximum + minimum) / 2;
    if (method === 'THIPWM') zero = m * Math.sin(3 * theta) / 6;
    if (method === 'DPWMMAX') zero = 1 - maximum;
    if (method === 'DPWMMIN') zero = -1 - minimum;
    if (method === 'DPWM5') zero = maximum >= -minimum ? 1 - maximum : -1 - minimum;
    return { sine, injected: sine.map(v => v + zero), zero };
  }
  function referencePair(theta, m) {
    if (!Number.isFinite(theta) || !Number.isFinite(m) || m < 0 || m > 1.3) throw new RangeError('参考参数非法');
    const reference = references(theta, m, 'SVPWM');
    return { spwm: reference.sine, svpwm: reference.injected, zero: reference.zero };
  }
  function referenceTrajectories(m, count = 720) {
    if (!Number.isFinite(m) || m < 0 || m > 1.3 || !Number.isInteger(count) || count < 12 || count > 4096) throw new RangeError('参考轨迹参数非法');
    const curves = Object.fromEntries(METHODS.map(method => [method.toLowerCase(), []]));
    const zero = [];
    for (let i = 0; i <= count; i++) {
      const theta = TAU * i / count;
      for (const method of METHODS) {
        const ref = references(theta, m, method);
        curves[method.toLowerCase()].push(method === 'SPWM' ? ref.sine : ref.injected);
      }
      zero.push(references(theta, m, 'SVPWM').zero);
    }
    return { ...curves, zero };
  }
  function outputValues(sample, output) {
    if (output === 'phase') return sample.abc.slice();
    if (output === 'line') return [sample.abc[0] - sample.abc[1], sample.abc[1] - sample.abc[2], sample.abc[2] - sample.abc[0]];
    throw new RangeError('仅支持相电压与线电压');
  }
  function generate(config = {}) {
    const { levels = 3, method = 'SPWM', m = 0.8, ratio = 40, samples = 8192, cycles = 1 } = config;
    levelsCheck(levels);
    if (!METHODS.includes(method) || (method === 'DPWM5' && levels !== 2) || !Number.isFinite(m) || m < 0 || m > 1.3 ||
        !Number.isInteger(ratio) || ratio < 3 || ratio > 99 || !Number.isInteger(samples) || samples < 512 || samples > 131072 || samples < ratio * 64 || ![.5, 1, 2].includes(cycles)) throw new RangeError('参数范围或观察窗口非法');
    const count = Math.round(samples * cycles), data = [];
    let clippedSamples = 0;
    for (let i = 0; i < count; i++) {
      const theta = TAU * (i + 0.5) / samples;
      const ref = references(theta, m, method), carrier = triangle(ratio * theta / TAU);
      if (ref.injected.some(value => Math.abs(value) > 1 + 1e-12)) clippedSamples++;
      const abc = ref.injected.map(value => carrierLevel(value, carrier, levels));
      const vector = clarke(abc);
      data.push({ theta, abc, neutralPhase: abc.map(value => value - vector.zero), ...vector, reference: ref.sine, injected: ref.injected, carrier, referenceVector: clarke(ref.sine) });
    }
    return { samples: data, clippedSamples, config: { levels, method, m, ratio, samples, cycles } };
  }
  return { METHODS, TAU, clarke, inverseClarke, spaceStates, triangle, carrierLevel, references, referencePair, referenceTrajectories, outputValues, generate };
});
