(() => {
  'use strict';
  const Motor = window.SynchronousMotor, Preview = window.MotorPreview;
  const byId = id => document.getElementById(id);
  const voltageFrame = document.body.classList.contains('vf-page');
  const fields = [
    ['resistance', '定子电阻 Rs', 'Ω', 1], ['ld', 'D轴电感 Ld', 'mH', 1000],
    ['lq', 'Q轴电感 Lq', 'mH', 1000], ['flux', '永磁磁链 ψf', 'Wb', 1]
  ];
  const help = document.createElement('dialog');
  help.id = 'help-dialog'; help.className = 'motor-dialog'; help.setAttribute('aria-labelledby', 'help-title');
  help.innerHTML = `<header><h2 id="help-title">${voltageFrame ? '电压定向分析' : '转子定向分析'} · 帮助</h2><button type="button" class="dialog-close" aria-label="关闭帮助" title="关闭">×</button></header>
    <div class="dialog-body help-copy">
      <p>${voltageFrame ? '在定子电压定向的电流平面中，观察指定电压、频率和转子方向下的稳态工作点，以及所需电压、转矩和功率分布。' : '在转子DQ坐标中，观察电流、电压、转矩、功率及MTPA/MTPV轨迹之间的关系。'}</p>
      <ol><li>选择演示预设，或在左侧输入Rs、Ld、Lq和磁链的标幺值。右上角换算工具可将实际参数转换为pu；预设不是实机铭牌。</li>
      <li>右侧竖滑块调整${voltageFrame ? '电频率' : '转速'}。表格调整U、I、T、φ参考值；“轨迹”和“轨迹组”分别控制当前实线与背景参考线。</li>
      <li>拖动电流或电压矢量端点调整工作点；勾选“锁定”固定当前U、I、T或PF，最多一项，再点解除。φ是电压电流夹角，不是转子相角δ。</li>
      <li>${voltageFrame ? '拖动灰色dᵣ/qᵣ轴改变转子方向。拖动MTPA只更新I/T参考，不移动实际工作点；MTPV为只读参考。电压给定与频率独立。' : '拖动MTPA联动工作点及I/T参考，拖动MTPV联动工作点及U/T参考。色图可选电流或电压坐标；电压映射与电流轨迹分别显示。'}</li>
      <li>空白处拖动平移，滚轮缩放，图内房屋按钮恢复视图。右侧设置控制色图与显示项，底部可展开工作点和模型定义。</li></ol>
      <p class="tool-note">${voltageFrame ? '色图及橙色边界仅表示从零电流径向延拓确认的分支，不是全部解或绝对电流上限。' : '电流和电压矢量采用各自基准，图上长度不能直接比较物理单位。'}稳态模型不判定启动、失步或动态稳定；数值显示最多4位有效数字，计算保留完整精度。</p>
    </div>`;
  const converter = document.createElement('dialog');
  converter.id = 'conversion-dialog'; converter.className = 'motor-dialog'; converter.setAttribute('aria-labelledby', 'conversion-title');
  converter.innerHTML = `<header><h2 id="conversion-title">电机参数 · 标幺换算</h2><button type="button" class="dialog-close" aria-label="关闭换算工具" title="关闭">×</button></header>
    <div class="dialog-body">
      <div class="base-inputs">
        <label for="base-voltage">额定线电压 / V RMS<input id="base-voltage" type="number" min="0" step="any" value="400"></label>
        <label for="base-power">额定功率 / kW<input id="base-power" type="number" min="0" step="any" value="10"></label>
        <label for="base-frequency">额定电频率 / Hz<input id="base-frequency" type="number" min="0" step="any" value="50"></label>
        <label for="base-poles">极对数<input id="base-poles" type="number" min="1" step="1" value="2"></label>
      </div>
      <p class="tool-note">初始额定数据仅为演示。功率作为三相总功率基准，不使用铭牌电流，也不补偿效率或功率因数。参数须为等效星形每相值；三角形绕组、线间电阻或反电动势常数需先换算，不能直接填入。</p>
      <div id="base-results" class="base-results" aria-label="计算基准"></div>
      <table class="conversion-table"><thead><tr><th scope="col">参数</th><th scope="col">实际值</th><th scope="col">标幺值 / pu</th></tr></thead><tbody>${fields.map(([key, label, unit]) => `<tr><th scope="row">${label}<span class="unit">${unit}</span></th><td><input id="convert-${key}-si" type="number" min="0" step="any" aria-label="${label}实际值 ${unit}"></td><td><input id="convert-${key}-pu" type="number" min="0" step="any" aria-label="${label}标幺值"></td></tr>`).join('')}</tbody></table>
      <p class="tool-note">两列可双向编辑；更改基准时保留各行最后编辑的一侧。“读取页面”不改页面参数；“应用到页面”只写入这四项标幺参数，不改频率、工作点参考或限值。</p>
      <details class="base-formulas"><summary>基准公式与单位约定</summary>
        <p>U为额定线电压有效值，P为额定功率（W），f为电频率（Hz），p为极对数。I线,RMS=P/(√3 U)，Ub=√(2/3) U，Ib=√2 I线,RMS。</p>
        <p>ωb=2πf，ω机械,b=ωb/p，Zb=Ub/Ib，Lb=Zb/ωb，ψb=Ub/ωb，Tb=P/ω机械,b。</p>
        <p>Rpu=R/Zb，Ld,q,pu=ωb Ld,q/Zb，ψpu=ωb ψ/Ub；反向换算乘相应基准。磁链采用每相永磁磁链，ωb ψ是相反电动势峰值。</p>
        <p>P=3Ub Ib/2，Tb=3p ψb Ib/2，三相系数已吸收到基准内，因此与本页标幺方程一致。理论基准电流不等同真实额定负载电流。</p>
      </details>
      <p id="conversion-error" class="error-message" role="alert" hidden></p>
      <p id="conversion-status" class="tool-note" role="status"></p>
    </div>
    <footer><button id="conversion-read" type="button">读取页面标幺值</button><button id="conversion-apply" type="button">应用到页面</button></footer>`;
  document.body.append(help, converter);
  const numbers = Preview.createNumericInputs(converter);
  const source = Object.fromEntries(fields.map(([key]) => [key, 'pu']));
  let bases = null, valid = false, initialized = false;
  const locked = () => Boolean(document.querySelector('.trajectory-lock:checked'));
  const currentModel = () => {
    const plot = byId('dq-plot');
    return plot.dataset.stale === 'false' && plot.dataset.model ? JSON.parse(plot.dataset.model) : null;
  };
  function showError(message) {
    byId('conversion-error').textContent = message; byId('conversion-error').hidden = !message;
  }
  function updateButtons() {
    const model = currentModel();
    byId('conversion-read').disabled = !model;
    byId('conversion-apply').disabled = !valid || locked() || !model;
    byId('conversion-apply').title = locked() ? '请先关闭换算工具并解除工作点锁定' : '写入Rs、Ld、Lq和磁链标幺值';
  }
  function update() {
    valid = false; showError(''); byId('conversion-status').textContent = '';
    try {
      bases = Motor.createBases({ voltageRms: numbers.read(byId('base-voltage')), power: numbers.read(byId('base-power')) * 1000,
        frequency: numbers.read(byId('base-frequency')), polePairs: numbers.read(byId('base-poles')) });
      const outputs = [['相电压峰值', bases.voltage, 'V'], ['线电流有效值', bases.currentRms, 'A'], ['相电流峰值', bases.current, 'A'],
        ['基准阻抗', bases.impedance, 'Ω'], ['基准电感', bases.inductance * 1000, 'mH'], ['基准磁链', bases.flux, 'Wb'],
        ['基准转矩', bases.torque, 'N·m'], ['基准电角速度', bases.electricalSpeed, 'rad/s'], ['基准机械转速', bases.mechanicalSpeed * 60 / (2 * Math.PI), 'rpm']];
      byId('base-results').innerHTML = outputs.map(([label, value, unit]) => `<dl><dt>${label}</dt><dd>${Preview.formatNumber(value)} <span>${unit}</span></dd></dl>`).join('');
    } catch {
      bases = null; byId('base-results').replaceChildren();
      showError('电压、功率和频率必须为有限正数，极对数必须为正整数；数值须在可计算范围内。');
    }
    for (const [key, , , multiplier] of fields) {
      const side = source[key], input = byId(`convert-${key}-${side}`), output = byId(`convert-${key}-${side === 'si' ? 'pu' : 'si'}`);
      if (!bases) { numbers.write(output, NaN); continue; }
      try {
        const value = numbers.read(input);
        const converted = Motor.convertParameter(bases, key, side === 'si' ? value / multiplier : value, side === 'si' ? 'toPU' : 'toSI');
        const result = converted * (side === 'si' ? 1 : multiplier);
        if (!Number.isFinite(result) || (value > 0 && result === 0)) throw new RangeError('conversion-range');
        numbers.write(output, result);
      } catch { numbers.write(output, NaN); showError('实际值与标幺值必须为有限非负数，且换算结果不能溢出或下溢。'); }
    }
    valid = Boolean(bases) && byId('conversion-error').hidden;
    if (locked()) byId('conversion-status').textContent = '当前工作点已锁定：可以换算，解除锁定后才能应用。';
    updateButtons();
  }
  function readPage() {
    const model = currentModel();
    if (!model) return;
    for (const [key] of fields) { source[key] = 'pu'; numbers.write(byId(`convert-${key}-pu`), model.pu[key]); }
    initialized = true; update();
  }
  converter.addEventListener('input', event => {
    const match = event.target.id.match(/^convert-(resistance|ld|lq|flux)-(si|pu)$/);
    if (match) source[match[1]] = match[2];
    update();
  });
  byId('conversion-read').addEventListener('click', readPage);
  byId('conversion-apply').addEventListener('click', () => {
    if (!valid || locked() || !currentModel()) return;
    const values = Object.fromEntries(fields.map(([key]) => [key, numbers.read(byId(`convert-${key}-pu`))]));
    try { Motor.createModel({ ...currentModel().input, ...values }); } catch { showError('参数无法应用到当前模型。'); return; }
    for (const [key, value] of Object.entries(values)) { byId(key).value = String(value); byId(key).dispatchEvent(new Event('input', { bubbles: true })); byId(key).dispatchEvent(new Event('change', { bubbles: true })); }
    converter.close();
  });
  for (const [dialog, trigger] of [[help, byId('help-button')], [converter, byId('conversion-button')]]) {
    trigger.addEventListener('click', () => { if (dialog === converter) { if (!initialized) readPage(); else update(); } dialog.showModal(); });
    dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
    });
  }
})();