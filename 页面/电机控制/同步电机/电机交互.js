(() => {
  'use strict';
  const Motor = window.SynchronousMotor;
  const Analysis = window.MotorAnalysis;
  const byId = id => document.getElementById(id);
  const plot = byId('dq-plot');
  const constraintSampler = window.MotorPreview.createConstraintSampler();
  const specifications = [
    ['resistance', '电阻 Rs', .5, .005], ['ld', 'D 轴电感 Ld', 2, .01],
    ['lq', 'Q 轴电感 Lq', 2, .01], ['flux', '磁链 ψf', 2, .01]
  ];
  const boundaryInputs = [['currentLimit', null, '电流边界'], ['voltageLimit', null, '电压边界']];
  const locks = {};
  let lockNotice = '';
  const lockFields = { current: 'currentLimit', voltage: 'voltageLimit', torque: 'torque-target', pf: 'phase-target' };
  const format = (value, digits = 3) => value === null || !Number.isFinite(value) ? '未定义' : (Math.abs(value) >= 1e5 || (Math.abs(value) > 0 && Math.abs(value) < .0001)) ? value.toExponential(3) : value.toFixed(digits);
  let model = Motor.createModel(), timer = null, rendering = false, rerender = false, renderCount = 0, registered = false;
  let preview = null, lastScene = null, parameterPreviewTimer = null;
  const geometryCache = new Map(), cacheStats = { hits: 0, misses: 0 };
  let probe = { direct: -.5, quadrature: .7 };
  let view = null;
  const torqueLevels = Motor.DEFAULT_TORQUES;
  let torqueTarget = 1, phaseTarget = 0, voltageLevels = [...Motor.DEFAULT_VOLTAGES];

  for (const [key, preset] of Object.entries(Motor.PRESETS)) byId('motor-preset').add(new Option(preset.label, key));
  for (const [key, definition] of Object.entries(Analysis.quantities)) {
    const option = new Option(({ phaseAngle: '夹角 φ', voltageAngle: '电压角 δ' })[key] || definition.label, key);
    option.title = definition.label; byId('heat-quantity').add(option);
  }
  for (const [key, label, maximum, step] of specifications) {
    const field = document.createElement('div');
    field.className = 'parameter-control';
    field.innerHTML = `<label for="${key}"><span>${label}</span><span class="unit">pu</span></label><div class="slider-pair"><input type="range" id="${key}-slider" min="0" max="${maximum}" step="${step}" aria-label="${label}滑块"><input type="number" id="${key}" min="0" step="any"></div>`;
    byId('motor-parameters').append(field);
    byId(key).addEventListener('input', () => { syncSlider(key); schedule(); });
    byId(key + '-slider').addEventListener('input', event => { byId(key).value = event.target.value; previewParameterChange(); });
    byId(key + '-slider').addEventListener('change', finishPan);
  }

  const presetInputs = new Set([...specifications.flatMap(([key]) => [key, key + '-slider']), 'speedPU', 'speed-slider', 'currentLimit', 'voltageLimit', 'torque-target', 'phase-target', 'voltage-values']);
  document.querySelector('.motor-workbench').addEventListener('input', event => { lockNotice = ''; if (presetInputs.has(event.target.id)) byId('motor-preset').value = ''; }, true);

  function syncSlider(key) {
    const value = byId(key).valueAsNumber, slider = byId(key + '-slider');
    if (!Number.isFinite(value)) return;
    if (value >= 0) {
      slider.value = value;
      slider.title = value > Number(slider.max) ? `文本框值 ${value} pu 超出滑块范围；计算仍使用文本框值。` : '';
    }
  }

  function load(values, preset = 'ipm') {
    for (const [key, , maximum] of specifications) {
      byId(key).value = values[key];
      byId(key + '-slider').max = maximum;
      syncSlider(key);
    }
    byId('speedPU').value = values.speedPU; byId('speed-slider').value = values.speedPU;
    for (const [key] of boundaryInputs) byId(key).value = values[key];
    byId('torque-target').value = 1; byId('phase-target').value = 0;
    byId('voltage-values').value = Motor.DEFAULT_VOLTAGES.join(',');
    byId('motor-preset').value = preset;
  }

  function readModel() {
    const values = Object.fromEntries(specifications.map(([key]) => [key, byId(key).valueAsNumber]));
    values.speedPU = byId('speedPU').valueAsNumber;
    for (const [key] of boundaryInputs) values[key] = byId(key).valueAsNumber;
    const preset = Motor.PRESETS[byId('motor-preset').value];
    if (preset) {
      const defaults = { ...Motor.DEFAULTS, ...preset.parameters };
      if (Object.keys(values).some(key => values[key] !== defaults[key]) || byId('torque-target').valueAsNumber !== 1 ||
          byId('phase-target').valueAsNumber !== 0 || byId('voltage-values').value !== Motor.DEFAULT_VOLTAGES.join(',')) byId('motor-preset').value = '';
    }
    return Motor.createModel(values);
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; render(); }, 16);
  }
  function updateValues() {
    byId('speed-value').textContent = (model.input.speedPU > 0 ? '+' : '') + format(model.input.speedPU, 2);
  }

  function fitView(bounds) {
    const initial = !bounds;
    bounds ||= { x: [-3, 2], y: [-2, 2] };
    const width = Math.max(120, plot.clientWidth - (plot.clientWidth < 450 ? 49 : 75));
    const height = Math.max(1, plot.clientHeight - window.MotorPreview.plotTopMargin() - 37);
    const middle = (bounds.y[0] + bounds.y[1]) / 2;
    let half = (bounds.x[1] - bounds.x[0]) * height / width / 2;
    let horizontal = [...bounds.x];
    if (!initial && half < (bounds.y[1] - bounds.y[0]) / 2) {
      half = (bounds.y[1] - bounds.y[0]) / 2;
      const center = (bounds.x[0] + bounds.x[1]) / 2;
      horizontal = [center - half * width / height, center + half * width / height];
    }
    if (initial) {
      const state = Motor.evaluate(model, probe.direct, probe.quadrature);
      const required = byId('show-vectors').checked ? Math.max(Math.abs(state.quadrature - middle), Math.abs(state.vq - middle)) * 1.15 : 0;
      if (Number.isFinite(required) && required > half) {
        half = required; const center = (bounds.x[0] + bounds.x[1]) / 2;
        horizontal = [center - half * width / height, center + half * width / height];
      }
    }
    return { x: horizontal, y: [middle - half, middle + half] };
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
    const visible = Object.fromEntries(['mtpa', 'mtpv', 'torque', 'phase', 'current', 'voltage'].map(kind => [kind, byId('show-' + kind).checked]));
    for (const kind of ['torque', 'voltage', 'phase']) visible[kind + 'Group'] = byId('show-' + kind + '-group').checked;
    for (const kind of ['voltage', 'current', 'torque', 'phase']) visible[kind + 'Map'] = byId('show-' + kind + '-map').checked;
    return visible;
  }

  function vectorVisibility() {
    const visible = byId('show-vectors').checked;
    return { current: visible, voltage: visible };
  }

  function analysisScene() {
    const coordinate = byId('heat-coordinate').value, heat = byId('heat-quantity').value, definition = Analysis.quantities[heat];
    const capturedModel = model, capturedLocks = { ...locks };
    const mapped = mappingInputs();
    return { heatCoordinate: coordinate, forceCpu: coordinate === 'voltage' || definition.cyclic,
      extraGeometry: bounds => Analysis.voltageGeometry(capturedModel, mapped.values, mapped.visible, bounds, 720),
      grid: (bounds, count) => Analysis.grid(capturedModel, bounds, count, coordinate),
      heatColor: definition.cyclic ? Analysis.angleColor : null,
      constrainPoint: (state, reference, kind) => {
        if (kind === 'mtpa' || kind === 'mtpv') return Analysis.satisfies(state, capturedLocks) ? state : null;
        return Analysis.constrain(capturedModel, state, reference, capturedLocks);
      } };
  }

  function resolveLocks(candidate) {
    if (!Object.keys(locks).length) return probe;
    const state = Analysis.constrain(candidate, Motor.evaluate(candidate, probe.direct, probe.quadrature), probe, locks);
    if (!window.MotorPreview.interactivePoint(state)) throw new RangeError('locked-state');
    return { direct: state.direct, quadrature: state.quadrature };
  }

  function restoreModelInputs() {
    for (const [key, value] of Object.entries(model.input)) if (byId(key)) byId(key).value = value;
    for (const [key] of specifications) syncSlider(key);
    byId('speed-slider').value = model.input.speedPU; byId('motor-preset').value = '';
  }

  function updateLocks() {
    for (const [key, field] of Object.entries(lockFields)) {
      byId(field).disabled = Boolean(locks[key]);
      byId('lock-' + key).checked = Boolean(locks[key]);
      byId('lock-' + key).closest('tr').dataset.locked = String(Boolean(locks[key]));
    }
    const key = Object.keys(locks)[0];
    byId('locked-value').textContent = key ? ({ current: '|I|', voltage: '|U|', torque: 'T', pf: 'PF' }[key]) + ' = ' + format(locks[key].value) + (key === 'pf' ? '' : ' pu') : '';
    byId('lock-status').textContent = lockNotice || (key ? '沿等值线' : '');
    plot.dataset.locks = JSON.stringify(locks);
  }

  function mappingInputs() {
    return { values: { current: model.input.currentLimit, voltage: model.input.voltageLimit, torque: torqueTarget, phase: phaseTarget },
      visible: Object.fromEntries(['voltage', 'current', 'torque', 'phase'].map(kind => [kind, byId('show-' + kind + '-map').checked])) };
  }

  function readTargets() {
    const torque = byId('torque-target').valueAsNumber, angle = byId('phase-target').valueAsNumber;
    if (!Number.isFinite(torque)) throw new RangeError('torque-target');
    if (!Number.isFinite(angle) || Math.abs(angle) > 180) throw new RangeError('phase-target');
    torqueTarget = torque; phaseTarget = Motor.normalizePhaseAngle(angle);
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
      grid: byId('show-heat').checked ? cachedGeometry('grid', [physical, view, byId('heat-coordinate').value], () => {
        const { x, y, fields } = Analysis.grid(model, view, 161, byId('heat-coordinate').value);
        return { x, y, fields };
      }) : null,
      torques: visible.torqueGroup ? cachedGeometry('torques', [torqueModel, view, torqueLevels], () =>
        torqueLevels.map(level => ({ level, points: coordinates(Motor.torqueCurves(model, level, extent, 800, view), extent) }))) : [],
      phases: visible.phaseGroup ? cachedGeometry('phase', [physical, view], () =>
        Motor.DEFAULT_PHASE_ANGLES.map(level => ({ level, points: coordinates(Motor.phaseAngleCurves(model, level, extent, 1000, view), extent) }))) : [],
      mtpa: visible.mtpa ? cachedGeometry('mtpa', [torqueModel, extent, samples], () => coordinates(Motor.locus(model, 'mtpa', extent, samples), extent)) : null,
      mtpv: visible.mtpv ? cachedGeometry('mtpv', [physical, extent, samples], () => coordinates(Motor.locus(model, 'mtpv', extent, samples), extent)) : null
    };
  }

  function lineTrace(points, name, kind, colors, value) {
    const appearance = window.MotorPreview.curveAppearance(kind, value, { colors, dark: document.documentElement.dataset.theme === 'dark' });
    return { type: 'scatter', mode: 'lines', ...points, name, meta: { kind, value, draggable: kind === 'mtpa' || kind === 'mtpv' }, line: { color: appearance.color, width: appearance.width, dash: appearance.dash.length ? 'dash' : 'solid' }, opacity: appearance.opacity,
      connectgaps: false, hovertemplate: `${name}<br>id %{x:.3f} pu<br>iq %{y:.3f} pu<extra></extra>` };
  }

  function traces(extent, colors) {
    const data = [], computed = getGeometry(extent);
    const heat = byId('heat-quantity').value;
    const showHeat = byId('show-heat').checked;
    const fixed = byId('color-scale').value === 'fixed';
    const definition = Analysis.quantities[heat], cyclic = definition.cyclic;
    byId('color-scale').disabled = Boolean(cyclic);
    byId('color-limit').disabled = cyclic || !fixed || !showHeat;
    byId('color-legend').hidden = !showHeat;
    if (showHeat) {
      const values = computed.grid.fields[heat];
      let maximum = Number(byId('color-limit').value);
      if (!fixed && !cyclic) maximum = Math.max(1e-6, ...values.flat().filter(value => value !== null).map(Math.abs));
      if (cyclic) maximum = 180;
      const positive = heat === 'apparent';
      const coordinate = byId('heat-coordinate').value, prefix = coordinate === 'voltage' ? 'u' : 'i';
      data.push({ type: 'heatmap', name: definition.label, meta: { kind: 'heat', quantity: heat, coordinate }, x: computed.grid.x, y: computed.grid.y, z: values,
        zmin: positive ? 0 : -maximum, zmax: maximum, zsmooth: false, hoverongaps: false, opacity: .72,
        colorscale: cyclic ? Analysis.cyclicScale.map(stop => [...stop]) : positive ? [[0, '#f5f8f4'], [.35, '#8fccc3'], [.7, '#36a9ac'], [1, '#146c94']] : [[0, '#3979ac'], [.25, '#a2c9dd'], [.5, '#f5f7ef'], [.75, '#efc59f'], [1, '#cb5a4f']],
        showscale: false, hovertemplate: `${prefix}d %{x:.3f} pu<br>${prefix}q %{y:.3f} pu<br>${definition.label} %{z:.3f} ${definition.unit}<extra></extra>` });
      byId('color-min').textContent = positive ? '0' : format(-maximum, 2);
      byId('color-max').textContent = format(maximum, 2) + ' ' + definition.unit;
      byId('color-ramp').style.background = cyclic ? `linear-gradient(90deg,${Analysis.cyclicScale.map(stop => stop[1]).join(',')})` : positive ? 'linear-gradient(90deg,#f5f8f4,#8fccc3,#36a9ac,#146c94)' : '';
    }
    if (byId('show-feasible').checked) {
      const region = constraintSampler.sample(model, view);
      data.push(window.MotorPreview.constraintTrace(region, colors.feasible));
      plot.dataset.constraintInfo = JSON.stringify({ visible: true, dimension: region.dimension, status: region.status, voltageLimit: region.voltageLimit, currentLimit: region.currentLimit, ...constraintSampler.statistics });
      if (region.status === 'numeric') { byId('model-note').textContent += ' 约束域计算超出数值范围，未填色。'; byId('model-note').hidden = false; }
    } else plot.dataset.constraintInfo = JSON.stringify({ visible: false });
    for (const curve of computed.torques) data.push(lineTrace(curve.points, `T = ${curve.level} pu`, 'torque-level', colors, curve.level));
    if (byId('show-torque').checked) {
      data.push(lineTrace(coordinates(Motor.torqueCurves(model, torqueTarget, extent, 800, view), extent), `当前 T = ${torqueTarget} pu`, 'torque', colors, torqueTarget));
    }
    for (const curve of computed.phases) data.push(lineTrace(curve.points, `φ = ${curve.level}°`, 'phase-level', colors, curve.level));
    if (byId('show-phase').checked) {
      data.push(lineTrace(coordinates(Motor.phaseAngleCurves(model, phaseTarget, extent, 1000, view), extent), `当前 φ = ${phaseTarget}°`, 'phase', colors, phaseTarget));
    }
    if (byId('show-mtpa').checked) data.push(lineTrace(computed.mtpa, 'MTPA', 'mtpa', colors));
    if (byId('show-mtpv').checked) data.push(lineTrace(computed.mtpv, 'MTPV · 含 Rs', 'mtpv', colors));
    const angles = Array.from({ length: 721 }, (_, index) => index * Math.PI / 360);
    if (byId('show-current').checked) {
      const amplitude = model.input.currentLimit;
      const points = angles.map(angle => ({ direct: amplitude * Math.cos(angle), quadrature: amplitude * Math.sin(angle) }));
      const trace = lineTrace(coordinates([points], extent), `|I| = ${amplitude} pu`, 'current', colors, amplitude);
      if (amplitude === 0) Object.assign(trace, { mode: 'markers', marker: { size: 7, color: colors.boundary } });
      data.push(trace);
    }
    if (byId('show-voltage-group').checked) for (const level of voltageLevels) {
      if (byId('show-voltage').checked && level === model.input.voltageLimit) continue;
      const reference = lineTrace(coordinates(Motor.voltageCurves(model, level, extent, 720), extent), `参考 |U| = ${level} pu`, 'voltage-level', colors, level);
      reference.meta.voltage = level;
      if (level === 0 && Motor.currentAtVoltage(model, 0, 0)) Object.assign(reference, { mode: 'markers', marker: { size: 6, color: reference.line.color } });
      data.push(reference);
    }
    if (byId('show-voltage').checked) {
      const amplitude = model.input.voltageLimit;
      const trace = lineTrace(coordinates(Motor.voltageCurves(model, amplitude, extent, 1000), extent), `|U| = ${amplitude} pu`, 'voltage', colors, amplitude);
      trace.meta.voltage = amplitude;
      if (amplitude === 0 && Motor.currentAtVoltage(model, 0, 0)) Object.assign(trace, { mode: 'markers', marker: { size: 7, color: trace.line.color } });
      data.push(trace);
    }
    const mapped = mappingInputs();
    for (const line of Analysis.voltageGeometry(model, mapped.values, mapped.visible, view, 1200)) {
      const names = { voltage: '恒电压', current: '恒电流', torque: '恒转矩', phase: '恒夹角' };
      const trace = lineTrace(coordinates(line.branches, extent), names[line.sourceKind] + ' · 电压映射', line.kind, colors, line.value);
      Object.assign(trace.meta, { sourceKind: line.sourceKind, coordinate: 'voltage' });
      trace.hovertemplate = 'ud %{x:.3f} pu<br>uq %{y:.3f} pu<extra></extra>';
      if (line.dots) Object.assign(trace, { mode: 'markers', marker: { size: 7, color: trace.line.color } });
      data.push(trace);
    }
    data.push(...window.MotorPreview.vectorTraces({ point: Motor.evaluate(model, probe.direct, probe.quadrature), vectorVisibility: vectorVisibility(), colors }));
    return data;
  }

  function updateProbe() {
    const point = Analysis.stateAt(model, probe.direct, probe.quadrature);
    byId('probe-d').value = probe.direct; byId('probe-q').value = probe.quadrature;
    const entries = { vd: '电压 d', vq: '电压 q', current: '电流幅值', voltage: '电压幅值', torque: '转矩 T', mechanical: '机械功率', active: '有功 P', reactive: '无功 Q', apparent: '视在 S', pf: '功率因数', phaseAngle: 'φ / °', voltageAngle: 'δ / °' };
    byId('probe-readout').innerHTML = Object.entries(entries).map(([key, label]) => `<dl class="readout"><dt>${label}</dt><dd id="value-${key}">${format(point[key])}</dd></dl>`).join('');
    byId('probe-readout').dataset.point = JSON.stringify(point);
    const visibility = vectorVisibility(), valid = window.MotorPreview.interactivePoint(point);
    byId('probe-readout').dataset.visible = String(valid && (visibility.current || visibility.voltage));
    byId('probe-readout').dataset.currentVisible = String(valid && visibility.current);
    byId('probe-readout').dataset.voltageVisible = String(valid && visibility.voltage);
    byId('probe-state').textContent = !valid ? '矢量方向未定义' : point.feasible ? '稳态点 · 约束内' : '稳态点 · 超出当前约束';
  }

  function setProbe(direct, quadrature) {
    if (!lastScene || plot.dataset.stale === 'true') return;
    const reference = Motor.evaluate(model, probe.direct, probe.quadrature);
    const next = window.MotorPreview.advanceDrag((point, previous) => window.MotorPreview.pointDragState(lastScene, 'current-vector', point, previous), probe, { direct, quadrature }, reference);
    if (next.moved) applyDrag('current-vector', next.value);
    updateProbe(); plot.dataset.dragBlocked = String(next.blocked); finishPan();
  }

  function eventView(event) {
    const range = axis => event[axis + '.range'] || [event[axis + '.range[0]'] ?? plot._fullLayout[axis].range[0], event[axis + '.range[1]'] ?? plot._fullLayout[axis].range[1]];
    const next = { x: range('xaxis'), y: range('yaxis') };
    return [...next.x, ...next.y].every(Number.isFinite) && next.x[1] - next.x[0] > 1e-5 && next.y[1] - next.y[0] > 1e-5 ? next : null;
  }

  function finishPan() {
    if (preview?.dragging) return;
    clearTimeout(parameterPreviewTimer); parameterPreviewTimer = null;
    if (preview?.active) { preview.settle(); schedule(); }
  }

  function cancelPan() {
    if (preview?.active && plot._dragging) document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    finishPan();
  }

  function previewParameterChange(strict = false) {
    if (!preview || !lastScene || rendering || plot.dataset.stale === 'true') { if (!strict) schedule(); return false; }
    try {
      const candidate = readModel(); readTargets();
      const selectedVoltages = Motor.parseVoltageLevels(byId('voltage-values').value);
      for (const direct of view.x) for (const quadrature of view.y) {
        const state = Motor.evaluate(candidate, direct, quadrature);
        if (!['torque', 'active', 'reactive', 'apparent'].every(key => Number.isFinite(state[key]))) throw new RangeError('numeric-range');
      }
      probe = resolveLocks(candidate); model = candidate; voltageLevels = selectedVoltages;
      updateValues(); updateProbe();
      lastScene = { ...lastScene, model, levels: torqueLevels, torqueTarget, phaseTarget, voltageLevels: [...voltageLevels], visible: visibleLayers(), showFeasible: byId('show-feasible').checked,
        point: Motor.evaluate(model, probe.direct, probe.quadrature), vectorVisibility: vectorVisibility(), ...analysisScene() };
      preview.setScene(lastScene);
      preview.request(view);
      clearTimeout(parameterPreviewTimer); parameterPreviewTimer = setTimeout(finishPan, 120);
      return true;
    } catch (error) { if (!strict) { if (error.message === 'locked-state') { restoreModelInputs(); lockNotice = '参数与锁定不兼容，已保留上一状态'; updateLocks(); } finishPan(); schedule(); } return false; }
  }

  function applyDrag(kind, value) {
    if (!preview || rendering || plot.dataset.stale === 'true') return null;
    const linked = typeof value === 'object';
    if (!linked && locks[kind === 'phase' ? 'pf' : kind]) return null;
    if (linked ? !window.MotorPreview.interactivePoint(value) : !Number.isFinite(value)) return null;
    const fields = [...document.querySelectorAll('.motor-workbench input,.motor-workbench select')].map(field => [field, field.value]);
    const previous = { model, probe: { ...probe }, torqueTarget, phaseTarget, voltageLevels, lastScene };
    try {
      let field;
      if (linked) {
        probe = { direct: value.direct, quadrature: value.quadrature };
        const references = kind.endsWith('-vector') ? { 'torque-target': value.torque } :
          { currentLimit: value.current, voltageLimit: value.voltage, 'torque-target': value.torque, 'phase-target': value.phaseAngle };
        for (const [key, number] of Object.entries(references)) byId(key).value = number;
      } else {
        field = kind === 'torque' ? 'torque-target' : kind === 'phase' ? 'phase-target' : kind + 'Limit';
        byId(field).value = kind === 'phase' ? Motor.normalizePhaseAngle(value) : value;
      }
      if (!previewParameterChange(true)) throw new RangeError('invalid-drag');
      clearTimeout(parameterPreviewTimer); parameterPreviewTimer = null;
      return linked ? { ...value, ...lastScene.point } : byId(field).valueAsNumber;
    } catch {
      for (const [field, value] of fields) field.value = value;
      ({ model, probe, torqueTarget, phaseTarget, voltageLevels, lastScene } = previous);
      updateValues(); updateProbe(); preview.setScene(lastScene);
      return null;
    }
  }

  async function render() {
    if (rendering || preview?.active) { rerender = true; return; }
    rerender = false;
    const started = performance.now(), hitsBefore = cacheStats.hits, missesBefore = cacheStats.misses;
    try {
      const candidate = readModel();
      readTargets();
      const selectedVoltages = Motor.parseVoltageLevels(byId('voltage-values').value);
      if (byId('show-heat').checked && !Analysis.quantities[byId('heat-quantity').value].cyclic && byId('color-scale').value === 'fixed' && (!byId('color-limit').validity.valid || !Number.isFinite(byId('color-limit').valueAsNumber))) throw new RangeError('color-limit');
      probe = resolveLocks(candidate); model = candidate;
      voltageLevels = selectedVoltages;
      byId('input-error').hidden = true; plot.dataset.stale = 'false';
    } catch (error) {
      if (error.message === 'locked-state') {
        lockNotice = '参数与锁定不兼容，已保留上一状态'; updateLocks();
        restoreModelInputs(); byId('input-error').textContent = '参数变更与当前锁定条件不兼容，已保留上一有效状态。';
        byId('input-error').hidden = false; plot.dataset.stale = 'false'; return;
      }
      const field = [...specifications, ['speedPU', '转速'], ...boundaryInputs.map(([key, , label]) => [key, label])].find(([key]) => key === error.message);
      byId('input-error').textContent = error.message === 'voltage-values' ? '参考电压：请输入1～32个非负有限标幺值，用逗号分隔。' : error.message === 'torque-target' ? '当前转矩：请输入有限标幺值。' : error.message === 'phase-target' ? '电压–电流夹角：请输入−180°至180°的有效值。' : field ? field[0] === 'speedPU' ? '转速：请输入 −2 至 2 的有效标幺值。' : `${field[1]}：请输入大于或等于 0 的有限标幺值。` : '色标范围无效。';
      byId('input-error').hidden = false; plot.dataset.stale = 'true'; return;
    }
    updateValues();
    updateProbe();
    updateLocks();
    const notes = [];
    if (model.input.speedPU === 0) notes.push(model.pu.resistance > 0 ? '零速：机械功率与无功均为0；非零电流点φ=0°，无独立等夹角线。' : '零速且Rs=0：端电压恒为0，φ与MTPV未定义。');
    if (model.pu.flux === 0 && model.pu.ld === model.pu.lq) notes.push('无磁链且 Ld=Lq：电磁转矩恒为 0，MTPA/MTPV 无唯一解。');
    if (model.input.speedPU !== 0 && model.pu.resistance === 0 && model.pu.ld * model.pu.lq === 0) notes.push('零电阻与零电感使电压约束退化；MTPV 无有限唯一解。');
    if (byId('heat-coordinate').value === 'voltage' && !Motor.currentAtVoltage(model, 1, 0)) notes.push('电压坐标无唯一电流逆解，颜色图留空。');
    byId('model-note').textContent = notes.join(' '); byId('model-note').hidden = notes.length === 0;
    if (!window.Plotly) { byId('plot-status').hidden = false; byId('plot-status').textContent = '本地绘图库缺失；请确认页面第三方资源完整。'; return; }
    rendering = true;
    try {
      if (!view) view = fitView();
      const extent = Math.max(.1, ...view.x.map(Math.abs), ...view.y.map(Math.abs));
      const style = getComputedStyle(document.body);
      const colors = Object.fromEntries(['mtpa', 'mtpv', 'torque', 'pf', 'boundary', 'voltage', 'voltage-level', 'feasible', 'text', 'muted', 'surface', 'line'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
      const narrow = plot.clientWidth < 450;
      const axis = { fixedrange: false, showgrid: false, zerolinecolor: colors.muted, zerolinewidth: 1, tickfont: { size: narrow ? 10 : 11 }, nticks: 9, constrain: 'range' };
      const geometryStarted = performance.now(), data = traces(extent, colors), geometryMs = performance.now() - geometryStarted;
      const paintStarted = performance.now();
      await window.Plotly.react(plot, data, { paper_bgcolor: colors.surface, plot_bgcolor: colors.surface, font: { family: 'Segoe UI, Microsoft YaHei, sans-serif', color: colors.text },
        width: plot.clientWidth, height: plot.clientHeight, autosize: false,
        margin: { l: narrow ? 38 : 55, r: narrow ? 11 : 20, t: window.MotorPreview.plotTopMargin(), b: 37 }, showlegend: false, dragmode: 'pan', hovermode: false,
        xaxis: { ...axis, range: [...view.x], title: { text: 'd / pu', standoff: 4 } },
        yaxis: { ...axis, range: [...view.y], nticks: Math.max(2, Math.min(9, Math.floor((plot.clientHeight - window.MotorPreview.plotTopMargin() - 37) / 32))), title: { text: 'q / pu', standoff: 3 }, scaleanchor: 'x', scaleratio: 1 }, uirevision: 'motor-plane' },
      window.MotorPreview.plotConfig(() => { view = fitView(); schedule(); }));
      const plotlyMs = performance.now() - paintStarted;
      byId('plot-status').hidden = true;
      if (!preview) preview = window.MotorPreview.create(plot, { change: applyDrag, end: finishPan });
      const heatTrace = data.find(trace => trace.meta.kind === 'heat');
      lastScene = { model, levels: torqueLevels, torqueTarget, phaseTarget, dark: document.documentElement.dataset.theme === 'dark', voltageLevels: [...voltageLevels], visible: visibleLayers(), heat: heatTrace?.meta.quantity || null,
        maximum: heatTrace?.zmax || 1, colors, showFeasible: byId('show-feasible').checked, constraintSampler,
        point: Motor.evaluate(model, probe.direct, probe.quadrature), vectorVisibility: vectorVisibility(), ...analysisScene() };
      preview.setScene(lastScene);
      if (!preview.active) { view = { x: [...plot._fullLayout.xaxis.range], y: [...plot._fullLayout.yaxis.range] }; preview.hide(); }
      plot.dataset.renderCount = String(++renderCount); plot.dataset.model = JSON.stringify(model); plot.dataset.view = JSON.stringify(view);
      plot.dataset.targets = JSON.stringify({ torque: torqueTarget, phase: phaseTarget });
      plot.dataset.renderMetrics = JSON.stringify({ totalMs: performance.now() - started, geometryMs, plotlyMs,
        cacheHits: cacheStats.hits - hitsBefore, cacheMisses: cacheStats.misses - missesBefore });
      byId('view-readout').textContent = `id ${format(view.x[0], 2)}…${format(view.x[1], 2)} · iq ${format(view.y[0], 2)}…${format(view.y[1], 2)}`;
      window.MotorPreview.decorateViewTools(plot);
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
  byId('torque-target').addEventListener('input', schedule);
  byId('phase-target').addEventListener('input', schedule);
  byId('voltage-values').addEventListener('input', schedule);
  for (const [key] of boundaryInputs) byId(key).addEventListener('input', schedule);
  for (const key of Object.keys(lockFields)) byId('lock-' + key).addEventListener('change', event => {
    lockNotice = '';
    const enabled = event.target.checked;
    const state = Motor.evaluate(model, probe.direct, probe.quadrature), captured = enabled ? Analysis.captureLock(state, key) : null;
    if (enabled && (plot.dataset.stale === 'true' || !captured || !window.MotorPreview.interactivePoint(state))) { updateLocks(); return; }
    for (const previous of Object.keys(locks)) delete locks[previous];
    if (enabled) {
      locks[key] = captured;
      byId(lockFields[key]).value = key === 'pf' ? state.phaseAngle : state[key];
      byId('show-' + (key === 'pf' ? 'phase' : key)).checked = true;
    }
    updateLocks(); schedule();
  });
  byId('heat-coordinate').addEventListener('change', () => { byId('show-heat').checked = true; schedule(); });
  byId('heat-quantity').addEventListener('change', () => { byId('show-heat').checked = true; schedule(); });
  byId('motor-preset').addEventListener('change', event => {
    const preset = Motor.PRESETS[event.target.value];
    if (preset) { load({ ...Motor.DEFAULTS, ...preset.parameters }, event.target.value); schedule(); }
  });
  document.querySelectorAll('.plot-controls input[type="checkbox"], #color-scale').forEach(input => input.addEventListener('change', schedule));
  byId('color-limit').addEventListener('input', schedule);
  byId('probe-d').addEventListener('change', () => setProbe(byId('probe-d').valueAsNumber, byId('probe-q').valueAsNumber));
  byId('probe-q').addEventListener('change', () => setProbe(byId('probe-d').valueAsNumber, byId('probe-q').valueAsNumber));
  document.addEventListener('pointerup', () => setTimeout(finishPan, 0), true);
  document.addEventListener('touchend', () => setTimeout(finishPan, 0), true);
  document.addEventListener('pointercancel', cancelPan, true);
  document.addEventListener('touchcancel', cancelPan, true);
  window.addEventListener('blur', cancelPan);
  plot.addEventListener('keydown', event => {
    const shifts = { ArrowLeft: [-.05, 0], ArrowRight: [.05, 0], ArrowUp: [0, .05], ArrowDown: [0, -.05] };
    if (shifts[event.key] && byId('show-vectors').checked) { event.preventDefault(); setProbe(probe.direct + shifts[event.key][0], probe.quadrature + shifts[event.key][1]); }
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