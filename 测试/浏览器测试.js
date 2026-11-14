const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createServer } = require('../脚本/开发/预览服务.js');
const motorDesktopOnly = process.env.MOTOR_DESKTOP_ONLY === '1';
const motorDesktopViewports = [[1024, 768], [1060, 554], [1366, 768], [1440, 1000], [1920, 1080]];
const defaultTorques = [-3, -2.8, -2.6, -2.4, -2.2, -2, -1.8, -1.6, -1.4, -1.2, -1, -.8, -.6, -.4, -.2, 0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3];
const defaultVoltages = [0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2];
const defaultPhases = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const start = Date.now();
  while (Date.now() - start < 20000) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(), errors = [];
  let next = 1;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  return { call, evaluate, errors, close: () => socket.close() };
}

test(motorDesktopOnly ? '同步电机桌面专项：仅转子定向与VF电压定向' : '真实浏览器：三分类首页、同步电机、PI控制器与PWM功能回归', { timeout: 240000 }, async t => {
  const executable = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  try { await fs.access(executable); } catch { t.skip('未找到Edge，可设置EDGE_PATH'); return; }
  const scratch = path.resolve(__dirname, '../临时测试/2026-10-14-首页整理');
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, '浏览器-'));
  const profile = path.join(temporary, 'profile'); await fs.mkdir(profile);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const visitedPages = [];
  const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const exit = new Promise(resolve => browser.once('exit', resolve));
  let page, control;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(async () => { try { return (await fs.readFile(portFile, 'utf8')).includes('\n'); } catch { return false; } }, '浏览器启动超时');
    const [port, endpoint] = (await fs.readFile(portFile, 'utf8')).trim().split(/\r?\n/);
    control = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    page = await connect(target.webSocketDebuggerUrl); await page.call('Page.enable'); await page.call('Runtime.enable');
    const read = id => page.evaluate(`({...document.getElementById(${JSON.stringify(id)}).dataset})`);
    const click = id => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const change = (id, value, event = 'change') => page.evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    const voltageSnapshot = () => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model);return plot.data.filter(trace=>['voltage','voltage-level'].includes(trace.meta.kind)).map(trace=>{const points=trace.x.flatMap((direct,index)=>direct===null?[]:[{direct,quadrature:trace.y[index]}]);const expected=window.VoltageMotor?VoltageMotor.voltageTrajectory(model,trace.meta.voltage):null;const error=Math.max(0,...points.map((point,index)=>expected?Math.hypot(point.direct-expected[index].direct,point.quadrature-expected[index].quadrature):Math.abs(SynchronousMotor.evaluate(model,point.direct,point.quadrature).voltage-trace.meta.voltage)));const full=plot._fullData.find(item=>item.meta.kind===trace.meta.kind&&item.meta.voltage===trace.meta.voltage);return{voltage:trace.meta.voltage,kind:trace.meta.kind,count:points.length,error,drawn:!!full&&[...plot.querySelectorAll('.trace'+full.uid+' .js-line')].some(path=>path.getTotalLength()>2)}})})()`);
    const trendStyles = () => page.evaluate(`(()=>{const data=document.getElementById('dq-plot').data;return data.filter(trace=>['voltage-level','torque-level','phase-level'].includes(trace.meta.kind)).map(trace=>({kind:trace.meta.kind,value:trace.meta.value,color:trace.line.color,width:trace.line.width,opacity:trace.opacity,count:trace.x.filter(Number.isFinite).length}))})()`);
    const directDragChecks = [];
    const visibilityChecks = [];
    const constraintChecks = [], coupledChecks = [];
    const toolbarChecks = [];
    const vectorChecks = [], safetyChecks = [], optimumFollowChecks = [];
    const presetChecks = [], parameterLayouts = [];
    const motorReset = "(()=>{const preset=document.getElementById('motor-preset');preset.value='ipm';preset.dispatchEvent(new Event('change',{bubbles:true}));})()";
    async function checkParameterLayout(frame) {
      const snapshot = await page.evaluate(`(()=>{const strip=document.getElementById('motor-parameters').getBoundingClientRect(),preset=document.getElementById('motor-preset').getBoundingClientRect(),boxes=selector=>[...document.querySelectorAll(selector)].map(element=>{const box=element.getBoundingClientRect();return{left:box.left,right:box.right,top:box.top,bottom:box.bottom}}).sort((first,second)=>first.top-second.top);return{width:innerWidth,height:innerHeight,strip:{left:strip.left,right:strip.right,top:strip.top,bottom:strip.bottom},preset:{left:preset.left,right:preset.right,top:preset.top,bottom:preset.bottom},fields:[...document.querySelectorAll('.parameter-control input[type=number]')].map(input=>{const box=input.getBoundingClientRect();return{width:box.width,height:box.height,top:box.top,bottom:box.bottom}}),plotHeight:document.getElementById('dq-plot').clientHeight,yTicks:boxes('#dq-plot .yaxislayer-above .ytick text'),speedTicks:boxes('.speed-ticks > span'),speedInputTop:document.getElementById('speedPU').getBoundingClientRect().top,footer:boxes('.analysis-footer > label,.analysis-footer summary'),footerRight:document.querySelector('.analysis-footer').getBoundingClientRect().right}})()`);
      assert.equal(snapshot.fields.length, 4); assert.ok(snapshot.fields.every(field => field.width >= 50 && field.height >= 24));
      assert.ok(snapshot.preset.left >= snapshot.strip.left && snapshot.preset.right <= snapshot.strip.right && snapshot.preset.bottom <= snapshot.strip.bottom);
      if (snapshot.width > 950) {
        for (let index = 1; index < snapshot.fields.length; index++) assert.ok(snapshot.fields[index].top >= snapshot.fields[index - 1].bottom, '基础参数应为四行');
        const arrangement = await page.evaluate(`(()=>{const box=element=>{const rect=element.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};};const blocks=['motor-parameters','trajectory-table','motor-settings'].map(id=>box(document.getElementById(id))),settings=document.getElementById('motor-settings');return{blocks,rows:document.querySelectorAll('#trajectory-table tbody tr').length,cells:[...document.querySelectorAll('#trajectory-table tbody tr')].map(row=>row.querySelectorAll('td').length),fieldsInside:[...settings.querySelectorAll('input,select,label,.color-legend')].filter(element=>!element.hidden&&element.getBoundingClientRect().width>0).every(element=>{const rect=box(element);return rect.left>=blocks[2].left-1&&rect.right<=blocks[2].right+1}),plotTop:document.getElementById('dq-plot').getBoundingClientRect().top};})()`);
        assert.ok(arrangement.blocks[0].right <= arrangement.blocks[1].left && arrangement.blocks[1].right <= arrangement.blocks[2].left, JSON.stringify(arrangement));
        assert.ok(arrangement.blocks.every(block => block.bottom <= arrangement.plotTop), JSON.stringify(arrangement));
        assert.equal(arrangement.rows, 4); assert.deepEqual(arrangement.cells, Array(4).fill(frame === 'rotor' ? 5 : 4)); assert.equal(arrangement.fieldsInside, true, JSON.stringify(arrangement));
        snapshot.arrangement = arrangement;
        const controls = await page.evaluate(`(()=>{const settings=document.getElementById('motor-settings'),labels=[...settings.querySelectorAll('.fixed-options label')],colorRows=[...settings.querySelectorAll('.color-row,.heat-scale')],box=element=>{const rect=element.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom,left:rect.left};};return{labels:labels.map(box),colors:colorRows.map(box),borders:[...document.querySelectorAll('.rotor-control-layout > section')].map(element=>parseFloat(getComputedStyle(element).borderTopWidth)),legends:[...document.querySelectorAll('#trajectory-table tbody th')].every(header=>{const text=[...header.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()),range=document.createRange();range.selectNode(text);return header.querySelector('.line-key').getBoundingClientRect().left>=range.getBoundingClientRect().right;})};})()`);
        assert.deepEqual(controls.borders, [1, 1, 1]); assert.equal(controls.legends, true);
        assert.equal(controls.labels.length, 4); assert.equal(controls.colors.length, 4);
        for (let index = 0; index < 4; index++) {
          assert.ok(Math.abs(controls.labels[index].top - controls.colors[index].top) < 2, JSON.stringify(controls));
          if (index) assert.ok(controls.labels[index].top >= controls.labels[index - 1].bottom, JSON.stringify(controls));
        }
        snapshot.displayControls = controls;
      } else if (snapshot.width > 600) assert.ok(snapshot.fields.every(field => Math.abs(field.top - snapshot.preset.top) < 2 && Math.abs(field.bottom - snapshot.preset.bottom) < 2));
      assert.ok(snapshot.plotHeight >= 120, JSON.stringify(snapshot));
      assert.ok(await page.evaluate("['show-torque-group','show-voltage-group','show-phase-group','show-feasible',...Array.from(document.querySelectorAll('#show-vectors,#show-current-point,#show-voltage-point'),input=>input.id)].every(id=>{const input=document.getElementById(id);return input.closest('.plot-controls')&&input.getBoundingClientRect().bottom<=document.getElementById('dq-plot').getBoundingClientRect().top})"));
      const endpoints = await page.evaluate("(()=>{const plot=document.getElementById('dq-plot'),axes=plot._fullLayout,box=plot.getBoundingClientRect(),left=box.left+plot.clientLeft+axes.xaxis._offset,top=box.top+plot.clientTop+axes.yaxis._offset;return plot.data.filter(trace=>trace.meta.vector&&trace.visible).map(trace=>{const full=plot._fullData.find(item=>item.meta?.kind===trace.meta.kind),marker=[...plot.querySelectorAll('.trace'+full.uid+' .point')].filter(item=>item.getBBox().width>0).at(-1),bounds=marker?.getBoundingClientRect();return{kind:trace.meta.kind,inside:!!bounds&&bounds.left>=left+1&&bounds.right<=left+axes.xaxis._length-1&&bounds.top>=top+1&&bounds.bottom<=top+axes.yaxis._length-1,top:bounds?.top,graphTop:top,bottom:bounds?.bottom,graphBottom:top+axes.yaxis._length}})})()");
      assert.equal(endpoints.length, 2);
      assert.ok(endpoints.every(point => point.inside), JSON.stringify({ width: snapshot.width, height: snapshot.height, endpoints }));
      for (const ticks of [snapshot.yTicks, snapshot.speedTicks]) for (let index = 1; index < ticks.length; index++) assert.ok(ticks[index - 1].bottom <= ticks[index].top + 1, JSON.stringify(snapshot));
      assert.ok(snapshot.speedTicks.at(-1).bottom <= snapshot.speedInputTop);
      if (snapshot.width <= 600 && snapshot.height <= 650) assert.ok(snapshot.footer.every(item => item.bottom - item.top <= 20 && item.right <= snapshot.footerRight + 1), JSON.stringify(snapshot));
      parameterLayouts.push({ frame, ...snapshot });
    }
    async function checkPresets(action, frame) {
      assert.equal(await page.evaluate('document.getElementById("reset")'), null);
      assert.deepEqual(await page.evaluate('[...document.getElementById("motor-preset").options].filter(option=>!option.disabled).map(option=>option.value)'), ['spm', 'ipm', 'synrm']);
      const initialView = JSON.parse((await read('dq-plot')).view);
      const expected = { spm: { resistance: .02, ld: .3, lq: .3, flux: .8 }, ipm: { resistance: .02, ld: .2, lq: .4, flux: .8 }, synrm: { resistance: .02, ld: 1.2, lq: .4, flux: 0 } };
      const press = async (key, code) => {
        await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
        await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
      };
      for (const [index, key] of ['spm', 'ipm', 'synrm'].entries()) {
        await action(`(()=>{const edits={resistance:.13,speedPU:-.5,voltageLimit:1.5,currentLimit:2,'torque-target':.3,'phase-target':30};for(const [key,value]of Object.entries(edits)){const input=document.getElementById(key);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
        assert.equal(await page.evaluate('document.getElementById("motor-preset").value'), '');
        await page.evaluate('document.getElementById("motor-preset").focus()');
        await press('Home', 36);
        for (let step = 0; step < index; step++) await press('ArrowDown', 40);
        await page.evaluate('document.getElementById("motor-preset").blur()');
        await until(() => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model);return document.getElementById('motor-preset').value==='${key}'&&plot.dataset.previewActive!=='true'&&Object.entries(${JSON.stringify(expected[key])}).every(([name,value])=>model.pu[name]===value)})()`), '原生预设选择未更新模型');
        const state = await read('dq-plot'), model = JSON.parse(state.model), targets = JSON.parse(state.targets), view = JSON.parse(state.view);
        assert.deepEqual(model.pu, expected[key]); assert.equal(model.input.speedPU, 1); assert.equal(model.input.currentLimit, 1); assert.equal(model.input.voltageLimit, frame === 'voltage' ? .8 : 1);
        assert.deepEqual(targets, { torque: 1, phase: 0 });
        for (const axis of ['x', 'y']) for (let boundary = 0; boundary < 2; boundary++) assert.ok(Math.abs(view[axis][boundary] - initialView[axis][boundary]) < 1e-7);
        if (frame === 'voltage') assert.ok(JSON.parse((await read('probe-readout')).point).feasible);
        await action(`(()=>{const input=document.getElementById('lq');input.value=${expected[key].lq + .07};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        assert.equal(await page.evaluate('document.getElementById("motor-preset").value'), '');
        assert.equal(JSON.parse((await read('dq-plot')).model).pu.lq, expected[key].lq + .07);
        presetChecks.push({ frame, key, parameters: expected[key], keyboardSelected: true, editable: true, viewPreserved: true });
      }
      for (const invalidField of ['resistance', 'torque-target']) {
        await action(motorReset);
        const before = Number((await read('dq-plot')).renderCount);
        await change(invalidField, '', 'input');
        await until(async () => (await read('dq-plot')).stale === 'true', '无效输入没有被拒绝');
        assert.equal(await page.evaluate('document.getElementById("motor-preset").value'), '');
        await page.evaluate('document.getElementById("motor-preset").focus()');
        await press('Home', 36); await press('ArrowDown', 40);
        await page.evaluate('document.getElementById("motor-preset").blur()');
        await until(() => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return plot.dataset.stale==='false'&&Number(plot.dataset.renderCount)>${before}&&document.getElementById('motor-preset').value==='ipm'&&document.getElementById('${invalidField}').valueAsNumber===${invalidField === 'resistance' ? .02 : 1}})()`), '无效输入后未通过预设恢复');
        presetChecks.push({ frame, invalidField, keyboardRestored: true });
      }
      await action(motorReset); await checkParameterLayout(frame);
    }
    async function resetVectorPoint(action, frame) {
      await action(motorReset);
      if (frame === 'rotor') {
        await action("document.getElementById('probe-d').value=-.5;document.getElementById('probe-q').value=.7;document.getElementById('probe-d').dispatchEvent(new Event('change',{bubbles:true}))");
        await action(motorReset);
      }
      await action("document.querySelectorAll('#show-vectors,#show-current-point,#show-voltage-point').forEach(input=>{input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));})");
      await action('document.getElementById("reset-view").click()');
    }
    async function pointerSnapshot(expected) {
      const result = await page.evaluate("(()=>{const plot=document.getElementById('dq-plot'),marker=document.getElementById('pointer-cursor'),box=marker.getBoundingClientRect(),pointer=JSON.parse(plot.dataset.dragPointer),anchor=JSON.parse(plot.dataset.dragAnchor);return{hidden:marker.hidden,x:box.left+box.width/2,y:box.top+box.height/2,pointer,anchor,distance:Math.hypot(pointer.x-anchor.x,pointer.y-anchor.y),cursor:getComputedStyle(plot).cursor};})()");
      assert.equal(result.hidden, false); assert.notEqual(result.cursor, 'none');
      assert.ok(Math.abs(result.x - expected.x) < 2 && Math.abs(result.y - expected.y) < 2, JSON.stringify({ expected, result }));
      return result;
    }
    async function dragVector(frame, kind, target, touch = false, blocked = false, projected = false) {
      const vfCurrent = frame === 'voltage' && kind === 'current-vector', activeLocks = JSON.parse((await read('dq-plot')).locks || '{}');
      const fixedSource = vfCurrent && Boolean(activeLocks.voltage);
      const referenceValues = await page.evaluate('["currentLimit","voltageLimit","torque-target","phase-target"].map(id=>document.getElementById(id).valueAsNumber)');
      const fixedKinds = frame === 'rotor' ? ['current', 'voltage', 'phase', 'mapped-current', 'mapped-voltage', 'mapped-phase'] : vfCurrent ? ['current', 'phase', ...(fixedSource ? ['voltage'] : [])] : [];
      const fixedExpression = `JSON.stringify(document.getElementById('dq-plot').data.filter(trace=>${JSON.stringify(fixedKinds)}.includes(trace.meta.kind)).map(trace=>[trace.meta.kind,trace.meta.value,trace.x,trace.y]))`;
      const fixedCurves = await page.evaluate(fixedExpression);
      let previousCount = -1;
      await until(async () => { const state = await read('dq-plot'), count = Number(state.renderCount), ready = count === previousCount && state.previewActive !== 'true'; previousCount = count; return ready; }, '矢量拖动前未稳定');
      const start = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),box=plot.getBoundingClientRect(),layout=plot._fullLayout,point=JSON.parse(document.getElementById('probe-readout').dataset.point),target=${JSON.stringify(target)};const pixel=(direct,quadrature)=>({x:box.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis.d2p(direct),y:box.top+plot.clientTop+layout.yaxis._offset+layout.yaxis.d2p(quadrature)});return{from:pixel('${kind}'==='current-vector'?point.direct:point.vd,'${kind}'==='current-vector'?point.quadrature:'${frame}'==='voltage'?0:point.vq),to:pixel(target.direct,target.quadrature),point,count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0),view:plot.dataset.view}})()`);
      if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start.from, id: 49, radiusX: 1, radiusY: 1, force: 1 }] });
      else {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start.from });
        assert.equal((await read('dq-plot')).curveHover, kind);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start.from, button: 'left', clickCount: 1 });
      }
      let held;
      try {
        for (let step = 1; step <= 5; step++) {
          const position = { x: start.from.x + (start.to.x - start.from.x) * step / 5, y: start.from.y + (start.to.y - start.from.y) * step / 5 };
          if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...position, id: 49, radiusX: 1, radiusY: 1, force: 1 }] });
          else await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position, button: 'left', buttons: 1 });
        }
        await until(() => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),point=JSON.parse(document.getElementById('probe-readout').dataset.point),vectors=JSON.parse(plot.dataset.previewVectors||'[]'),current=vectors.find(vector=>vector.kind==='current-vector');return plot.dataset.curveDragging==='true'&&Number(plot.dataset.previewFrameCount)>${start.frames}&&current&&Math.abs(current.point.direct-point.direct)<1e-8&&Math.abs(current.point.quadrature-point.quadrature)<1e-8})()`), '矢量未实时同步');
        held = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),point=JSON.parse(document.getElementById('probe-readout').dataset.point),input=JSON.parse(plot.dataset.previewModel),model=SynchronousMotor.createModel(input),reference=SynchronousMotor.evaluate(model,'${frame}'==='voltage'?point.rotorDirect:point.direct,'${frame}'==='voltage'?point.rotorQuadrature:point.quadrature),vectors=JSON.parse(plot.dataset.previewVectors),view=JSON.parse(plot.dataset.previewView),canvas=document.getElementById('drag-curves'),context=canvas.getContext('2d');const pixels=vectors.map(vector=>{const column=Math.round((vector.point.direct-view.x[0])/(view.x[1]-view.x[0])*canvas.width),row=Math.round((view.y[1]-vector.point.quadrature)/(view.y[1]-view.y[0])*canvas.height);return column>6&&column<canvas.width-6&&row>6&&row<canvas.height-6?{kind:vector.kind,rgba:[...context.getImageData(column,row,1,1).data]}:null}).filter(Boolean);return{point,reference,vectors,pixels,input,values:['currentLimit','voltageLimit','torque-target','phase-target'].map(id=>document.getElementById(id).valueAsNumber),kind:plot.dataset.curveDragKind,blocked:plot.dataset.dragBlocked==='true',stale:plot.dataset.stale,count:Number(plot.dataset.renderCount),view:plot.dataset.view,liveView:plot.dataset.previewView,plotlyDragging:Boolean(plot._dragging)}})()`);
        assert.equal(held.kind, kind); if (blocked !== null) assert.equal(held.blocked, blocked); assert.equal(held.stale, 'false'); assert.equal(held.count, start.count); assert.equal(held.view, start.view); assert.equal(held.plotlyDragging, false);
        for (const key of ['current', 'voltage', 'torque']) assert.ok(Math.abs(held.point[key] - held.reference[key]) < 1e-8);
        held.pointer = await pointerSnapshot(start.to);
        const expected = frame === 'rotor' ? [referenceValues[0], referenceValues[1], held.point.torque, referenceValues[3]] : vfCurrent ? [referenceValues[0], held.point.voltage, held.point.torque, referenceValues[3]] : [held.point.current, held.point.voltage, held.point.torque, held.point.phaseAngle];
        for (let index = 0; index < expected.length; index++) assert.ok(Number.isFinite(held.values[index]) && Math.abs(held.values[index] - expected[index]) < 1e-7, JSON.stringify({ kind, held }));
        assert.equal(held.vectors.length, 2); assert.ok(held.pixels.length > 0 && held.pixels.every(pixel => pixel.rgba[3] > 200));
        if (frame === 'voltage') { assert.equal(held.input.voltageMode, 'manual'); assert.equal(held.vectors.find(vector => vector.kind === 'voltage-vector').point.quadrature, 0); }
        if (frame === 'voltage') {
          const axes = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.previewView),canvas=document.getElementById('drag-curves');return JSON.parse(plot.dataset.previewAxes).map(axis=>{const column=Math.round((axis.point.direct-view.x[0])/(view.x[1]-view.x[0])*canvas.width),row=Math.round((view.y[1]-axis.point.quadrature)/(view.y[1]-view.y[0])*canvas.height);const inside=column>4&&column<canvas.width-4&&row>4&&row<canvas.height-4;return{...axis,inside,alpha:inside?Math.max(...[...canvas.getContext('2d').getImageData(column-3,row-3,7,7).data].filter((value,index)=>index%4===3)):null};});})()`);
          assert.equal(axes.length, 2);
          const direct = axes.find(axis => axis.kind === 'rotor-axis-d'), length = Math.hypot(direct.point.direct, direct.point.quadrature), angle = held.point.angleDeg * Math.PI / 180;
          assert.ok(Math.abs(direct.point.direct / length - Math.cos(angle)) < 1e-8 && Math.abs(direct.point.quadrature / length + Math.sin(angle)) < 1e-8);
          assert.ok(axes.filter(axis => axis.inside).every(axis => axis.alpha > 0), JSON.stringify(axes)); held.axes = axes;
          if (fixedSource) { assert.equal(held.input.voltageLimit, referenceValues[1]); assert.ok(Math.abs(held.point.voltage - referenceValues[1]) < 1e-8); }
        }
        if (!blocked && !projected) {
          const actual = kind === 'current-vector' ? { direct: held.point.direct, quadrature: held.point.quadrature } : { direct: held.point.vd, quadrature: frame === 'voltage' ? 0 : held.point.vq };
          assert.ok(Math.abs(actual.direct - target.direct) < .035 && Math.abs(actual.quadrature - (kind === 'voltage-vector' && frame === 'voltage' ? 0 : target.quadrature)) < .035, JSON.stringify({ actual, target }));
        }
        if (vfCurrent && activeLocks.current && !touch) {
          assert.ok(held.pointer.distance > 5, '受约束工作点与实际鼠标应分别显示');
          const shot = await page.call('Page.captureScreenshot', {});
          await fs.writeFile(path.resolve(__dirname, '../临时测试/2026-11-13-VF工作点/VF-鼠标与约束点.png'), Buffer.from(shot.data, 'base64'));
        }
      } finally {
        if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        else await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start.to, button: 'left', clickCount: 1 });
      }
      await until(async () => { const state = await read('dq-plot'); return state.curveDragging === 'false' && state.previewActive === 'false'; }, '矢量拖动未结束');
      assert.ok(await page.evaluate('document.getElementById("pointer-cursor").hidden&&document.getElementById("dq-plot").dataset.dragPointer===undefined'));
      const final = await page.evaluate("document.getElementById('dq-plot').data.filter(trace=>trace.meta.vector).map(trace=>({kind:trace.meta.kind,visible:trace.visible,x:trace.x,y:trace.y}))");
      for (const vector of final) {
        assert.equal(vector.visible, true); assert.equal(vector.x[0], 0); assert.equal(vector.y[0], 0);
        const live = held.vectors.find(item => item.kind === vector.kind).point;
        assert.ok(Math.abs(vector.x[1] - live.direct) < 1e-8 && Math.abs(vector.y[1] - live.quadrature) < 1e-8);
      }
      assert.equal(await page.evaluate(fixedExpression), fixedCurves, '拖动不得修改未联动的参考曲线');
      vectorChecks.push({ frame, kind, touch, blocked, projected, point: held.point, pixels: held.pixels, axes: held.axes, pointer: held.pointer, referenceValues, resultingValues: held.values, torqueOnly: frame === 'rotor' || fixedSource, fixedSource, fullRedrawsWhileHeld: 0 });
      return held;
    }
    async function checkVectors(action, frame, touch = false) {
      await resetVectorPoint(action, frame);
      const point = (await read('probe-readout')).point;
      assert.equal(await page.evaluate('document.querySelector("#show-current-point,#show-voltage-point")'), null);
      if (!touch) for (const id of ['show-vectors']) {
        await action(`document.getElementById('${id}').click()`);
        const kinds = ['current', 'voltage'];
        for (const kind of kinds) assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='${kind}-vector').visible`), false);
        assert.equal((await read('probe-readout')).point, point);
        await action(`document.getElementById('${id}').click()`);
        for (const kind of kinds) assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='${kind}-vector').visible`), true);
      }
      const currentTarget = frame === 'rotor' ? { direct: -.4, quadrature: 1 } : await page.evaluate("(()=>{const point=JSON.parse(document.getElementById('probe-readout').dataset.point);return{direct:point.direct+.2,quadrature:point.quadrature+.2};})()");
      const freeMove = await dragVector(frame, 'current-vector', currentTarget, touch);
      if (frame === 'voltage') assert.ok(Math.abs(freeMove.point.voltage - JSON.parse(point).voltage) > .01, '未锁电压时U必须可以变化');
      const voltage = frame === 'rotor' ? await page.evaluate("(()=>{const model=JSON.parse(document.getElementById('dq-plot').dataset.model),point=SynchronousMotor.evaluate(model,-.8,.3);return{direct:point.vd,quadrature:point.vq}})()") : { direct: 1.2, quadrature: .5 };
      const before = JSON.parse((await read('probe-readout')).point);
      const moved = await dragVector(frame, 'voltage-vector', voltage, touch);
      if (frame === 'voltage') assert.ok(Math.abs(moved.point.angleDeg - before.angleDeg) < 1e-7);
      await resetVectorPoint(action, frame);
    }
    async function checkVectorSafety(action, frame) {
      await resetVectorPoint(action, frame);
      if (frame === 'rotor') {
        const stopped = await dragVector(frame, 'current-vector', { direct: 0, quadrature: 0 }, false, true);
        assert.ok(stopped.point.current > 0 && stopped.point.quadrature > 0);
        await dragVector(frame, 'current-vector', { direct: -.4, quadrature: .8 });
        safetyChecks.push({ frame, kind: 'zero-current', retained: true, resumed: true });
      } else {
        const stopped = await dragVector(frame, 'voltage-vector', { direct: -.2, quadrature: .4 }, false, true);
        assert.ok(stopped.point.voltage > 0);
        await dragVector(frame, 'voltage-vector', { direct: .7, quadrature: .2 });
        safetyChecks.push({ frame, kind: 'zero-voltage', retained: true, resumed: true });
        await resetVectorPoint(action, frame);
        const held = await dragVector(frame, 'current-vector', { direct: 0, quadrature: 0 }, false, null);
        assert.ok(held.point.current > 0 && held.point.voltage > 0);
        const target = await page.evaluate("(()=>{const model=JSON.parse(document.getElementById('dq-plot').dataset.model),point=VoltageMotor.atAngle(model,100);return{direct:point.direct,quadrature:point.quadrature};})()");
        await dragVector(frame, 'current-vector', target);
        const freeMove = await dragVector(frame, 'current-vector', { direct: .9, quadrature: .4 });
        assert.ok(Math.hypot(freeMove.point.direct - .9, freeMove.point.quadrature - .4) < .035);
        safetyChecks.push({ frame, kind: 'free-source-zero-current', retained: true, resumed: true, freePointerFollowed: true });
      }
      await resetVectorPoint(action, frame);
    }
    async function checkToolbar(frame, touch = false) {
      const snapshot = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),box=plot.getBoundingClientRect();return{width:innerWidth,mode:plot.layout.dragmode,wheel:plot._context.scrollZoom,model:plot.dataset.model,targets:plot.dataset.targets,probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible,buttons:[...plot.querySelectorAll('.modebar-btn')].map(button=>{const bounds=button.getBoundingClientRect();return{id:button.id,width:bounds.width,height:bounds.height,top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right,label:button.getAttribute('aria-label'),icon:!!button.querySelector('svg path')}}),plotRight:box.right,graphTop:box.top+plot.clientTop+plot._fullLayout.yaxis._offset}})()`);
      assert.deepEqual(snapshot.buttons.map(button => button.id), ['zoom-in', 'zoom-out', 'reset-view']);
      assert.equal(snapshot.mode, 'pan'); assert.equal(snapshot.wheel, true);
      for (const button of snapshot.buttons) {
        assert.ok(button.icon && button.label);
        assert.ok(button.width >= (touch ? 44 : 32) && button.height >= (touch ? 44 : 32));
        assert.ok(button.right <= snapshot.plotRight && button.bottom <= snapshot.graphTop);
      }
      const press = async id => {
        const before = Number((await read('dq-plot')).renderCount);
        const point = await page.evaluate(`(()=>{const box=document.getElementById('${id}').getBoundingClientRect();return{x:box.left+box.width/2,y:box.top+box.height/2}})()`);
        if (touch) {
          await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 45, radiusX: 1, radiusY: 1, force: 1 }] });
          await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        }
        await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > before && state.previewActive !== 'true'; }, '图内工具未完成重绘');
        return JSON.parse((await read('dq-plot')).view);
      };
      const baseline = await press('reset-view'), closer = await press('zoom-in'), farther = await press('zoom-out');
      const span = view => view.x[1] - view.x[0];
      assert.ok(span(closer) < span(baseline)); assert.ok(span(farther) > span(closer));
      if (!touch) {
        const before = Number((await read('dq-plot')).renderCount);
        const point = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),box=plot.getBoundingClientRect(),layout=plot._fullLayout;return{x:box.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis._length*.5,y:box.top+plot.clientTop+layout.yaxis._offset+layout.yaxis._length*.5}})()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -100 });
        await until(async () => Number((await read('dq-plot')).renderCount) > before, '滚轮未缩放');
        assert.ok(span(JSON.parse((await read('dq-plot')).view)) < span(farther));
      }
      const restored = await press('reset-view');
      for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(restored[axis][index] - baseline[axis][index]) < 1e-7);
      const state = await read('dq-plot'); assert.equal(state.model, snapshot.model); assert.equal(state.targets, snapshot.targets);
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="current-vector").visible'), snapshot.probe);
      toolbarChecks.push({ frame, touch, ...snapshot, zoomIn: true, zoomOut: true, restored: true });
    }
    async function checkConstraint(action, frame) {
      const snapshot = await page.evaluate(`(async()=>{
        const plot=document.getElementById('dq-plot'),trace=plot.data.find(trace=>trace.meta.kind==='feasible'),model=JSON.parse(plot.dataset.model);let mismatch=0;
        for(let row=0;row<trace.y.length;row+=8)for(let column=0;column<trace.x.length;column+=8){const direct=trace.x[column],quadrature=trace.y[row];const expected=${frame === 'voltage' ? 'Math.hypot(direct,quadrature)<=model.input.currentLimit+1e-10&&VoltageMotor.requiredVoltage(model,direct,quadrature)<=model.outputVoltage+1e-10' : 'SynchronousMotor.evaluate(model,direct,quadrature).feasible'};if((trace.z[row][column]===1)!==expected)mismatch++;}
        const element=[...plot.querySelectorAll('.heatmaplayer image')].at(-1),image=new Image();image.src=element.getAttribute('href')||element.getAttribute('xlink:href');await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let filled=0;for(let offset=3;offset<pixels.length;offset+=4)if(pixels[offset])filled++;let opacity=1;for(let node=element;node&&node!==plot;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);
        return{frame:'${frame}',checked:document.getElementById('show-feasible').checked,opacity,traceOpacity:trace.opacity,dimension:trace.meta.dimension,voltage:trace.meta.voltageLimit,current:trace.meta.currentLimit,mismatch,filled,pixels:canvas.width*canvas.height};
      })()`);
      assert.equal(snapshot.checked, true); assert.equal(snapshot.dimension, 2); assert.equal(snapshot.mismatch, 0);
      assert.equal(snapshot.traceOpacity, .22); assert.ok(Math.abs(snapshot.opacity - .22) < 1e-6);
      assert.ok(snapshot.filled > 0 && snapshot.filled < snapshot.pixels);
      await action('document.getElementById("show-feasible").click()');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.kind==="feasible")'), false);
      await action('document.getElementById("show-feasible").click()');
      constraintChecks.push(snapshot);
    }
    const constraintPixels = points => page.evaluate(`(()=>{
      const plot=document.getElementById('dq-plot'),canvas=document.getElementById('drag-feasible'),view=JSON.parse(plot.dataset.previewView),meta=JSON.parse(plot.dataset.previewConstraint),voltageFrame=typeof VoltageMotor==='object';
      if(!meta.visible)return{visible:false,samples:[]};
      const model=voltageFrame?VoltageMotor.createModel(JSON.parse(plot.dataset.previewModel)):SynchronousMotor.createModel(JSON.parse(plot.dataset.previewModel));
      const requested=${JSON.stringify(points)}.filter(([direct,quadrature])=>direct>view.x[0]&&direct<view.x[1]&&quadrature>view.y[0]&&quadrature<view.y[1]);if(!requested.length)requested.push([(view.x[0]+view.x[1])/2,(view.y[0]+view.y[1])/2]);
      return{visible:getComputedStyle(canvas).display!=='none',dimension:meta.dimension,status:meta.status,samples:requested.map(([horizontal,vertical])=>{const column=Math.max(0,Math.min(canvas.width-1,Math.floor((horizontal-view.x[0])/(view.x[1]-view.x[0])*canvas.width))),row=Math.max(0,Math.min(canvas.height-1,Math.floor((view.y[1]-vertical)/(view.y[1]-view.y[0])*canvas.height)));const direct=view.x[0]+(column+.5)/canvas.width*(view.x[1]-view.x[0]),quadrature=view.y[1]-(row+.5)/canvas.height*(view.y[1]-view.y[0]);const expected=voltageFrame?Math.hypot(direct,quadrature)<=model.input.currentLimit+1e-10&&VoltageMotor.requiredVoltage(model,direct,quadrature)<=model.outputVoltage+1e-10:SynchronousMotor.evaluate(model,direct,quadrature).feasible;return{direct,quadrature,expected,rgba:[...canvas.getContext('2d').getImageData(column,row,1,1).data]};})};
    })()`);
    function assertConstraintPixels(result) {
      if (!result.visible || result.status === 'numeric' || result.dimension === 0 || result.dimension === 1) return;
      for (const sample of result.samples) assert.ok(sample.expected ? Math.abs(sample.rgba[3] - 56) <= 2 : sample.rgba[3] === 0, JSON.stringify(sample));
    }
    async function checkVisibility(action, frame) {
      for (const kind of ['mtpa', 'mtpv']) {
        await action(`document.getElementById('show-${kind}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}')`), false);
        await action(`document.getElementById('show-${kind}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}')`), true);
        visibilityChecks.push({ frame, kind, independentToggle: true });
      }
      for (const kind of ['torque', 'voltage', 'phase']) {
        const selected = await page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='${kind}').meta.value`);
        await action(`document.getElementById('show-${kind}-group').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}-level')`), false);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='${kind}').meta.value`), selected);
        await action(`document.getElementById('show-${kind}-group').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}-level')`), true);
        await action(`document.getElementById('show-${kind}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}')`), false);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}-level')`), true);
        const styles = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return plot._fullData.filter(trace=>trace.meta?.kind==='${kind}-level').flatMap(trace=>[...plot.querySelectorAll('.trace'+trace.uid+' .js-line')].map(line=>getComputedStyle(line).strokeDasharray))})()`);
        assert.ok(styles.length > 0 && styles.every(dash => dash !== 'none'));
        await action(`document.getElementById('show-${kind}-group').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}'||trace.meta.kind==='${kind}-level')`), false);
        await action(`document.getElementById('show-${kind}').click();document.getElementById('show-${kind}-group').click()`);
        visibilityChecks.push({ frame, kind: kind + '-group', currentRetained: true, backgroundRetained: true, fourStates: true, svgDashed: true });
      }
    }
    const blankStart = () => page.evaluate(`(()=>{
      const plot=document.getElementById('dq-plot'),box=plot.getBoundingClientRect(),layout=plot._fullLayout,view=JSON.parse(plot.dataset.view),size={width:layout.xaxis._length,height:layout.yaxis._length};
      const lines=plot.data.filter(trace=>trace.visible!==false&&(trace.meta.draggable||['torque','voltage','current','phase'].includes(trace.meta.kind))).map(trace=>({kind:trace.meta.kind,value:trace.meta.value,draggable:trace.meta.draggable,vector:trace.meta.vector,dots:trace.mode==='markers',branches:trace.x.reduce((branches,direct,index)=>{if(direct===null){if(branches.at(-1).length)branches.push([]);}else branches.at(-1).push({direct,quadrature:trace.y[index]});return branches;},[[]]).filter(branch=>branch.length)}));
      for(const horizontal of [.08,.04,.12,.18])for(const vertical of [.6,.35,.8,.2,.5,.9,.1]){
        const position={x:size.width*horizontal,y:size.height*vertical};
        if(MotorPreview.pickCurve(lines,view,size,position,18))continue;
        return{count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0),builds:JSON.parse(plot.dataset.previewMetrics||'{}').geometryBuilds||0,view,input:JSON.parse(plot.dataset.model).input,targets:JSON.parse(plot.dataset.targets),start:{x:box.left+plot.clientLeft+layout.xaxis._offset+position.x,y:box.top+plot.clientTop+layout.yaxis._offset+position.y},width:size.width};
      }
      throw new Error('No blank plot area for pan');
    })()`);
    async function dragCurve(kind, target, touch = false, cancel = false) {
      const inputId = ['torque', 'phase'].includes(kind) ? kind + '-target' : kind + 'Limit';
      const previewValue = ['torque', 'phase'].includes(kind) ? `JSON.parse(state.previewTargets).${kind}` : `JSON.parse(state.previewModel)['${kind}Limit']`;
      let previousCount = -1;
      await until(async () => { const state = await read('dq-plot'), count = Number(state.renderCount); const ready = count === previousCount && state.previewActive !== 'true'; previousCount = count; return ready; }, '曲线拖动前未完成重绘');
      const start = await page.evaluate(`(()=>{
        const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),bounds=JSON.parse(plot.dataset.view),layout=plot._fullLayout,box=plot.getBoundingClientRect();
        const frame=typeof VoltageMotor==='object'?'voltage':'rotor',kind=${JSON.stringify(kind)},target=${target};
        const trace=plot.data.find(trace=>trace.meta.kind===kind),size={width:layout.xaxis._length,height:layout.yaxis._length};
        const pointAt=(direct,quadrature)=>({direct,quadrature});
        const screen=point=>({x:layout.xaxis.d2p(point.direct),y:layout.yaxis.d2p(point.quadrature)});
        const absolute=point=>({x:box.left+plot.clientLeft+layout.xaxis._offset+point.x,y:box.top+plot.clientTop+layout.yaxis._offset+point.y});
        const inside=point=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>16&&point.y>16&&point.x<size.width-16&&point.y<size.height-16;
        const lines=plot.data.filter(trace=>trace.visible!==false&&(trace.meta.draggable||['torque','current','voltage','phase'].includes(trace.meta.kind))).map(trace=>({kind:trace.meta.kind,value:trace.meta.value,draggable:trace.meta.draggable,vector:trace.meta.vector,dots:trace.mode==='markers',branches:trace.x.reduce((branches,direct,index)=>{if(direct===null){if(branches.at(-1).length)branches.push([]);}else branches.at(-1).push(pointAt(direct,trace.y[index]));return branches;},[[]]).filter(branch=>branch.length)}));
        let source=frame==='voltage'&&kind==='voltage'?VoltageMotor.trajectory(model):trace.x.map((direct,index)=>direct===null?null:pointAt(direct,trace.y[index]));
        if(frame==='voltage'&&kind==='phase'){const end=source.filter(Boolean).at(-1);source=Array.from({length:240},(_,index)=>pointAt(end.direct*(index+1)/240,end.quadrature*(index+1)/240));}
        const destinations=frame==='voltage'&&kind==='torque'?VoltageMotor.torqueCurves(model,target,bounds).flat().filter(Boolean):frame==='rotor'&&kind==='phase'?SynchronousMotor.phaseAngleCurves(model,target,Math.max(...bounds.x.map(Math.abs),...bounds.y.map(Math.abs)),1000,bounds).flat().filter(Boolean):[];
        const otherLines=lines.filter(line=>line.kind!==kind);
        for(const point of source){
          if(!point)continue;const from=screen(point);if(!inside(from)||MotorPreview.pickCurve(lines,bounds,size,from,${touch ? 12 : 8})?.kind!==kind||MotorPreview.pickCurve(otherLines,bounds,size,from,${touch ? 18 : 12}))continue;
          let destination;
          if(kind==='current'){const scale=target/Math.hypot(point.direct,point.quadrature);destination=pointAt(point.direct*scale,point.quadrature*scale);}
          else if(kind==='phase'&&frame==='voltage'){const radius=Math.hypot(point.direct,point.quadrature),angle=target*Math.PI/180;destination=pointAt(radius*Math.cos(angle),-radius*Math.sin(angle));}
          else if(kind==='phase')destination=destinations.filter(candidate=>Math.abs(candidate.direct-point.direct)<1e-7).sort((first,second)=>Math.abs(first.quadrature-point.quadrature)-Math.abs(second.quadrature-point.quadrature))[0];
          else if(frame==='voltage'&&kind==='voltage')destination=VoltageMotor.atVoltage(model,target,point.angleDeg);
          else if(frame==='voltage')destination=destinations.filter(candidate=>Math.abs(candidate.quadrature-point.quadrature)<1e-7).sort((first,second)=>Math.abs(first.direct-point.direct)-Math.abs(second.direct-point.direct))[0];
          else if(kind==='torque')destination=pointAt(point.direct,target/(model.pu.flux+(model.pu.ld-model.pu.lq)*point.direct));
          else{const voltage=SynchronousMotor.evaluate(model,point.direct,point.quadrature);destination=SynchronousMotor.currentAtVoltage(model,target,Math.atan2(voltage.vq,voltage.vd));}
          if(!destination)continue;const to=screen(destination);if(!inside(to)||Math.hypot(to.x-from.x,to.y-from.y)<8)continue;
          const continuous=MotorPreview.advanceDrag((position,value,previous)=>MotorPreview.curveDragValue({model,frame},{kind,angleDeg:point.angleDeg},position,previous),point,destination,trace.meta.value);
          if(continuous.blocked)continue;
          return{from:absolute(from),to:absolute(to),frame,count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0),view:plot.dataset.view,probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible};
        }
        throw new Error('No isolated visible curve segment: '+JSON.stringify({frame,kind,target,bounds,size,value:trace.meta.value}));
      })()`);
      if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start.from, id: 31, radiusX: 1, radiusY: 1, force: 1 }] });
      else {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start.from });
        assert.equal((await read('dq-plot')).curveHover, kind);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start.from, button: 'left', clickCount: 1 });
      }
      let held;
      try {
        for (let step = 1; step <= 4; step++) {
          const position = { x: start.from.x + (start.to.x - start.from.x) * step / 4, y: start.from.y + (start.to.y - start.from.y) * step / 4 };
          if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...position, id: 31, radiusX: 1, radiusY: 1, force: 1 }] });
          else await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position, button: 'left', buttons: 1 });
        }
        await until(() => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),state=plot.dataset,input=Number(document.getElementById('${inputId}').value);if(state.curveDragging!=='true'||state.previewActive!=='true'||Number(state.previewFrameCount)<=${start.frames})return false;const value=${previewValue};return Math.abs(value-input)<1e-9})()`), '直接拖动未实时预览最新参数');
        held = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return{kind:plot.dataset.curveDragKind,value:Number(document.getElementById('${inputId}').value),count:Number(plot.dataset.renderCount),view:plot.dataset.view,liveView:JSON.parse(plot.dataset.previewView),plotlyDragging:Boolean(plot._dragging),mode:JSON.parse(plot.dataset.previewModel).voltageMode,probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible}})()`);
        assert.equal(held.kind, kind); assert.ok(Math.abs(held.value - target) < (kind === 'phase' ? .15 : .035), JSON.stringify({ start, held, target }));
        assert.equal(held.count, start.count, '按住曲线时不得整图重绘'); assert.equal(held.view, start.view, '曲线调节不得误平移'); assert.equal(held.probe, start.probe);
        assert.equal(held.plotlyDragging, false, '曲线手势不得启动Plotly平移');
        const readout = await page.evaluate('({text:document.getElementById("curve-drag-readout").textContent,hidden:document.getElementById("curve-drag-readout").hidden,cursorHidden:document.getElementById("curve-cursor").hidden,color:getComputedStyle(document.getElementById("curve-cursor"),"::before").backgroundColor})');
        assert.equal(readout.hidden, false); assert.equal(readout.cursorHidden, false); assert.equal(readout.color, 'rgb(0, 0, 0)');
        assert.ok(readout.text.includes({ torque: 'T=', current: '|I|=', voltage: '|U|=', phase: 'φ=' }[kind]));
        for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(held.liveView[axis][index] - JSON.parse(start.view)[axis][index]) < 1e-7, '预览视野不得随曲线手势平移');
        if (start.frame === 'voltage' && kind === 'voltage') assert.equal(held.mode, 'manual');
      } finally {
        if (touch) await page.call('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
        else await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start.to, button: 'left', clickCount: 1 });
      }
      await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > start.count && state.curveDragging === 'false' && state.previewActive === 'false'; }, '曲线手势结束未精绘');
      assert.equal(await page.evaluate('document.getElementById("curve-drag-readout").hidden&&document.getElementById("curve-cursor").hidden'), true);
      const finalView = JSON.parse((await read('dq-plot')).view);
      for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(finalView[axis][index] - JSON.parse(start.view)[axis][index]) < 1e-7, '手势结束后不得改变视野');
      const measured = kind === 'current' ? 'Math.hypot(point.direct,point.quadrature)' : `${start.frame === 'voltage' ? 'VoltageMotor.field' : 'SynchronousMotor.evaluate'}(model,point.direct,point.quadrature)['${kind === 'phase' ? 'phaseAngle' : kind}']`;
      const settled = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),trace=plot.data.find(trace=>trace.meta.kind==='${kind}'),points=trace.x.flatMap((direct,index)=>direct===null?[]:[{direct,quadrature:trace.y[index]}]);const expected=${start.frame === 'voltage' && kind === 'voltage' ? 'VoltageMotor.trajectory(model)' : 'null'};const errors=points.map((point,index)=>expected?Math.hypot(point.direct-expected[index].direct,point.quadrature-expected[index].quadrature):Math.abs(${kind === 'phase' ? 'SynchronousMotor.normalizePhaseAngle(' + measured + '-trace.meta.value)' : measured + '-trace.meta.value'}));return{value:trace.meta.value,count:points.length,error:Math.max(0,...errors),background:plot.data.filter(trace=>trace.meta.kind==='torque-level').map(trace=>trace.meta.value),probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible,grid:plot.layout.xaxis.showgrid||plot.layout.yaxis.showgrid}})()`);
      assert.equal(settled.value, held.value); assert.deepEqual(settled.background, defaultTorques); assert.equal(settled.probe, start.probe); assert.equal(settled.grid, false);
      assert.ok(settled.count > 0 && settled.error < (kind === 'phase' ? 1e-6 : 1e-7));
      const evidence = { frame: start.frame, kind, target, actual: settled.value, touch, cancel, fullRedrawsWhileHeld: held.count - start.count, viewPreserved: true, visibilityPreserved: true };
      directDragChecks.push(evidence); return evidence;
    }
    async function dragOptimum(kind, amplitude, direction, touch = false) {
      let previousCount = -1;
      await until(async () => { const state = await read('dq-plot'), count = Number(state.renderCount); const ready = count === previousCount && state.previewActive !== 'true'; previousCount = count; return ready; }, '联动前未完成绘图');
      const start = await page.evaluate(`(()=>{
        const plot=document.getElementById('dq-plot'),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.model).input),layout=plot._fullLayout,box=plot.getBoundingClientRect();
        const position=point=>({x:box.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis.d2p(point.direct),y:box.top+plot.clientTop+layout.yaxis._offset+layout.yaxis.d2p(point.quadrature)});
        return{from:position(SynchronousMotor['${kind}'](model,${amplitude}*.65,${direction})),to:position(SynchronousMotor['${kind}'](model,${amplitude},${direction})),count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0),view:plot.dataset.view,probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible};
      })()`);
      if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start.from, id: 32, radiusX: 1, radiusY: 1, force: 1 }] });
      else { await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start.from }); assert.equal((await read('dq-plot')).curveHover, kind); await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start.from, button: 'left', clickCount: 1 }); }
      let held;
      try {
        for (let step = 1; step <= 4; step++) {
          const point = { x: start.from.x + (start.to.x - start.from.x) * step / 4, y: start.from.y + (start.to.y - start.from.y) * step / 4 };
          if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 32, radiusX: 1, radiusY: 1, force: 1 }] });
          else await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 });
        }
        await until(() => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return plot.dataset.curveDragKind==='${kind}'&&plot.dataset.curveDragging==='true'&&Number(plot.dataset.previewFrameCount)>${start.frames}&&JSON.parse(plot.dataset.previewTargets).torque===Number(document.getElementById('torque-target').value)})()`), '联动曲线未实时更新');
        held = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.previewModel)),amplitude=Number(document.getElementById('${kind === 'mtpa' ? 'currentLimit' : 'voltageLimit'}').value),expected=SynchronousMotor['${kind}'](model,amplitude,${direction}),cursor=document.getElementById('curve-cursor'),readout=document.getElementById('curve-drag-readout');return{amplitude,torque:Number(document.getElementById('torque-target').value),expected:expected.torque,view:plot.dataset.previewView,count:Number(plot.dataset.renderCount),plotlyDragging:Boolean(plot._dragging),probe:plot.data.find(trace=>trace.meta.kind==='current-vector').visible,text:readout.textContent,readoutHidden:readout.hidden,cursorHidden:cursor.hidden,cursorColor:getComputedStyle(cursor,'::before').backgroundColor}})()`);
        assert.ok(Math.abs(held.amplitude - amplitude) < .02); assert.ok(Math.abs(held.torque - held.expected) < 1e-10);
        assert.equal(held.count, start.count); assert.equal(held.view, start.view); assert.equal(held.plotlyDragging, false); assert.equal(held.probe, start.probe);
        assert.equal(held.readoutHidden, false); assert.equal(held.cursorHidden, false); assert.equal(held.cursorColor, 'rgb(0, 0, 0)');
        assert.ok(held.text.includes(kind.toUpperCase()) && held.text.includes('T=') && held.text.includes(kind === 'mtpa' ? '|I|=' : '|U|='));
      } finally {
        if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        else await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start.to, button: 'left', clickCount: 1 });
      }
      await until(async () => { const state = await read('dq-plot'); return state.previewActive === 'false' && Number(state.renderCount) > start.count; }, '联动松手未精绘');
      coupledChecks.push({ kind, direction, touch, amplitude: held.amplitude, torque: held.torque, fullRedrawsWhileHeld: 0 });
    }
    async function checkOptimumFollowing(kind, touch = false) {
      const start = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),point=SynchronousMotor.optimumAtQuadrature(model,'${kind}',.9),box=plot.getBoundingClientRect(),layout=plot._fullLayout;const position=quadrature=>({x:box.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis.d2p(point.direct),y:box.top+plot.clientTop+layout.yaxis._offset+layout.yaxis.d2p(quadrature)});return{from:position(.9),positions:[.65,.4,.7].map(position),count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0)}})()`);
      if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start.from, id: 50, radiusX: 1, radiusY: 1, force: 1 }] });
      else { await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start.from }); assert.equal((await read('dq-plot')).curveHover, kind); await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start.from, button: 'left', clickCount: 1 }); }
      const samples = []; let previous = .9, frames = start.frames;
      try {
        for (const [index, position] of start.positions.entries()) {
          if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...position, id: 50, radiusX: 1, radiusY: 1, force: 1 }] });
          else await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position, button: 'left', buttons: 1 });
          await until(async () => Number((await read('dq-plot')).previewFrameCount) > frames, '优化曲线未跟随上下移动');
          const state = await read('dq-plot'), point = JSON.parse((await read('probe-readout')).point), expected = [.65, .4, .7][index];
          assert.equal(state.curveDragKind, kind); assert.equal(state.dragBlocked, 'false'); assert.equal(Number(state.renderCount), start.count);
          assert.ok(Math.abs(point.quadrature - expected) < .035 && (point.quadrature - previous) * (expected - previous) > 0, JSON.stringify({ point, previous, expected }));
          samples.push(point.quadrature); previous = point.quadrature; frames = Number(state.previewFrameCount);
        }
      } finally {
        if (touch) await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        else await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start.positions.at(-1), button: 'left', clickCount: 1 });
      }
      await until(async () => (await read('dq-plot')).previewActive === 'false', '优化跟随未结束');
      optimumFollowChecks.push({ kind, touch, samples, downwardAndUpward: true });
    }
    async function navigate(route) {
      if (motorDesktopOnly) assert.ok(['页面/电机控制/同步电机/同步电机分析.html', '页面/电机控制/同步电机/VF工作点分析.html'].includes(route), '桌面专项不得访问其他实验');
      visitedPages.push(route);
      await page.call('Page.navigate', { url: origin + '/' + encodeURI(route) });
      await until(() => page.evaluate(`document.readyState==='complete' && decodeURI(location.pathname)===${JSON.stringify('/' + route.split('?')[0])}`), '页面加载失败：' + route);
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    await t.test('同步电机：纯标幺、双向竖滑块、曲线显隐、缩放平移与离线绘图', async motorTest => {
      motorTest.after(async () => {
        await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      });
      const evidence = path.resolve(__dirname, '../临时测试/2026-11-13-同步电机曲线');
      await fs.mkdir(evidence, { recursive: true });
      await navigate('页面/电机控制/同步电机/同步电机分析.html');
      await until(() => page.evaluate('Number(document.getElementById("dq-plot").dataset.renderCount)>0'), '同步电机初次绘制失败');
      assert.equal(await page.evaluate('document.title'), '同步电机转子定向工作点分析');
      assert.equal(await page.evaluate('document.querySelector("h1").textContent'), '同步电机转子定向工作点分析');
      const motorAction = async expression => {
        const before = Number((await read('dq-plot')).renderCount);
        await page.evaluate(expression);
        let previousCount = -1;
        await until(async () => { const state = await read('dq-plot'), count = Number(state.renderCount); const ready = count > before && count === previousCount && state.previewActive !== 'true'; previousCount = count; return ready; }, '电机参数变更未完成重绘');
      };
      const motorChange = (id, value, event = 'input') => motorAction(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
      const chooseHeat = value => value === 'none' ? motorAction('document.getElementById("show-heat").click()') : motorChange('heat-quantity', value, 'change');
      const previewChecks = [];
      const nextPreview = frames => page.evaluate(`new Promise((resolve,reject)=>{const started=performance.now();const check=()=>{const plot=document.getElementById('dq-plot');if(Number(plot.dataset.previewFrameCount)>${frames})resolve(true);else if(performance.now()-started>5000)reject(new Error('按住拖动时预览帧未更新'));else setTimeout(check,8)};check()})`);
      async function heldPan({ moves = 3, fraction = .12, screenshot = '', loseContext = false } = {}) {
        const expectedMaps = await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind.startsWith("mapped-")).map(trace=>trace.meta.kind)');
        let previousCount = -1;
        await until(async () => {
          const state = await read('dq-plot'), count = Number(state.renderCount);
          const settled = count > 0 && count === previousCount && state.previewActive !== 'true';
          previousCount = count; return settled;
        }, '开始拖动前的绘图未稳定');
        const before = await blankStart();
        let end = before.start, lastFrames = before.frames, held, contextLost = false;
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...before.start });
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...before.start, button: 'left', clickCount: 1 });
        try {
          for (let step = 1; step <= moves; step++) {
            end = { x: before.start.x + before.width * fraction * step / moves, y: before.start.y };
            await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
            await nextPreview(lastFrames);
            lastFrames = Number((await read('dq-plot')).previewFrameCount);
          }
          if (loseContext) {
            contextLost = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');if(plot.dataset.previewBackend!=='webgl')return false;const extension=document.getElementById('drag-heat').getContext('webgl').getExtension('WEBGL_lose_context');if(!extension)return false;extension.loseContext();return true})()`);
            if (contextLost) await nextPreview(lastFrames);
          }
          held = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.previewView),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.previewModel)),heat=plot.data.find(trace=>trace.meta.kind==='heat');let pixel=null;
            if(heat){const accelerated=plot.dataset.previewBackend==='webgl',canvas=document.getElementById(accelerated?'drag-heat':'drag-heat-cpu'),column=Math.max(1,Math.floor(canvas.width*.02)),row=Math.floor(canvas.height*.31);let rgba,direct,quadrature;
              if(accelerated){const context=canvas.getContext('webgl'),channels=new Uint8Array(4);context.readPixels(column,row,1,1,context.RGBA,context.UNSIGNED_BYTE,channels);rgba=[...channels];direct=view.x[0]+(column+.5)/canvas.width*(view.x[1]-view.x[0]);quadrature=view.y[0]+(row+.5)/canvas.height*(view.y[1]-view.y[0]);}
              else{rgba=[...canvas.getContext('2d').getImageData(column,row,1,1).data];direct=view.x[0]+column/(canvas.width-1)*(view.x[1]-view.x[0]);quadrature=view.y[1]-row/(canvas.height-1)*(view.y[1]-view.y[0]);}
              const value=MotorAnalysis.stateAt(model,direct,quadrature,heat.meta.coordinate||'current')[heat.meta.quantity];pixel={heat:heat.meta.quantity,coordinate:heat.meta.coordinate,direct,quadrature,rgba,expected:MotorAnalysis.quantities[heat.meta.quantity]?.cyclic?MotorAnalysis.angleColor(value):MotorPreview.colorFor(value,heat.zmax,heat.meta.quantity==='apparent'),visible:getComputedStyle(canvas).display};}
            const lines=document.getElementById('drag-curves'),pixels=lines.getContext('2d').getImageData(0,0,lines.width,lines.height).data;let ink=0;for(let offset=3;offset<pixels.length;offset+=4)if(pixels[offset])ink++;
            return{active:plot.dataset.previewActive,count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount),view,pixel,ink,metrics:JSON.parse(plot.dataset.previewMetrics),probe:JSON.parse(document.getElementById('probe-readout').dataset.point)};})()`);
          assert.equal(held.active, 'true'); assert.equal(held.count, before.count, '按住平移不能触发整图重绘');
          if (expectedMaps.length) {
            const mapped = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.previewView),canvas=document.getElementById('drag-curves'),context=canvas.getContext('2d');return JSON.parse(plot.dataset.previewMapped).map(line=>{if(!line.sample)return{kind:line.kind,alpha:0};const column=Math.round((line.sample.direct-view.x[0])/(view.x[1]-view.x[0])*canvas.width),row=Math.round((view.y[1]-line.sample.quadrature)/(view.y[1]-view.y[0])*canvas.height),pixels=context.getImageData(column-3,row-3,7,7).data;return{kind:line.kind,alpha:Math.max(...[...pixels].filter((value,index)=>index%4===3)),value:line.value};});})()`);
            assert.deepEqual(mapped.map(line => line.kind), expectedMaps); assert.ok(mapped.every(line => line.alpha > 0), JSON.stringify(mapped)); held.mapped = mapped;
          }
          assert.deepEqual(JSON.parse((await read('dq-plot')).previewModel), before.input, '空白平移不得改变电机或边界参数');
          assert.deepEqual(JSON.parse((await read('dq-plot')).previewTargets), before.targets, '空白平移不得改变当前等值线');
          const regionPixels = await constraintPixels([[0, .5], [0, -.5], [1.4, 0]]);
          assertConstraintPixels(regionPixels);
          constraintChecks.push({ frame: 'rotor', type: 'preview', ...regionPixels });
          assert.ok(held.frames - before.frames >= moves); assert.ok(held.view.x[0] < before.view.x[0]);
          if (held.pixel) {
            assert.notEqual(held.pixel.visible, 'none'); assert.ok(held.pixel.direct < before.view.x[0], '检查的是新露出的左侧区域');
            assert.ok(Math.abs(held.pixel.rgba[3] - 184) <= 1, '新区域必须有实际热力像素');
            assert.ok(held.pixel.expected.every((channel, index) => Math.abs(channel - held.pixel.rgba[index]) <= 3), JSON.stringify(held.pixel));
          }
          if (contextLost) { assert.equal(held.metrics.backend, 'canvas2d'); assert.equal(held.metrics.fallback, 'context-lost'); }
          if (screenshot) {
            const shot = await page.call('Page.captureScreenshot', {});
            await fs.writeFile(path.join(evidence, screenshot), Buffer.from(shot.data, 'base64'));
          }
        } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 }); }
        await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > before.count && state.previewActive === 'false'; }, '松开后未恢复精确绘制');
        const settled = JSON.parse((await read('dq-plot')).view);
        for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(settled[axis][index] - held.view[axis][index]) < 1e-7);
        assert.equal(await page.evaluate('[...document.querySelectorAll(".pan-preview")].every(canvas=>getComputedStyle(canvas).display==="none")'), true);
        if (held.pixel) assert.equal(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="heat").x.length'), 161);
        const check = { backend: held.metrics.backend, renderer: held.metrics.renderer, fallback: held.metrics.fallback, contextLost, frames: held.frames - before.frames,
          geometryBuilds: held.metrics.geometryBuilds - before.builds, drawMs: held.metrics.drawMs.slice(-Math.min(held.frames - before.frames, 180)), fullRedrawsWhileHeld: held.count - before.count, pixel: held.pixel, mapped: held.mapped, ink: held.ink, settled: JSON.parse((await read('dq-plot')).renderMetrics) };
        previewChecks.push(check); return check;
      }
      assert.equal(await page.evaluate('document.querySelectorAll(".parameter-control input[type=range]").length'), 4);
      assert.equal(await page.evaluate('document.querySelector("#preset,#powerKW,#emfV,#base-parameters")'), null);
      const initial = JSON.parse((await read('dq-plot')).model);
      assert.deepEqual(initial.pu, { resistance: .02, ld: .2, lq: .4, flux: .8 }); assert.equal(initial.base, undefined);
      for (const [key, maximum] of [['resistance', '.5'], ['ld', '2'], ['lq', '2'], ['flux', '2']]) {
        const bounds = await page.evaluate(`(()=>{const slider=document.getElementById('${key}-slider'),input=document.getElementById('${key}');return{min:slider.min,max:slider.max,inputMin:input.min,inputMax:input.getAttribute('max')}})()`);
        assert.equal(Number(bounds.min), 0); assert.equal(Number(bounds.max), Number(maximum)); assert.equal(bounds.inputMin, '0'); assert.equal(bounds.inputMax, null);
      }
      for (const prefix of ['current', 'voltage']) {
        assert.equal(await page.evaluate(`document.getElementById('${prefix}-preset')`), null);
        assert.equal(await page.evaluate(`document.getElementById('${prefix}Limit').getAttribute('max')`), null);
      }
      assert.equal(await page.evaluate('document.getElementById("speed-slider").min'), '-2');
      assert.equal(await page.evaluate('document.getElementById("speed-slider").max'), '2');
      assert.equal(await page.evaluate('getComputedStyle(document.getElementById("speed-slider")).writingMode'), 'vertical-lr');
      const traces = await page.evaluate('document.getElementById("dq-plot").data.map(trace=>({name:trace.name,kind:trace.meta.kind,dash:trace.line?.dash,opacity:trace.opacity,visible:trace.visible,points:trace.x.filter(value=>value!==null).length}))');
      for (const kind of ['mtpa', 'torque', 'phase', 'current', 'voltage']) assert.ok(traces.some(trace => trace.kind === kind && trace.points > 0), kind);
      for (const kind of ['current-vector', 'voltage-vector']) { assert.equal(traces.find(trace => trace.kind === kind).visible, true); assert.equal(traces.find(trace => trace.kind === kind).points, 2); }
      assert.equal(traces.some(trace => trace.kind === 'probe'), false);
      assert.deepEqual(traces.filter(trace => trace.kind === 'torque-level').map(trace => trace.name), defaultTorques.map(level => `T = ${level} pu`));
      assert.equal(await page.evaluate('document.querySelector("#torque-values,#torque-preset,#pf-target,#show-pf")'), null);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="phase-level").map(trace=>trace.meta.value)'), defaultPhases);
      assert.equal(await page.evaluate('document.getElementById("phase-target").value'), '0');
      assert.equal(await page.evaluate('document.getElementById("torque-target").value'), '1');
      assert.deepEqual(await page.evaluate('[...document.getElementById("heat-quantity").options].map(option=>option.value)'), ['torque', 'active', 'reactive', 'apparent', 'phaseAngle', 'voltageAngle']);
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      const voltageInitial = await voltageSnapshot();
      assert.deepEqual(voltageInitial.map(item => item.voltage).sort((first, second) => first - second), defaultVoltages);
      assert.ok(voltageInitial.every(item => item.error < 1e-8));
      assert.ok(voltageInitial.some(item => item.kind === 'voltage-level' && item.drawn));
      const trends = await trendStyles();
      assert.ok(trends.every(item => item.width === 1 && item.opacity === .45));
      assert.equal(trends.filter(item => item.kind === 'torque-level' && item.value < 0).length, 15);
      assert.equal(new Set(trends.filter(item => item.kind === 'torque-level').map(item => item.color)).size, 31);
      assert.ok(trends.some(item => item.kind === 'torque-level' && item.value < 0 && item.count > 2));
      assert.equal(await page.evaluate('document.getElementById("torque-step")'), null);
      assert.equal(await page.evaluate('document.getElementById("dq-plot").layout.hovermode'), false);
      assert.ok(traces.some(trace => trace.kind === 'mtpv'));
      for (const kind of ['torque', 'phase']) {
        assert.equal(traces.find(trace => trace.kind === kind).dash, 'solid');
        assert.ok(traces.filter(trace => trace.kind === kind + '-level').every(trace => trace.opacity === .45));
      }
      assert.equal(await page.evaluate('document.getElementById("dq-plot").layout.xaxis.showgrid||document.getElementById("dq-plot").layout.yaxis.showgrid'), false);
      assert.ok(traces.filter(trace => trace.kind?.endsWith('-level')).every(trace => trace.dash === 'dash'));
      await checkConstraint(motorAction, 'rotor');
      await checkVisibility(motorAction, 'rotor');
      await checkToolbar('rotor');
      await checkPresets(motorAction, 'rotor');
      await checkVectors(motorAction, 'rotor');
      await checkVectorSafety(motorAction, 'rotor');
      const mappingChecks = [], tableKinds = ['voltage', 'current', 'torque', 'phase'];
      await resetVectorPoint(motorAction, 'rotor');
      assert.equal(await page.evaluate('document.querySelector("#show-current-group,#point-lock")'), null);
      for (const kind of tableKinds) {
        for (const currentVisible of [true, false]) for (const mappedVisible of [true, false]) {
          await motorAction(`(()=>{for(const [id,checked]of [['show-${kind}',${currentVisible}],['show-${kind}-map',${mappedVisible}]]){const input=document.getElementById(id);input.checked=checked;input.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
          const state = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),trace=plot.data.find(item=>item.meta.kind==='mapped-${kind}');let error=0,count=0;trace?.x.forEach((direct,index)=>{if(direct===null)return;const quadrature=trace.y[index],current=SynchronousMotor.currentAtVoltage(model,Math.hypot(direct,quadrature),Math.atan2(quadrature,direct)),state=SynchronousMotor.evaluate(model,current.direct,current.quadrature),actual=state['${kind === 'phase' ? 'phaseAngle' : kind}'];error=Math.max(error,Math.abs('${kind}'==='phase'?SynchronousMotor.normalizePhaseAngle(actual-trace.meta.value):actual-trace.meta.value));count++;});const full=plot._fullData.find(item=>item.meta?.kind==='mapped-${kind}');return{current:plot.data.some(item=>item.meta.kind==='${kind}'),mapped:!!trace,count,error,drawn:!!full&&[...plot.querySelectorAll('.trace'+full.uid+' .js-line')].some(path=>path.getTotalLength()>1),dash:trace?.line.dash};})()`);
          assert.equal(state.current, currentVisible); assert.equal(state.mapped, mappedVisible);
          if (mappedVisible) { assert.ok(state.count > 0 && state.error < 1e-7, JSON.stringify(state)); assert.equal(state.drawn, true); assert.equal(state.dash, 'solid'); }
          mappingChecks.push({ kind, currentVisible, mappedVisible, ...state });
        }
      }
      await motorAction("['voltage','current','torque','phase'].forEach(kind=>{for(const suffix of ['', '-map']){const input=document.getElementById('show-'+kind+suffix);input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));}})");
      const mappedPreview = await heldPan({ moves: 2, screenshot: '桌面-轨迹表电压映射.png' });
      await motorChange('voltageLimit', '1.2');
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="mapped-voltage").x.every((direct,index,values)=>direct===null||Math.abs(Math.hypot(direct,document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="mapped-voltage").y[index])-1.2)<1e-8)'));
      await motorAction("['voltage','current','torque','phase'].forEach(kind=>{const input=document.getElementById('show-'+kind+'-map');input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));})");
      await fs.writeFile(path.join(evidence, '轨迹表与电压映射验收.json'), JSON.stringify({ mappingChecks, mappedPreview }, null, 2));
      const analysisChecks = [], lockChecks = [];
      await resetVectorPoint(motorAction, 'rotor');
      for (const coordinate of ['current', 'voltage']) {
        await motorChange('heat-coordinate', coordinate, 'change');
        for (const quantity of ['torque', 'active', 'reactive', 'apparent', 'phaseAngle', 'voltageAngle']) {
          await chooseHeat(quantity);
          const checked = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),trace=plot.data.find(item=>item.meta.kind==='heat'),model=JSON.parse(plot.dataset.model);let error=0,count=0;for(const row of [20,60,100,140])for(const column of [15,55,95,135]){const direct=trace.x[column],quadrature=trace.y[row],current=trace.meta.coordinate==='voltage'?SynchronousMotor.currentAtVoltage(model,Math.hypot(direct,quadrature),Math.atan2(quadrature,direct)):{direct,quadrature},state=SynchronousMotor.evaluate(model,current.direct,current.quadrature);const expected=trace.meta.quantity==='voltageAngle'?SynchronousMotor.normalizePhaseAngle(Math.atan2(state.vq,state.vd)*180/Math.PI):state[trace.meta.quantity];error=Math.max(error,Math.abs(trace.z[row][column]-expected));count++;}return{coordinate:trace.meta.coordinate,quantity:trace.meta.quantity,error,count,range:[trace.zmin,trace.zmax],cycle:trace.colorscale[0][1]===trace.colorscale.at(-1)[1],disabled:document.getElementById('color-limit').disabled,point:JSON.parse(document.getElementById('probe-readout').dataset.point)};})()`);
          assert.equal(checked.coordinate, coordinate); assert.equal(checked.quantity, quantity); assert.ok(checked.error < 1e-8, JSON.stringify(checked));
          if (quantity.endsWith('Angle')) { assert.deepEqual(checked.range, [-180, 180]); assert.equal(checked.cycle, true); assert.equal(checked.disabled, true); }
          if (quantity.endsWith('Angle') || (coordinate === 'voltage' && quantity === 'torque')) {
            checked.preview = await heldPan({ moves: 2, screenshot: `${coordinate}-${quantity}-预览.png` });
            assert.equal(checked.preview.backend, 'canvas2d');
            await motorAction('document.getElementById("reset-view").click()');
          }
          analysisChecks.push(checked);
        }
      }
      await motorChange('heat-coordinate', 'current', 'change'); await chooseHeat('torque');
      for (const key of ['current', 'voltage', 'torque', 'pf']) for (const kind of ['current-vector', 'voltage-vector']) {
        await resetVectorPoint(motorAction, 'rotor');
        await motorAction(`document.getElementById('lock-${key}').click()`);
        const start = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),point=JSON.parse(document.getElementById('probe-readout').dataset.point),layout=plot._fullLayout,rect=plot.getBoundingClientRect(),model=JSON.parse(plot.dataset.model),target=SynchronousMotor.evaluate(model,point.direct+.2,point.quadrature+.2);const screen=state=>({x:rect.left+layout.xaxis._offset+layout.xaxis.l2p('${kind}'==='voltage-vector'?state.vd:state.direct),y:rect.top+layout.yaxis._offset+layout.yaxis.l2p('${kind}'==='voltage-vector'?state.vq:state.quadrature)});return{point,from:screen(point),to:screen(target),count:Number(plot.dataset.renderCount)};})()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start.from, button: 'left', clickCount: 1 });
        let result;
        try {
          for (let step = 1; step <= 6; step++) await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.from.x + (start.to.x - start.from.x) * step / 6, y: start.from.y + (start.to.y - start.from.y) * step / 6, button: 'left', buttons: 1 });
          await until(async () => (await read('dq-plot')).curveDragging === 'true', '锁定端点拖动未启动');
          result = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return{point:JSON.parse(document.getElementById('probe-readout').dataset.point),kind:plot.dataset.curveDragKind,count:Number(plot.dataset.renderCount),locks:JSON.parse(plot.dataset.locks)};})()`);
          assert.equal(result.kind, kind); assert.equal(result.count, start.count);
          result.pointer = await pointerSnapshot(start.to);
          if (key === 'current' && kind === 'current-vector') {
            assert.ok(result.pointer.distance > 5);
            const shot = await page.call('Page.captureScreenshot', {});
            await fs.writeFile(path.join(evidence, '转子-鼠标与约束点.png'), Buffer.from(shot.data, 'base64'));
          }
          assert.ok(Math.abs(result.point[key] - start.point[key]) < 1e-7, `${key}: ${JSON.stringify(result)}`);
          assert.ok(Math.abs(result.point.direct - start.point.direct) > 1e-4, `${key} direct must move`);
          assert.ok(Math.abs(result.point.quadrature - start.point.quadrature) > 1e-4, `${key} quadrature must move`);
        } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start.to, button: 'left', clickCount: 1 }); }
        await until(async () => (await read('dq-plot')).previewActive === 'false', '锁定拖动未结束');
        lockChecks.push({ key, kind, before: start.point, after: result.point, pointer: result.pointer });
        await motorAction(`document.getElementById('lock-${key}').click()`);
      }
      await resetVectorPoint(motorAction, 'rotor');
      assert.equal(await page.evaluate('document.getElementById("point-lock")'), null);
      assert.equal(await page.evaluate('document.querySelectorAll("#trajectory-table tbody tr td:last-child .trajectory-lock").length'), 4);
      for (const key of ['current', 'voltage', 'torque', 'pf']) {
        await motorAction(`document.getElementById('lock-${key}').click()`);
        assert.deepEqual(Object.keys(JSON.parse((await read('dq-plot')).locks)), [key]);
        assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".trajectory-lock:checked")].map(input=>input.id)'), ['lock-' + key]);
        assert.equal(await page.evaluate('document.querySelectorAll("#trajectory-table tr[data-locked=true]").length'), 1);
        assert.deepEqual(await page.evaluate('["currentLimit","voltageLimit","torque-target","phase-target"].map(id=>document.getElementById(id).disabled)'), ['current', 'voltage', 'torque', 'pf'].map(value => value === key));
      }
      await change('speedPU', '0', 'input');
      await until(() => page.evaluate('document.getElementById("lock-status").textContent.includes("不兼容")'), '不兼容参数没有提示');
      assert.equal(await page.evaluate('Number(document.getElementById("speedPU").value)'), 1);
      await change('speed-slider', '0', 'input');
      await until(() => page.evaluate('document.getElementById("lock-status").textContent.includes("不兼容")'), '滑块拒绝提示被覆盖');
      assert.equal(await page.evaluate('Number(document.getElementById("speed-slider").value)'), 1);
      await motorAction('document.getElementById("lock-pf").click()');
      assert.deepEqual(JSON.parse((await read('dq-plot')).locks), {});
      assert.equal(await page.evaluate('document.querySelectorAll(".trajectory-lock:checked").length'), 0);
      assert.equal(await page.evaluate('["currentLimit","voltageLimit","torque-target","phase-target"].every(id=>!document.getElementById(id).disabled)'), true);
      await fs.writeFile(path.join(evidence, '坐标色图与锁定验收.json'), JSON.stringify({ analysisChecks, lockChecks, singleSelection: true, switchingReplacesLock: true, unlocked: true, incompatibleSpeedRejected: true }, null, 2));
      await resetVectorPoint(motorAction, 'rotor');
      await chooseHeat('none');
      for (const [kind, target] of [['current', 1.3], ['voltage', 1.2], ['torque', -.7], ['phase', -30]]) { await dragCurve(kind, target); await motorAction(motorReset); }
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>["torque","current","voltage"].includes(trace.meta.kind)).every(trace=>trace.line.dash==="solid")'));
      assert.ok(await page.evaluate('document.querySelectorAll("#dq-plot .scatterlayer path.js-line").length>12'));
      await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-6,4],'yaxis.range':[-4,4]});return true})()`);
      await motorAction("document.getElementById('show-vectors').click()");
      for (const kind of ['mtpa', 'mtpv']) for (const direction of [1, -1]) { await dragOptimum(kind, kind === 'mtpa' ? .9 : 1.2, direction); await motorAction(motorReset); }
      for (const kind of ['mtpa', 'mtpv']) { await checkOptimumFollowing(kind); await motorAction(motorReset); }
      await motorAction("document.getElementById('show-vectors').click()");
      const torqueChecks = [];
      for (const selection of [-1, -.5, 0, .5, 1, 3.5]) {
        await motorChange('torque-target', String(selection));
        const checked = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.model).input);return plot.data.filter(trace=>['torque','torque-level'].includes(trace.meta.kind)).map(trace=>{const level=trace.meta.value;const errors=trace.x.flatMap((direct,index)=>direct===null?[]:[Math.abs(SynchronousMotor.evaluate(model,direct,trace.y[index]).torque-level)]);return{kind:trace.meta.kind,level,count:errors.length,error:Math.max(0,...errors),dash:trace.line.dash}})})()`);
        assert.deepEqual(checked.map(item => item.level), [...defaultTorques, selection]);
        assert.ok(checked.every(item => item.count > 0 && item.error < 1e-8));
        assert.ok(checked.every(item => item.dash === (item.kind === 'torque' ? 'solid' : 'dash')));
        torqueChecks.push({ selection, curves: checked });
      }
      for (const angle of [-180, -120, -90, -30, 0, 30, 90, 150, 180]) {
        await motorChange('phase-target', String(angle));
        assert.ok(await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),trace=plot.data.find(trace=>trace.meta.kind==='phase');return trace.x.some(Number.isFinite)&&trace.x.every((direct,index)=>direct===null||Math.abs(SynchronousMotor.normalizePhaseAngle(SynchronousMotor.evaluate(model,direct,trace.y[index]).phaseAngle-(${angle})))<1e-6)})()`));
      }
      await motorAction('document.getElementById("reset-view").click()');
      const beforeInvalidTorque = (await read('dq-plot')).renderCount;
      await change('torque-target', '', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '无效转矩没有提示');
      assert.equal((await read('dq-plot')).renderCount, beforeInvalidTorque);
      assert.ok(await page.evaluate('document.getElementById("input-error").textContent.includes("转矩")'));
      await motorAction(motorReset);
      assert.equal(await page.evaluate('document.getElementById("torque-target").value'), '1');
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque-level").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
      await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-16,8],'yaxis.range':[-8,8]});return true})()`);
      await motorChange('voltage-values', '0,.35,2.4');
      const customVoltage = await voltageSnapshot();
      assert.deepEqual(customVoltage.map(item => item.voltage), [0, .35, 2.4, 1]);
      assert.ok(customVoltage.every(item => item.count > 0 && item.error < 1e-8));
      await motorAction('document.getElementById("show-voltage").click()');
      assert.deepEqual((await voltageSnapshot()).map(item => item.voltage), [0, .35, 2.4]);
      await motorAction('document.getElementById("show-voltage").click()');
      const voltageRenderCount = (await read('dq-plot')).renderCount;
      await change('voltage-values', '-1', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '负电压幅值没有提示');
      assert.equal((await read('dq-plot')).renderCount, voltageRenderCount);
      await motorAction(motorReset);
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="mtpv").x.some(Number.isFinite)'), '缩小视图后可以看到较小电感对应的MTPV');
      const boundaryChecks = [];
      for (const [key, kind] of [['currentLimit', 'current'], ['voltageLimit', 'voltage']]) {
        for (const value of [1, 1.15, 1.5, 2, 2.25, 0]) {
          await motorChange(key, String(value));
          const checked = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.model).input),trace=plot.data.find(trace=>trace.meta.kind==='${kind}');const values=trace.x.flatMap((direct,index)=>direct===null?[]:[${kind === 'current' ? 'Math.hypot(direct,trace.y[index])' : 'SynchronousMotor.evaluate(model,direct,trace.y[index]).voltage'}]);return{kind:'${kind}',input:Number(document.getElementById('${key}').value),model:model.input['${key}'],name:trace.name,mode:trace.mode,count:values.length,error:Math.max(...values.map(value=>Math.abs(value-${value})))}})()`);
          assert.equal(checked.input, value); assert.equal(checked.model, value); assert.ok(checked.count > 0); assert.ok(checked.error < 1e-8);
          assert.ok(checked.name.includes(String(value)));
          if (value === 0) assert.equal(checked.mode, 'markers');
          boundaryChecks.push(checked);
        }
        await motorChange(key, '100');
        assert.equal(JSON.parse((await read('dq-plot')).model).input[key], 100);
        await motorChange(key, '1');
      }
      await motorAction('document.getElementById("reset-view").click()');
      for (const [key, maximum] of [['resistance', .5], ['ld', 2], ['lq', 2], ['flux', 2]]) {
        await motorChange(key, '50');
        assert.equal(JSON.parse((await read('dq-plot')).model).pu[key], 50);
        assert.equal(await page.evaluate(`document.getElementById('${key}').value`), '50');
        assert.equal(await page.evaluate(`Number(document.getElementById('${key}-slider').max)`), maximum);
        assert.equal(await page.evaluate(`Number(document.getElementById('${key}-slider').value)`), maximum);
        await motorAction(motorReset);
      }
      await chooseHeat('torque');
      const raster = await page.evaluate(`(async()=>{const element=document.querySelector('#dq-plot .heatmaplayer image');const image=new Image();image.src=element.getAttribute('href')||element.getAttribute('xlink:href');await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;const colors=new Set();for(let index=0;index<pixels.length;index+=16)colors.add([pixels[index],pixels[index+1],pixels[index+2]].join(','));return{width:canvas.width,height:canvas.height,colors:colors.size}})()`);
      assert.ok(raster.width >= 100 && raster.height >= 100 && raster.colors > 30);
      const continuous = await heldPan({ moves: 12, fraction: .8, screenshot: '桌面-按住拖动.png' });
      assert.ok(continuous.geometryBuilds < continuous.frames, '连续平移应复用扩展区域内的曲线');
      await motorAction('document.getElementById("reset-view").click()');
      await motorChange('currentLimit', '1.15'); await motorChange('currentLimit', '1.5');
      const cacheCheck = JSON.parse((await read('dq-plot')).renderMetrics);
      assert.equal(cacheCheck.cacheMisses, 0); assert.equal(cacheCheck.cacheHits, 5, '只变电流边界应复用热力场和四类曲线');
      await motorChange('currentLimit', '1');
      const sliderStart = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=document.getElementById('ld-slider').getBoundingClientRect();return{x:bounds.left+bounds.width*.35,y:bounds.top+bounds.height/2,frames:Number(plot.dataset.previewFrameCount),count:Number(plot.dataset.renderCount)}})()`);
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: sliderStart.x, y: sliderStart.y, button: 'left', clickCount: 1 });
      let sliderPreview;
      try {
        await nextPreview(sliderStart.frames);
        sliderPreview = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return{active:plot.dataset.previewActive,input:Number(document.getElementById('ld').value),preview:JSON.parse(plot.dataset.previewModel).ld,count:Number(plot.dataset.renderCount)}})()`);
        assert.equal(sliderPreview.active, 'true'); assert.equal(sliderPreview.input, sliderPreview.preview); assert.notEqual(sliderPreview.input, .2);
        assert.equal(sliderPreview.count, sliderStart.count);
      } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sliderStart.x, y: sliderStart.y, button: 'left', clickCount: 1 }); }
      await until(async () => Number((await read('dq-plot')).renderCount) > sliderStart.count, '滑块松开后未精绘');
      assert.equal(JSON.parse((await read('dq-plot')).model).pu.ld, sliderPreview.input);
      await motorAction(motorReset);
      const beforeSlider = Number((await read('dq-plot')).renderCount);
      await page.evaluate('document.getElementById("ld-slider").focus()');
      await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await until(async () => Number((await read('dq-plot')).renderCount) > beforeSlider, '真实滑块键盘事件未触发重绘');
      assert.equal(await page.evaluate('document.getElementById("ld").value'), '0.21');
      const changed = JSON.parse((await read('dq-plot')).model);
      assert.equal(changed.pu.ld, .21);
      await motorAction(motorReset);
      for (const [key, value] of [['ld', 0], ['lq', 0], ['flux', 0], ['resistance', 0]]) {
        await motorChange(key, String(value));
        assert.equal(JSON.parse((await read('dq-plot')).model).pu[key], value);
        assert.ok(await page.evaluate('document.getElementById("dq-plot").data.every(trace=>trace.x.every(value=>value===null||Number.isFinite(value)))'));
      }
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("无唯一解")'));
      await motorAction(motorReset);
      for (const fraction of [.15, .85]) {
        const before = Number((await read('dq-plot')).renderCount);
        const position = await page.evaluate(`(()=>{const slider=document.getElementById('speed-slider');slider.scrollIntoView({block:'center',behavior:'instant'});const bounds=slider.getBoundingClientRect();return{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height*${fraction}}})()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
        await until(async () => Number((await read('dq-plot')).renderCount) > before, '竖向转速鼠标操作未重绘');
        const speed = JSON.parse((await read('dq-plot')).model).input.speedPU;
        assert.ok(fraction < .5 ? speed > .5 : speed < -.5);
      }
      await motorChange('speedPU', '-2');
      assert.equal(JSON.parse((await read('dq-plot')).model).input.speedPU, -2);
      await motorAction(motorReset);
      const beforeZoom = JSON.parse((await read('dq-plot')).view);
      const plotCenter = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');plot.scrollIntoView({block:'center',behavior:'instant'});const bounds=plot.getBoundingClientRect();return{x:bounds.left+bounds.width*.5,y:bounds.top+bounds.height*.5}})()`);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...plotCenter, deltaX: 0, deltaY: -450 });
      await until(async () => { const bounds = JSON.parse((await read('dq-plot')).view); return bounds.x[1] - bounds.x[0] < (beforeZoom.x[1] - beforeZoom.x[0]) * .95; }, '滚轮没有放大');
      const zoomed = JSON.parse((await read('dq-plot')).view);
      await motorChange('resistance', '.15');
      const preserved = JSON.parse((await read('dq-plot')).view);
      for (let index = 0; index < 2; index++) assert.ok(Math.abs(preserved.x[index] - zoomed.x[index]) < 1e-7);
      const heatBounds = await page.evaluate('(()=>{const trace=document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="heat");return[trace.x[0],trace.x.at(-1)]})()');
      for (let index = 0; index < 2; index++) assert.ok(Math.abs(heatBounds[index] - zoomed.x[index]) < 1e-7);
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...plotCenter, button: 'left', clickCount: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: plotCenter.x + 60, y: plotCenter.y + 20, button: 'left', buttons: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: plotCenter.x + 60, y: plotCenter.y + 20, button: 'left', clickCount: 1 });
      await until(async () => Math.abs(JSON.parse((await read('dq-plot')).view).x[0] - zoomed.x[0]) > .01, '平移未更新采样窗口');
      await motorAction('document.getElementById("reset-view").click()');
      const restored = JSON.parse((await read('dq-plot')).view);
      assert.ok(Math.abs(restored.x[0] + 3) < 1e-7 && Math.abs(restored.x[1] - 2) < 1e-7);
      await motorAction(motorReset);
      const heatChecks = [];
      for (const heat of ['active', 'reactive', 'apparent', 'torque']) {
        await chooseHeat(heat);
        const check = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),trace=plot.data.find(trace=>trace.meta.kind==='heat');const model=SynchronousMotor.createModel(JSON.parse(plot.dataset.model).input);const expected=SynchronousMotor.evaluate(model,trace.x[30],trace.y[80])['${heat}'];return{heat:trace.meta.quantity,actual:trace.z[80][30],expected,minimum:trace.zmin,maximum:trace.zmax}})()`);
        assert.equal(check.heat, heat); assert.ok(Math.abs(check.actual - check.expected) < 1e-10); assert.equal(check.maximum, 2);
        assert.equal(check.minimum, heat === 'apparent' ? 0 : -2); heatChecks.push(check);
        await heldPan();
      }
      await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-.5,-.4995],'yaxis.range':[.3,.3003]});return true})()`);
      const precisionFallback = await heldPan();
      assert.equal(precisionFallback.backend, 'canvas2d');
      if (continuous.backend === 'webgl') assert.equal(precisionFallback.fallback, 'numeric-precision');
      await motorAction('document.getElementById("reset-view").click()');
      for (const heat of ['torque', 'active']) {
        await motorAction(`(()=>{document.getElementById('ld').value='99999999';document.getElementById('lq').value='100000000';document.getElementById('heat-quantity').value='${heat}';document.getElementById('heat-quantity').dispatchEvent(new Event('change',{bubbles:true}));})()`);
        const largeFallback = await heldPan();
        assert.equal(largeFallback.backend, 'canvas2d');
        if (continuous.backend === 'webgl') assert.equal(largeFallback.fallback, 'numeric-precision');
      }
      await motorAction(motorReset);
      await motorAction('document.getElementById("reset-view").click()');
      await chooseHeat('torque');
      await motorChange('speedPU', '2');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data[0].zmax'), 2);
      await motorChange('color-scale', 'auto', 'change');
      const autoScale = await page.evaluate('(()=>{const trace=document.getElementById("dq-plot").data[0];return{actual:trace.zmax,expected:Math.max(1e-6,...trace.z.flat().map(Math.abs))}})()');
      assert.ok(Math.abs(autoScale.actual - autoScale.expected) < 1e-10);
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data[0].z.flat().every(Number.isFinite)'));
      await chooseHeat('none');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.kind==="heat")'), false);
      assert.ok((await heldPan()).ink > 100, '关闭热力图时曲线仍实时更新');
      for (const kind of ['mtpa', 'mtpv', 'torque', 'phase', 'current', 'voltage']) {
        await motorAction(`document.getElementById('show-${kind}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}')`), false);
      }
      await motorAction('["show-torque-group","show-voltage-group","show-phase-group"].forEach(id=>{const input=document.getElementById(id);input.checked=false;input.dispatchEvent(new Event("change",{bubbles:true}))})');
      await motorAction('document.getElementById("show-feasible").click()');
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.map(trace=>trace.meta.kind)'), ['current-vector', 'voltage-vector']);
      const selected = (await read('probe-readout')).point, blank = (await blankStart()).start;
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...blank, button: 'left', clickCount: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...blank, button: 'left', clickCount: 1 });
      assert.equal((await read('probe-readout')).point, selected);
      const probeChecks = { blankClickUnchanged: true };
      await motorAction('document.getElementById("show-vectors").click()');
      for (const kind of ['current', 'voltage']) {
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='${kind}-vector').visible`), false);
        assert.equal((await read('probe-readout')).point, selected);
      }
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...blank, button: 'left', clickCount: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...blank, button: 'left', clickCount: 1 });
      assert.equal((await read('probe-readout')).point, selected); assert.equal((await read('probe-readout')).visible, 'false');
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.every(trace=>trace.visible===false)'));
      probeChecks.hiddenClickUnchanged = true;
      const dragStart = (await blankStart()).start;
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...dragStart, button: 'left', clickCount: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x + 45, y: dragStart.y + 15, button: 'left', buttons: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragStart.x + 45, y: dragStart.y + 15, button: 'left', clickCount: 1 });
      await delay(150);
      assert.equal((await read('probe-readout')).visible, 'false', '平移不应切换矢量显隐');
      assert.equal((await read('probe-readout')).point, selected, '平移不应修改工作点');
      await motorAction(`['mtpa','mtpv','torque','phase','current','voltage','torque-group','voltage-group','phase-group','vectors','feasible'].forEach(kind=>{document.getElementById('show-'+kind).checked=true});${motorReset}`);
      await motorAction('document.getElementById("reset-view").click()');
      await chooseHeat('torque');
      assert.equal((await read('probe-readout')).visible, 'true');
      assert.equal(JSON.parse((await read('probe-readout')).point).direct, JSON.parse(selected).direct);
      probeChecks.panPreservedPoint = true;
      await motorAction("document.getElementById('probe-d').value=0;document.getElementById('probe-q').value=0;document.getElementById('probe-d').dispatchEvent(new Event('change',{bubbles:true}))");
      assert.ok(JSON.parse((await read('probe-readout')).point).current > 0);
      assert.equal((await read('dq-plot')).dragBlocked, 'true'); assert.equal((await read('dq-plot')).stale, 'false');
      await motorAction("document.getElementById('probe-d').value=-.5;document.getElementById('probe-q').value=.7;document.getElementById('probe-d').dispatchEvent(new Event('change',{bubbles:true}))");
      await motorChange('currentLimit', '.1');
      assert.equal(JSON.parse((await read('probe-readout')).point).feasible, false);
      await motorChange('speedPU', '0');
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("零速")'));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="phase").every(trace=>trace.x.every(value=>value===null))'));
      await motorChange('resistance', '0');
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("未定义")'));
      await motorAction(motorReset);
      const oldPlot = (await read('dq-plot')).renderCount;
      await change('ld', '-1', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '非法输入未阻止重绘');
      assert.equal((await read('dq-plot')).renderCount, oldPlot);
      assert.equal(await page.evaluate('document.getElementById("input-error").hidden'), false);
      await motorAction(motorReset);
      for (const [key, value] of [['lq', '.2'], ['flux', '0'], ['lq', '.4']]) {
        await motorChange(key, value);
        assert.ok(await page.evaluate('document.getElementById("dq-plot").data.every(trace=>trace.x.every(value=>value===null||Number.isFinite(value)))'));
      }
      await motorAction(motorReset);
      await motorChange('color-scale', 'fixed', 'change');
      const layouts = [];
      for (const [width, height] of motorDesktopOnly ? motorDesktopViewports : [[320, 568], [390, 844], [768, 768], [1060, 554], [1366, 768], [1440, 1000]]) {
        const previous = Number((await read('dq-plot')).renderCount);
        await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        await until(async () => Number((await read('dq-plot')).renderCount) > previous, '同步电机尺寸变化未重绘');
        const layout = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),rail=document.querySelector('.speed-rail'),bounds=plot.getBoundingClientRect();return{width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,plot:plot.clientWidth,plotHeight:plot.clientHeight,stageHeight:document.querySelector('.plot-stage').clientHeight,plotTop:bounds.top,plotBottom:bounds.bottom,rendered:plot._fullLayout.width,renderedHeight:plot._fullLayout.height,scaleRatio:Math.abs(plot._fullLayout.xaxis._m/plot._fullLayout.yaxis._m),speedRight:rail.getBoundingClientRect().left>=bounds.right}})()`);
        assert.equal(layout.width, width); assert.ok(layout.scroll <= width); assert.ok(Math.abs(layout.scaleRatio - 1) < 1e-8);
        assert.equal(layout.height, height); assert.ok(layout.scrollHeight <= height, '页面不应纵向滚动 ' + width + 'x' + height);
        assert.ok(layout.plotTop >= 0 && layout.plotBottom <= height, '整张图必须位于视窗内');
        assert.ok(Math.abs(layout.plotHeight - layout.stageHeight) < 3, '画布不被网格内容撑大');
        assert.ok(Math.abs(layout.renderedHeight - layout.plotHeight) < 3, '真实Plotly高度匹配容器而非裁剪');
        assert.equal(layout.speedRight, true);
        if (width === 1440) assert.ok(layout.plot / width > .88);
        assert.ok(Math.abs(layout.plot - layout.rendered) < 3); layouts.push(layout);
        if (width === 390) {
          await heldPan({ screenshot: '手机-按住拖动.png' });
          assert.equal(await page.evaluate('innerWidth'), width);
          await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
          await checkToolbar('rotor', true);
          await checkVectors(motorAction, 'rotor', true);
          const touchPoint = (await blankStart()).start, beforeTap = (await read('probe-readout')).point;
          for (let tap = 0; tap < 2; tap++) {
            await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
            await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            assert.equal((await read('probe-readout')).point, beforeTap);
          }
          const beforeTouch = await read('dq-plot'), fixedPoint = (await read('probe-readout')).point;
          const blankTouch = (await blankStart()).start;
          await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [blankTouch] });
          try {
            await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: blankTouch.x + 25, y: blankTouch.y }] });
            await nextPreview(Number(beforeTouch.previewFrameCount));
            assert.equal((await read('dq-plot')).previewActive, 'true');
          } finally { await page.call('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); }
          await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > Number(beforeTouch.renderCount) && state.previewActive === 'false'; }, '取消触摸后没有退出预览');
          assert.equal((await read('probe-readout')).point, fixedPoint); assert.equal((await read('probe-readout')).visible, 'true');
          assert.equal(await page.evaluate('document.getElementById("dq-plot")._dragging'), false);
          assert.equal(await page.evaluate('document.querySelectorAll(".dragcover").length'), 0);
          probeChecks.touchDragCancelled = true;
          await motorAction(motorReset);
          for (const [kind, target, cancelled] of [['current', 1.6, true], ['voltage', 1.2, false], ['torque', -.7, false], ['phase', -30, true]]) {
            await motorAction('document.getElementById("reset-view").click()');
            await dragCurve(kind, target, true, cancelled);
            await motorAction(motorReset);
          }
          await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-8,4],'yaxis.range':[-4,4]});return true})()`);
          await motorAction("document.getElementById('show-vectors').click()");
          for (const kind of ['mtpa', 'mtpv']) { await dragOptimum(kind, kind === 'mtpa' ? .9 : 1.2, 1, true); await motorAction(motorReset); }
          for (const kind of ['mtpa', 'mtpv']) { await checkOptimumFollowing(kind, true); await motorAction(motorReset); }
          await motorAction("document.getElementById('show-vectors').click()");
          await resetVectorPoint(motorAction, 'rotor');
          await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
        }
        await checkParameterLayout('rotor');
        if (width === 320 || width === 390 || width === 1440) {
          await page.evaluate('window.scrollTo({top:0,behavior:"instant"})');
          const metrics = await page.call('Page.getLayoutMetrics');
          const shot = await page.call('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(4000, metrics.cssContentSize.height), scale: 1 } });
          await fs.writeFile(path.join(evidence, `${width === 320 ? '窄屏' : width === 390 ? '手机' : '桌面'}-默认.png`), Buffer.from(shot.data, 'base64'));
          assert.equal(await page.evaluate('innerWidth'), width);
        }
      }
      const panelHeight = await page.evaluate('document.getElementById("dq-plot").clientHeight');
      await page.evaluate('document.querySelector(".probe-details").open=true');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").clientHeight'), panelHeight);
      assert.equal(await page.evaluate('document.documentElement.scrollHeight<=innerHeight'), true);
      await page.evaluate('document.querySelector(".probe-details").open=false');
      await motorAction('document.getElementById("theme-toggle").click()');
      assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'dark');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").layout.paper_bgcolor'), '#1d2520');
      const darkShot = await page.call('Page.captureScreenshot', {});
      await fs.writeFile(path.join(evidence, '桌面-深色.png'), Buffer.from(darkShot.data, 'base64'));
      await motorAction('document.getElementById("theme-toggle").click()');
      await fs.writeFile(path.join(evidence, '浏览器验收.json'), JSON.stringify({ raster, heatChecks, boundaryChecks, torqueChecks, coupledChecks, vectorChecks: vectorChecks.filter(check => check.frame === 'rotor'), safetyChecks: safetyChecks.filter(check => check.frame === 'rotor'), optimumFollowChecks, presetChecks: presetChecks.filter(check => check.frame === 'rotor'), parameterLayouts: parameterLayouts.filter(check => check.frame === 'rotor'), toolbarChecks: toolbarChecks.filter(check => check.frame === 'rotor'), constraintChecks: constraintChecks.filter(check => check.frame === 'rotor'), directDragChecks: directDragChecks.filter(check => check.frame === 'rotor'), visibilityChecks: visibilityChecks.filter(check => check.frame === 'rotor'), probeChecks, layouts, beforeZoom, zoomed, preserved, restored, errors: page.errors }, null, 2));
      await page.call('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '../页面/电机控制/同步电机/同步电机分析.html')).href });
      await until(() => page.evaluate('location.protocol==="file:" && Number(document.getElementById("dq-plot")?.dataset.renderCount)>0'), '直接打开HTML未能绘图');
      await page.call('Network.enable');
      motorTest.after(async () => {
        await page.call('Network.setBlockedURLs', { urls: [] });
        await page.call('Network.setCacheDisabled', { cacheDisabled: false });
      });
      await page.call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
      await page.call('Network.setCacheDisabled', { cacheDisabled: true });
      await page.call('Page.reload');
      await until(() => page.evaluate('Number(document.getElementById("dq-plot")?.dataset.renderCount)>0'), '阻断外网后本地页面无法绘图');
      await chooseHeat('active');
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.quantity==="active")'));
      await heldPan({ loseContext: true });
      const unavailable = await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...options){return type==='webgl'||type==='experimental-webgl'?null:original.call(this,type,...options)}})()` });
      try {
        await page.call('Page.reload');
        await until(() => page.evaluate('Number(document.getElementById("dq-plot")?.dataset.renderCount)>0'), '无WebGL页面加载失败');
        await chooseHeat('active');
        const fallback = await heldPan();
        assert.equal(fallback.backend, 'canvas2d'); assert.equal(fallback.fallback, 'webgl-unavailable');
      } finally { await page.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: unavailable.identifier }); }
      await fs.writeFile(path.join(evidence, '实时预览验收.json'), JSON.stringify({ previewChecks, cacheCheck, sliderPreview, errors: page.errors }, null, 2));
    });

    await t.test('VF：电压定向工作点、真实转矩着色、退化边界与一屏布局', async vfTest => {
      vfTest.after(async () => {
        await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      });
      const evidence = path.resolve(__dirname, '../临时测试/2026-11-13-VF工作点'); await fs.mkdir(evidence, { recursive: true });
      await navigate('页面/电机控制/同步电机/VF工作点分析.html');
      await until(() => page.evaluate('Number(document.getElementById("dq-plot").dataset.renderCount)>0'), 'VF未绘图');
      assert.equal(await page.evaluate('document.querySelector("#torque-values,#torque-preset,#pf-target,#show-pf")'), null);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="phase-level").map(trace=>trace.meta.value)'), defaultPhases);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque-level").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
      const action = async expression => {
        const before = Number((await read('dq-plot')).renderCount);
        await page.evaluate(expression);
        let previousCount = -1;
        await until(async () => {
          const state = await read('dq-plot'), count = Number(state.renderCount);
          const settled = count > before && count === previousCount && state.previewActive !== 'true';
          previousCount = count; return settled;
        }, 'VF未完成重绘');
      };
      const setValue = (id, value, event = 'input') => action(`(()=>{const field=document.getElementById('${id}');field.value=${JSON.stringify(String(value))};field.dispatchEvent(new Event('${event}',{bubbles:true}));})()`);
      const initial = JSON.parse((await read('probe-readout')).point);
      assert.equal(await page.evaluate('document.querySelector("#vfRatio,#voltageBoost,#voltage-mode,.vf-settings")'), null);
      assert.equal(JSON.parse((await read('dq-plot')).model).input.voltageMode, 'manual');
      assert.deepEqual(await page.evaluate('[...document.getElementById("heat-quantity").options].map(option=>option.value)'), ['none', 'voltage', 'torque', 'active', 'reactive']);
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      const voltageInitial = await voltageSnapshot();
      assert.deepEqual(voltageInitial.map(item => item.voltage).sort((first, second) => first - second), defaultVoltages.filter(voltage => voltage > 0));
      assert.ok(voltageInitial.every(item => item.count > 0 && item.error < 1e-8));
      assert.ok(voltageInitial.some(item => item.kind === 'voltage-level' && item.drawn));
      await setValue('voltage-values', '0,.35,2.4');
      await setValue('voltageLimit', 2.3);
      const customVoltage = await voltageSnapshot();
      assert.deepEqual(customVoltage.map(item => item.voltage), [.35, 2.4, 2.3]);
      assert.ok(customVoltage.every(item => item.count > 0 && item.error < 1e-8));
      await action('document.getElementById("show-voltage").click()');
      assert.deepEqual((await voltageSnapshot()).map(item => item.voltage), [.35, 2.4]);
      await action(`document.getElementById('show-voltage').click();${motorReset}`);
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      assert.ok(Math.abs(initial.vd - .8) < 1e-10 && Math.abs(initial.vq) < 1e-10);
      const trends = await trendStyles();
      assert.ok(trends.every(item => item.width === 1 && item.opacity === .45));
      assert.equal(trends.filter(item => item.kind === 'torque-level' && item.value < 0).length, 15);
      assert.equal(new Set(trends.filter(item => item.kind === 'torque-level').map(item => item.color)).size, 31);
      assert.ok(trends.some(item => item.kind === 'torque-level' && item.value < 0 && item.count > 2));
      assert.ok(Math.abs(initial.quadrature) > .01); assert.ok(initial.feasible);
      const rotorDirectionChecks = [];
      for (const angleDeg of [0, 90, -60, 110]) {
        await setValue('angleDeg', angleDeg);
        const axes = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot');return plot.data.filter(trace=>trace.meta.kind.startsWith('rotor-axis-')).map(trace=>{const full=plot._fullData.find(item=>item.meta?.kind===trace.meta.kind),label=plot._fullData.find(item=>item.meta?.kind==='rotor-label'&&item.meta.axis===trace.meta.kind),texts=[...plot.querySelectorAll('.trace'+label.uid+' .textpoint text')];return{kind:trace.meta.kind,direct:trace.x[1],quadrature:trace.y[1],label:label.text[0],textDrawn:texts.some(text=>text.textContent===label.text[0]&&text.getBoundingClientRect().width>0),drawn:[...plot.querySelectorAll('.trace'+full.uid+' .js-line')].some(path=>path.getTotalLength()>1)};});})()`);
        assert.equal(axes.length, 2); assert.ok(axes.every(axis => axis.drawn && axis.textDrawn), JSON.stringify(axes));
        const direct = axes.find(axis => axis.kind === 'rotor-axis-d'), length = Math.hypot(direct.direct, direct.quadrature), angle = angleDeg * Math.PI / 180;
        assert.ok(Math.abs(direct.direct / length - Math.cos(angle)) < 1e-8 && Math.abs(direct.quadrature / length + Math.sin(angle)) < 1e-8);
        assert.equal(direct.label, 'dᵣ'); rotorDirectionChecks.push({ angleDeg, axes });
      }
      await fs.writeFile(path.join(evidence, '转子方向验收.json'), JSON.stringify(rotorDirectionChecks, null, 2));
      const axisClip = await page.evaluate("(()=>{const plot=document.getElementById('dq-plot'),box=plot.getBoundingClientRect(),layout=plot._fullLayout;return{x:Math.max(0,box.left+layout.xaxis._offset+layout.xaxis.l2p(0)-180),y:Math.max(0,box.top+layout.yaxis._offset+layout.yaxis.l2p(0)-180),width:360,height:360,scale:1};})()");
      const axisShot = await page.call('Page.captureScreenshot', { clip: axisClip });
      await fs.writeFile(path.join(evidence, 'VF-转子方向局部.png'), Buffer.from(axisShot.data, 'base64'));
      const referenceSnapshot = () => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.view);return Object.fromEntries(['mtpa','mtpv'].map(kind=>{const trace=plot.data.find(item=>item.meta.kind===kind),full=plot._fullData.find(item=>item.meta.kind===kind),paths=[...plot.querySelectorAll('.trace'+full.uid+' .js-line')];return[kind,{checked:document.getElementById('show-'+kind).checked,toolbar:!!document.querySelector('#motor-settings #show-'+kind),inside:trace.x.filter((direct,index)=>direct!==null&&direct>=view.x[0]&&direct<=view.x[1]&&trace.y[index]>=view.y[0]&&trace.y[index]<=view.y[1]).length,drawn:paths.some(path=>path.getTotalLength()>2),signature:JSON.stringify([trace.x,trace.y])}]}))})()`);
      const initialReferences = await referenceSnapshot();
      for (const kind of ['mtpa', 'mtpv']) { assert.equal(initialReferences[kind].checked, true); assert.equal(initialReferences[kind].toolbar, true); assert.ok(initialReferences[kind].inside > 2 && initialReferences[kind].drawn, kind + ' initial visible curve'); }
      await checkVisibility(action, 'voltage');
      await checkToolbar('voltage');
      await checkPresets(action, 'voltage');
      await checkVectors(action, 'voltage');
      await checkVectorSafety(action, 'voltage');
      await checkConstraint(action, 'voltage');
      const vfLockChecks = [];
      assert.equal(await page.evaluate('document.querySelectorAll("#trajectory-table tbody tr td:last-child .trajectory-lock").length'), 4);
      for (const kind of ['voltage', 'current', 'torque', 'pf']) {
        await resetVectorPoint(action, 'voltage');
        const before = JSON.parse((await read('probe-readout')).point);
        await action(`document.getElementById('lock-${kind}').click()`);
        assert.deepEqual(Object.keys(JSON.parse((await read('dq-plot')).locks)), [kind]);
        const target = { direct: before.direct + .2, quadrature: before.quadrature + .2 };
        const moved = await dragVector('voltage', 'current-vector', target, false, false, true);
        assert.ok(Math.abs(moved.point[kind] - before[kind]) < 1e-8, kind);
        const displacement = Math.hypot(moved.point.direct - before.direct, moved.point.quadrature - before.quadrature);
        assert.ok(displacement > .005, kind);
        if (kind === 'voltage') assert.ok(Math.abs(moved.point.voltage - before.voltage) < 1e-8);
        else assert.ok(Math.abs(moved.point.voltage - before.voltage) > 1e-5, kind);
        vfLockChecks.push({ kind, fixedSource: kind === 'voltage', before, after: moved.point, displacement, pointer: moved.pointer });
        await action(`document.getElementById('lock-${kind}').click()`);
        assert.deepEqual(JSON.parse((await read('dq-plot')).locks), {});
      }
      await resetVectorPoint(action, 'voltage');
      for (const kind of ['voltage', 'current', 'torque', 'pf']) {
        await action(`document.getElementById('lock-${kind}').click()`);
        assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".trajectory-lock:checked")].map(input=>input.id)'), ['lock-' + kind]);
        assert.deepEqual(await page.evaluate('["voltageLimit","currentLimit","torque-target","phase-target"].map(id=>document.getElementById(id).disabled)'), ['voltage', 'current', 'torque', 'pf'].map(key => key === kind));
      }
      const lockShot = await page.call('Page.captureScreenshot', {});
      await fs.writeFile(path.join(evidence, 'VF-锁定.png'), Buffer.from(lockShot.data, 'base64'));
      const beforeLockedEdit = JSON.parse((await read('probe-readout')).point);
      await setValue('angleDeg', 90);
      assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).angleDeg - beforeLockedEdit.angleDeg) < 1e-8);
      assert.ok(await page.evaluate('document.getElementById("lock-status").textContent.includes("不兼容")'));
      await setValue('speedPU', 2); assert.equal(JSON.parse((await read('dq-plot')).model).input.speedPU, 1);
      await setValue('voltageLimit', 0); assert.equal(JSON.parse((await read('dq-plot')).model).outputVoltage, .8);
      await action('document.getElementById("lock-pf").click()');
      assert.equal(await page.evaluate('document.querySelectorAll(".trajectory-lock:checked").length'), 0);
      assert.ok(await page.evaluate('["voltageLimit","currentLimit","torque-target","phase-target"].every(id=>!document.getElementById(id).disabled)'));
      const unlockedTarget = await page.evaluate("(()=>{const model=JSON.parse(document.getElementById('dq-plot').dataset.model),point=VoltageMotor.atAngle(model,118);return{direct:point.direct,quadrature:point.quadrature};})()");
      await dragVector('voltage', 'current-vector', unlockedTarget);
      await fs.writeFile(path.join(evidence, 'VF锁定验收.json'), JSON.stringify({ vfLockChecks, mutuallyExclusive: true, incompatibleEditsRejected: true, unlockedMovement: true, onlySelectedConstraint: true, pointerVisible: true }, null, 2));
      await resetVectorPoint(action, 'voltage');
      for (const [kind, target] of [['current', 1.3], ['voltage', 1.05], ['torque', -.7], ['phase', -30]]) { await dragCurve(kind, target); await action(motorReset); }
      await setValue('voltageLimit', 1.3);
      for (const speed of [.5, -1, 0, 2]) {
        await setValue('speedPU', speed);
        assert.equal(JSON.parse((await read('dq-plot')).model).outputVoltage, 1.3);
        assert.equal(await page.evaluate('document.getElementById("voltageLimit").valueAsNumber'), 1.3);
      }
      await action(motorReset);
      const pixels = [];
      const torqueMapChecks = [];
      await setValue('heat-quantity', 'none', 'change');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.kind==="heat")'), false);
      await setValue('heat-quantity', 'torque', 'change');
      for (const speed of [1, -1, 2]) {
        await setValue('speedPU', speed); await action('document.getElementById("reset-view").click()');
        for (const quantity of ['voltage', 'torque', 'active', 'reactive']) {
        await setValue('heat-quantity', quantity, 'change');
        const snapshot = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=JSON.parse(plot.dataset.model),trace=plot.data.find(trace=>trace.meta.kind==='heat');let error=0,checked=0,offSource=0;for(let row=0;row<trace.y.length;row+=5)for(let column=0;column<trace.x.length;column+=5){const value=trace.z[row][column];if(value===null)continue;const direct=trace.x[column],quadrature=trace.y[row],state=VoltageMotor.originState(model,direct,quadrature),rotor=SynchronousMotor.evaluate(model,state.rotorDirect,state.rotorQuadrature);const expected={voltage:Math.hypot(rotor.vd,rotor.vq),torque:rotor.torque,active:state.voltage*direct,reactive:-state.voltage*quadrature};error=Math.max(error,Math.abs(value-expected[trace.meta.quantity]));checked++;if(Math.abs(state.voltage-model.outputVoltage)>.1)offSource++;}return{speed:model.input.speedPU,quantity:trace.meta.quantity,shape:[trace.y.length,trace.x.length],type:trace.type,representation:trace.meta.representation,error,checked,offSource,images:plot.querySelectorAll('.heatmaplayer image').length,minimum:trace.zmin};})()`);
        assert.equal(snapshot.representation, 'origin-connected-plane'); assert.equal(snapshot.type, 'heatmap'); assert.deepEqual(snapshot.shape, [81, 81]);
        assert.ok(snapshot.checked > 20 && snapshot.offSource > 20 && snapshot.images > 0 && snapshot.error < 1e-7, JSON.stringify(snapshot));
        assert.equal(snapshot.minimum, quantity === 'voltage' ? 0 : -2); torqueMapChecks.push(snapshot);
        const panStart = await blankStart(), start = { ...panStart.start, frames: panStart.frames, count: panStart.count };
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
        let sample;
        try {
          await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 70, y: start.y, button: 'left', buttons: 1 });
          await until(async () => Number((await read('dq-plot')).previewFrameCount) > start.frames, 'VF按住时无预览');
          sample = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.previewView),canvas=document.getElementById('drag-heat-cpu'),context=canvas.getContext('2d'),model=VoltageMotor.createOperatingModel(JSON.parse(plot.dataset.previewModel)),quantity=document.getElementById('heat-quantity').value,data=context.getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let offset=3;offset<data.length;offset+=4)if(data[offset])ink++;const samples=[];for(let row=3;row<canvas.height;row+=7)for(let column=3;column<canvas.width;column+=7){const direct=view.x[0]+column/(canvas.width-1)*(view.x[1]-view.x[0]),quadrature=view.y[1]-row/(canvas.height-1)*(view.y[1]-view.y[0]),state=VoltageMotor.originState(model,direct,quadrature);samples.push({rgba:[...context.getImageData(column,row,1,1).data],expected:state?MotorPreview.colorFor(state[quantity],2,quantity==='voltage'):null});}return{quantity,backend:plot.dataset.previewBackend,ink,total:canvas.width*canvas.height,opacity:Number(getComputedStyle(canvas).opacity),count:Number(plot.dataset.renderCount),samples};})()`);
          assert.equal(sample.count, start.count); assert.equal(sample.backend, 'canvas2d'); assert.equal(sample.opacity, 1);
          assert.ok(sample.ink / sample.total > .15, JSON.stringify({ ink: sample.ink, total: sample.total }));
          const regionPixels = await constraintPixels([[0, .5], [0, -.5], [1.4, 0]]);
          assertConstraintPixels(regionPixels); constraintChecks.push({ frame: 'voltage', type: 'preview', ...regionPixels });
          for (const checked of sample.samples) {
            assert.equal(checked.rgba[3], checked.expected ? 184 : 0);
            if (checked.expected) assert.ok(checked.expected.every((channel, index) => Math.abs(channel - checked.rgba[index]) <= 3), JSON.stringify(checked));
          }
          pixels.push(sample);
        } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 70, y: start.y, button: 'left', clickCount: 1 }); }
        await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > start.count && state.previewActive === 'false'; }, 'VF松开未精绘');
        }
      }
      const fieldBefore = await page.evaluate('JSON.stringify(document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="heat").z)');
      await setValue('voltageLimit', 1.2); await setValue('angleDeg', 100);
      assert.equal(await page.evaluate('JSON.stringify(document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="heat").z)'), fieldBefore, '全平面场不应依赖当前电源或相角');
      await action(motorReset); await setValue('heat-quantity', 'torque', 'change');
      await action('document.getElementById("reset-view").click()');
      let previousReferences = await referenceSnapshot();
      const speedChecks = [];
      for (const speed of [-1, 2]) {
        const previousView = JSON.parse((await read('dq-plot')).view);
        await setValue('speedPU', speed);
        const state = await read('dq-plot'), model = JSON.parse(state.model), currentView = JSON.parse(state.view), references = await referenceSnapshot();
        assert.equal(model.outputVoltage, .8);
        for (const kind of ['mtpa', 'mtpv']) assert.notEqual(references[kind].signature, previousReferences[kind].signature, kind + ' speed update');
        for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(currentView[axis][index] - previousView[axis][index]) < 1e-7, '调速不能改变用户视野');
        speedChecks.push({ speed, voltage: model.outputVoltage, voltageIndependent: true, mtpaUpdated: true, mtpvUpdated: true, viewPreserved: true }); previousReferences = references;
      }
      await setValue('speedPU', 0);
      assert.equal(JSON.parse((await read('dq-plot')).model).outputVoltage, .8);
      assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).quadrature) < 1e-10);
      await setValue('heat-quantity', 'torque', 'change'); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.kind==="heat")'), false);
      await setValue('resistance', 0); assert.equal(JSON.parse((await read('dq-plot')).model).reason, 'singular');
      await setValue('voltageLimit', 0); assert.equal(JSON.parse((await read('dq-plot')).model).reason, 'zero-voltage');
      assert.equal(JSON.parse((await read('probe-readout')).point), null);
      await action(motorReset);
      await setValue('flux', 0); await setValue('lq', .2);
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("MTPA/MTPV无唯一解")'));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>["mtpa","mtpv"].includes(trace.meta.kind)).every(trace=>trace.x.every(value=>value===null))'));
      await action(motorReset);
      await setValue('angleDeg', -80); assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).angleDeg + 80) < 1e-10);
      await setValue('torque-target', -.7); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="torque").meta.value'), -.7);
      await setValue('phase-target', 90); assert.ok(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="phase").x.every(value=>value===null||value===0)'));
      for (const layer of ['mtpa', 'mtpv', 'torque', 'phase', 'current', 'voltage']) {
        await action(`document.getElementById('show-${layer}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${layer}')`), false);
        await action(`document.getElementById('show-${layer}').click()`);
        assert.ok(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${layer}')`));
      }
      await action('document.getElementById("show-vectors").click()'); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="current-vector").visible'), false);
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="voltage-vector").visible'), false);
      await action(`document.getElementById('show-vectors').click();${motorReset}`);
      assert.equal(await page.evaluate('document.getElementById("torque-target").value'), '1');
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque-level").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
      const slider = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=document.getElementById('angle-slider').getBoundingClientRect();return{x:bounds.left+bounds.width*.6,y:bounds.top+bounds.height/2,step:bounds.width*.05,frames:Number(plot.dataset.previewFrameCount),count:Number(plot.dataset.renderCount)}})()`);
      const nextFrame = frames => page.evaluate(`new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{const plot=document.getElementById('dq-plot');if(Number(plot.dataset.previewFrameCount)>${frames})resolve({frames:Number(plot.dataset.previewFrameCount),builds:JSON.parse(plot.dataset.previewMetrics).geometryBuilds,count:Number(plot.dataset.renderCount),angle:JSON.parse(plot.dataset.previewModel).angleDeg,input:Number(document.getElementById('angleDeg').value),speed:JSON.parse(plot.dataset.previewModel).speedPU,speedInput:Number(document.getElementById('speedPU').value)});else if(performance.now()-start>5000)reject(new Error('VF滑块没有实时更新'));else setTimeout(check,8)};check()})`);
      let sliderPreview;
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: slider.x, y: slider.y, button: 'left', clickCount: 1 });
      try {
        const first = await nextFrame(slider.frames);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slider.x + slider.step, y: slider.y, button: 'left', buttons: 1 });
        sliderPreview = await nextFrame(first.frames);
        assert.equal(sliderPreview.angle, sliderPreview.input); assert.notEqual(sliderPreview.angle, first.angle);
        assert.equal(sliderPreview.builds, first.builds, '只改相角应复用轨迹缓存'); assert.equal(sliderPreview.count, slider.count);
      } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: slider.x + slider.step, y: slider.y, button: 'left', clickCount: 1 }); }
      await until(async () => Number((await read('dq-plot')).renderCount) > slider.count, 'VF滑块松开后未精绘');
      const speedSlider = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=document.getElementById('speed-slider').getBoundingClientRect();return{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height*.35,step:bounds.height*.07,frames:Number(plot.dataset.previewFrameCount),count:Number(plot.dataset.renderCount)}})()`);
      let speedPreview;
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: speedSlider.x, y: speedSlider.y, button: 'left', clickCount: 1 });
      try {
        const first = await nextFrame(speedSlider.frames);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: speedSlider.x, y: speedSlider.y + speedSlider.step, button: 'left', buttons: 1 });
        speedPreview = await nextFrame(first.frames);
        assert.equal(speedPreview.speed, speedPreview.speedInput); assert.notEqual(speedPreview.speed, first.speed);
        assert.ok(speedPreview.builds > first.builds, '调速必须重算优化曲线'); assert.equal(speedPreview.count, speedSlider.count);
      } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: speedSlider.x, y: speedSlider.y + speedSlider.step, button: 'left', clickCount: 1 }); }
      await until(async () => Number((await read('dq-plot')).renderCount) > speedSlider.count, '调速松开后未精绘');
      await action(motorReset);
      await setValue('resistance', 0); await setValue('voltageLimit', .001); await setValue('heat-quantity', 'torque', 'change'); await setValue('color-scale', 'auto', 'change');
      await setValue('angleDeg', 110); assert.equal((await read('dq-plot')).stale, 'false');
      assert.ok(await page.evaluate('(()=>{const heat=document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="heat");return Number.isFinite(heat.zmax)&&Math.abs(heat.zmax-Math.max(1e-6,...heat.z.flat().filter(Number.isFinite).map(Math.abs)))<1e-8;})()'));
      await action(motorReset); await setValue('color-scale', 'fixed', 'change'); await setValue('heat-quantity', 'torque', 'change');
      const layouts = [];
      for (const [width, height] of motorDesktopOnly ? motorDesktopViewports : [[320, 568], [390, 844], [1060, 554], [1440, 1000]]) {
        await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        await until(() => page.evaluate('document.getElementById("dq-plot")._fullLayout.width===document.getElementById("dq-plot").clientWidth'), 'VF尺寸未同步');
        await action('document.getElementById("reset-view").click()');
        const layout = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=plot.getBoundingClientRect(),header=document.querySelector('.motor-header').getBoundingClientRect(),heading=document.querySelector('h1').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,plotHeight:plot.clientHeight,renderedHeight:plot._fullLayout.height,bottom:bounds.bottom,headingBottom:heading.bottom,headerBottom:header.bottom}})()`);
        assert.equal(layout.width, width); assert.ok(layout.scrollWidth <= width && layout.scrollHeight <= height);
        assert.ok(layout.plotHeight >= 120); assert.ok(Math.abs(layout.plotHeight - layout.renderedHeight) < 2); assert.ok(layout.bottom <= height); assert.ok(layout.headingBottom <= layout.headerBottom); layouts.push(layout);
        const references = await referenceSnapshot();
        for (const kind of ['mtpa', 'mtpv']) assert.ok(references[kind].inside > 2 && references[kind].drawn, kind + ' visible at ' + width);
        if (width === 390) {
          await page.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
          try {
            await checkToolbar('voltage', true);
            await checkVectors(action, 'voltage', true);
            for (const [kind, target, cancelled] of [['current', 1.6, true], ['voltage', 1.05, false], ['torque', -.7, false], ['phase', -30, true]]) {
              await action('document.getElementById("reset-view").click()');
              await dragCurve(kind, target, true, cancelled);
              await action(motorReset);
            }
          } finally { await page.call('Emulation.setTouchEmulationEnabled', { enabled: false }); }
        }
        await checkParameterLayout('voltage');
        if (width === 320 || width === 390 || width === 1440) { const shot = await page.call('Page.captureScreenshot', {}); await fs.writeFile(path.join(evidence, `VF-${width}.png`), Buffer.from(shot.data, 'base64')); assert.equal(await page.evaluate('innerWidth'), width); }
      }
      await action('document.getElementById("theme-toggle").click()'); assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'dark');
      await action('document.getElementById("theme-toggle").click()');
      for (const [key, value] of [['resistance', 0], ['ld', .2], ['lq', .2], ['currentLimit', 6]]) await setValue(key, value);
      await setValue('voltageLimit', .5); await action('document.getElementById("reset-view").click()');
      const folded = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),trace=plot.data.find(trace=>trace.meta.kind==='feasible');const nearest=(axis,value)=>axis.reduce((best,entry,index)=>Math.abs(entry-value)<Math.abs(axis[best]-value)?index:best,0);return[[.5,-5],[0,5]].map(([direct,quadrature])=>({direct,quadrature,outsideVoltage:direct*direct+(quadrature+2.5)**2>16,filled:trace.z[nearest(trace.y,quadrature)][nearest(trace.x,direct)]===1}))})()`);
      assert.equal(folded[0].outsideVoltage, false); assert.equal(folded[0].filled, true);
      assert.equal(folded[1].outsideVoltage, true); assert.equal(folded[1].filled, false);
      const foldedStart = await blankStart();
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...foldedStart.start, button: 'left', clickCount: 1 });
      try {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: foldedStart.start.x + 50, y: foldedStart.start.y, button: 'left', buttons: 1 });
        await until(async () => Number((await read('dq-plot')).previewFrameCount) > foldedStart.frames, '多分支约束域未预览');
        const checked = await constraintPixels([[.5, -5], [0, 5]]); assertConstraintPixels(checked); constraintChecks.push({ frame: 'voltage', type: 'folded', folded, ...checked });
      } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: foldedStart.start.x + 50, y: foldedStart.start.y, button: 'left', clickCount: 1 }); }
      await until(async () => (await read('dq-plot')).previewActive === 'false', '多分支约束域未结束预览');
      await action(motorReset); await action('document.getElementById("reset-view").click()');
      await page.call('Network.enable'); await page.call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }); await page.call('Network.setCacheDisabled', { cacheDisabled: true });
      try {
        await page.call('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '../页面/电机控制/同步电机/VF工作点分析.html')).href });
        await until(() => page.evaluate('location.protocol==="file:" && Number(document.getElementById("dq-plot")?.dataset.renderCount)>0'), 'VF离线绘图失败');
        assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).torque - initial.torque) < 1e-12);
      } finally { await page.call('Network.setBlockedURLs', { urls: [] }); await page.call('Network.setCacheDisabled', { cacheDisabled: false }); }
      await fs.writeFile(path.join(evidence, 'VF验收.json'), JSON.stringify({ initial, voltageInitial, customVoltage, vectorChecks: vectorChecks.filter(check => check.frame === 'voltage'), safetyChecks: safetyChecks.filter(check => check.frame === 'voltage'), presetChecks: presetChecks.filter(check => check.frame === 'voltage'), parameterLayouts: parameterLayouts.filter(check => check.frame === 'voltage'), toolbarChecks: toolbarChecks.filter(check => check.frame === 'voltage'), constraintChecks: constraintChecks.filter(check => check.frame === 'voltage'), directDragChecks: directDragChecks.filter(check => check.frame === 'voltage'), visibilityChecks: visibilityChecks.filter(check => check.frame === 'voltage'), initialReferences: Object.fromEntries(Object.entries(initialReferences).map(([kind, { signature, ...values }]) => [kind, values])), speedChecks, torqueMapChecks, pixels, sliderPreview, speedPreview, offline: true, layouts, errors: page.errors }, null, 2));
    });

    if (motorDesktopOnly) {
      assert.deepEqual([...new Set(visitedPages)], ['页面/电机控制/同步电机/同步电机分析.html', '页面/电机控制/同步电机/VF工作点分析.html']);
      assert.deepEqual(page.errors, []);
      await fs.writeFile(path.resolve(__dirname, '../临时测试/2026-11-13-同步电机曲线/桌面专项验收.json'), JSON.stringify({ scope: '同步电机两页桌面', visitedPages, viewports: motorDesktopViewports, mobileCases: false, errors: page.errors }, null, 2));
      return;
    }

    await navigate('页面/控制原理/PI控制器/控制器可视化.html');
    await until(()=>page.evaluate('!!document.querySelector("#phase")?.dataset.state'), '控制器初次绘制');
    assert.equal(await page.evaluate('document.getElementById("stability").dataset.regime'),'unstable');
    assert.equal(await page.evaluate('document.getElementById("damping").min'),'-4');
    await click('reset-all');
    assert.equal(await page.evaluate('document.querySelectorAll("#parameters input[type=number]").length'), 11);
    const initialController = JSON.parse((await read('phase')).state);
    assert.equal(initialController.f, 1.4); assert.equal(initialController.v, 0);
    assert.equal(await page.evaluate('document.querySelector(".field-arrow, #current-vector") === null'),true);
    assert.ok(await page.evaluate('document.querySelector(".flow-line").getAttribute("d").length > 100'));
    await click('flow-complete');
    const normalCount=Number((await read('phase')).flowCount);
    assert.ok(normalCount>100);
    const fades=await page.evaluate('Array.from(document.querySelectorAll(".flow-band"),el=>Number(el.getAttribute("opacity")))');
    assert.ok(fades[0]>.6&&fades.at(-1)===0&&fades.every((x,i)=>i===0||x<=fades[i-1]));
    await click('flow-animate');await delay(200);
    assert.ok(Number((await read('phase')).flowTime)>0&&Number((await read('phase')).flowTime)<1.2);
    assert.equal(JSON.parse((await read('phase')).state).t,0,'背景流场时间与主轨迹时间独立');
    await click('flow-animate');const heldFlow=(await read('phase')).flowTime;await delay(100);
    assert.equal((await read('phase')).flowTime,heldFlow);
    await change('flow-density','5','input');assert.ok(Number((await read('phase')).flowCount)>normalCount);
    await change('flow-density','1','input');assert.ok(Number((await read('phase')).flowCount)<normalCount);
    await change('flow-density','3','input');
    await change('flow-seeding','absolute');assert.equal((await read('phase')).flowWeighted,'true');
    await change('flow-seeding','square');assert.equal((await read('phase')).flowMode,'square');
    await change('flow-horizon','2');assert.equal((await read('phase')).flowTime,'2');
    await change('flow-horizon','1.2');await change('flow-seeding','uniform');
    await change('timeline', '4', 'input');
    assert.ok(Math.abs(JSON.parse((await read('phase')).state).v - 1) < .1);
    const atFour=(await read('phase')).state;
    await change('flow-horizon','3');assert.equal((await read('phase')).state,atFour,'改变背景时长不改主轨迹');
    await change('flow-horizon','1.2');
    await change('preset', 'proportional');
    await change('timeline', '12', 'input');
    const pEnd=JSON.parse((await read('phase')).state);
    assert.ok(pEnd.v < .6 && pEnd.v > .4, '有摩擦的纯P保留稳态误差');
    assert.equal(await page.evaluate('document.querySelector(".equilibrium") === null'), true);
    for(const name of ['oscillation','smooth','friction','default']){
      await change('preset',name);
      assert.ok(await page.evaluate('!document.querySelector("#phase").innerHTML.includes("NaN")'));
    }
    await change('friction','1.8','input'); await delay(100);
    assert.equal(await page.evaluate('document.getElementById("preset").value'), 'custom');
    await change('mass','0','input'); await delay(100);
    assert.equal(await page.evaluate('document.getElementById("input-error").hidden'),false);
    assert.equal(await page.evaluate('document.getElementById("play").disabled'),true);
    await click('reset-all');
    await click('play'); await delay(200);
    assert.ok(JSON.parse((await read('phase')).state).t > 0);
    await click('play'); const held=(await read('phase')).state;
    await delay(100); assert.equal((await read('phase')).state,held);
    await click('restart'); assert.equal(JSON.parse((await read('phase')).state).t,0);
    const seed=await page.evaluate('(()=>{const r=document.getElementById("phase").getBoundingClientRect();return{x:r.left+r.width*.4,y:r.top+r.height*.5}})()');
    await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:seed.x,y:seed.y,button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:seed.x,y:seed.y,button:'left',clickCount:1});
    assert.notEqual(JSON.parse((await read('phase')).state).f,1.4);
    await page.evaluate('document.getElementById("phase").focus()');
    const beforeKey=JSON.parse((await read('phase')).state);
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    assert.ok(Math.abs(JSON.parse((await read('phase')).state).f-beforeKey.f-.05)<1e-9);
    await click('show-flow');assert.equal(await page.evaluate('document.querySelector(".flow-line") === null'),true);await click('show-flow');
    await click('show-nullclines');assert.equal(await page.evaluate('document.querySelector(".velocity-curve") === null'),true);await click('show-nullclines');
    await change('preset','unstable');
    await change('flow-seeding','absolute');assert.equal((await read('phase')).flowWeighted,'false');
    await change('flow-seeding','uniform');
    assert.equal((await read('stability')).regime,'unstable');
    assert.equal(JSON.parse((await read('gain-map')).analysis).kpCritical,1);
    await click('set-boundary');
    assert.equal((await read('stability')).regime,'boundary');
    assert.equal(await page.evaluate('document.getElementById("kp").value'),'1');
    await click('set-stable');
    assert.equal((await read('stability')).regime,'stable');
    assert.equal(await page.evaluate('document.getElementById("damping").value'),'-1');
    await change('preset','local');
    assert.equal(JSON.parse((await read('gain-map')).analysis).globalSufficient,false);
    assert.ok(await page.evaluate('document.getElementById("stability-note").textContent.includes("局部")'));
    await change('preset','unstable');
    const gainPosition=await page.evaluate('(()=>{const el=document.getElementById("gain-map");el.scrollIntoView({block:"center",behavior:"instant"});const r=el.getBoundingClientRect();return{x:r.left+42+(r.width-60)*.25,y:r.top+31+(r.height-74)*.5}})()');
    await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:gainPosition.x,y:gainPosition.y,button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:gainPosition.x,y:gainPosition.y,button:'left',clickCount:1});
    assert.ok(Math.abs(Number(await page.evaluate('document.getElementById("kp").value'))-2)<.02);
    // MouseEvent 客户区坐标以像素取整；Ki 轴每像素约 0.061。
    assert.ok(Math.abs(Number(await page.evaluate('document.getElementById("ki").value'))-6)<.07);
    assert.equal((await read('stability')).regime,'stable');
    await page.evaluate('document.getElementById("gain-map").focus()');
    const beforeGain=Number(await page.evaluate('document.getElementById("kp").value'));
    await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
    await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
    assert.ok(Math.abs(Number(await page.evaluate('document.getElementById("kp").value'))-beforeGain+.05)<1e-9);
    for(const [id,value] of [['mass','.2'],['damping','-4'],['kp','0'],['ki','0'],['force0','0'],['speed0','1'],['duration','30']])await change(id,value,'input');
    await delay(150);
    assert.equal(await page.evaluate('document.getElementById("simulation-note").hidden'),false);
    assert.ok(Number(await page.evaluate('document.getElementById("timeline").max'))<1);
    await change('timeline','30','input');
    assert.ok(JSON.parse((await read('phase')).state).t<1);
    assert.ok(await page.evaluate('!document.querySelector("#phase").innerHTML.includes("NaN") && !document.querySelector("#response").innerHTML.includes("NaN")'));
    await change('preset','unstable');await change('timeline','6','input');
    await page.evaluate('window.scrollTo({top:0,left:0,behavior:"instant"})');
    if(process.env.CONTROLLER_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.CONTROLLER_SCREENSHOT_DIR,{recursive:true});
      const shot=await page.call('Page.captureScreenshot',{captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:1800,scale:1}});
      await fs.writeFile(path.join(process.env.CONTROLLER_SCREENSHOT_DIR,'渐隐轨迹桌面预览.png'),Buffer.from(shot.data,'base64'));
      await change('preset','local');await change('flow-seeding','square');await change('flow-horizon','2');
      const localShot=await page.call('Page.captureScreenshot',{captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:1600,scale:1}});
      await fs.writeFile(path.join(process.env.CONTROLLER_SCREENSHOT_DIR,'散度加密预览.png'),Buffer.from(localShot.data,'base64'));
      await change('preset','unstable');await change('flow-seeding','uniform');await change('flow-horizon','1.2');
    }
    for(const width of [320,390,768,1440]){
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<768});await delay(100);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'控制器窄屏不溢出 '+width);
      assert.ok(await page.evaluate('!document.querySelector("#phase").innerHTML.includes("NaN")'));
      assert.ok(await page.evaluate('!document.querySelector("#gain-map").innerHTML.includes("NaN")'));
      if(width===390&&process.env.CONTROLLER_SCREENSHOT_DIR){
        await page.evaluate('document.querySelector(".phase-panel").scrollIntoView({block:"start",behavior:"instant"})');
        const shot=await page.call('Page.captureScreenshot',{});
        await fs.writeFile(path.join(process.env.CONTROLLER_SCREENSHOT_DIR,'渐隐轨迹手机预览.png'),Buffer.from(shot.data,'base64'));
      }
    }
    await click('theme-toggle');await delay(100);
    assert.ok(await page.evaluate('document.querySelector("#phase .flow-line").getAttribute("d").length > 100'));
    if(process.env.CONTROLLER_SCREENSHOT_DIR){
      await change('preset','stabilized');
      await page.evaluate('document.querySelector(".phase-panel").scrollIntoView({block:"start",behavior:"instant"})');
      const shot=await page.call('Page.captureScreenshot',{});
      await fs.writeFile(path.join(process.env.CONTROLLER_SCREENSHOT_DIR,'渐隐轨迹深色预览.png'),Buffer.from(shot.data,'base64'));
    }
    await click('theme-toggle');
    await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await navigate('页面/控制原理/PI控制器/控制器可视化.html');
    await until(()=>page.evaluate('!!document.querySelector("#phase")?.dataset.flowTime'),'减少动态效果初始化');
    assert.equal((await read('phase')).flowRunning,'false');assert.equal((await read('phase')).flowTime,'1.2');
    await page.call('Emulation.setEmulatedMedia',{features:[]});
    if(process.env.CONTROLLER_STANDALONE){
      await page.call('Page.navigate',{url:pathToFileURL(process.env.CONTROLLER_STANDALONE).href});
      await until(()=>page.evaluate('document.readyState==="complete" && document.getElementById("stability")?.dataset.regime==="unstable"'),'独立控制器页面未初始化');
      assert.equal(await page.evaluate('document.getElementById("damping").value'),'-1');
      assert.ok(await page.evaluate('document.querySelector("#phase .flow-line").getAttribute("d").length>100'));
      await click('set-boundary');assert.equal((await read('stability')).regime,'boundary');
      await click('set-stable');assert.equal((await read('stability')).regime,'stable');
    }
    await navigate('页面/电机控制/PWM实验/PWM教学实验.html');
    assert.equal((await read('space-3d')).stateCount, '27'); assert.equal((await read('space-3d')).positionCount, '19');
    const hull = JSON.parse((await read('space-3d')).projectionHull);
    assert.equal(hull.length, 6);
    for (const vertex of hull) assert.ok(Math.abs(Math.hypot(...vertex) - Math.sqrt(8 / 3)) < 1e-10);
    assert.equal((await read('space-3d')).planeGrid, 'false');
    const layout = await page.evaluate(`(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};return {controls:rect('pwm-controls'),carrier:rect('modulator'),pwm:rect('waveform'),cube:rect('space-3d'),sidebar:document.querySelector('.lab-sidebar').getBoundingClientRect().left}})()`);
    assert.ok(layout.controls.right < layout.carrier.left, '参数位于三图左侧');
    assert.equal((await read('space-3d')).cubeEdgeCount, '12');
    assert.equal((await read('space-3d')).projectionLinkCount, '1');
    assert.equal(await page.evaluate('document.getElementById("space-links") === null'), true);
    assert.ok(layout.cube.bottom < layout.carrier.top && layout.carrier.bottom < layout.pwm.top, '三维图在前，随后载波与三相PWM');
    assert.equal(await page.evaluate('document.getElementById("ratio").value'), '40');
    assert.equal(await page.evaluate('document.querySelector("#pwm-controls button[type=submit]")'), null);
    assert.ok(layout.sidebar > layout.cube.right, '说明位于三图右侧');
    assert.equal(layout.carrier.left, layout.pwm.left, '时间轴左右对齐');
    assert.ok(layout.pwm.top - layout.carrier.bottom < 110);
    assert.equal(await page.evaluate('parseFloat(getComputedStyle(document.querySelector(".lab-results")).rowGap)'), 6);
    assert.ok(layout.cube.bottom - layout.cube.top >= 600, '扩大桌面三维绘图区');
    assert.equal((await read('space-3d')).latticeEdgeCount, '30');
    assert.deepEqual(JSON.parse((await read('space-3d')).planeOpacity), { fill: .045, edge: .32 });
    const mappingBeforeOptions = (await read('space-3d')).projection;
    assert.equal(await page.evaluate('document.querySelectorAll("#show-alpha, #show-beta, #show-zero").length'), 0);
    for (const [key, id] of [['cube', 'show-cube'], ['abc', 'show-abc'], ['alphaBetaZero', 'show-alphabeta-zero']]) {
      await click(id);
      assert.equal(JSON.parse((await read('space-3d')).visibleGeometry)[key], false);
      if (key === 'cube') assert.equal((await read('space-3d')).cubeEdgeCount, '0');
      if (key === 'cube') assert.equal((await read('space-3d')).latticeEdgeCount, '0');
      assert.equal((await read('space-3d')).projection, mappingBeforeOptions);
      await click(id);
      if (key === 'cube') {
        assert.equal((await read('space-3d')).cubeEdgeCount, '12');
        assert.equal((await read('space-3d')).latticeEdgeCount, '30');
      }
    }
    for (const key of ['thipwm', 'dpwm5', 'dpwmmax', 'dpwmmin']) {
      assert.equal(JSON.parse((await read('space-3d')).trajectories)[key], 721);
      await click('show-' + key + '-reference');
      assert.equal(JSON.parse((await read('space-3d')).visibleTrajectories)[key], true);
      assert.equal(JSON.parse((await read('space-3d')).reference)[key].length, 3);
      await click('show-' + key + '-reference');
      assert.equal(JSON.parse((await read('space-3d')).visibleTrajectories)[key], false);
    }
    if (process.env.PWM_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.PWM_SCREENSHOT_DIR, { recursive: true });
      const screenshot = await page.call('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: 1500, scale: 1 } });
      await fs.writeFile(path.join(process.env.PWM_SCREENSHOT_DIR, 'PWM桌面.png'), Buffer.from(screenshot.data, 'base64'));
    }
    const trajectories = JSON.parse((await read('space-3d')).trajectories);
    assert.equal(trajectories.spwm, 721); assert.equal(trajectories.svpwm, 721);
    assert.ok(trajectories.zeroRange[0] < 0 && trajectories.zeroRange[1] > 0);
    await page.evaluate('document.getElementById("show-spwm-reference").click()');
    assert.equal(JSON.parse((await read('space-3d')).visibleTrajectories).spwm, false);
    await page.evaluate('document.getElementById("show-spwm-reference").click()');
    assert.equal(JSON.parse((await read('space-3d')).visibleTrajectories).spwm, true);
    const originalMapping = (await read('space-3d')).projection;
    const zeroAxis = JSON.parse((await read('space-3d')).zeroAxis);
    assert.deepEqual(zeroAxis.negative, [-1.3, -1.3, -1.3]);
    assert.ok(zeroAxis.negativeLabel.includes('−1,−1,−1'));
    await change('levels', '2');
    assert.ok(JSON.parse((await read('space-3d')).zeroAxis).negativeLabel.includes('000'));
    await change('levels', '3');
    await change('space-view', 'zero');
    const rotation = await page.evaluate(`(()=>{
      const oldRAF=window.requestAnimationFrame,oldCancel=window.cancelAnimationFrame;let next=1;const queue=new Map();
      window.requestAnimationFrame=fn=>{const id=next++;queue.set(id,fn);return id};window.cancelAnimationFrame=id=>queue.delete(id);
      const frame=t=>{const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn(t))};
      const canvas=document.getElementById('space-3d'),button=document.getElementById('space-rotate'),read=()=>JSON.parse(canvas.dataset.camera);
      try {
        button.click();const initial=read();frame(1000);frame(2000);const rotated=read(),mapping=canvas.dataset.projection,view=document.getElementById('space-view').value;
        button.click();const stopped=read();frame(5000);const afterStop=read();
        button.click();frame(6000);frame(7000);document.getElementById('space-reset').click();
        return {initial,rotated,mapping,view,stopped,afterStop,pending:queue.size,pressed:button.getAttribute('aria-pressed'),probe:document.getElementById('animate').getAttribute('aria-pressed')};
      } finally {if(button.getAttribute('aria-pressed')==='true')button.click();window.requestAnimationFrame=oldRAF;window.cancelAnimationFrame=oldCancel;}
    })()`);
    assert.equal(rotation.initial.yaw, -.75); assert.equal(rotation.initial.pitch, .5); assert.equal(rotation.initial.zoom, 1);
    assert.ok(Math.abs(rotation.rotated.yaw - rotation.initial.yaw - Math.PI / 15) < 1e-10, '一秒绕C轴12度');
    assert.equal(rotation.rotated.pitch, rotation.initial.pitch); assert.equal(rotation.rotated.roll, 0);
    assert.equal(rotation.mapping, originalMapping); assert.equal(rotation.view, 'custom');
    assert.deepEqual(rotation.afterStop, rotation.stopped); assert.equal(rotation.pending, 0); assert.equal(rotation.pressed, 'false'); assert.equal(rotation.probe, 'false');
    await click('space-rotate'); await delay(100);
    assert.equal(await page.evaluate('document.getElementById("space-rotate").getAttribute("aria-pressed")'), 'true');
    await change('space-view', 'A');
    assert.equal(await page.evaluate('document.getElementById("space-rotate").getAttribute("aria-pressed")'), 'false');
    await click('space-rotate');
    await page.evaluate('document.getElementById("space-3d").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight"}));');
    assert.equal(await page.evaluate('document.getElementById("space-rotate").getAttribute("aria-pressed")'), 'false');
    await click('space-reset');
    assert.equal((await read('space-3d')).projectionMode, 'orthographic');
    assert.equal(await page.evaluate('document.getElementById("space-projection").value'), 'orthographic');
    assert.equal(await page.evaluate('document.getElementById("show-lattice") === null'), true);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#space-view option")].map(o=>o.value)'), ['default', 'A', 'B', 'C', 'alpha', 'beta', 'zero', 'custom']);
    assert.equal(await page.evaluate('document.querySelector("#space-view option[value=default]").textContent'), '默认视角');
    const overlayLabels = await page.evaluate(`(()=>{const labels=[],original=CanvasRenderingContext2D.prototype.fillText;try{CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(this.canvas.id==='space-3d') labels.push(text);return original.call(this,text,...args)};document.getElementById('space-reset').click();return labels;}finally{CanvasRenderingContext2D.prototype.fillText=original}})()`);
    assert.ok(!overlayLabels.some(text => /A\s*\+\s*B\s*\+\s*C\s*=\s*0/.test(text)), '三维画布不显示平面方程文字');
    for (const view of ['A', 'B', 'C', 'alpha', 'beta', 'zero', 'default']) {
      await change('space-view', view);
      assert.equal((await read('space-3d')).viewPreset, view);
      assert.equal((await read('space-3d')).projectionMode, 'orthographic');
      assert.equal((await read('space-3d')).projection, originalMapping);
    }
    const screenAxes = await page.evaluate(`(()=>{const c=document.getElementById('space-3d'),camera=SpatialProjection.viewCamera('zero',JSON.parse(c.dataset.camera));return [[0,0,0],[1,-.5,-.5],[0,Math.sqrt(3)/2,-Math.sqrt(3)/2]].map(v=>SpatialProjection.cameraPoint(v,camera,c.clientWidth,c.clientHeight));})()`);
    assert.ok(screenAxes[1].x > screenAxes[0].x);
    assert.ok(Math.abs(screenAxes[1].y - screenAxes[0].y) < 1e-8, 'Zero视角α水平向右');
    assert.ok(screenAxes[2].y < screenAxes[0].y);
    assert.ok(Math.abs(screenAxes[2].x - screenAxes[0].x) < 1e-8, 'Zero视角β竖直向上');
    await change('space-projection', 'orthographic');
    assert.equal((await read('space-3d')).projectionMode, 'orthographic');
    assert.equal((await read('space-3d')).projection, originalMapping, '切换成像不改变数学映射');
    const pose = JSON.parse((await read('space-3d')).camera);
    await click('space-reset'); assert.equal((await read('space-3d')).projectionMode, 'orthographic');
    await change('space-view', 'zero'); assert.equal((await read('space-3d')).projectionMode, 'orthographic');
    await click('space-reset');
    await change('space-projection', 'perspective');
    assert.equal((await read('space-3d')).projectionMode, 'perspective');
    assert.equal(JSON.parse((await read('space-3d')).camera).yaw, pose.yaw);
    const initial = (await read('space-3d')).camera;
    await page.evaluate('document.getElementById("space-3d").focus()');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    assert.notEqual((await read('space-3d')).camera, initial, '真实键盘旋转');
    assert.equal(await page.evaluate('document.getElementById("space-view").value'), 'custom');
    assert.equal(await page.evaluate('document.getElementById("space-view").selectedOptions[0].textContent'), '自由视角');
    await click('space-reset');
    await page.evaluate('document.getElementById("space-3d").scrollIntoView({block:"center",behavior:"instant"})');
    const r = await page.evaluate('(()=>{const r=document.getElementById("space-3d").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 60, y: r.y + 20, button: 'left', buttons: 1 });
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 60, y: r.y + 20, button: 'left', clickCount: 1 });
    assert.notEqual((await read('space-3d')).camera, initial, '真实拖拽旋转');
    assert.equal(await page.evaluate('document.getElementById("space-view").value'), 'custom');
    const freeCamera = (await read('space-3d')).camera;
    await change('space-view', 'custom');
    assert.equal((await read('space-3d')).camera, freeCamera, '选择自由视角保留当前姿态');
    assert.ok(JSON.parse((await read('space-3d')).camera).yaw < JSON.parse(initial).yaw, '向右拖动应按抓住模型的方向旋转');
    await change('space-view', 'zero'); assert.notEqual((await read('space-3d')).camera, initial);
    await click('space-reset'); assert.equal((await read('space-3d')).camera, initial);
    assert.equal(await page.evaluate('!!document.querySelector("#probe, #space, #spectrum, #she-controls")'), false, '删除滑块、二维辅助图和谐波区');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#method option")].map(option=>option.value)'), ['SPWM', 'SVPWM', 'THIPWM', 'DPWM5', 'DPWMMAX', 'DPWMMIN']);
    for (const method of ['THIPWM', 'DPWMMAX', 'DPWMMIN', 'DPWM5']) {
      await change('method', method);
      assert.equal((await read('modulator')).method, method);
      assert.equal(await page.evaluate('document.getElementById("status").textContent.includes("错误")'), false);
      assert.equal((await read('waveform')).probeAngle, (await read('modulator')).probeAngle);
      if (method === 'DPWM5') assert.equal(await page.evaluate('document.getElementById("levels").value'), '2');
    }
    await change('levels', '3');
    assert.equal(await page.evaluate('document.getElementById("method").value'), 'SVPWM');
    await change('method', 'SPWM');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#zoom option")].map(option=>option.value)'), ['0.5', '1', '2']);
    const channels = ['waveform'];
    assert.deepEqual(JSON.parse((await read('waveform-plots')).series), ['UAO', 'UBO', 'UCO']);
    const firstState = JSON.parse((await read('space-3d')).projection);
    assert.deepEqual(JSON.parse((await read('waveform-plots')).values), firstState.abc, '相电压以直流中点为参考');
    assert.notDeepEqual(firstState.abc, firstState.plane, '该测试状态应区分桥臂与浮动中性点电压');
    assert.deepEqual(JSON.parse((await read('waveform')).series), ['UAO', 'UBO', 'UCO']);
    assert.deepEqual(JSON.parse((await read('waveform')).yTicks), [-1, 0, 1]);
    const panels = JSON.parse((await read('waveform')).panels);
    assert.equal(panels.length, 3);
    assert.ok(panels[0].bottom < panels[1].top && panels[1].bottom < panels[2].top, '同图三个通道必须上下分区而不是叠加');
    assert.equal(await page.evaluate('document.querySelectorAll("#waveform-plots canvas").length'), 1);
    async function chartPosition(id, fraction, channel = 1) {
      await page.evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center',behavior:'instant'})`);
      return page.evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)}),r=el.getBoundingClientRect(),panels=el.dataset.panels?JSON.parse(el.dataset.panels):null;const y=panels?(panels[${channel}].top+panels[${channel}].bottom)/2*r.height/(el.height/devicePixelRatio):r.height/2;return{x:r.left+48+${fraction}*(r.width-64),y:r.top+y};})()`);
    }
    const projection = (await read('space-3d')).projection;
    const hover = await chartPosition('waveform', .26);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y });
    assert.notEqual((await read('space-3d')).projection, projection, '图内悬停应联动三维状态');
    const point = JSON.parse((await read('space-3d')).projection); assert.ok(Math.abs(point.plane.reduce((a, b) => a + b, 0)) < 1e-10);
    const reference = JSON.parse((await read('space-3d')).reference);
    assert.ok(Math.abs(reference.spwm.reduce((a, b) => a + b, 0)) < 1e-10);
    assert.ok(Math.abs(reference.svpwm.reduce((a, b) => a + b, 0) - 3 * reference.zero) < 1e-10);
    assert.ok(Math.abs(reference.zero) > .05, '图内探针应移动到可见的零序偏移位置');
    assert.deepEqual(JSON.parse((await read('waveform-plots')).values), point.abc, '三相波形取桥臂对直流中点电压');
    for (const cycles of ['0.5', '1', '2']) {
      await change('zoom', cycles);
      for (const id of channels) {
        assert.equal((await read(id)).cycles, cycles);
        assert.equal(JSON.parse((await read(id)).series).length, 3);
      }
    }
    await change('output', 'line'); assert.deepEqual(JSON.parse((await read('waveform-plots')).series), ['UAB', 'UBC', 'UCA']);
    for (const id of channels) assert.deepEqual(JSON.parse((await read(id)).yTicks), [-2, -1, 0, 1, 2]);
    const start = await chartPosition('waveform', .2), end = { ...start, x: (await chartPosition('waveform', .75)).x };
    await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
    const oldAngle = Number((await read('waveform')).probeAngle);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1 });
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 });
    assert.ok(Number((await read('waveform')).probeAngle) > oldAngle);
    assert.ok(Number((await read('waveform')).probeAngle) > 360, '两周期探针应覆盖第二个周期');
    assert.equal((await read('waveform')).probeAngle, (await read('modulator')).probeAngle);
    const secondChannel = await chartPosition('waveform', .42, 1);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondChannel.x, y: secondChannel.y });
    for (const id of channels) assert.equal((await read(id)).probeAngle, (await read('modulator')).probeAngle, '任一通道移动探针均同步所有波形');
    const abc = JSON.parse((await read('space-3d')).projection).abc;
    assert.deepEqual(JSON.parse((await read('waveform-plots')).values), [abc[0] - abc[1], abc[1] - abc[2], abc[2] - abc[0]]);
    await page.evaluate('document.getElementById("waveform").focus()');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    assert.ok(Number((await read('waveform')).probeAngle) > 719);
    await change('zoom', '0.5');
    assert.ok(Number((await read('waveform')).probeAngle) < 180, '缩短窗口时探针应限制在窗口内');
    await change('levels', '2'); assert.equal((await read('space-3d')).stateCount, '8'); assert.equal((await read('space-3d')).positionCount, '7');
    await change('levels', '3');
    for (const method of ['SVPWM', 'SPWM']) {
      await change('method', method);
      assert.equal(await page.evaluate(`document.getElementById('status').textContent.includes(${JSON.stringify(method)})`), true);
    }
    const animationButton = await page.evaluate(`(()=>{const b=document.getElementById('animate'),h=document.querySelector('.spatial-heading');return {text:b.textContent,parent:b.parentElement===h,right:h.getBoundingClientRect().right-b.getBoundingClientRect().right};})()`);
    assert.equal(animationButton.text, '运行'); assert.equal(animationButton.parent, true); assert.ok(animationButton.right < 2);
    const angle = (await read('waveform')).probeAngle;
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await click('animate'); await delay(150);
    assert.equal(await page.evaluate('document.getElementById("animate").textContent'), '停止');
    for (const [id, value] of [['modulation', '.9'], ['ratio', '24'], ['frequency', '60'], ['method', 'DPWMMAX'], ['levels', '2'], ['output', 'phase'], ['zoom', '1']]) {
      await change(id, value);
      assert.equal(await page.evaluate('document.getElementById("animate").getAttribute("aria-pressed")'), 'true', id + '更新不能停止运行');
      const before = (await read('waveform')).probeAngle;
      await delay(80);
      assert.notEqual((await read('waveform')).probeAngle, before, id + '更新后仍推进');
    }
    await page.evaluate('document.getElementById("pwm-controls").requestSubmit()');
    assert.equal(await page.evaluate('document.getElementById("animate").textContent'), '停止');
    await click('animate'); assert.notEqual((await read('waveform')).probeAngle, angle);
    const stopped = (await read('waveform')).probeAngle;
    await delay(100); assert.equal((await read('waveform')).probeAngle, stopped);
    assert.equal(await page.evaluate('document.getElementById("animate").textContent'), '运行');
    await change('frequency', '1');
    await click('animate');
    for (const id of ['waveform', 'modulator']) {
      const hover = await chartPosition(id, .4, 0);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y });
      const hovered = (await read('waveform')).probeAngle;
      await delay(100); assert.equal((await read('waveform')).probeAngle, hovered, '悬停时临时暂停：' + id);
      assert.equal(await page.evaluate('document.getElementById("animate").getAttribute("aria-pressed")'), 'true');
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await delay(100); assert.notEqual((await read('waveform')).probeAngle, hovered, '离开后继续：' + id);
    }
    await click('animate');
    const clockChecks = await page.evaluate(`(()=>{
      const oldRAF=window.requestAnimationFrame,oldCancel=window.cancelAnimationFrame;
      let next=1;const queue=new Map(),read=()=>Number(document.getElementById('waveform').dataset.probeAngle);
      window.requestAnimationFrame=fn=>{const id=next++;queue.set(id,fn);return id};window.cancelAnimationFrame=id=>queue.delete(id);
      const frame=time=>{const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn(time))};
      const change=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))};
      const button=document.getElementById('animate'),wave=document.getElementById('waveform');
      const event=name=>wave.dispatchEvent(new PointerEvent(name,{pointerType:'mouse',clientX:wave.getBoundingClientRect().left+100,clientY:wave.getBoundingClientRect().top+50}));
      try {
        change('zoom','2');change('frequency','50');button.click();frame(1000);const a=read();frame(1005);const b=read();frame(2005);const oneSecond=read();
        change('frequency','100');frame(2010);const c=read();
        event('pointerenter');event('pointermove');const paused=read();frame(5000);const held=read();event('pointerleave');frame(10000);const resumed=read();frame(10005);const advanced=read();frame(10255);const longFrame=read();
        event('pointerenter');button.click();event('pointerleave');const stopped=read();frame(20000);const afterStop=read();
        return {a,b,oneSecond,c,paused,held,resumed,advanced,longFrame,stopped,afterStop,pending:queue.size};
      } finally {if(button.getAttribute('aria-pressed')==='true')button.click();window.requestAnimationFrame=oldRAF;window.cancelAnimationFrame=oldCancel;}
    })()`);
    const delta = (a, b) => (b - a + 720) % 720;
    assert.ok(Math.abs(delta(clockChecks.a, clockChecks.b) - 1.8) < 1e-8, '50Hz慢放50倍，5ms推进1.8度');
    assert.ok(Math.abs(delta(clockChecks.b, clockChecks.oneSecond) - 360) < 1e-8, '50Hz对应1Hz，一秒推进一圈');
    assert.ok(Math.abs(delta(clockChecks.oneSecond, clockChecks.c) - 3.6) < 1e-8, '100Hz慢放后对应2Hz，5ms推进3.6度');
    assert.equal(clockChecks.paused, clockChecks.held);
    assert.equal(clockChecks.resumed, clockChecks.paused, '从离开点继续且不补算暂停时间');
    assert.ok(Math.abs(delta(clockChecks.resumed, clockChecks.advanced) - 3.6) < 1e-8);
    assert.ok(Math.abs(delta(clockChecks.advanced, clockChecks.longFrame) - 180) < 1e-8, '慢放下长帧仍使用完整经过时间');
    assert.equal(clockChecks.stopped, clockChecks.afterStop, '手动停止后离开不自动恢复');
    assert.equal(clockChecks.pending, 0);
    await click('animate'); await change('modulation', '2');
    assert.equal(await page.evaluate('document.getElementById("animate").getAttribute("aria-pressed")'), 'false', '无效参数安全停止');
    await change('modulation', '.8'); await change('levels', '3');
    await click('theme-toggle'); assert.equal((await read('space-3d')).stateCount, '27');
    await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(120);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    const touchStart = await chartPosition('waveform', .1, 0), touchEnd = await chartPosition('waveform', .6, 2);
    await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchStart.x, y: touchStart.y }] });
    const touchAngle = Number((await read('waveform')).probeAngle);
    await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchEnd.x, y: touchEnd.y }] });
    await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(Number((await read('waveform')).probeAngle) > touchAngle, '触控应在波形图内移动探针');
    assert.equal((await read('waveform')).probeAngle, (await read('modulator')).probeAngle);
    await navigate('index.html');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("main h2")].map(el=>el.textContent)'), ['电机控制', '控制原理', '数学原理']);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".experiment-card h3")].map(el=>el.textContent)'), ['同步电机转子定向工作点分析', '同步电机VF定子电压定向工作点分析', '异步电机分析', 'PWM', 'PI 控制器可视化']);
    assert.equal(await page.evaluate('document.querySelectorAll(".experiment-card[href]").length'), 5);
    assert.equal(await page.evaluate('document.querySelector(".pending-card") === null'), true);
    assert.equal(await page.evaluate('document.querySelector("a[href*=同步电机分析]") !== null'), true);
    assert.equal(await page.evaluate('document.querySelector("#search, #tags, #saved-only, #pagination") === null'), true);
    assert.equal(await page.evaluate('document.getElementById("control").textContent.includes("PI 控制器可视化") && document.getElementById("math").textContent.includes("暂无内容")'), true);
    for (const width of [320, 390, 768, 1440]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `首页${width}px不应水平溢出`);
    }
    const theme = await page.evaluate('document.documentElement.dataset.theme');
    await click('theme-toggle');
    assert.notEqual(await page.evaluate('document.documentElement.dataset.theme'), theme);
    await page.call('Page.reload');
    await until(() => page.evaluate('document.readyState === "complete"'), '首页刷新超时');
    assert.notEqual(await page.evaluate('document.documentElement.dataset.theme'), theme, '保留主题偏好');
    await page.evaluate('document.querySelectorAll("nav a")[1].click()');
    assert.equal(await page.evaluate('location.hash'), '#control');
    const pwmLink = await page.evaluate('document.querySelector("a.experiment-card[href*=PWM]").getAttribute("href")');
    await navigate(pwmLink);
    assert.equal((await read('space-3d')).stateCount, '27');
    await page.evaluate('document.querySelector(".site-header a[href*=index]").click()');
    await until(() => page.evaluate('decodeURI(location.pathname) === "/index.html" && document.querySelectorAll(".experiment-card").length === 5'), '实验应能返回三分类首页');
    await page.call('Emulation.setScriptExecutionDisabled', { value: true });
    await page.call('Page.reload');
    await until(() => page.evaluate('document.readyState === "complete"'), '无脚本首页加载超时');
    assert.equal(await page.evaluate('document.querySelectorAll(".experiment-card[href]").length'), 5, '首页内容不依赖JS渲染');
    await page.call('Emulation.setScriptExecutionDisabled', { value: false });
    assert.deepEqual(page.errors, []);
  } finally {
    try { await control?.call('Browser.close'); } catch { /* Close only this test's browser. */ }
    page?.close(); control?.close();
    const exited = await Promise.race([exit.then(() => true), delay(4000).then(() => false)]); if (!exited) browser.kill();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
});
