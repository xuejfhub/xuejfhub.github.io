const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createServer } = require('../脚本/开发/预览服务.js');
const defaultTorques = [-3, -2.8, -2.6, -2.4, -2.2, -2, -1.8, -1.6, -1.4, -1.2, -1, -.8, -.6, -.4, -.2, 0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3];
const defaultTorqueText = defaultTorques.join(',');
const defaultVoltages = [0, .2, .4, .6, .8, 1, 1.2, 1.4, 1.6, 1.8, 2];
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

test('真实浏览器：三分类首页、同步电机、PI控制器与PWM功能回归', { timeout: 180000 }, async t => {
  const executable = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  try { await fs.access(executable); } catch { t.skip('未找到Edge，可设置EDGE_PATH'); return; }
  const scratch = path.resolve(__dirname, '../临时测试/2026-10-14-首页整理');
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, '浏览器-'));
  const profile = path.join(temporary, 'profile'); await fs.mkdir(profile);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
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
    const trendStyles = () => page.evaluate(`(()=>{const data=document.getElementById('dq-plot').data;return data.filter(trace=>trace.meta.kind==='voltage-level'||(trace.meta.kind==='torque'&&trace.name.startsWith('T = -'))).map(trace=>({kind:trace.meta.kind,width:trace.line.width,opacity:trace.opacity,count:trace.x.filter(Number.isFinite).length}))})()`);
    async function navigate(route) {
      await page.call('Page.navigate', { url: origin + '/' + encodeURI(route) });
      await until(() => page.evaluate(`document.readyState==='complete' && decodeURI(location.pathname)===${JSON.stringify('/' + route.split('?')[0])}`), '页面加载失败：' + route);
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    await t.test('同步电机：纯标幺、双向竖滑块、曲线显隐、缩放平移与离线绘图', async motorTest => {
      const evidence = path.resolve(__dirname, '../临时测试/2026-11-13-同步电机曲线');
      await fs.mkdir(evidence, { recursive: true });
      await navigate('页面/电机控制/同步电机/同步电机分析.html');
      await until(() => page.evaluate('Number(document.getElementById("dq-plot").dataset.renderCount)>0'), '同步电机初次绘制失败');
      assert.equal(await page.evaluate('document.title'), '同步电机转子定向工作点分析');
      assert.equal(await page.evaluate('document.querySelector("h1").textContent'), '同步电机转子定向工作点分析');
      const motorAction = async expression => {
        const before = Number((await read('dq-plot')).renderCount);
        await page.evaluate(expression);
        await until(async () => Number((await read('dq-plot')).renderCount) > before, '电机参数变更未完成重绘');
      };
      const motorChange = (id, value, event = 'input') => motorAction(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
      const chooseHeat = value => value === 'none' ? motorAction('document.getElementById("show-heat").click()') : motorChange('heat-quantity', value, 'change');
      const previewChecks = [];
      const nextPreview = frames => page.evaluate(`new Promise((resolve,reject)=>{const started=performance.now();const check=()=>{const plot=document.getElementById('dq-plot');if(Number(plot.dataset.previewFrameCount)>${frames})resolve(true);else if(performance.now()-started>5000)reject(new Error('按住拖动时预览帧未更新'));else setTimeout(check,8)};check()})`);
      async function heldPan({ moves = 3, fraction = .12, screenshot = '', loseContext = false } = {}) {
        let previousCount = -1;
        await until(async () => {
          const state = await read('dq-plot'), count = Number(state.renderCount);
          const settled = count > 0 && count === previousCount && state.previewActive !== 'true';
          previousCount = count; return settled;
        }, '开始拖动前的绘图未稳定');
        const before = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=plot.getBoundingClientRect(),layout=plot._fullLayout;return{count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount||0),builds:JSON.parse(plot.dataset.previewMetrics||'{}').geometryBuilds||0,view:JSON.parse(plot.dataset.view),start:{x:bounds.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis._length*.08,y:bounds.top+plot.clientTop+layout.yaxis._offset+layout.yaxis._length*.6},width:layout.xaxis._length}})()`);
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
              const value=SynchronousMotor.evaluate(model,direct,quadrature)[heat.meta.quantity];pixel={heat:heat.meta.quantity,direct,quadrature,rgba,expected:MotorPreview.colorFor(value,heat.zmax,heat.meta.quantity==='apparent'),visible:getComputedStyle(canvas).display};}
            const lines=document.getElementById('drag-curves'),pixels=lines.getContext('2d').getImageData(0,0,lines.width,lines.height).data;let ink=0;for(let offset=3;offset<pixels.length;offset+=4)if(pixels[offset])ink++;
            return{active:plot.dataset.previewActive,count:Number(plot.dataset.renderCount),frames:Number(plot.dataset.previewFrameCount),view,pixel,ink,metrics:JSON.parse(plot.dataset.previewMetrics),probe:JSON.parse(document.getElementById('probe-readout').dataset.point)};})()`);
          assert.equal(held.active, 'true'); assert.equal(held.count, before.count, '按住平移不能触发整图重绘');
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
          geometryBuilds: held.metrics.geometryBuilds - before.builds, drawMs: held.metrics.drawMs.slice(-Math.min(held.frames - before.frames, 180)), fullRedrawsWhileHeld: held.count - before.count, pixel: held.pixel, ink: held.ink, settled: JSON.parse((await read('dq-plot')).renderMetrics) };
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
        assert.deepEqual(await page.evaluate(`[...document.getElementById('${prefix}-preset').options].map(option=>option.value).filter(Boolean)`), ['1', '1.15', '1.5', '2']);
        assert.equal(await page.evaluate(`document.getElementById('${prefix}Limit').getAttribute('max')`), null);
      }
      assert.equal(await page.evaluate('document.getElementById("speed-slider").min'), '-2');
      assert.equal(await page.evaluate('document.getElementById("speed-slider").max'), '2');
      assert.equal(await page.evaluate('getComputedStyle(document.getElementById("speed-slider")).writingMode'), 'vertical-lr');
      const traces = await page.evaluate('document.getElementById("dq-plot").data.map(trace=>({name:trace.name,kind:trace.meta.kind,dash:trace.line?.dash,opacity:trace.opacity,visible:trace.visible,points:trace.x.filter(value=>value!==null).length}))');
      for (const kind of ['mtpa', 'torque', 'pf', 'current', 'voltage']) assert.ok(traces.some(trace => trace.kind === kind && trace.points > 0), kind);
      assert.equal(traces.find(trace => trace.kind === 'probe').visible, false);
      assert.equal(traces.find(trace => trace.kind === 'probe').points, 0);
      assert.deepEqual(traces.filter(trace => trace.kind === 'torque').map(trace => trace.name), defaultTorques.map(level => `T = ${level} pu`));
      assert.equal(await page.evaluate('document.getElementById("torque-values").value'), defaultTorqueText);
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      const voltageInitial = await voltageSnapshot();
      assert.deepEqual(voltageInitial.map(item => item.voltage).sort((first, second) => first - second), defaultVoltages);
      assert.ok(voltageInitial.every(item => item.error < 1e-8));
      assert.ok(voltageInitial.some(item => item.kind === 'voltage-level' && item.drawn));
      const trends = await trendStyles();
      assert.ok(trends.every(item => item.width === .85 && item.opacity === (item.kind === 'torque' ? .3 : .35)));
      assert.equal(trends.filter(item => item.kind === 'torque').length, 15);
      assert.ok(trends.some(item => item.kind === 'torque' && item.count > 2));
      assert.equal(await page.evaluate('document.getElementById("torque-step")'), null);
      assert.deepEqual(await page.evaluate('[...document.getElementById("torque-preset").options].map(option=>option.value).filter(Boolean)'), [defaultTorqueText, '-1,-0.5,0.5,1', '-1', '-0.5', '0.5', '1']);
      assert.equal(await page.evaluate('document.getElementById("dq-plot").layout.hovermode'), false);
      assert.ok(traces.some(trace => trace.kind === 'mtpv'));
      for (const [kind, name] of [['torque', 'T = 1 pu'], ['pf', 'PF = 1']]) {
        assert.equal(traces.find(trace => trace.name === name).dash, 'solid');
        assert.ok(traces.filter(trace => trace.kind === kind && trace.name !== name).every(trace => trace.dash === 'dash' && trace.opacity < .6));
      }
      assert.ok(await page.evaluate('[...document.querySelectorAll("#dq-plot .scatterlayer path.js-line")].some(path=>getComputedStyle(path).strokeDasharray!=="none")'));
      assert.ok(await page.evaluate('document.querySelectorAll("#dq-plot .scatterlayer path.js-line").length>12'));
      await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-6,4],'yaxis.range':[-4,4]});return true})()`);
      const torqueChecks = [];
      for (const selection of ['-1', '-0.5', '0.5', '1', '-1,-0.5,0.5,1', defaultTorqueText, '-0.75,0,0.75', '±0.625']) {
        const preset = ['-1', '-0.5', '0.5', '1', '-1,-0.5,0.5,1', defaultTorqueText].includes(selection);
        await motorChange(preset ? 'torque-preset' : 'torque-values', selection, preset ? 'change' : 'input');
        const checked = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),model=SynchronousMotor.createModel(JSON.parse(plot.dataset.model).input);return plot.data.filter(trace=>trace.meta.kind==='torque').map(trace=>{const level=Number(trace.name.match(/^T = (.+) pu$/)[1]);const errors=trace.x.flatMap((direct,index)=>direct===null?[]:[Math.abs(SynchronousMotor.evaluate(model,direct,trace.y[index]).torque-level)]);return{level,count:errors.length,error:Math.max(0,...errors),dash:trace.line.dash}})})()`);
        const expected = selection === '±0.625' ? [-.625, .625] : selection.split(',').map(Number).sort((first, second) => first - second);
        assert.deepEqual(checked.map(item => item.level), expected);
        assert.ok(checked.every(item => item.count > 0 && item.error < 1e-8));
        assert.ok(checked.every(item => item.dash === (item.level === 1 ? 'solid' : 'dash')));
        torqueChecks.push({ selection, curves: checked });
      }
      await motorAction('document.getElementById("reset-view").click()');
      const beforeInvalidTorque = (await read('dq-plot')).renderCount;
      await change('torque-values', 'invalid', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '无效转矩列表没有提示');
      assert.equal((await read('dq-plot')).renderCount, beforeInvalidTorque);
      assert.ok(await page.evaluate('document.getElementById("input-error").textContent.includes("恒转矩")'));
      await motorAction('document.getElementById("reset").click()');
      assert.equal(await page.evaluate('document.getElementById("torque-values").value'), defaultTorqueText);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
      await motorAction(`(async()=>{await Plotly.relayout(document.getElementById('dq-plot'),{'xaxis.range':[-16,8],'yaxis.range':[-8,8]});return true})()`);
      await motorChange('voltage-values', '0,.35,2.4');
      const customVoltage = await voltageSnapshot();
      assert.deepEqual(customVoltage.map(item => item.voltage), [0, .35, 2.4, 1]);
      assert.ok(customVoltage.every(item => item.count > 0 && item.error < 1e-8));
      await motorAction('document.getElementById("show-voltage").click()');
      assert.deepEqual(await voltageSnapshot(), []);
      await motorAction('document.getElementById("show-voltage").click()');
      const voltageRenderCount = (await read('dq-plot')).renderCount;
      await change('voltage-values', '-1', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '负电压幅值没有提示');
      assert.equal((await read('dq-plot')).renderCount, voltageRenderCount);
      await motorAction('document.getElementById("reset").click()');
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.find(trace=>trace.meta.kind==="mtpv").x.some(Number.isFinite)'), '缩小视图后可以看到较小电感对应的MTPV');
      const boundaryChecks = [];
      for (const [key, preset, kind] of [['currentLimit', 'current-preset', 'current'], ['voltageLimit', 'voltage-preset', 'voltage']]) {
        for (const value of [1, 1.15, 1.5, 2, 2.25, 0]) {
          if ([1, 1.15, 1.5, 2].includes(value)) await motorChange(preset, String(value), 'change');
          else await motorChange(key, String(value));
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
        await motorAction('document.getElementById("reset").click()');
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
      await motorAction('document.getElementById("reset").click()');
      const beforeSlider = Number((await read('dq-plot')).renderCount);
      await page.evaluate('document.getElementById("ld-slider").focus()');
      await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await until(async () => Number((await read('dq-plot')).renderCount) > beforeSlider, '真实滑块键盘事件未触发重绘');
      assert.equal(await page.evaluate('document.getElementById("ld").value'), '0.21');
      const changed = JSON.parse((await read('dq-plot')).model);
      assert.equal(changed.pu.ld, .21);
      await motorAction('document.getElementById("reset").click()');
      for (const [key, value] of [['ld', 0], ['lq', 0], ['flux', 0], ['resistance', 0]]) {
        await motorChange(key, String(value));
        assert.equal(JSON.parse((await read('dq-plot')).model).pu[key], value);
        assert.ok(await page.evaluate('document.getElementById("dq-plot").data.every(trace=>trace.x.every(value=>value===null||Number.isFinite(value)))'));
      }
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("无唯一解")'));
      await motorAction('document.getElementById("reset").click()');
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
      await motorAction('document.getElementById("reset").click()');
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
      await motorAction('document.getElementById("reset").click()');
      const heatChecks = [];
      for (const heat of ['mechanical', 'active', 'reactive', 'apparent', 'torque']) {
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
      await motorAction('document.getElementById("reset").click()');
      await motorAction('document.getElementById("reset-view").click()');
      await chooseHeat('torque');
      await motorChange('speedPU', '2');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data[0].zmax'), 2);
      await motorChange('color-scale', 'auto', 'change');
      const autoScale = await page.evaluate('(()=>{const trace=document.getElementById("dq-plot").data[0];return{actual:trace.zmax,expected:Math.max(1e-6,...trace.z.flat().map(Math.abs))}})()');
      assert.ok(Math.abs(autoScale.actual - autoScale.expected) < 1e-10);
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data[0].z.flat().every(Number.isFinite)'));
      await chooseHeat('none');
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.type==="heatmap")'), false);
      assert.ok((await heldPan()).ink > 100, '关闭热力图时曲线仍实时更新');
      for (const kind of ['mtpa', 'mtpv', 'torque', 'pf', 'current', 'voltage']) {
        await motorAction(`document.getElementById('show-${kind}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${kind}')`), false);
      }
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data.length'), 1);
      const pointPosition = (direct, quadrature) => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=plot.getBoundingClientRect(),layout=plot._fullLayout;return{x:bounds.left+plot.clientLeft+layout.xaxis._offset+layout.xaxis.d2p(${direct}),y:bounds.top+plot.clientTop+layout.yaxis._offset+layout.yaxis.d2p(${quadrature})}})()`);
      const clickPoint = async (direct, quadrature, visible) => {
        const position = await pointPosition(direct, quadrature);
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
        await until(() => page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='probe').visible===${visible}`), '工作点显隐不符');
      };
      const probeChecks = { initialVisible: await page.evaluate('document.getElementById("dq-plot").data[0].visible') };
      assert.equal(probeChecks.initialVisible, false, '平移、缩放及调参不应创建工作点');
      await clickPoint(-.8, .4, true);
      const selected = JSON.parse((await read('probe-readout')).point);
      assert.ok(Math.abs(selected.direct + .8) < .01 && Math.abs(selected.quadrature - .4) < .01, '无曲线和底色时也按点击坐标定位');
      assert.equal(await page.evaluate('document.querySelectorAll("#dq-plot .scatterlayer path.point").length'), 1);
      const otherPoint = await pointPosition(.4, -.3);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...otherPoint });
      await delay(100);
      assert.deepEqual(JSON.parse((await read('probe-readout')).point), selected, '移动鼠标不能移动固定工作点');
      assert.equal(await page.evaluate('document.querySelectorAll("#dq-plot .hoverlayer > *").length'), 0);
      probeChecks.pinned = selected;
      probeChecks.afterMove = JSON.parse((await read('probe-readout')).point);
      await clickPoint(.4, -.3, false);
      assert.deepEqual(JSON.parse((await read('probe-readout')).point), selected, '第二次点击只隐藏，不重定位');
      assert.equal(await page.evaluate('document.querySelectorAll("#dq-plot .scatterlayer path.point").length'), 0);
      assert.equal(await page.evaluate('document.getElementById("dq-plot").data[0].x.length'), 0);
      probeChecks.hidden = (await read('probe-readout')).visible;
      await clickPoint(.3, .2, true);
      const relocated = JSON.parse((await read('probe-readout')).point);
      assert.ok(Math.abs(relocated.direct - .3) < .01 && Math.abs(relocated.quadrature - .2) < .01);
      const dragStart = await pointPosition(-.4, .1);
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...dragStart, button: 'left', clickCount: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x + 45, y: dragStart.y + 15, button: 'left', buttons: 1 });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragStart.x + 45, y: dragStart.y + 15, button: 'left', clickCount: 1 });
      await delay(150);
      assert.equal((await read('probe-readout')).visible, 'true', '拖动不应切换标记');
      assert.deepEqual(JSON.parse((await read('probe-readout')).point), relocated, '拖动不应修改工作点数据坐标');
      await motorAction('document.querySelectorAll(".curve-switches input[type=checkbox]").forEach(input=>{input.checked=true});document.getElementById("reset").click()');
      await motorAction('document.getElementById("reset-view").click()');
      await chooseHeat('torque');
      assert.equal((await read('probe-readout')).visible, 'true', '重绘后保留固定标记');
      assert.equal(JSON.parse((await read('probe-readout')).point).direct, relocated.direct);
      probeChecks.afterDrag = relocated;
      await change('probe-d', '0'); await change('probe-q', '0');
      assert.equal(JSON.parse((await read('probe-readout')).point).pf, null);
      await change('probe-d', '2'); await change('probe-q', '2');
      assert.equal(JSON.parse((await read('probe-readout')).point).feasible, false);
      await clickPoint(0, 0, false);
      await motorChange('speedPU', '0');
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("零速")'));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="pf").every(trace=>trace.x.every(value=>value===null))'));
      await motorChange('resistance', '0');
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("未定义")'));
      await motorAction('document.getElementById("reset").click()');
      const oldPlot = (await read('dq-plot')).renderCount;
      await change('ld', '-1', 'input');
      await until(async () => (await read('dq-plot')).stale === 'true', '非法输入未阻止重绘');
      assert.equal((await read('dq-plot')).renderCount, oldPlot);
      assert.equal(await page.evaluate('document.getElementById("input-error").hidden'), false);
      await motorAction('document.getElementById("reset").click()');
      for (const [key, value] of [['lq', '.2'], ['flux', '0'], ['lq', '.4']]) {
        await motorChange(key, value);
        assert.ok(await page.evaluate('document.getElementById("dq-plot").data.every(trace=>trace.x.every(value=>value===null||Number.isFinite(value)))'));
      }
      await motorAction('document.getElementById("reset").click()');
      await motorChange('color-scale', 'fixed', 'change');
      const layouts = [];
      for (const [width, height] of [[320, 568], [390, 844], [768, 768], [1060, 554], [1366, 768], [1440, 1000]]) {
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
          const touchPoint = await pointPosition(-.5, .2);
          for (const visible of [true, false]) {
            await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
            await page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await until(() => page.evaluate(`document.getElementById('dq-plot').data.find(trace=>trace.meta.kind==='probe').visible===${visible}`), '触摸点击未切换工作点');
          }
          const beforeTouch = await read('dq-plot'), fixedPoint = (await read('probe-readout')).point;
          await page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
          try {
            await page.call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchPoint.x + 25, y: touchPoint.y }] });
            await nextPreview(Number(beforeTouch.previewFrameCount));
            assert.equal((await read('dq-plot')).previewActive, 'true');
          } finally { await page.call('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); }
          await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > Number(beforeTouch.renderCount) && state.previewActive === 'false'; }, '取消触摸后没有退出预览');
          assert.equal((await read('probe-readout')).point, fixedPoint); assert.equal((await read('probe-readout')).visible, 'false');
          assert.equal(await page.evaluate('document.getElementById("dq-plot")._dragging'), false);
          assert.equal(await page.evaluate('document.querySelectorAll(".dragcover").length'), 0);
          probeChecks.touchDragCancelled = true;
          await page.call('Emulation.setTouchEmulationEnabled', { enabled: false });
        }
        if (width === 390 || width === 1440) {
          await page.evaluate('window.scrollTo({top:0,behavior:"instant"})');
          const metrics = await page.call('Page.getLayoutMetrics');
          const shot = await page.call('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(4000, metrics.cssContentSize.height), scale: 1 } });
          await fs.writeFile(path.join(evidence, `${width === 390 ? '手机' : '桌面'}-默认.png`), Buffer.from(shot.data, 'base64'));
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
      await fs.writeFile(path.join(evidence, '浏览器验收.json'), JSON.stringify({ raster, heatChecks, boundaryChecks, torqueChecks, probeChecks, layouts, beforeZoom, zoomed, preserved, restored, errors: page.errors }, null, 2));
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

    await t.test('VF：电压定向工作点、GPU/CPU预览、退化边界与一屏布局', async () => {
      const evidence = path.resolve(__dirname, '../临时测试/2026-11-13-VF工作点'); await fs.mkdir(evidence, { recursive: true });
      await navigate('页面/电机控制/同步电机/VF工作点分析.html');
      await until(() => page.evaluate('Number(document.getElementById("dq-plot").dataset.renderCount)>0'), 'VF未绘图');
      assert.equal(await page.evaluate('document.getElementById("torque-values").value'), defaultTorqueText);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
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
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      const voltageInitial = await voltageSnapshot();
      assert.deepEqual(voltageInitial.map(item => item.voltage).sort((first, second) => first - second), defaultVoltages.filter(voltage => voltage > 0));
      assert.ok(voltageInitial.every(item => item.count > 0 && item.error < 1e-8));
      assert.ok(voltageInitial.some(item => item.kind === 'voltage-level' && item.drawn));
      await setValue('voltage-values', '0,.35,2.4');
      await setValue('voltageLimit', 3); await setValue('vfRatio', 2.3);
      const customVoltage = await voltageSnapshot();
      assert.deepEqual(customVoltage.map(item => item.voltage), [.35, 2.4, 2.3]);
      assert.ok(customVoltage.every(item => item.count > 0 && item.error < 1e-8));
      await action('document.getElementById("show-voltage").click()');
      assert.deepEqual(await voltageSnapshot(), []);
      await action('document.getElementById("show-voltage").click();document.getElementById("reset").click()');
      assert.equal(await page.evaluate('document.getElementById("voltage-values").value'), defaultVoltages.join(','));
      assert.ok(Math.abs(initial.vd - .8) < 1e-10 && Math.abs(initial.vq) < 1e-10);
      const trends = await trendStyles();
      assert.ok(trends.every(item => item.width === .85 && item.opacity === (item.kind === 'torque' ? .3 : .35)));
      assert.equal(trends.filter(item => item.kind === 'torque').length, 15);
      assert.ok(trends.some(item => item.kind === 'torque' && item.count > 2));
      assert.ok(Math.abs(initial.quadrature) > .01); assert.ok(initial.feasible);
      const referenceSnapshot = () => page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.view);return Object.fromEntries(['mtpa','mtpv'].map(kind=>{const trace=plot.data.find(item=>item.meta.kind===kind),full=plot._fullData.find(item=>item.meta.kind===kind),paths=[...plot.querySelectorAll('.trace'+full.uid+' .js-line')];return[kind,{checked:document.getElementById('show-'+kind).checked,toolbar:!!document.querySelector('.curve-switches #show-'+kind),inside:trace.x.filter((direct,index)=>direct!==null&&direct>=view.x[0]&&direct<=view.x[1]&&trace.y[index]>=view.y[0]&&trace.y[index]<=view.y[1]).length,drawn:paths.some(path=>path.getTotalLength()>2),signature:JSON.stringify([trace.x,trace.y])}]}))})()`);
      const initialReferences = await referenceSnapshot();
      for (const kind of ['mtpa', 'mtpv']) { assert.equal(initialReferences[kind].checked, true); assert.equal(initialReferences[kind].toolbar, true); assert.ok(initialReferences[kind].inside > 2 && initialReferences[kind].drawn, kind + ' initial visible curve'); }
      const pixels = [];
      let contextLost = false;
      for (const [index, heat] of ['torque', 'mechanical', 'active', 'reactive', 'apparent', 'active'].entries()) {
        await setValue('heat-quantity', heat, 'change');
        if (index === 5) contextLost = await page.evaluate(`(()=>{const context=document.getElementById('drag-heat').getContext('webgl'),extension=context?.getExtension('WEBGL_lose_context');if(!extension)return false;extension.loseContext();return true})()`);
        const start = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=plot.getBoundingClientRect(),layout=plot._fullLayout;return{x:bounds.left+layout.xaxis._offset+60,y:bounds.top+layout.yaxis._offset+layout.yaxis._length*.6,frames:Number(plot.dataset.previewFrameCount||0),count:Number(plot.dataset.renderCount)}})()`);
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
        let sample;
        try {
          await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 70, y: start.y, button: 'left', buttons: 1 });
          await until(async () => Number((await read('dq-plot')).previewFrameCount) > start.frames, 'VF按住时无预览');
          sample = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),view=JSON.parse(plot.dataset.previewView),accelerated=plot.dataset.previewBackend==='webgl',canvas=document.getElementById(accelerated?'drag-heat':'drag-heat-cpu'),column=Math.floor(canvas.width*.02),row=Math.floor(canvas.height*.31);let rgba,direct,quadrature;if(accelerated){const context=canvas.getContext('webgl'),data=new Uint8Array(4);context.readPixels(column,row,1,1,context.RGBA,context.UNSIGNED_BYTE,data);rgba=[...data];direct=view.x[0]+(column+.5)/canvas.width*(view.x[1]-view.x[0]);quadrature=view.y[0]+(row+.5)/canvas.height*(view.y[1]-view.y[0]);}else{rgba=[...canvas.getContext('2d').getImageData(column,row,1,1).data];direct=view.x[0]+column/(canvas.width-1)*(view.x[1]-view.x[0]);quadrature=view.y[1]-row/(canvas.height-1)*(view.y[1]-view.y[0]);}const model=VoltageMotor.createModel(JSON.parse(plot.dataset.previewModel)),value=VoltageMotor.field(model,direct,quadrature)['${heat}'];return{heat:'${heat}',backend:plot.dataset.previewBackend,rgba,expected:MotorPreview.colorFor(value,2,'${heat}'==='apparent'),count:Number(plot.dataset.renderCount)}})()`);
          assert.equal(sample.count, start.count); assert.ok(Math.abs(sample.rgba[3] - 184) <= 1);
          assert.ok(sample.expected.every((channel, index) => Math.abs(channel - sample.rgba[index]) <= 3), JSON.stringify(sample)); pixels.push(sample);
          if (index === 5 && contextLost) assert.equal(sample.backend, 'canvas2d');
        } finally { await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 70, y: start.y, button: 'left', clickCount: 1 }); }
        await until(async () => { const state = await read('dq-plot'); return Number(state.renderCount) > start.count && state.previewActive === 'false'; }, 'VF松开未精绘');
      }
      await action('document.getElementById("reset-view").click()');
      let previousReferences = await referenceSnapshot();
      const speedChecks = [];
      for (const speed of [-1, 2]) {
        const previousView = JSON.parse((await read('dq-plot')).view);
        await setValue('speedPU', speed);
        const state = await read('dq-plot'), model = JSON.parse(state.model), currentView = JSON.parse(state.view), references = await referenceSnapshot();
        assert.equal(model.outputVoltage, Math.min(1, .8 * Math.abs(speed)));
        for (const kind of ['mtpa', 'mtpv']) assert.notEqual(references[kind].signature, previousReferences[kind].signature, kind + ' speed update');
        for (const axis of ['x', 'y']) for (let index = 0; index < 2; index++) assert.ok(Math.abs(currentView[axis][index] - previousView[axis][index]) < 1e-7, '调速不能改变用户视野');
        speedChecks.push({ speed, mtpaUpdated: true, mtpvUpdated: true, viewPreserved: true }); previousReferences = references;
      }
      await setValue('speedPU', 0); assert.equal(JSON.parse((await read('probe-readout')).point), null);
      await setValue('voltageBoost', .02); assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).quadrature) < 1e-10);
      await setValue('heat-quantity', 'torque', 'change'); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.some(trace=>trace.meta.kind==="heat")'), false);
      await setValue('resistance', 0); assert.equal(JSON.parse((await read('dq-plot')).model).reason, 'singular');
      await action('document.getElementById("reset").click()');
      await setValue('flux', 0); await setValue('lq', .2);
      assert.ok(await page.evaluate('document.getElementById("model-note").textContent.includes("MTPA/MTPV无唯一解")'));
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>["mtpa","mtpv"].includes(trace.meta.kind)).every(trace=>trace.x.every(value=>value===null))'));
      await action('document.getElementById("reset").click()');
      await setValue('angleDeg', -80); assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).angleDeg + 80) < 1e-10);
      await setValue('torque-values', '±0.7'); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque").length'), 2);
      for (const layer of ['mtpa', 'mtpv']) {
        await action(`document.getElementById('show-${layer}').click()`);
        assert.equal(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${layer}')`), false);
        await action(`document.getElementById('show-${layer}').click()`);
        assert.ok(await page.evaluate(`document.getElementById('dq-plot').data.some(trace=>trace.meta.kind==='${layer}')`));
      }
      await action('document.getElementById("show-point").click()'); assert.equal(await page.evaluate('document.getElementById("dq-plot").data.at(-1).visible'), false);
      await action('document.getElementById("show-point").click();document.getElementById("reset").click()');
      assert.equal(await page.evaluate('document.getElementById("torque-values").value'), defaultTorqueText);
      assert.deepEqual(await page.evaluate('document.getElementById("dq-plot").data.filter(trace=>trace.meta.kind==="torque").map(trace=>trace.name)'), defaultTorques.map(level => `T = ${level} pu`));
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
      await action('document.getElementById("reset").click()');
      await setValue('vfRatio', .001); await setValue('heat-quantity', 'apparent', 'change'); await setValue('color-scale', 'auto', 'change');
      await setValue('angleDeg', 110); assert.equal((await read('dq-plot')).stale, 'false');
      assert.ok(await page.evaluate('document.getElementById("dq-plot").data[0].zmax<.1'));
      await action('document.getElementById("reset").click()'); await setValue('color-scale', 'fixed', 'change'); await setValue('heat-quantity', 'torque', 'change');
      const layouts = [];
      for (const [width, height] of [[320, 568], [390, 844], [1060, 554], [1440, 1000]]) {
        await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        await until(() => page.evaluate('document.getElementById("dq-plot")._fullLayout.width===document.getElementById("dq-plot").clientWidth'), 'VF尺寸未同步');
        await action('document.getElementById("reset-view").click()');
        const layout = await page.evaluate(`(()=>{const plot=document.getElementById('dq-plot'),bounds=plot.getBoundingClientRect(),header=document.querySelector('.motor-header').getBoundingClientRect(),heading=document.querySelector('h1').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,plotHeight:plot.clientHeight,renderedHeight:plot._fullLayout.height,bottom:bounds.bottom,headingBottom:heading.bottom,headerBottom:header.bottom}})()`);
        assert.equal(layout.width, width); assert.ok(layout.scrollWidth <= width && layout.scrollHeight <= height);
        assert.ok(layout.plotHeight >= 120); assert.ok(Math.abs(layout.plotHeight - layout.renderedHeight) < 2); assert.ok(layout.bottom <= height); assert.ok(layout.headingBottom <= layout.headerBottom); layouts.push(layout);
        const references = await referenceSnapshot();
        for (const kind of ['mtpa', 'mtpv']) assert.ok(references[kind].inside > 2 && references[kind].drawn, kind + ' visible at ' + width);
        if (width === 390 || width === 1440) { const shot = await page.call('Page.captureScreenshot', {}); await fs.writeFile(path.join(evidence, `VF-${width}.png`), Buffer.from(shot.data, 'base64')); assert.equal(await page.evaluate('innerWidth'), width); }
      }
      await action('document.getElementById("theme-toggle").click()'); assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'dark');
      await action('document.getElementById("theme-toggle").click()');
      await page.call('Network.enable'); await page.call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }); await page.call('Network.setCacheDisabled', { cacheDisabled: true });
      try {
        await page.call('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '../页面/电机控制/同步电机/VF工作点分析.html')).href });
        await until(() => page.evaluate('location.protocol==="file:" && Number(document.getElementById("dq-plot")?.dataset.renderCount)>0'), 'VF离线绘图失败');
        assert.ok(Math.abs(JSON.parse((await read('probe-readout')).point).torque - initial.torque) < 1e-12);
      } finally { await page.call('Network.setBlockedURLs', { urls: [] }); await page.call('Network.setCacheDisabled', { cacheDisabled: false }); }
      await fs.writeFile(path.join(evidence, 'VF验收.json'), JSON.stringify({ initial, voltageInitial, customVoltage, initialReferences: Object.fromEntries(Object.entries(initialReferences).map(([kind, { signature, ...values }]) => [kind, values])), speedChecks, pixels, contextLost, sliderPreview, speedPreview, offline: true, layouts, errors: page.errors }, null, 2));
    });

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
