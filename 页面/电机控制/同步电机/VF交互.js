(() => {
  'use strict';
  const VF = window.VoltageMotor, Rotor = window.SynchronousMotor, byId = id => document.getElementById(id), plot = byId('dq-plot');
  const constraintSampler = MotorPreview.createConstraintSampler({ frame: 'voltage', requiredVoltage: VF.requiredVoltage });
  const fieldSampler = VF.createFieldSampler();
  const torqueSampler = VF.createTorqueSampler();
  const boundaryCache = new Map();
  const specifications = [['resistance', '电阻 Rs', .5, .0005], ['ld', 'D轴电感 Ld', 2, .001], ['lq', 'Q轴电感 Lq', 2, .001], ['flux', '磁链 ψf', 2, .001]];
  const valueKeys = [...specifications.map(([key]) => key), 'voltageLimit', 'currentLimit', 'angleDeg', 'speedPU'];
  let view = null, preview = null, rendering = false, pending = false, timer = null, settleTimer = null, registered = false, scene = null, renderCount = 0;
  let pointLock = null, lockMessage = '';
  const lockFields = { voltage: 'voltageLimit', current: 'currentLimit', torque: 'torque-target', pf: 'phase-target' };
  const format = value => value === null || value === undefined ? '未定义' : Math.abs(value) > 1e5 ? value.toExponential(2) : value.toFixed(3);

  for (const [key, preset] of Object.entries(Rotor.PRESETS)) byId('motor-preset').add(new Option(preset.label, key));
  for (const [key, label, maximum, step] of specifications) {
    const field = document.createElement('div'); field.className = 'parameter-control';
    field.innerHTML = `<label for="${key}"><span>${label}</span><span class="unit">pu</span></label><div class="slider-pair"><input type="range" id="${key}-slider" min="0" max="${maximum}" step="${step}" aria-label="${label}滑块"><input type="number" id="${key}" min="0" step="any"></div>`;
    byId('motor-parameters').append(field);
    byId(key + '-slider').addEventListener('input', event => { byId(key).value = event.target.value; previewInput(); });
    byId(key + '-slider').addEventListener('change', settle);
    byId(key).addEventListener('input', () => { byId(key + '-slider').value = byId(key).value; schedule(); });
  }
  const presetInputs = new Set([...valueKeys, ...specifications.map(([key]) => key + '-slider'), 'speed-slider', 'torque-target', 'phase-target', 'voltage-values']);
  document.querySelector('.motor-workbench').addEventListener('input', event => { lockMessage = ''; if (presetInputs.has(event.target.id)) byId('motor-preset').value = ''; }, true);

  function updateLockControls() {
    for (const [kind, field] of Object.entries(lockFields)) {
      const active = pointLock?.kind === kind;
      byId('lock-' + kind).checked = active; byId(field).disabled = active;
      byId('lock-' + kind).closest('tr').dataset.locked = String(active);
    }
    byId('locked-value').textContent = pointLock ? ({ voltage: '|U|', current: '|I|', torque: 'T', pf: 'PF' })[pointLock.kind] + ' = ' + format(pointLock.value) : '';
    byId('lock-status').textContent = lockMessage || (pointLock ? ({ voltage: '沿恒电压线', current: '沿恒电流线', torque: '沿恒转矩线', pf: '沿恒夹角线' })[pointLock.kind] : '');
    plot.dataset.locks = JSON.stringify(pointLock ? { [pointLock.kind]: pointLock } : {});
  }

  function restoreSceneInputs() {
    for (const key of valueKeys) byId(key).value = scene.model.input[key];
    for (const [key] of specifications) byId(key + '-slider').value = scene.model.input[key];
    byId('speed-slider').value = scene.model.input.speedPU;
    byId('torque-target').value = scene.torqueTarget; byId('phase-target').value = scene.phaseTarget;
    byId('motor-preset').value = '';
  }

  function loadDefaults(preset = 'ipm') {
    const values = { ...VF.OPERATING_DEFAULTS, ...Rotor.PRESETS[preset].parameters };
    for (const key of valueKeys) byId(key).value = values[key];
    for (const [key] of specifications) byId(key + '-slider').value = values[key];
    byId('speed-slider').value = values.speedPU;
    byId('torque-target').value = 1; byId('phase-target').value = 0;
    byId('voltage-values').value = Rotor.DEFAULT_VOLTAGES.join(',');
    byId('motor-preset').value = preset;
  }
  function fitView(bounds) {
    const width = Math.max(1, plot.clientWidth - (plot.clientWidth < 450 ? 49 : 75));
    const height = Math.max(1, plot.clientHeight - MotorPreview.plotTopMargin() - 37);
    if (!bounds) {
      const model = VF.createOperatingModel(Object.fromEntries(valueKeys.map(key => [key, byId(key).valueAsNumber])));
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
    const half = Math.max((bounds.x[1] - bounds.x[0]) * height / width / 2, (bounds.y[1] - bounds.y[0]) / 2);
    const middle = (bounds.y[0] + bounds.y[1]) / 2;
    const center = (bounds.x[0] + bounds.x[1]) / 2;
    return { x: [center - half * width / height, center + half * width / height], y: [middle - half, middle + half] };
  }
  function schedule() { if (timer === null) timer = setTimeout(() => { timer = null; render(); }, 16); }
  function settle() { if (preview?.dragging) return; clearTimeout(settleTimer); if (preview?.active) { preview.settle(); schedule(); } }
  function cancel() { if (preview?.active && plot._dragging) document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); settle(); }
  function readScene(previewOnly = false) {
    const model = VF.createOperatingModel(Object.fromEntries(valueKeys.map(key => [key, byId(key).valueAsNumber])));
    const levels = Rotor.DEFAULT_TORQUES, point = VF.atAngle(model);
    if (!VF.matchesLock(point, pointLock)) throw new RangeError('locked-state');
    const torqueTarget = byId('torque-target').valueAsNumber, angleTarget = byId('phase-target').valueAsNumber;
    if (!Number.isFinite(torqueTarget)) throw new RangeError('torque-target');
    if (!Number.isFinite(angleTarget) || Math.abs(angleTarget) > 180) throw new RangeError('phase-target');
    const phaseTarget = Rotor.normalizePhaseAngle(angleTarget);
    const voltageLevels = Rotor.parseVoltageLevels(byId('voltage-values').value);
    const preset = Rotor.PRESETS[byId('motor-preset').value];
    if (preset) {
      const defaults = { ...VF.OPERATING_DEFAULTS, ...preset.parameters };
      if (valueKeys.some(key => model.input[key] !== defaults[key]) || model.input.voltageMode !== defaults.voltageMode ||
          torqueTarget !== 1 || phaseTarget !== 0 || byId('voltage-values').value !== Rotor.DEFAULT_VOLTAGES.join(',')) byId('motor-preset').value = '';
    }
    const selection = byId('heat-quantity').value;
    const sampled = byId('show-heat').checked ? fieldSampler.sample(model, view, previewOnly ? 81 : 161) : null;
    const heat = sampled?.status === 'ok' ? selection : null;
    const maximum = byId('color-scale').value === 'auto' ? Math.max(1e-6, ...(sampled?.fields[selection]?.flat().filter(Number.isFinite).map(Math.abs) || [])) : byId('color-limit').valueAsNumber;
    if (heat && (!Number.isFinite(maximum) || maximum <= 0 || (byId('color-scale').value === 'fixed' && maximum < .1))) throw new RangeError('color-limit');
    const visible = Object.fromEntries(['mtpa', 'mtpv', 'voltage', 'current', 'torque', 'phase'].map(key => [key, byId('show-' + key).checked]));
    visible.branchBoundary = byId('show-branch-boundary').checked;
    for (const kind of ['torque', 'voltage', 'phase']) visible[kind + 'Group'] = byId('show-' + kind + '-group').checked;
    const style = getComputedStyle(document.body), colors = Object.fromEntries(['mtpa', 'mtpv', 'torque', 'pf', 'boundary', 'voltage', 'voltage-level', 'feasible', 'text', 'muted', 'surface', 'line'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
    const vectorVisibility = { current: byId('show-vectors').checked, voltage: byId('show-vectors').checked };
    const result = { model, levels, torqueTarget, phaseTarget, dark: document.documentElement.dataset.theme === 'dark', voltageLevels, visible, heat, sampled, maximum, colors, frame: 'voltage', point, vectorVisibility, showFeasible: byId('show-feasible').checked, constraintSampler,
      forceCpu: true, asinhColor: byId('color-scale').value === 'auto', rasterResolution: 81, grid: (bounds, resolution) => fieldSampler.sample(model, bounds, resolution) };
    result.heatColor = value => MotorPreview.colorFor(value, result.maximum, heat === 'voltage', result.asinhColor);
    plot.dataset.fieldInfo = JSON.stringify(sampled ? { ...sampled.summary, status: sampled.status, branch: 'origin', quantity: selection, resolution: sampled.x.length, ...fieldSampler.statistics } : { hidden: true });
    result.geometryKey = [Object.entries(model.input).filter(([key]) => key !== 'angleDeg'), visible, levels, voltageLevels, torqueTarget, phaseTarget];
    result.torqueCurves = (level, bounds) => torqueSampler.sample(model, level, bounds);
    result.torqueAt = position => VF.originState(model, position.direct, position.quadrature)?.torque ?? null;
    result.geometry = (bounds, fast = true) => {
      const boundaryKey = JSON.stringify([model.pu, model.input.speedPU, bounds]);
      const branchBoundary = () => {
        if (!boundaryCache.has(boundaryKey)) {
          boundaryCache.set(boundaryKey, VF.branchBoundary(model, bounds));
          if (boundaryCache.size > 2) boundaryCache.delete(boundaryCache.keys().next().value);
        }
        return boundaryCache.get(boundaryKey);
      };
      const geometry = VF.geometry({ ...result, branchBoundary, torqueCurves: level => torqueSampler.sample(model, level, bounds, fast ? 480 : 960) }, bounds);
      plot.dataset.torqueCache = JSON.stringify(torqueSampler.statistics);
      return geometry;
    };
    const capturedLock = pointLock && { ...pointLock };
    result.axisState = angle => {
      const candidate = VF.atAngle(model, angle);
      return VF.matchesLock(candidate, capturedLock) ? candidate : null;
    };
    result.solveOptimum = (kind, position, direction = 1) => kind === 'mtpa' && !['current', 'torque'].includes(capturedLock?.kind) ? VF.mtpaAtCurrent(model, Math.hypot(position.direct, position.quadrature), direction) : null;
    result.solveCurrent = (position, reference) => VF.projectLockedCurrent(model, position, reference, capturedLock);
    result.solveVoltage = (voltage, reference) => {
      const candidate = VF.atVoltage(model, voltage, reference?.angleDeg ?? model.input.angleDeg);
      if (!capturedLock) return candidate;
      if (capturedLock.kind === 'voltage') return VF.atVoltage(model, capturedLock.value, reference?.angleDeg ?? model.input.angleDeg);
      return candidate && VF.projectLockedCurrent(model, candidate, reference, capturedLock);
    };
    result.axesGeometry = bounds => VF.rotorAxes(model, bounds);
    byId('speed-value').textContent = model.input.speedPU.toFixed(2);
    byId('color-limit').disabled = byId('color-scale').value === 'auto' || !heat;
    const notes = [model.reason === 'zero-voltage' ? '输出电压为0，电压定向无定义。' : model.reason === 'singular' ? '电压方程奇异，不能求得唯一稳态电流。' : model.input.speedPU === 0 ? '零速时同一电流位置可对应不同转子角和转矩，转矩着色留空；工作点仍按转子方程计算。' : '',
      model.pu.flux === 0 && model.pu.ld === model.pu.lq ? '无磁链且Ld=Lq：转矩恒为0，MTPA/MTPV无唯一解。' : ''].filter(Boolean).join(' ');
    const fieldNote = sampled && sampled.status !== 'ok' ? ' · 色图：零速或零磁链无原点方向锚点' : '';
    byId('model-note').textContent = notes; byId('model-note').hidden = !notes;
    byId('operating-summary').textContent = `Ud ${format(model.outputVoltage)} · Uq 0 · T ${format(point?.torque)} · φ ${Number.isFinite(point?.phaseAngle) ? format(point.phaseAngle) + '°' : '未定义'}${fieldNote}`;
    byId('probe-readout').dataset.point = JSON.stringify(point);
    byId('probe-readout').dataset.currentVisible = String(MotorPreview.interactivePoint(point) && vectorVisibility.current);
    byId('probe-readout').dataset.voltageVisible = String(MotorPreview.interactivePoint(point) && vectorVisibility.voltage);
    byId('probe-readout').dataset.visible = String(MotorPreview.interactivePoint(point) && (vectorVisibility.current || vectorVisibility.voltage));
    byId('probe-readout').innerHTML = [['direct', 'Id,u'], ['quadrature', 'Iq,u'], ['rotorDirect', '转子 id'], ['rotorQuadrature', '转子 iq'], ['torque', '转矩 T'], ['active', '有功 P'], ['reactive', '无功 Q'], ['apparent', '视在 S']].map(([key, name]) => `<dl class="readout"><dt>${name}</dt><dd>${format(point?.[key])}</dd></dl>`).join('');
    byId('operating-state').textContent = point ? `δ=${format(model.input.angleDeg)}° · |I|=${format(point.current)} pu · ${point.feasible ? '电流未超界' : '超出电流边界'} · 同步稳态，不代表动态稳定。` : notes;
    plot.dataset.stale = 'false'; byId('input-error').hidden = true;
    updateLockControls();
    return result;
  }
  function showError(error) {
    if (error.message === 'locked-state' && scene) {
      restoreSceneInputs(); lockMessage = '与当前锁定不兼容，已保留上一状态'; updateLockControls();
      plot.dataset.stale = 'false'; preview?.hide(); schedule(); return;
    }
    plot.dataset.stale = 'true'; byId('input-error').hidden = false; byId('input-error').textContent = '输入无效或数值超出范围：' + error.message; preview?.hide();
  }
  function previewInput() {
    if (!preview || rendering) { schedule(); return; }
    try {
      const previousMaximum = scene.maximum; scene = readScene(true);
      if (byId('color-scale').value === 'auto') scene.maximum = previousMaximum;
      updateColorLegend(scene);
      preview.setScene(scene); preview.request(view); clearTimeout(settleTimer); settleTimer = setTimeout(settle, 120);
    } catch (error) { showError(error); }
  }

  function applyDrag(kind, value) {
    if (!preview || rendering || plot.dataset.stale === 'true') return null;
    const linked = typeof value === 'object';
    if (!linked && pointLock?.kind === (kind === 'phase' ? 'pf' : kind)) return null;
    if (linked ? !MotorPreview.interactivePoint(value) : !Number.isFinite(value)) return null;
    const fields = [...document.querySelectorAll('.motor-workbench input,.motor-workbench select')].map(field => [field, field.value]);
    const previous = scene;
    try {
      let field;
      if (kind === 'mtpa' && linked) {
        if (['current', 'torque'].includes(pointLock?.kind)) throw new RangeError('locked-state');
        byId('currentLimit').value = value.current;
        byId('torque-target').value = value.torque;
      } else if (linked) {
        const currentDrag = kind === 'current-vector';
        const voltageLimit = pointLock?.kind === 'voltage' ? previous.model.input.voltageLimit : value.voltage;
        const proposed = VF.createOperatingModel({ ...previous.model.input, voltageLimit, ...(currentDrag ? {} : { currentLimit: value.current }), angleDeg: value.angleDeg });
        const actual = VF.atAngle(proposed);
        if (!MotorPreview.interactivePoint(actual)) throw new RangeError('invalid-drag');
        const values = currentDrag ? { voltageLimit: proposed.outputVoltage, angleDeg: proposed.input.angleDeg, 'torque-target': actual.torque } :
          { voltageLimit: proposed.outputVoltage, currentLimit: actual.current, angleDeg: proposed.input.angleDeg, 'torque-target': actual.torque, 'phase-target': actual.phaseAngle };
        for (const [key, number] of Object.entries(values)) byId(key).value = number;
      } else {
        field = kind.startsWith('rotor-axis-') ? 'angleDeg' : kind === 'torque' ? 'torque-target' : kind === 'phase' ? 'phase-target' : kind + 'Limit';
        byId(field).value = kind === 'phase' ? Rotor.normalizePhaseAngle(value) : value;
      }
      const next = readScene(true);
      if (next.model.reason || ((linked || kind === 'voltage') && !MotorPreview.interactivePoint(next.point))) throw new RangeError('invalid-drag');
      if (byId('color-scale').value === 'auto') next.maximum = previous.maximum;
      updateColorLegend(next);
      scene = next; preview.setScene(scene); preview.request(view); clearTimeout(settleTimer); settleTimer = null;
      return kind === 'mtpa' && linked ? value : linked ? { ...value, ...next.point } : byId(field).valueAsNumber;
    } catch {
      for (const [field, value] of fields) field.value = value;
      scene = previous;
      try { readScene(true); } catch { }
      preview.setScene(previous);
      return null;
    }
  }
  function trace(line, scene, extent) {
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
    const appearance = MotorPreview.curveAppearance(line.kind, line.value, scene);
    const result = { type: 'scatter', mode: line.dots ? 'markers' : 'lines', name: line.name, x: direct, y: quadrature, meta: { kind: line.kind, value: line.value, voltage: line.voltage, draggable: line.draggable }, line: { color: appearance.color, width: appearance.width, dash: appearance.dash.length ? 'dash' : 'solid' }, opacity: appearance.opacity, marker: { size: 7, color: appearance.color }, connectgaps: false, hoverinfo: 'skip' };
    return result;
  }
  function updateColorLegend(next) {
    byId('color-legend').hidden = !next.heat;
    byId('color-min').textContent = next.heat === 'voltage' ? '0' : format(-next.maximum);
    byId('color-max').textContent = format(next.maximum) + ' pu' + (next.asinhColor ? ' · asinh' : '');
    byId('color-legend').title = next.asinhColor ? '颜色按asinh(数值/1 pu)映射，端点标注原始数值' : '';
    byId('color-ramp').style.background = next.heat === 'voltage' ? 'linear-gradient(90deg,#f5f8f4,#8fccc3,#36a9ac,#146c94)' : '';
  }
  async function render() {
    if (rendering || preview?.active) { pending = true; return; }
    rendering = true; pending = false;
    try {
      if (!view) view = fitView();
      const next = readScene(), geometry = next.geometry(view, false), data = [];
      updateColorLegend(next);
      if (next.heat) {
        const positive = next.heat === 'voltage';
        const values = next.sampled.fields[next.heat], maximum = next.asinhColor ? Math.asinh(next.maximum) : next.maximum;
        data.push({ type: 'heatmap', x: next.sampled.x, y: next.sampled.y, z: next.asinhColor ? values.map(row => row.map(value => value === null ? null : Math.asinh(value))) : values, customdata: values,
          zmin: positive ? 0 : -maximum, zmax: maximum, zsmooth: 'best', connectgaps: false, showscale: false, hoverongaps: false,
          meta: { kind: 'heat', quantity: next.heat, representation: 'origin-connected-plane', maximum: next.maximum, transform: next.asinhColor ? 'asinh' : 'linear' },
          colorscale: positive ? [[0, '#f5f8f4'], [.35, '#8fccc3'], [.7, '#36a9ac'], [1, '#146c94']] : [[0, '#3979ac'], [.25, '#a2c9dd'], [.5, '#f5f7ef'], [.75, '#efc59f'], [1, '#cb5a4f']], opacity: .72, hoverinfo: 'skip' });
      }
      if (next.showFeasible) {
        const region = constraintSampler.sample(next.model, view);
        data.push(MotorPreview.constraintTrace(region, next.colors.feasible));
        plot.dataset.constraintInfo = JSON.stringify({ visible: true, dimension: region.dimension, status: region.status, voltageLimit: region.voltageLimit, currentLimit: region.currentLimit, ...constraintSampler.statistics });
        if (region.status === 'numeric') { byId('model-note').textContent += ' 约束域计算超出数值范围，未填色。'; byId('model-note').hidden = false; }
      } else plot.dataset.constraintInfo = JSON.stringify({ visible: false });
      data.push(...geometry.lines.map(line => trace(line, next, geometry.extent)));
      const axes = next.axesGeometry(view);
      data.push(...axes.map(line => trace(line, next, geometry.extent)));
      data.push(...axes.map(axis => ({ type: 'scatter', mode: 'text', x: [axis.labelPoint.direct], y: [axis.labelPoint.quadrature],
        text: [axis.axisLabel], textposition: 'top center', textfont: { size: 11, color: next.colors.muted },
        meta: { kind: 'rotor-label', axis: axis.kind }, hoverinfo: 'skip' })));
      data.push(...MotorPreview.vectorTraces(next));
      const narrow = plot.clientWidth < 450, axis = { showgrid: false, zerolinecolor: next.colors.muted, nticks: 8, constrain: 'range' };
      await Plotly.react(plot, data, { width: plot.clientWidth, height: plot.clientHeight, margin: { l: narrow ? 38 : 55, r: narrow ? 11 : 20, t: MotorPreview.plotTopMargin(), b: 37 }, paper_bgcolor: next.colors.surface, plot_bgcolor: next.colors.surface, font: { color: next.colors.text, size: 11 }, showlegend: false, hovermode: false, dragmode: 'pan', uirevision: 'vf-plane', xaxis: { ...axis, range: view.x, title: 'd / pu' }, yaxis: { ...axis, range: view.y, nticks: Math.max(2, Math.min(8, Math.floor((plot.clientHeight - MotorPreview.plotTopMargin() - 37) / 32))), title: 'q / pu', scaleanchor: 'x', scaleratio: 1 } }, MotorPreview.plotConfig(() => { try { view = fitView(); schedule(); } catch (error) { showError(error); } }));
      MotorPreview.decorateViewTools(plot);
      scene = next;
      if (!preview) preview = MotorPreview.create(plot, { change: applyDrag, end: settle });
      preview.setScene(scene);
      if (!preview.active) { view = { x: [...plot._fullLayout.xaxis.range], y: [...plot._fullLayout.yaxis.range] }; preview.hide(); }
      plot.dataset.renderCount = String(++renderCount); plot.dataset.model = JSON.stringify(next.model); plot.dataset.view = JSON.stringify(view);
      plot.dataset.targets = JSON.stringify({ torque: next.torqueTarget, phase: next.phaseTarget });
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
  for (const [kind, field] of Object.entries(lockFields)) byId('lock-' + kind).addEventListener('change', event => {
    lockMessage = '';
    const enabled = event.target.checked, captured = enabled ? VF.capturePointLock(scene?.point, kind) : null;
    if (enabled && (plot.dataset.stale === 'true' || !captured)) { lockMessage = '当前工作点无有效解，不能锁定'; updateLockControls(); return; }
    pointLock = captured;
    if (captured) {
      byId(field).value = kind === 'pf' ? scene.point.phaseAngle : kind === 'voltage' ? scene.model.outputVoltage : captured.value;
      byId('show-' + (kind === 'pf' ? 'phase' : kind)).checked = true;
    }
    updateLockControls(); schedule();
  });
  for (const key of ['voltageLimit', 'currentLimit', 'torque-target', 'phase-target', 'voltage-values', 'color-limit', 'angleDeg']) byId(key).addEventListener('input', schedule);
  for (const [slider, input] of [['speed-slider', 'speedPU']]) {
    byId(slider).addEventListener('input', event => { byId(input).value = event.target.value; previewInput(); });
    byId(slider).addEventListener('change', settle);
    byId(input).addEventListener('input', event => { byId(slider).value = event.target.value; schedule(); });
  }
  document.querySelectorAll('input[type=checkbox],select').forEach(input => input.addEventListener('change', schedule));
  byId('motor-preset').addEventListener('change', event => { if (Rotor.PRESETS[event.target.value]) { loadDefaults(event.target.value); schedule(); } });
  document.addEventListener('pointerup', () => setTimeout(settle, 0), true);
  document.addEventListener('touchend', () => setTimeout(settle, 0), true);
  document.addEventListener('pointercancel', cancel, true); document.addEventListener('touchcancel', cancel, true); window.addEventListener('blur', cancel);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let previousSize = '';
  new ResizeObserver(() => { const size = plot.clientWidth + ':' + plot.clientHeight; if (size !== previousSize) { previousSize = size; view = fitView(view || undefined); schedule(); } }).observe(document.querySelector('.plot-stage'));
  document.querySelectorAll('.analysis-footer details').forEach(panel => panel.addEventListener('toggle', () => { if (panel.open) document.querySelectorAll('.analysis-footer details').forEach(other => { if (other !== panel) other.open = false; }); }));
  loadDefaults(); render();
})();