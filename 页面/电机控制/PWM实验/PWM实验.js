/* Browser-only UI. Numerical calculations live in PWM模型.js. */
(() => {
  'use strict';
  const P = window.PWMModel, $ = id => document.getElementById(id);
  const form = $('pwm-controls');
  const spatialView = new window.SpatialProjection.SpaceView($('space-3d'));
  let result = null, config = null, running = false, lastFrame = null, probeAngle = 0;
  const pausedGraphs = new Set();
  const outputCanvases = ['waveform'];
  const graphCanvases = [...outputCanvases, 'modulator'];
  const graphs = new Map();
  const outputLabels = () => config.output === 'line' ? ['UAB', 'UBC', 'UCA'] : ['UAO', 'UBO', 'UCO'];
  const fixed = (v, n = 4) => Number.isFinite(v) ? v.toFixed(n) : '—';
  function palette() {
    const css = getComputedStyle(document.documentElement);
    return Object.fromEntries(['bg', 'surface', 'text', 'muted', 'accent', 'line'].map(k => [k, css.getPropertyValue('--' + k).trim()]));
  }
  function setup(id, xRange, yRange, yTicks = null) {
    const canvas = $(id), bounds = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const width = Math.max(240, bounds.width), height = Math.max(200, bounds.height);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const colors = palette(), left = 48, top = 22, pw = width - left - 16, ph = height - top - 38;
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, height);
    const sx = pw / (xRange[1] - xRange[0]), sy = ph / (yRange[1] - yRange[0]);
    const x = v => left + pw / 2 + (v - (xRange[0] + xRange[1]) / 2) * sx;
    const y = v => top + ph / 2 - (v - (yRange[0] + yRange[1]) / 2) * sy;
    ctx.font = '11px sans-serif';
    for (let i = 0; i <= 4; i++) {
      const xv = xRange[0] + (xRange[1] - xRange[0]) * i / 4;
      ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(xv), y(yRange[0])); ctx.lineTo(x(xv), y(yRange[1])); ctx.stroke();
      ctx.fillStyle = colors.muted; ctx.textAlign = 'center'; ctx.fillText(fixed(xv, 2), x(xv), height - 12);
    }
    const ticks = yTicks || Array.from({ length: 5 }, (_, i) => yRange[0] + (yRange[1] - yRange[0]) * i / 4);
    for (const yv of ticks) {
      ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(xRange[0]), y(yv)); ctx.lineTo(x(xRange[1]), y(yv)); ctx.stroke();
      ctx.fillStyle = colors.muted; ctx.textAlign = 'right'; ctx.fillText(yTicks ? String(yv) : fixed(yv, 1), left - 5, y(yv) + 4);
    }
    const graph = { ctx, x, y, colors, width, height, xRange, yRange, left, right: width - 16 };
    graphs.set(id, graph);
    return graph;
  }
  function path(graph, points, color, dashed = false, steps = false) {
    if (!points.length) return;
    const { ctx, x, y } = graph;
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(x(points[0][0]), y(points[0][1]));
    for (let i = 1; i < points.length; i++) {
      if (steps) ctx.lineTo(x(points[i][0]), y(points[i - 1][1]));
      ctx.lineTo(x(points[i][0]), y(points[i][1]));
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  function sampleAtProbe() {
    if (!result?.samples.length) return null;
    const index = Math.min(result.samples.length - 1, Math.max(0, Math.floor(probeAngle / 360 * config.samples)));
    return result.samples[index];
  }
  function probeLine(graph) {
    const sample = sampleAtProbe();
    if (!sample) return;
    const time = sample.theta / P.TAU * 1000 / config.frequency;
    path(graph, [[time, graph.yRange[0]], [time, graph.yRange[1]]], graph.colors.text, true);
  }
  function seriesColors() {
    return document.documentElement.dataset.theme === 'dark' ? ['#92bba0', '#e4ad84', '#96b3dc'] : ['#47775f', '#b36b3c', '#577bab'];
  }
  function stackedOutput(maxTime, colors, labels, ticks, values, samples, time) {
    const canvas = $('waveform'), bounds = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const width = Math.max(240, bounds.width), height = Math.max(300, bounds.height);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const theme = palette(), left = 48, right = width - 16, top = 26, bottom = height - 32, gap = 20;
    const rowHeight = (bottom - top - 2 * gap) / 3;
    const range = config.output === 'line' ? [-2.2, 2.2] : [-1.15, 1.15];
    const x = value => left + value / maxTime * (right - left), panels = [];
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, width, height);
    const probeTime = time(sampleAtProbe());
    for (let channel = 0; channel < 3; channel++) {
      const rowTop = top + channel * (rowHeight + gap), rowBottom = rowTop + rowHeight;
      const y = value => rowBottom - (value - range[0]) / (range[1] - range[0]) * rowHeight;
      ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(x(maxTime * i / 4), rowTop); ctx.lineTo(x(maxTime * i / 4), rowBottom); ctx.stroke();
      }
      for (const value of ticks) {
        ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
        ctx.fillStyle = theme.muted; ctx.textAlign = 'right'; ctx.fillText(String(value), left - 7, y(value) + 4);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(left, rowTop, right - left, rowHeight); ctx.clip();
      path({ ctx, x, y }, samples.map(point => [time(point), P.outputValues(point, config.output)[channel]]), colors[channel], false, true);
      ctx.restore();
      ctx.fillStyle = colors[channel]; ctx.textAlign = 'left'; ctx.font = '12px sans-serif';
      ctx.fillText(`${labels[channel]} / (Vdc/2)`, left, rowTop - 7);
      ctx.beginPath(); ctx.arc(x(probeTime), y(values[channel]), 3.5, 0, P.TAU); ctx.fill();
      panels.push({ label: labels[channel], top: rowTop, bottom: rowBottom, yRange: range, yTicks: ticks });
    }
    ctx.strokeStyle = theme.text; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(probeTime), top); ctx.lineTo(x(probeTime), bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '11px sans-serif'; ctx.fillStyle = theme.muted; ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) ctx.fillText(fixed(maxTime * i / 4, 2), x(maxTime * i / 4), height - 12);
    ctx.textAlign = 'right'; ctx.fillText('t / ms', right, 13);
    graphs.set('waveform', { ctx, x, width, height, left, right, xRange: [0, maxTime] });
    canvas.dataset.series = JSON.stringify(labels); canvas.dataset.values = JSON.stringify(values);
    canvas.dataset.panels = JSON.stringify(panels); canvas.dataset.probeAngle = String(probeAngle);
    canvas.dataset.cycles = String(config.cycles); canvas.dataset.yTicks = JSON.stringify(ticks);
    canvas.setAttribute('aria-label', `${labels.join('、')}位于同图上下三个通道，共${config.cycles}个周期，共享时间轴和探针。`);
  }
  function waveform() {
    const maxTime = 1000 / config.frequency * config.cycles;
    const samples = result.samples, time = sample => sample.theta / P.TAU * 1000 / config.frequency;
    const colors = seriesColors(), labels = outputLabels(), sample = sampleAtProbe();
    const values = P.outputValues(sample, config.output);
    const ticks = config.output === 'line' ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
    stackedOutput(maxTime, colors, labels, ticks, values, samples, time);
    $('waveform-plots').dataset.series = JSON.stringify(labels);
    $('waveform-plots').dataset.values = JSON.stringify(values);
    $('waveform-plots').dataset.reference = config.output === 'phase' ? 'dc-midpoint' : 'line-to-line';
    $('waveform-legend').innerHTML = labels.map((label, phase) => `<span style="color:${colors[phase]}">━ ${label}</span>`).join('');
    $('voltage-note').textContent = config.levels === 3 ? '三电平桥臂对直流中点 O：0、±1；相间线电压：0、±1、±2。归一化基准为 Vdc/2。' : '两电平桥臂对直流中点 O：±1；相间线电压：0、±2。归一化基准为 Vdc/2。';
    const modulator = setup('modulator', [0, maxTime], [-1.4, 1.4]);
    path(modulator, samples.map(sample => [time(sample), config.levels === 2 ? 2 * sample.carrier - 1 : sample.carrier]), modulator.colors.muted);
    if (config.levels === 3) path(modulator, samples.map(sample => [time(sample), sample.carrier - 1]), modulator.colors.muted);
    for (let phase = 0; phase < 3; phase++) {
      path(modulator, samples.filter((_, index) => index % 4 === 0).map(sample => [time(sample), sample.injected[phase]]), colors[phase]);
    }
    probeLine(modulator);
    $('modulator').dataset.probeAngle = String(probeAngle);
    $('modulator-legend').textContent = `灰：三角载波；绿 / 橙 / 蓝：A / B / C 比较参考（${config.method}）。`;
    $('modulator').dataset.method = config.method;
  }
  function space() {
    const sample = sampleAtProbe(), all = P.spaceStates(config.levels);
    const reference = sample ? { ...P.referencePair(sample.theta, config.m), ...Object.fromEntries(P.METHODS.slice(2).map(method => [method.toLowerCase(), P.references(sample.theta, config.m, method).injected])) } : null;
    spatialView.update(all.states, sample, reference);
    if (sample) {
      const projection = window.SpatialProjection.projectState(sample.abc);
      $('projection-info').textContent = `${all.states.length} 个三维状态 → ${all.positions.length} 个平面位置；当前 ABC=[${sample.abc.join(', ')}]；实际开关零序 z_sw=${fixed(projection.zero, 3)}，P₀=[${projection.plane.map(value => fixed(value, 3)).join(', ')}]，α=${fixed(sample.alpha, 3)}，β=${fixed(sample.beta, 3)}。`;
      $('reference-info').textContent = `${config.method} 当前比较参考=[${sample.injected.map(value => fixed(value, 3)).join(', ')}]。三维各色曲线和调制波使用同一未限幅解析参考，不作载波周期采样保持。`;
    }
  }
  function probe() {
    const sample = sampleAtProbe();
    if (!sample) return;
    const time = sample.theta / P.TAU * 1000 / config.frequency;
    $('probe-angle').textContent = `${fixed(sample.theta * 180 / Math.PI, 1)}° / ${fixed(time, 3)} ms`;
    const labels = outputLabels();
    $('instant').textContent = `ABC=[${sample.abc.join(', ')}]；${labels.map((label, index) => `${label}=${fixed(P.outputValues(sample, config.output)[index], 3)}`).join('，')}；共同零序 z=${fixed(sample.zero, 3)}。`;
  }
  function draw() {
    if (!result?.samples.length) { spatialView.draw(); return; }
    waveform(); space(); probe();
  }
  function clear(message) {
    result = null; stop(); graphs.clear();
    $('status').textContent = message; $('instant').textContent = ''; $('probe-angle').textContent = '无有效结果';
    $('modulator-legend').textContent = '没有生成有效波形。'; $('waveform-legend').textContent = '';
    spatialView.setTrajectories(null);
    spatialView.update(P.spaceStates(config?.levels === 2 ? 2 : 3).states, null);
    $('reference-info').textContent = '';
    $('projection-info').textContent = '开关状态与投影平面仍可查看；当前没有有效PWM结果，因此不显示瞬时矢量。';
    $('waveform-plots').removeAttribute('data-series'); $('waveform-plots').removeAttribute('data-values'); $('waveform-plots').removeAttribute('data-reference');
    for (const id of graphCanvases) {
      const graph = setup(id, [0, 1], [-1, 1]); graph.ctx.fillStyle = graph.colors.muted; graph.ctx.textAlign = 'left'; graph.ctx.fillText('无有效结果，请调整参数', 50, 35);
      for (const key of ['series', 'probeAngle', 'values', 'cycles', 'yTicks', 'panels']) delete $(id).dataset[key];
    }
  }
  function compute(event) {
    if (event) event.preventDefault();
    if ($('method').value === 'DPWM5' && $('levels').value !== '2') {
      if (event?.target?.id === 'levels') $('method').value = 'SVPWM';
      else $('levels').value = '2';
    }
    $('method-note').textContent = $('method').value === 'DPWM5'
      ? '五段式使用两电平与自然采样钳位参考；换钳位处有固有跳变，不保证每周期严格五段。'
      : $('method').value.startsWith('DPWM') ? '钳位参考连续更新；三电平沿用 PD 载波，不保证严格五段序列。'
      : '连续参考载波比较；SVPWM 为居中零序注入等效实现，不含中点平衡。';
    if (!form.reportValidity()) { clear('输入非法：请按参数范围修正。'); return; }
    try {
      config = { levels: Number($('levels').value), method: $('method').value, m: Number($('modulation').value), ratio: Number($('ratio').value), samples: 8192, frequency: Number($('frequency').value), output: $('output').value, cycles: Number($('zoom').value) };
      if (!['phase', 'line'].includes(config.output)) throw new RangeError('仅支持相电压与线电压');
      result = P.generate(config);
      if (event?.target?.id === 'method') {
        const key = config.method.toLowerCase(), checkbox = $(`show-${key}-reference`);
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
      }
      spatialView.setTrajectories(P.referenceTrajectories(config.m));
      probeAngle = Math.max(0, Math.min(probeAngle, config.cycles * 360 - 1e-6));
      $('status').textContent = `${config.levels} 电平 / ${config.method}；观察 ${config.cycles} 个周期。${result.clippedSamples ? ` ${result.clippedSamples} 个采样点的比较参考超出±1，输出已削顶。` : ' 比较参考处于线性范围。'}`;
      draw();
    } catch (error) { clear('输入 / 计算错误：' + error.message); }
  }
  let frameId = null;
  function stop() {
    running = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    $('animate').textContent = '运行'; $('animate').setAttribute('aria-pressed', 'false');
  }
  function schedule() {
    if (running && !pausedGraphs.size && frameId === null) frameId = requestAnimationFrame(tick);
  }
  function pauseGraph(id) {
    pausedGraphs.add(id);
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null; lastFrame = null;
  }
  function leaveGraph(id) {
    pausedGraphs.delete(id);
    lastFrame = null;
    schedule();
  }
  function tick(time) {
    frameId = null;
    if (!running || pausedGraphs.size) return;
    const elapsed = lastFrame === null ? 0 : Math.max(0, time - lastFrame); lastFrame = time;
    probeAngle = (probeAngle + elapsed * .36 * config.frequency / 50) % (config.cycles * 360);
    draw(); schedule();
  }
  function graphProbe(id, event) {
    if (!result?.samples.length || (event.buttons && event.buttons !== 1)) return;
    const graph = graphs.get(id), bounds = $(id).getBoundingClientRect();
    if (!graph || !bounds.width) return;
    const x = (event.clientX - bounds.left) * graph.width / bounds.width;
    const fraction = Math.max(0, Math.min(1, (x - graph.left) / (graph.right - graph.left)));
    pauseGraph(id); probeAngle = Math.min(config.cycles * 360 - 1e-6, fraction * config.cycles * 360); draw();
  }
  for (const id of graphCanvases) {
    $(id).addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') pauseGraph(id); });
    $(id).addEventListener('pointerleave', () => leaveGraph(id));
    $(id).addEventListener('pointercancel', () => leaveGraph(id));
    $(id).addEventListener('lostpointercapture', event => { if (event.pointerType === 'touch' || !$(id).matches(':hover')) leaveGraph(id); });
    $(id).addEventListener('pointerup', event => { if (event.pointerType === 'touch') leaveGraph(id); });
    $(id).addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      $(id).setPointerCapture(event.pointerId); graphProbe(id, event);
    });
    $(id).addEventListener('pointermove', event => graphProbe(id, event));
    $(id).addEventListener('keydown', event => {
      if (!result || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); stop();
      const maximum = config.cycles * 360 - 1e-6;
      probeAngle = event.key === 'Home' ? 0 : event.key === 'End' ? maximum : Math.max(0, Math.min(maximum, probeAngle + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1)));
      draw();
    });
  }
  for (const [id, property] of [
    ['show-spwm-reference', 'showSPWM'], ['show-svpwm-reference', 'showSVPWM'],
    ['show-thipwm-reference', 'showTHIPWM'], ['show-dpwm5-reference', 'showDPWM5'],
    ['show-dpwmmax-reference', 'showDPWMMAX'], ['show-dpwmmin-reference', 'showDPWMMIN'],
    ['show-cube', 'showCube'], ['show-abc', 'showABC'],
    ['show-alphabeta-zero', 'showAlphaBetaZero']
  ]) {
    $(id).addEventListener('change', event => { spatialView[property] = event.target.checked; spatialView.draw(); });
  }
  $('space-projection').addEventListener('change', event => spatialView.setProjection(event.target.value));
  $('space-reset').addEventListener('click', () => spatialView.reset());
  $('space-rotate').addEventListener('click', () => {
    if (spatialView.rotating) spatialView.stopRotation();
    else spatialView.startRotation();
  });
  $('space-3d').addEventListener('rotationchange', () => {
    $('space-rotate').textContent = spatialView.rotating ? '停止旋转' : '沿 C 轴旋转';
    $('space-rotate').setAttribute('aria-pressed', String(spatialView.rotating));
  });
  $('space-view').addEventListener('change', event => spatialView.setView(event.target.value));
  $('space-3d').addEventListener('viewchange', () => { $('space-view').value = spatialView.viewPreset; });
  form.addEventListener('submit', compute);
  for (const id of ['levels', 'method', 'modulation', 'ratio', 'frequency', 'output', 'zoom']) $(id).addEventListener('change', compute);
  $('animate').addEventListener('click', () => {
    if (running) { stop(); return; }
    if (!result?.samples.length) return;
    running = true; lastFrame = null; $('animate').textContent = '停止'; $('animate').setAttribute('aria-pressed', 'true'); schedule();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe($('waveform'));
  else window.addEventListener('resize', draw);
  compute();
})();
