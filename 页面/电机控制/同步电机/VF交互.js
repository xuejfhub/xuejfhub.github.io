(() => {
  'use strict';
  const VF = window.VoltageMotor, Rotor = window.SynchronousMotor, byId = id => document.getElementById(id), plot = byId('dq-plot');
  const specifications = [['resistance', '电阻 Rs', .5, .005], ['ld', 'D轴电感 Ld', 2, .01], ['lq', 'Q轴电感 Lq', 2, .01], ['flux', '磁链 ψf', 2, .01]];
  const valueKeys = [...specifications.map(([key]) => key), 'vfRatio', 'voltageBoost', 'voltageLimit', 'currentLimit', 'angleDeg', 'speedPU'];
  let view = null, preview = null, rendering = false, pending = false, timer = null, settleTimer = null, registered = false, scene = null, renderCount = 0;
  const format = value => value === null || value === undefined ? '未定义' : Math.abs(value) > 1e5 ? value.toExponential(2) : value.toFixed(3);

  for (const [key, label, maximum, step] of specifications) {
    const field = document.createElement('div'); field.className = 'parameter-control';
    field.innerHTML = `<label for="${key}"><span>${label}</span><span class="unit">pu</span></label><div class="slider-pair"><input type="range" id="${key}-slider" min="0" max="${maximum}" step="${step}" aria-label="${label}滑块"><input type="number" id="${key}" min="0" step="any"></div>`;
    byId('motor-parameters').append(field);
    byId(key + '-slider').addEventListener('input', event => { byId(key).value = event.target.value; previewInput(); });
    byId(key + '-slider').addEventListener('change', settle);
    byId(key).addEventListener('input', () => { byId(key + '-slider').value = byId(key).value; schedule(); });
  }
  function loadDefaults() {
    for (const key of valueKeys) byId(key).value = VF.DEFAULTS[key];
    for (const [key] of specifications) byId(key + '-slider').value = VF.DEFAULTS[key];
    byId('speed-slider').value = VF.DEFAULTS.speedPU; byId('angle-slider').value = VF.DEFAULTS.angleDeg;
    byId('torque-values').value = Rotor.DEFAULT_TORQUES.join(',');
  }
  function fitView(bounds) {
    const width = Math.max(1, plot.clientWidth - (plot.clientWidth < 450 ? 49 : 75));
    const height = Math.max(1, plot.clientHeight - 65);
    if (!bounds) {
      const model = VF.createModel(Object.fromEntries(valueKeys.map(key => [key, byId(key).valueAsNumber])));
      const radius = Math.max(1, model.input.currentLimit), points = [{ direct: -radius, quadrature: -radius }, { direct: radius, quadrature: radius }];
      const operating = VF.atAngle(model);
      if (operating) points.push(operating);
      for (const kind of ['mtpa', 'mtpv']) if (byId('show-' + kind).checked) {
        const amplitudes = kind === 'mtpa' ? [model.input.currentLimit] : [...new Set([model.outputVoltage, model.input.voltageLimit])];
        for (const amplitude of amplitudes) for (const direction of [1, -1]) {
          const state = Rotor[kind](model, amplitude, direction);
          if (state && state.voltage > 1e-12) {
            const point = { direct: state.active / state.voltage, quadrature: -state.reactive / state.voltage };
            if (Object.values(point).every(Number.isFinite)) points.push(point);
          }
        }
      }
      const minimumD = Math.min(...points.map(point => point.direct)), maximumD = Math.max(...points.map(point => point.direct));
      const minimumQ = Math.min(...points.map(point => point.quadrature)), maximumQ = Math.max(...points.map(point => point.quadrature));
      const centerD = (minimumD + maximumD) / 2, centerQ = (minimumQ + maximumQ) / 2;
      const halfD = Math.max(maximumD - minimumD, (maximumQ - minimumQ) * width / height) * .56, halfQ = halfD * height / width;
      if (![centerD, centerQ, halfD, halfQ].every(Number.isFinite)) throw new RangeError('view-range');
      return { x: [centerD - halfD, centerD + halfD], y: [centerQ - halfQ, centerQ + halfQ] };
    }
    const half = (bounds.x[1] - bounds.x[0]) * height / width / 2;
    const middle = (bounds.y[0] + bounds.y[1]) / 2;
    return { x: [...bounds.x], y: [middle - half, middle + half] };
  }
  function schedule() { if (timer === null) timer = setTimeout(() => { timer = null; render(); }, 16); }
  function settle() { clearTimeout(settleTimer); if (preview?.active) { preview.settle(); schedule(); } }
  function cancel() { if (preview?.active && plot._dragging) document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); settle(); }
  function readScene() {
    const model = VF.createModel(Object.fromEntries(valueKeys.map(key => [key, byId(key).valueAsNumber])));
    const levels = Rotor.parseTorqueLevels(byId('torque-values').value), point = VF.atAngle(model);
    let heat = byId('heat-quantity').value;
    if (heat === 'none' || model.reason || (heat === 'torque' && model.input.speedPU === 0)) heat = null;
    const maximum = byId('color-scale').value === 'auto' ? (scene?.maximum || 1) : byId('color-limit').valueAsNumber;
    if (heat && (!Number.isFinite(maximum) || maximum <= 0 || (byId('color-scale').value === 'fixed' && maximum < .1))) throw new RangeError('color-limit');
    const visible = Object.fromEntries(['voltage', 'current', 'torque', 'pf', 'mtpa', 'mtpv'].map(key => [key, byId('show-' + key).checked]));
    const style = getComputedStyle(document.body), colors = Object.fromEntries(['mtpa', 'mtpv', 'torque', 'pf', 'boundary', 'text', 'muted', 'surface', 'line'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
    const result = { model, levels, visible, heat, maximum, colors, frame: 'voltage', point, probe: { direct: point?.direct || 0, quadrature: point?.quadrature || 0, visible: Boolean(point && byId('show-point').checked) } };
    result.geometryKey = [Object.entries(model.input).filter(([key]) => key !== 'angleDeg'), visible, levels];
    result.geometry = bounds => VF.geometry(result, bounds); result.grid = (bounds, count) => VF.grid(model, bounds, count);
    byId('speed-value').textContent = model.input.speedPU.toFixed(2);
    byId('color-limit').disabled = byId('color-scale').value === 'auto' || !heat;
    const notes = [model.reason === 'zero-voltage' ? '输出电压为0，电压定向无定义。' : model.reason === 'singular' ? '电压方程奇异，不能求得唯一稳态电流。' : model.input.speedPU === 0 ? '零速不由功率反推转矩；工作点转矩由转子方程计算。' : '',
      model.pu.flux === 0 && model.pu.ld === model.pu.lq ? '无磁链且Ld=Lq：转矩恒为0，MTPA/MTPV无唯一解。' : ''].filter(Boolean).join(' ');
    byId('model-note').textContent = notes; byId('model-note').hidden = !notes;
    byId('operating-summary').textContent = `Ud ${format(model.outputVoltage)} · Uq 0 · T ${format(point?.torque)} · PF ${format(point?.pf)}`;
    byId('probe-readout').dataset.point = JSON.stringify(point);
    byId('probe-readout').innerHTML = [['direct', 'Id,u'], ['quadrature', 'Iq,u'], ['rotorDirect', '转子 id'], ['rotorQuadrature', '转子 iq'], ['torque', '转矩 T'], ['active', '有功 P'], ['reactive', '无功 Q'], ['apparent', '视在 S']].map(([key, name]) => `<dl class="readout"><dt>${name}</dt><dd>${format(point?.[key])}</dd></dl>`).join('');
    byId('operating-state').textContent = point ? `δ=${format(model.input.angleDeg)}° · |I|=${format(point.current)} pu · ${point.feasible ? '电流未超界' : '超出电流边界'} · 同步稳态，不代表动态稳定。` : notes;
    plot.dataset.stale = 'false'; byId('input-error').hidden = true;
    return result;
  }
  function showError(error) { plot.dataset.stale = 'true'; byId('input-error').hidden = false; byId('input-error').textContent = '输入无效或数值超出范围：' + error.message; preview?.hide(); }
  function previewInput() {
    if (!preview || rendering) { schedule(); return; }
    try {
      const previousMaximum = scene.maximum; scene = readScene();
      if (byId('color-scale').value === 'auto') scene.maximum = previousMaximum;
      preview.setScene(scene); preview.request(view); clearTimeout(settleTimer); settleTimer = setTimeout(settle, 120);
    } catch (error) { showError(error); }
  }
  function trace(line, colors, extent) {
    const direct = [], quadrature = [];
    for (const branch of line.branches) {
      let previous = null;
      for (const point of branch) {
        if (!point || !Number.isFinite(point.direct) || !Number.isFinite(point.quadrature)) { direct.push(null); quadrature.push(null); previous = null; continue; }
        if (previous && branch.length > 2 && Math.hypot(point.direct - previous.direct, point.quadrature - previous.quadrature) > extent * .35) { direct.push(null); quadrature.push(null); }
        direct.push(point.direct); quadrature.push(point.quadrature); previous = point;
      }
      direct.push(null); quadrature.push(null);
    }
    return { type: 'scatter', mode: line.dots ? 'markers' : 'lines', name: line.name, x: direct, y: quadrature, meta: { kind: line.kind }, line: { color: colors[line.kind], width: line.width, dash: line.dash.length ? 'dash' : 'solid' }, opacity: line.opacity, marker: { size: 7, color: colors[line.kind] }, connectgaps: false, hoverinfo: 'skip' };
  }
  async function render() {
    if (rendering || preview?.active) { pending = true; return; }
    rendering = true; pending = false;
    try {
      if (!view) view = fitView();
      const next = readScene(), geometry = VF.geometry(next, view), data = [];
      if (next.heat) {
        const grid = VF.grid(next.model, view), positive = next.heat === 'apparent';
        if (!grid.fields[next.heat].flat().every(Number.isFinite)) throw new RangeError('numeric-range');
        if (byId('color-scale').value === 'auto') next.maximum = Math.max(1e-6, ...grid.fields[next.heat].flat().map(Math.abs));
        const stops = positive ? [[0, '#f5f8f4'], [.35, '#8fccc3'], [.7, '#36a9ac'], [1, '#146c94']] : [[0, '#3979ac'], [.25, '#a2c9dd'], [.5, '#f5f7ef'], [.75, '#efc59f'], [1, '#cb5a4f']];
        data.push({ type: 'heatmap', x: grid.x, y: grid.y, z: grid.fields[next.heat], meta: { kind: 'heat', quantity: next.heat }, colorscale: stops, zmin: positive ? 0 : -next.maximum, zmax: next.maximum, showscale: false, opacity: .72, hoverinfo: 'skip' });
      }
      data.push(...geometry.lines.map(line => trace(line, next.colors, geometry.extent)));
      data.push({ type: 'scatter', mode: 'markers', x: [next.probe.direct], y: [next.probe.quadrature], visible: next.probe.visible, meta: { kind: 'probe' }, marker: { size: 11, color: next.colors.text, line: { color: next.colors.surface, width: 2 } }, hoverinfo: 'skip' });
      const narrow = plot.clientWidth < 450, axis = { gridcolor: next.colors.line, zerolinecolor: next.colors.muted, nticks: 8, constrain: 'range' };
      await Plotly.react(plot, data, { width: plot.clientWidth, height: plot.clientHeight, margin: { l: narrow ? 38 : 55, r: narrow ? 11 : 20, t: 28, b: 37 }, paper_bgcolor: next.colors.surface, plot_bgcolor: next.colors.surface, font: { color: next.colors.text, size: 11 }, showlegend: false, hovermode: false, dragmode: 'pan', uirevision: 'vf-plane', xaxis: { ...axis, range: view.x, title: 'i<sub>d,u</sub> / pu' }, yaxis: { ...axis, range: view.y, title: 'i<sub>q,u</sub> / pu', scaleanchor: 'x', scaleratio: 1 } }, { displaylogo: false, scrollZoom: true, doubleClick: false, responsive: false, modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'resetScale2d', 'toImage'] });
      scene = next;
      if (!preview) preview = MotorPreview.create(plot);
      preview.setScene(scene);
      if (!preview.active) { view = { x: [...plot._fullLayout.xaxis.range], y: [...plot._fullLayout.yaxis.range] }; preview.hide(); }
      plot.dataset.renderCount = String(++renderCount); plot.dataset.model = JSON.stringify(next.model); plot.dataset.view = JSON.stringify(view);
      if (!registered) {
        const eventView = event => {
          const range = axisName => event[axisName + '.range'] || [event[axisName + '.range[0]'] ?? plot._fullLayout[axisName].range[0], event[axisName + '.range[1]'] ?? plot._fullLayout[axisName].range[1]];
          const bounds = { x: range('xaxis'), y: range('yaxis') };
          return [...bounds.x, ...bounds.y].every(Number.isFinite) && bounds.x[1] - bounds.x[0] > 1e-5 && bounds.y[1] - bounds.y[0] > 1e-5 ? bounds : null;
        };
        plot.on('plotly_relayouting', event => { if (!Object.keys(event).some(key => /^[xy]axis\.range/.test(key))) return; const bounds = eventView(event); if (bounds) { clearTimeout(settleTimer); view = bounds; preview.request(view); } });
        plot.on('plotly_relayout', event => { if ((rendering && !preview.active) || !Object.keys(event).some(key => /^[xy]axis\.(range|autorange)/.test(key))) return; const bounds = eventView(event); if (bounds) { view = bounds; settle(); schedule(); } });
        registered = true;
      }
    } catch (error) { showError(error); }
    finally { rendering = false; if (pending && !preview?.active) schedule(); }
  }
  for (const key of ['vfRatio', 'voltageBoost', 'voltageLimit', 'currentLimit', 'torque-values', 'color-limit']) byId(key).addEventListener('input', schedule);
  for (const [slider, input] of [['speed-slider', 'speedPU'], ['angle-slider', 'angleDeg']]) {
    byId(slider).addEventListener('input', event => { byId(input).value = event.target.value; previewInput(); });
    byId(slider).addEventListener('change', settle);
    byId(input).addEventListener('input', event => { byId(slider).value = event.target.value; schedule(); });
  }
  document.querySelectorAll('input[type=checkbox],select').forEach(input => input.addEventListener('change', schedule));
  byId('reset').addEventListener('click', () => { loadDefaults(); schedule(); });
  byId('reset-view').addEventListener('click', () => { try { view = fitView(); schedule(); } catch (error) { showError(error); } });
  document.addEventListener('pointerup', () => setTimeout(settle, 0), true);
  document.addEventListener('touchend', () => setTimeout(settle, 0), true);
  document.addEventListener('pointercancel', cancel, true); document.addEventListener('touchcancel', cancel, true); window.addEventListener('blur', cancel);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let previousSize = '';
  new ResizeObserver(() => { const size = plot.clientWidth + ':' + plot.clientHeight; if (size !== previousSize) { previousSize = size; view = fitView(view || undefined); schedule(); } }).observe(document.querySelector('.plot-stage'));
  document.querySelectorAll('.analysis-footer details').forEach(panel => panel.addEventListener('toggle', () => { if (panel.open) document.querySelectorAll('.analysis-footer details').forEach(other => { if (other !== panel) other.open = false; }); }));
  loadDefaults(); render();
})();