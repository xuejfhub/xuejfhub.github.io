(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./电机模型.js'));
  else root.MotorPreview = factory(root.SynchronousMotor);
})(typeof globalThis === 'object' ? globalThis : this, function (Motor) {
  'use strict';
  const HEAT_KEYS = ['torque', 'mechanical', 'active', 'reactive', 'apparent'];
  const SIGNED = [[0, [57, 121, 172]], [.25, [162, 201, 221]], [.5, [245, 247, 239]], [.75, [239, 197, 159]], [1, [203, 90, 79]]];
  const POSITIVE = [[0, [245, 248, 244]], [.35, [143, 204, 195]], [.7, [54, 169, 172]], [1, [20, 108, 148]]];

  function colorFor(value, maximum, positive = false) {
    const fraction = Math.max(0, Math.min(1, positive ? value / maximum : (value / maximum + 1) / 2));
    const stops = positive ? POSITIVE : SIGNED;
    let upper = 1;
    while (upper < stops.length - 1 && fraction > stops[upper][0]) upper++;
    const lower = stops[upper - 1], higher = stops[upper];
    const weight = (fraction - lower[0]) / (higher[0] - lower[0]);
    return lower[1].map((channel, index) => Math.round(channel + weight * (higher[1][index] - channel)));
  }

  function paddedBounds(view) {
    const expand = range => { const padding = (range[1] - range[0]) * .65; return [range[0] - padding, range[1] + padding]; };
    return { x: expand(view.x), y: expand(view.y) };
  }

  function covers(outer, inner) {
    return ['x', 'y'].every(axis => outer[axis][0] <= inner[axis][0] && outer[axis][1] >= inner[axis][1]);
  }

  function geometryFor(scene, bounds) {
    const { model, visible, levels } = scene;
    const extent = Math.max(.1, ...bounds.x.map(Math.abs), ...bounds.y.map(Math.abs));
    const lines = [];
    const add = (kind, branches, width, opacity = 1, dash = [], dots = false) => lines.push({ kind, branches, width, opacity, dash, dots });
    if (visible.torque) for (const level of levels) add('torque', Motor.torqueCurves(model, level, extent, 480, bounds), level === 1 ? 2.5 : 1.3, level === 1 ? 1 : .45, level === 1 ? [] : [7, 6]);
    if (visible.pf) for (const factor of [-1, -.9, -.7, -.5, .5, .7, .9, .95, 1]) add('pf', Motor.powerFactorCurves(model, factor, extent, 480, bounds), factor === 1 ? 2.5 : 1.25, factor === 1 ? 1 : .44, factor === 1 ? [] : [7, 6]);
    if (visible.mtpa) add('mtpa', Motor.locus(model, 'mtpa', extent, 160), 2.8);
    if (visible.mtpv) add('mtpv', Motor.locus(model, 'mtpv', extent, 160), 2.8);
    if (visible.current) add('boundary', [Array.from({ length: 361 }, (_, index) => {
      const angle = index * Math.PI / 180;
      return { direct: model.input.currentLimit * Math.cos(angle), quadrature: model.input.currentLimit * Math.sin(angle) };
    })], 1.8, 1, [7, 6], model.input.currentLimit === 0);
    if (visible.voltage) add('boundary', Motor.voltageCurves(model, model.input.voltageLimit, extent, 480), 2, 1, [], model.input.voltageLimit === 0);
    return { bounds, extent, lines };
  }

  const VERTEX_SHADER = `attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }`;
  const FRAGMENT_SHADER = `precision highp float;
varying vec2 uv;
uniform vec2 minimumView;
uniform vec2 maximumView;
uniform vec4 motor;
uniform float speed;
uniform float colorMaximum;
uniform int quantity;
vec3 palette(float fraction, bool positive) {
  if (positive) {
    if (fraction < .35) return mix(vec3(245.,248.,244.),vec3(143.,204.,195.),fraction/.35)/255.;
    if (fraction < .7) return mix(vec3(143.,204.,195.),vec3(54.,169.,172.),(fraction-.35)/.35)/255.;
    return mix(vec3(54.,169.,172.),vec3(20.,108.,148.),(fraction-.7)/.3)/255.;
  }
  if (fraction < .25) return mix(vec3(57.,121.,172.),vec3(162.,201.,221.),fraction*4.)/255.;
  if (fraction < .5) return mix(vec3(162.,201.,221.),vec3(245.,247.,239.),(fraction-.25)*4.)/255.;
  if (fraction < .75) return mix(vec3(245.,247.,239.),vec3(239.,197.,159.),(fraction-.5)*4.)/255.;
  return mix(vec3(239.,197.,159.),vec3(203.,90.,79.),(fraction-.75)*4.)/255.;
}
void main() {
  vec2 current = mix(minimumView, maximumView, uv);
  vec2 voltage = vec2(motor.x*current.x-speed*motor.z*current.y, motor.x*current.y+speed*(motor.y*current.x+motor.w));
  float torque = (motor.w+(motor.y-motor.z)*current.x)*current.y;
  float value = torque;
  if (quantity == 1) value = speed*torque;
  if (quantity == 2) value = dot(voltage,current);
  if (quantity == 3) value = voltage.y*current.x-voltage.x*current.y;
  if (quantity == 4) value = length(voltage)*length(current);
  bool positive = quantity == 4;
  float fraction = clamp(positive ? value/colorMaximum : (value/colorMaximum+1.)*.5,0.,1.);
  gl_FragColor = vec4(palette(fraction,positive),.72);
}`;

  function create(plot) {
    const heatCanvas = document.createElement('canvas'), lineCanvas = document.createElement('canvas'), raster = document.createElement('canvas');
    heatCanvas.id = 'drag-heat'; lineCanvas.id = 'drag-curves';
    raster.id = 'drag-heat-cpu';
    for (const canvas of [heatCanvas, raster, lineCanvas]) { canvas.className = 'pan-preview'; canvas.setAttribute('aria-hidden', 'true'); plot.append(canvas); }
    const context = lineCanvas.getContext('2d');
    raster.width = 81; raster.height = 81;
    const rasterContext = raster.getContext('2d'), pixels = rasterContext.createImageData(81, 81);
    let scene = null, cache = null, active = false, frame = null, frameKind = '', pendingView = null, lastView = null;
    let gpu = null, program = null, uniforms = {}, gpuAttempted = false, gpuLost = false, gpuPrecision = 0;
    const stats = { frames: 0, geometryBuilds: 0, drawMs: [], backend: 'canvas2d', renderer: null, fallback: null };

    function initGpu() {
      if (gpuAttempted) return;
      gpuAttempted = true;
      try {
        gpu = heatCanvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false,
          premultipliedAlpha: false, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: true });
        if (!gpu) { stats.fallback = 'webgl-unavailable'; return; }
        gpuPrecision = Math.min(23, gpu.getShaderPrecisionFormat(gpu.FRAGMENT_SHADER, gpu.HIGH_FLOAT).precision);
        if (!gpuPrecision) throw new Error('fragment-highp-unavailable');
        const compile = (type, source) => {
          const shader = gpu.createShader(type); gpu.shaderSource(shader, source); gpu.compileShader(shader);
          if (!gpu.getShaderParameter(shader, gpu.COMPILE_STATUS)) { const message = gpu.getShaderInfoLog(shader); gpu.deleteShader(shader); throw new Error(message); }
          return shader;
        };
        const vertex = compile(gpu.VERTEX_SHADER, VERTEX_SHADER), fragment = compile(gpu.FRAGMENT_SHADER, FRAGMENT_SHADER);
        program = gpu.createProgram(); gpu.attachShader(program, vertex); gpu.attachShader(program, fragment); gpu.linkProgram(program);
        gpu.deleteShader(vertex); gpu.deleteShader(fragment);
        if (!gpu.getProgramParameter(program, gpu.LINK_STATUS)) throw new Error(gpu.getProgramInfoLog(program));
        gpu.useProgram(program);
        const buffer = gpu.createBuffer(); gpu.bindBuffer(gpu.ARRAY_BUFFER, buffer);
        gpu.bufferData(gpu.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gpu.STATIC_DRAW);
        const position = gpu.getAttribLocation(program, 'position'); gpu.enableVertexAttribArray(position); gpu.vertexAttribPointer(position, 2, gpu.FLOAT, false, 0, 0);
        uniforms = Object.fromEntries(['minimumView', 'maximumView', 'motor', 'speed', 'colorMaximum', 'quantity'].map(name => [name, gpu.getUniformLocation(program, name)]));
        const info = gpu.getExtension('WEBGL_debug_renderer_info');
        stats.renderer = gpu.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gpu.RENDERER);
      } catch (error) { gpuLost = true; stats.fallback = error.message; }
    }

    function gpuSuitable(view) {
      if (!gpu || !program || gpuLost || gpu.isContextLost()) return false;
      const values = [...Object.values(scene.model.pu), ...view.x, ...view.y];
      if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= 1e8) || scene.maximum > 1e30) return false;
      const { resistance, ld, lq, flux } = scene.model.pu;
      const currentMagnitude = Math.max(1, ...view.x.map(Math.abs), ...view.y.map(Math.abs));
      const roundoffScale = 2 * currentMagnitude * (resistance * currentMagnitude + Math.max(1, Math.abs(scene.model.input.speedPU)) * ((ld + lq) * currentMagnitude + flux));
      if (roundoffScale * 2 ** (3 - gpuPrecision) > scene.maximum * .002) return false;
      return ['x', 'y'].every(axis => (view[axis][1] - view[axis][0]) / Math.max(1, ...view[axis].map(Math.abs)) >= .002);
    }

    function drawHeat(view) {
      heatCanvas.style.display = 'none';
      raster.style.display = 'none';
      stats.backend = 'canvas2d';
      if (!scene.heat) return;
      if (gpuSuitable(view)) {
        gpu.viewport(0, 0, heatCanvas.width, heatCanvas.height); gpu.useProgram(program);
        gpu.uniform2f(uniforms.minimumView, view.x[0], view.y[0]); gpu.uniform2f(uniforms.maximumView, view.x[1], view.y[1]);
        const { resistance, ld, lq, flux } = scene.model.pu;
        gpu.uniform4f(uniforms.motor, resistance, ld, lq, flux); gpu.uniform1f(uniforms.speed, scene.model.input.speedPU);
        gpu.uniform1f(uniforms.colorMaximum, scene.maximum); gpu.uniform1i(uniforms.quantity, HEAT_KEYS.indexOf(scene.heat));
        gpu.drawArrays(gpu.TRIANGLES, 0, 3); heatCanvas.style.display = 'block'; stats.backend = 'webgl'; stats.fallback = null; return;
      }
      if (gpu && program && !gpuLost && !gpu.isContextLost()) stats.fallback = 'numeric-precision';
      const grid = Motor.grid(scene.model, 1, 81, view), field = grid.fields[scene.heat];
      for (let row = 0; row < 81; row++) for (let column = 0; column < 81; column++) {
        const color = colorFor(field[80 - row][column], scene.maximum, scene.heat === 'apparent');
        const offset = (row * 81 + column) * 4;
        pixels.data[offset] = color[0]; pixels.data[offset + 1] = color[1]; pixels.data[offset + 2] = color[2]; pixels.data[offset + 3] = 184;
      }
      rasterContext.putImageData(pixels, 0, 0); raster.style.display = 'block';
    }

    function draw(view) {
      if (!scene || !plot._fullLayout) return;
      const started = performance.now(), layout = plot._fullLayout;
      const width = layout.xaxis._length, height = layout.yaxis._length;
      if (width <= 0 || height <= 0) return;
      const density = Math.min(2, devicePixelRatio || 1);
      for (const canvas of [heatCanvas, raster, lineCanvas]) {
        if (!canvas.isConnected) plot.append(canvas);
        Object.assign(canvas.style, { left: layout.xaxis._offset + 'px', top: layout.yaxis._offset + 'px', width: width + 'px', height: height + 'px' });
        const pixelWidth = Math.max(1, Math.round(width * density)), pixelHeight = Math.max(1, Math.round(height * density));
        if (canvas !== raster && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      }
      context.setTransform(density, 0, 0, density, 0, 0); context.clearRect(0, 0, width, height);
      drawHeat(view);
      const key = JSON.stringify([scene.model.input, scene.visible, scene.levels]);
      if (!cache || cache.key !== key || !covers(cache.bounds, view) || (view.x[1] - view.x[0]) < (cache.bounds.x[1] - cache.bounds.x[0]) / 5) {
        cache = { key, ...geometryFor(scene, paddedBounds(view)) }; stats.geometryBuilds++;
      }
      const screenX = value => (value - view.x[0]) / (view.x[1] - view.x[0]) * width;
      const screenY = value => (view.y[1] - value) / (view.y[1] - view.y[0]) * height;
      for (const line of cache.lines) {
        context.strokeStyle = scene.colors[line.kind]; context.fillStyle = scene.colors[line.kind];
        context.lineWidth = line.width; context.globalAlpha = line.opacity; context.setLineDash(line.dash); context.beginPath();
        const drawnDots = new Set();
        for (const branch of line.branches) {
          let previous = null;
          for (const point of branch) {
            if (!point || !Number.isFinite(point.direct) || !Number.isFinite(point.quadrature)) { previous = null; continue; }
            if (line.dots) {
              const dotKey = point.direct + ',' + point.quadrature;
              if (!drawnDots.has(dotKey)) { context.moveTo(screenX(point.direct) + 3.5, screenY(point.quadrature)); context.arc(screenX(point.direct), screenY(point.quadrature), 3.5, 0, 2 * Math.PI); drawnDots.add(dotKey); }
              continue;
            }
            if (previous && branch.length > 2 && Math.hypot(point.direct - previous.direct, point.quadrature - previous.quadrature) > cache.extent * .35) previous = null;
            if (previous) context.lineTo(screenX(point.direct), screenY(point.quadrature));
            else context.moveTo(screenX(point.direct), screenY(point.quadrature));
            previous = point;
          }
        }
        if (line.dots) context.fill(); else context.stroke();
      }
      context.globalAlpha = 1; context.setLineDash([]);
      if (scene.probe.visible) {
        context.fillStyle = scene.colors.text; context.strokeStyle = scene.colors.surface; context.lineWidth = 2;
        context.beginPath(); context.arc(screenX(scene.probe.direct), screenY(scene.probe.quadrature), 5.5, 0, 2 * Math.PI); context.fill(); context.stroke();
      }
      lineCanvas.style.display = 'block'; plot.dataset.previewActive = 'true';
      lastView = { x: [...view.x], y: [...view.y] };
      stats.frames++; stats.drawMs.push(performance.now() - started); if (stats.drawMs.length > 180) stats.drawMs.shift();
      plot.dataset.previewFrameCount = String(stats.frames); plot.dataset.previewBackend = stats.backend;
      plot.dataset.previewModel = JSON.stringify(scene.model.input);
      plot.dataset.previewView = JSON.stringify(lastView); plot.dataset.previewMetrics = JSON.stringify(stats);
    }

    function cancelFrame() {
      if (frame !== null) { if (frameKind === 'animation') cancelAnimationFrame(frame); else clearTimeout(frame); frame = null; }
    }

    function request(view) {
      active = true; pendingView = { x: [...view.x], y: [...view.y] };
      if (frame !== null) return;
      const paint = () => { frame = null; if (active && pendingView) { const next = pendingView; pendingView = null; draw(next); } };
      frameKind = document.visibilityState === 'visible' ? 'animation' : 'timer';
      frame = frameKind === 'animation' ? requestAnimationFrame(paint) : setTimeout(paint, 16);
    }

    heatCanvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); gpuLost = true; stats.fallback = 'context-lost';
      if (active && (pendingView || lastView)) request(pendingView || lastView);
    });

    return {
      get active() { return active; },
      setScene(next) { scene = next; if (scene.heat) initGpu(); },
      setProbe(probe) { if (scene) scene.probe = probe; if (active && (pendingView || lastView)) request(pendingView || lastView); },
      request,
      settle() { active = false; pendingView = null; cancelFrame(); },
      hide() { active = false; pendingView = null; cancelFrame(); for (const canvas of [heatCanvas, raster, lineCanvas]) canvas.style.display = 'none'; plot.dataset.previewActive = 'false'; }
    };
  }

  return { create, colorFor, paddedBounds, covers, geometryFor };
});