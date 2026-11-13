(() => {
  'use strict';
  const Motor = window.SynchronousMotor;
  const byId = id => document.getElementById(id);
  const plot = byId('dq-plot');
  const specifications = [
    ['resistance', '电阻 Rs', .5, .005], ['ld', 'D 轴电感 Ld', 2, .01],
    ['lq', 'Q 轴电感 Lq', 2, .01], ['flux', '磁链 ψf', 2, .01]
  ];
  const boundaryInputs = [['currentLimit', 'current-preset', '电流边界'], ['voltageLimit', 'voltage-preset', '电压边界']];
  const quantity = { torque: '电磁转矩', mechanical: '机械功率', active: '有功功率', reactive: '无功功率', apparent: '视在功率' };
  const format = (value, digits = 3) => value === null || !Number.isFinite(value) ? '未定义' : (Math.abs(value) >= 1e5 || (Math.abs(value) > 0 && Math.abs(value) < .0001)) ? value.toExponential(3) : value.toFixed(digits);
  let model = Motor.createModel(), timer = null, rendering = false, rerender = false, renderCount = 0, registered = false;
  let preview = null, lastScene = null, parameterPreviewTimer = null;
  const geometryCache = new Map(), cacheStats = { hits: 0, misses: 0 };
  let probe = { direct: -.5, quadrature: .7 };
  let probeIndex = 0, view = null;
  let torqueLevels = [...Motor.DEFAULT_TORQUES], voltageLevels = [...Motor.DEFAULT_VOLTAGES], probeVisible = false, pointerPress = null;

  for (const [key, label, maximum, step] of specifications) {
    const field = document.createElement('div');
    field.className = 'parameter-control';
    field.innerHTML = `<label for="${key}"><span>${label}</span><span class="unit">pu</span></label><div class="slider-pair"><input type="range" id="${key}-slider" min="0" max="${maximum}" step="${step}" aria-label="${label}滑块"><input type="number" id="${key}" min="0" step="any"></div>`;
    byId('motor-parameters').append(field);
    byId(key).addEventListener('input', () => { syncSlider(key); schedule(); });
    byId(key + '-slider').addEventListener('input', event => { byId(key).value = event.target.value; previewParameterChange(); });
    byId(key + '-slider').addEventListener('change', finishPan);
  }

  function syncSlider(key) {
    const value = byId(key).valueAsNumber, slider = byId(key + '-slider');
    if (!Number.isFinite(value)) return;
    if (value >= 0) {
      slider.value = value;
      slider.title = value > Number(slider.max) ? `文本框值 ${value} pu 超出滑块范围；计算仍使用文本框值。` : '';
    }
  }

  function load(values) {
    for (const [key, , maximum] of specifications) {
      byId(key).value = values[key];
      byId(key + '-slider').max = maximum;
      syncSlider(key);
    }
    byId('speedPU').value = values.speedPU; byId('speed-slider').value = values.speedPU;
    for (const [key, preset] of boundaryInputs) { byId(key).value = values[key]; byId(preset).value = ''; }
    byId('torque-values').value = Motor.DEFAULT_TORQUES.join(','); byId('torque-preset').value = '';
    byId('voltage-values').value = Motor.DEFAULT_VOLTAGES.join(',');
  }

  function readModel() {
    const values = Object.fromEntries(specifications.map(([key]) => [key, byId(key).valueAsNumber]));
    values.speedPU = byId('speedPU').valueAsNumber;
    for (const [key] of boundaryInputs) values[key] = byId(key).valueAsNumber;
    return Motor.createModel(values);
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; render(); }, 16);
  }
  function updateValues() {
    byId('speed-value').textContent = (model.input.speedPU > 0 ? '+' : '') + format(model.input.speedPU, 2);
  }

  function fitView(bounds = { x: [-3, 2], y: [-2, 2] }) {
    const width = Math.max(120, plot.clientWidth - (plot.clientWidth < 450 ? 49 : 75));
    const height = Math.max(120, plot.clientHeight - 65);
    const middle = (bounds.y[0] + bounds.y[1]) / 2;
    const half = (bounds.x[1] - bounds.x[0]) * height / width / 2;
    return { x: [...bounds.x], y: [middle - half, middle + half] };
  }

  function coordinates(branches, extent) {
    const direct = [], quadrature = [];
    for (const branch of branches) {
      let previous = null;
      for (const point of branch) {
        const valid = point && Number.isFinite(point.direct) && Number.isFinite(point.quadrature) && Math.abs(point.direct) <= extent * 1.002 && Math.abs(point.quadrature) <= extent * 1.002;
        if (!valid) { direct.push(null); quadrature.push(null); previous = null; continue; }
        if (previous && branch.length > 2 && Math.hypot(point.direct - previous.direct, point.quadrature - previous.quadrature) > extent * .35) { direct.push(null); quadrature.push(null); }
        direct.push(point.direct); quadrature.push(point.quadrature); previous = point;
      }
      direct.push(null); quadrature.push(null);
    }
    return { x: direct, y: quadrature };
  }

  function visibleLayers() {
    return Object.fromEntries(['mtpa', 'mtpv', 'torque', 'pf', 'current', 'voltage'].map(kind => [kind, byId('show-' + kind).checked]));
  }

  function cachedGeometry(name, parts, build) {
    const key = JSON.stringify(parts), previous = geometryCache.get(name);
    if (previous?.key === key) { cacheStats.hits++; return previous.value; }
    const value = build(); geometryCache.set(name, { key, value }); cacheStats.misses++; return value;
  }

  function getGeometry(extent) {
    const visible = visibleLayers(), { ld, lq, flux } = model.pu;
    const physical = [model.pu, model.input.speedPU], torqueModel = [ld, lq, flux];
    const samples = Math.min(1200, Math.max(200, Math.ceil(200 * extent / Math.max(view.x[1] - view.x[0], view.y[1] - view.y[0]))));
    for (const direct of view.x) for (const quadrature of view.y) {
      const point = Motor.evaluate(model, direct, quadrature);
      if (!['torque', 'active', 'reactive', 'apparent'].every(key => Number.isFinite(point[key]))) throw new RangeError('输入过大，计算超出浏览器数值范围；请减小输入。');
    }
    return {
      grid: byId('show-heat').checked ? cachedGeometry('grid', [physical, view], () => {
        const { x, y, fields } = Motor.grid(model, extent, 161, view);
        return { x, y, fields };
      }) : null,
      torques: visible.torque ? cachedGeometry('torques', [torqueModel, view, torqueLevels], () =>
        torqueLevels.map(level => ({ level, points: coordinates(Motor.torqueCurves(model, level, extent, 800, view), extent) }))) : [],
      factors: visible.pf ? cachedGeometry('pf', [physical, view], () =>
        [-1, -.9, -.7, -.5, .5, .7, .9, .95, 1].map(level => ({ level, points: coordinates(Motor.powerFactorCurves(model, level, extent, 1000, view), extent) }))) : [],
      mtpa: visible.mtpa ? cachedGeometry('mtpa', [torqueModel, extent, samples], () => coordinates(Motor.locus(model, 'mtpa', extent, samples), extent)) : null,
      mtpv: visible.mtpv ? cachedGeometry('mtpv', [physical, extent, samples], () => coordinates(Motor.locus(model, 'mtpv', extent, samples), extent)) : null
    };
  }

  function lineTrace(points, name, kind, color, width = 2, dash = 'solid', opacity = 1) {
    return { type: 'scatter', mode: 'lines', ...points, name, meta: { kind }, line: { color, width, dash }, opacity,
      connectgaps: false, hovertemplate: `${name}<br>id %{x:.3f} pu<br>iq %{y:.3f} pu<extra></extra>` };
  }

  function traces(extent, colors) {
    const data = [], computed = getGeometry(extent);
    const heat = byId('heat-quantity').value;
    const showHeat = byId('show-heat').checked;
    const fixed = byId('color-scale').value === 'fixed';
    byId('color-limit').disabled = !fixed || !showHeat;
    byId('color-legend').hidden = !showHeat;
    if (showHeat) {
      const values = computed.grid.fields[heat];
      let maximum = Number(byId('color-limit').value);
      if (!fixed) maximum = Math.max(1e-6, ...values.flat().filter(value => value !== null).map(Math.abs));
      const positive = heat === 'apparent';
      data.push({ type: 'heatmap', name: quantity[heat], meta: { kind: 'heat', quantity: heat }, x: computed.grid.x, y: computed.grid.y, z: values,
        zmin: positive ? 0 : -maximum, zmax: maximum, zsmooth: false, hoverongaps: false, opacity: .72,
        colorscale: positive ? [[0, '#f5f8f4'], [.35, '#8fccc3'], [.7, '#36a9ac'], [1, '#146c94']] : [[0, '#3979ac'], [.25, '#a2c9dd'], [.5, '#f5f7ef'], [.75, '#efc59f'], [1, '#cb5a4f']],
        showscale: false, hovertemplate: `id %{x:.3f} pu<br>iq %{y:.3f} pu<br>${quantity[heat]} %{z:.3f} pu<extra></extra>` });
      byId('color-min').textContent = positive ? '0' : format(-maximum, 2);
      byId('color-max').textContent = format(maximum, 2) + ' pu';
      byId('color-ramp').style.background = positive ? 'linear-gradient(90deg,#f5f8f4,#8fccc3,#36a9ac,#146c94)' : '';
    }
    if (byId('show-torque').checked) for (const curve of computed.torques) data.push(lineTrace(curve.points, `T = ${curve.level} pu`, 'torque', colors.torque, curve.level === 1 ? 2.5 : curve.level < 0 ? .85 : 1.3, curve.level === 1 ? 'solid' : 'dash', curve.level === 1 ? 1 : curve.level < 0 ? .3 : .45));
    if (byId('show-pf').checked) for (const curve of computed.factors) data.push(lineTrace(curve.points, `PF = ${curve.level}`, 'pf', colors.pf, curve.level === 1 ? 2.5 : 1.25, curve.level === 1 ? 'solid' : 'dash', curve.level === 1 ? 1 : .44));
    if (byId('show-mtpa').checked) data.push(lineTrace(computed.mtpa, 'MTPA', 'mtpa', colors.mtpa, 2.8));
    if (byId('show-mtpv').checked) data.push(lineTrace(computed.mtpv, 'MTPV · 含 Rs', 'mtpv', colors.mtpv, 2.8));
    const angles = Array.from({ length: 721 }, (_, index) => index * Math.PI / 360);
    if (byId('show-current').checked) {
      const amplitude = model.input.currentLimit;
      const points = angles.map(angle => ({ direct: amplitude * Math.cos(angle), quadrature: amplitude * Math.sin(angle) }));
      const trace = lineTrace(coordinates([points], extent), `|I| = ${amplitude} pu`, 'current', colors.boundary, 1.8, 'dash');
      if (amplitude === 0) Object.assign(trace, { mode: 'markers', marker: { size: 7, color: colors.boundary } });
      data.push(trace);
    }
    if (byId('show-voltage').checked) {
      const amplitude = model.input.voltageLimit;
      for (const level of voltageLevels) {
        if (level === amplitude) continue;
        const reference = lineTrace(coordinates(Motor.voltageCurves(model, level, extent, 720), extent), `参考 |U| = ${level} pu`, 'voltage-level', colors['voltage-level'], .85, 'dot', .35);
        reference.meta.voltage = level;
        if (level === 0) Object.assign(reference, { mode: 'markers', marker: { size: 6, color: colors['voltage-level'] } });
        data.push(reference);
      }
      const trace = lineTrace(coordinates(Motor.voltageCurves(model, amplitude, extent, 1000), extent), `|U| = ${amplitude} pu`, 'voltage', colors.voltage, 1.6, 'solid', .8);
      trace.meta.voltage = amplitude;
      if (amplitude === 0) Object.assign(trace, { mode: 'markers', marker: { size: 7, color: colors.voltage } });
      data.push(trace);
    }
    probeIndex = data.length;
    data.push({ type: 'scatter', mode: 'markers', x: probeVisible ? [probe.direct] : [], y: probeVisible ? [probe.quadrature] : [], visible: probeVisible, name: '工作点', meta: { kind: 'probe' },
      marker: { size: 11, color: colors.text, line: { width: 2, color: colors.surface }, symbol: 'circle' }, hoverinfo: 'skip' });
    return data;
  }

  function updateProbe() {
    const point = Motor.evaluate(model, probe.direct, probe.quadrature);
    byId('probe-d').value = format(probe.direct, 3); byId('probe-q').value = format(probe.quadrature, 3);
    const entries = { torque: '转矩 T', mechanical: '机械功率', active: '有功 P', reactive: '无功 Q', apparent: '视在 S', pf: 'PF' };
    byId('probe-readout').innerHTML = Object.entries(entries).map(([key, label]) => `<dl class="readout"><dt>${label}</dt><dd id="value-${key}">${format(point[key])}</dd></dl>`).join('');
    byId('probe-readout').dataset.point = JSON.stringify(point);
    byId('probe-readout').dataset.visible = String(probeVisible);
    byId('probe-state').textContent = probeVisible ? '已固定' : '标记隐藏';
  }

  function paintProbe() {
    updateProbe();
    preview?.setProbe({ ...probe, visible: probeVisible });
    if (rendering) { rerender = true; return; }
    if (registered && plot.dataset.stale !== 'true') window.Plotly.restyle(plot, {
      x: [probeVisible ? [probe.direct] : []], y: [probeVisible ? [probe.quadrature] : []], visible: [probeVisible]
    }, [probeIndex]);
  }

  function setProbe(direct, quadrature) {
    if (![direct, quadrature].every(Number.isFinite) || plot.dataset.stale === 'true') return;
    probe = { direct, quadrature };
    paintProbe();
  }

  function toggleProbe(point) {
    if (plot.dataset.stale === 'true') return;
    if (probeVisible) { probeVisible = false; paintProbe(); }
    else { probeVisible = true; setProbe(point.direct, point.quadrature); }
  }

  function pointerPoint(event) {
    const layout = plot._fullLayout;
    if (!layout || event.target.closest?.('.modebar')) return null;
    const bounds = plot.getBoundingClientRect();
    const horizontal = event.clientX - bounds.left - plot.clientLeft - layout.xaxis._offset;
    const vertical = event.clientY - bounds.top - plot.clientTop - layout.yaxis._offset;
    if (horizontal < 0 || horizontal > layout.xaxis._length || vertical < 0 || vertical > layout.yaxis._length) return null;
    const direct = layout.xaxis.p2d(horizontal), quadrature = layout.yaxis.p2d(vertical);
    return [direct, quadrature].every(Number.isFinite) ? { direct, quadrature } : null;
  }

  function eventView(event) {
    const range = axis => event[axis + '.range'] || [event[axis + '.range[0]'] ?? plot._fullLayout[axis].range[0], event[axis + '.range[1]'] ?? plot._fullLayout[axis].range[1]];
    const next = { x: range('xaxis'), y: range('yaxis') };
    return [...next.x, ...next.y].every(Number.isFinite) && next.x[1] - next.x[0] > 1e-5 && next.y[1] - next.y[0] > 1e-5 ? next : null;
  }

  function finishPan() {
    clearTimeout(parameterPreviewTimer); parameterPreviewTimer = null;
    if (preview?.active) { preview.settle(); schedule(); }
  }

  function cancelPan() {
    pointerPress = null;
    if (preview?.active && plot._dragging) document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    finishPan();
  }

  function previewParameterChange() {
    if (!preview || !lastScene || plot.dataset.stale === 'true') { schedule(); return; }
    try {
      model = readModel(); torqueLevels = Motor.parseTorqueLevels(byId('torque-values').value); voltageLevels = Motor.parseVoltageLevels(byId('voltage-values').value);
      updateValues(); updateProbe();
      preview.setScene({ ...lastScene, model, levels: [...torqueLevels], voltageLevels: [...voltageLevels], visible: visibleLayers(), probe: { ...probe, visible: probeVisible } });
      preview.request(view);
      clearTimeout(parameterPreviewTimer); parameterPreviewTimer = setTimeout(finishPan, 120);
    } catch { finishPan(); schedule(); }
  }

  async function render() {
    if (rendering || preview?.active) { rerender = true; return; }
    rerender = false;
    const started = performance.now(), hitsBefore = cacheStats.hits, missesBefore = cacheStats.misses;
    try {
      const candidate = readModel();
      const selectedTorques = Motor.parseTorqueLevels(byId('torque-values').value);
      const selectedVoltages = Motor.parseVoltageLevels(byId('voltage-values').value);
      if (byId('show-heat').checked && byId('color-scale').value === 'fixed' && (!byId('color-limit').validity.valid || !Number.isFinite(byId('color-limit').valueAsNumber))) throw new RangeError('color-limit');
      model = candidate;
      torqueLevels = selectedTorques;
      voltageLevels = selectedVoltages;
      byId('input-error').hidden = true; plot.dataset.stale = 'false';
    } catch (error) {
      const field = [...specifications, ['speedPU', '转速'], ...boundaryInputs.map(([key, , label]) => [key, label])].find(([key]) => key === error.message);
      byId('input-error').textContent = error.message === 'voltage-values' ? '参考电压：请输入1～32个非负有限标幺值，用逗号分隔。' : error.message === 'torque-values' ? '恒转矩：请输入1～32个有限标幺值，用逗号分隔，可正、可负或为零。' : field ? field[0] === 'speedPU' ? '转速：请输入 −2 至 2 的有效标幺值。' : `${field[1]}：请输入大于或等于 0 的有限标幺值。` : '色标范围无效。';
      byId('input-error').hidden = false; plot.dataset.stale = 'true'; return;
    }
    updateValues();
    updateProbe();
    const notes = [];
    if (model.input.speedPU === 0) notes.push(model.pu.resistance > 0 ? '零速：机械功率与无功均为 0；非零电流点 PF=1，无独立等功率因数线。' : '零速且 Rs=0：端电压恒为 0，PF 与 MTPV 未定义。');
    if (model.pu.flux === 0 && model.pu.ld === model.pu.lq) notes.push('无磁链且 Ld=Lq：电磁转矩恒为 0，MTPA/MTPV 无唯一解。');
    if (model.input.speedPU !== 0 && model.pu.resistance === 0 && model.pu.ld * model.pu.lq === 0) notes.push('零电阻与零电感使电压约束退化；MTPV 无有限唯一解。');
    byId('model-note').textContent = notes.join(' '); byId('model-note').hidden = notes.length === 0;
    if (!window.Plotly) { byId('plot-status').hidden = false; byId('plot-status').textContent = '本地绘图库缺失；请确认页面第三方资源完整。'; return; }
    rendering = true;
    try {
      if (!view) view = fitView();
      const extent = Math.max(.1, ...view.x.map(Math.abs), ...view.y.map(Math.abs));
      const style = getComputedStyle(document.body);
      const colors = Object.fromEntries(['mtpa', 'mtpv', 'torque', 'pf', 'boundary', 'voltage', 'voltage-level', 'text', 'muted', 'surface', 'line'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
      const narrow = plot.clientWidth < 450;
      const axis = { fixedrange: false, gridcolor: colors.line, zerolinecolor: colors.muted, zerolinewidth: 1, tickfont: { size: narrow ? 10 : 11 }, nticks: 9, constrain: 'range' };
      const geometryStarted = performance.now(), data = traces(extent, colors), geometryMs = performance.now() - geometryStarted;
      const paintStarted = performance.now();
      await window.Plotly.react(plot, data, { paper_bgcolor: colors.surface, plot_bgcolor: colors.surface, font: { family: 'Segoe UI, Microsoft YaHei, sans-serif', color: colors.text },
        width: plot.clientWidth, height: plot.clientHeight, autosize: false,
        margin: { l: narrow ? 38 : 55, r: narrow ? 11 : 20, t: 28, b: 37 }, showlegend: false, dragmode: 'pan', hovermode: false,
        xaxis: { ...axis, range: [...view.x], title: { text: 'i<sub>d</sub> / pu', standoff: 4 } },
        yaxis: { ...axis, range: [...view.y], title: { text: 'i<sub>q</sub> / pu', standoff: 3 }, scaleanchor: 'x', scaleratio: 1 }, uirevision: 'motor-plane' },
      { responsive: false, displayModeBar: true, displaylogo: false, scrollZoom: true, doubleClick: false,
        modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'resetScale2d', 'toImage'] });
      const plotlyMs = performance.now() - paintStarted;
      byId('plot-status').hidden = true;
      if (!preview) preview = window.MotorPreview.create(plot);
      const heatTrace = data.find(trace => trace.meta.kind === 'heat');
      lastScene = { model, levels: [...torqueLevels], voltageLevels: [...voltageLevels], visible: visibleLayers(), heat: heatTrace?.meta.quantity || null,
        maximum: heatTrace?.zmax || 1, colors, probe: { ...probe, visible: probeVisible } };
      preview.setScene(lastScene);
      if (!preview.active) { view = { x: [...plot._fullLayout.xaxis.range], y: [...plot._fullLayout.yaxis.range] }; preview.hide(); }
      plot.dataset.renderCount = String(++renderCount); plot.dataset.model = JSON.stringify(model); plot.dataset.view = JSON.stringify(view);
      plot.dataset.renderMetrics = JSON.stringify({ totalMs: performance.now() - started, geometryMs, plotlyMs,
        cacheHits: cacheStats.hits - hitsBefore, cacheMisses: cacheStats.misses - missesBefore });
      byId('view-readout').textContent = `id ${format(view.x[0], 2)}…${format(view.x[1], 2)} · iq ${format(view.y[0], 2)}…${format(view.y[1], 2)}`;
      const titles = { Zoom: '框选放大', Pan: '平移', 'Zoom in': '放大', 'Zoom out': '缩小' };
      plot.querySelectorAll('.modebar-btn').forEach(button => { const title = titles[button.getAttribute('data-title')]; if (title) button.setAttribute('data-title', title); });
      if (!registered) {
        plot.on('plotly_relayouting', event => {
          if (!Object.keys(event).some(key => /^[xy]axis\.range/.test(key))) return;
          const next = eventView(event);
          if (next) { clearTimeout(parameterPreviewTimer); parameterPreviewTimer = null; view = next; preview.request(next); }
        });
        plot.on('plotly_relayout', event => {
          if ((rendering && !preview.active) || !Object.keys(event).some(key => /^[xy]axis\.(range|autorange)/.test(key))) return;
          const next = eventView(event);
          if (next) { view = next; finishPan(); schedule(); }
        });
        registered = true;
      }
    } catch (error) {
      plot.dataset.stale = 'true'; byId('plot-status').hidden = false; byId('plot-status').textContent = '绘图失败：' + error.message;
    } finally { rendering = false; if (rerender && !preview?.active) { rerender = false; schedule(); } }
  }

  byId('speed-slider').addEventListener('input', event => { byId('speedPU').value = event.target.value; previewParameterChange(); });
  byId('speed-slider').addEventListener('change', finishPan);
  byId('speedPU').addEventListener('input', event => { byId('speed-slider').value = event.target.value; schedule(); });
  byId('torque-values').addEventListener('input', () => { byId('torque-preset').value = ''; schedule(); });
  byId('voltage-values').addEventListener('input', schedule);
  byId('torque-preset').addEventListener('change', event => {
    if (event.target.value === '') return;
    byId('torque-values').value = event.target.value; event.target.value = ''; schedule();
  });
  for (const [key, preset] of boundaryInputs) {
    byId(key).addEventListener('input', () => { byId(preset).value = ''; schedule(); });
    byId(preset).addEventListener('change', event => {
      if (event.target.value === '') return;
      byId(key).value = event.target.value; event.target.value = ''; schedule();
    });
  }
  byId('heat-quantity').addEventListener('change', () => { byId('show-heat').checked = true; schedule(); });
  byId('reset-view').addEventListener('click', () => { view = fitView(); schedule(); });
  byId('reset').addEventListener('click', () => {
    load(Motor.DEFAULTS); schedule();
  });
  document.querySelectorAll('.curve-switches input[type="checkbox"], #show-heat, #color-scale').forEach(input => input.addEventListener('change', schedule));
  byId('color-limit').addEventListener('input', schedule);
  byId('probe-d').addEventListener('change', () => setProbe(byId('probe-d').valueAsNumber, byId('probe-q').valueAsNumber));
  byId('probe-q').addEventListener('change', () => setProbe(byId('probe-d').valueAsNumber, byId('probe-q').valueAsNumber));
  plot.addEventListener('pointerdown', event => {
    pointerPress = null;
    if (!event.isPrimary || event.button !== 0 || !pointerPoint(event)) return;
    pointerPress = { id: event.pointerId, horizontal: event.clientX, vertical: event.clientY, moved: false };
  }, true);
  document.addEventListener('pointermove', event => {
    if (pointerPress?.id === event.pointerId && Math.hypot(event.clientX - pointerPress.horizontal, event.clientY - pointerPress.vertical) > 5) pointerPress.moved = true;
  }, true);
  document.addEventListener('pointerup', event => {
    if (pointerPress?.id !== event.pointerId) return;
    const pressed = pointerPress;
    pointerPress = null;
    if (pressed.moved || Math.hypot(event.clientX - pressed.horizontal, event.clientY - pressed.vertical) > 5) { setTimeout(finishPan, 0); return; }
    const point = pointerPoint(event);
    if (point) toggleProbe(point);
  }, true);
  document.addEventListener('pointercancel', cancelPan, true);
  document.addEventListener('touchcancel', cancelPan, true);
  window.addEventListener('blur', cancelPan);
  plot.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleProbe(probe); return; }
    if (event.key === 'Escape' && probeVisible) { event.preventDefault(); probeVisible = false; paintProbe(); return; }
    const shifts = { ArrowLeft: [-.05, 0], ArrowRight: [.05, 0], ArrowUp: [0, .05], ArrowDown: [0, -.05] };
    if (shifts[event.key]) { event.preventDefault(); setProbe(probe.direct + shifts[event.key][0], probe.quadrature + shifts[event.key][1]); }
  });
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let lastWidth = 0, lastHeight = 0;
  function resizePlot() {
    if (plot.clientWidth === lastWidth && plot.clientHeight === lastHeight) return;
    lastWidth = plot.clientWidth; lastHeight = plot.clientHeight;
    view = fitView(view || undefined); schedule();
  }
  new ResizeObserver(resizePlot).observe(document.querySelector('.plot-stage'));
  window.addEventListener('resize', resizePlot);
  document.querySelectorAll('.analysis-footer details').forEach(panel => panel.addEventListener('toggle', () => {
    if (panel.open) document.querySelectorAll('.analysis-footer details').forEach(other => { if (other !== panel) other.open = false; });
  }));
  load(Motor.DEFAULTS);
  render();
})();