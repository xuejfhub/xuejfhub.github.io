(function (root) {
  'use strict';
  function projectState(abc) {
    const zero = (abc[0] + abc[1] + abc[2]) / 3;
    return { abc: abc.slice(), zero, plane: abc.map(value => value - zero), alpha: (2 * abc[0] - abc[1] - abc[2]) / 3, beta: (abc[1] - abc[2]) / Math.sqrt(3) };
  }
  function cubePlaneSection() {
    const corners = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) corners.push([a, b, c]);
    const intersections = [];
    for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i], b = corners[j];
      if (a.filter((value, axis) => value !== b[axis]).length !== 1) continue;
      const da = a.reduce((sum, value) => sum + value, 0), db = b.reduce((sum, value) => sum + value, 0);
      if (da * db > 0) continue;
      const fraction = da / (da - db);
      intersections.push(a.map((value, axis) => value + fraction * (b[axis] - value)));
    }
    return intersections.sort((a, b) => Math.atan2(projectState(a).beta, projectState(a).alpha) - Math.atan2(projectState(b).beta, projectState(b).alpha));
  }
  function cubeProjectionHull() {
    const vertices = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
      if (a === b && b === c) continue;
      vertices.push(projectState([a, b, c]).plane);
    }
    return vertices.sort((a, b) => Math.atan2(projectState(a).beta, projectState(a).alpha) - Math.atan2(projectState(b).beta, projectState(b).alpha));
  }
  function stateLatticeEdges(states) {
    const values = [...new Set(states.flatMap(state => state.abc))].sort((a, b) => a - b);
    const edges = [];
    for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) {
      const a = states[i].abc, b = states[j].abc;
      const axes = [0, 1, 2].filter(axis => a[axis] !== b[axis]);
      if (axes.length !== 1) continue;
      const axis = axes[0];
      if (Math.abs(values.indexOf(a[axis]) - values.indexOf(b[axis])) === 1) edges.push([a, b]);
    }
    return edges;
  }
  function viewCamera(view, camera = {}) {
    const directions = { A: [1, 0, 0], B: [0, 1, 0], C: [0, 0, 1], alpha: [1, -.5, -.5], beta: [0, 1, -1], zero: [1, 1, 1] };
    const base = { zoom: camera.zoom ?? 1, projection: camera.projection || 'orthographic', roll: 0 };
    if (view === 'default') return { ...base, yaw: -.75, pitch: .5 };
    const n = directions[view];
    if (!n) throw new RangeError('未知视角');
    return { ...base, yaw: Math.atan2(n[1], n[0]), pitch: Math.asin(n[2] / Math.hypot(...n)), roll: view === 'zero' ? -5 * Math.PI / 6 : 0 };
  }
  function cameraPoint(point, camera, width, height) {
    const { yaw, pitch, zoom } = camera;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const horizontal = -sy * point[0] + cy * point[1];
    const vertical = -sp * cy * point[0] - sp * sy * point[1] + cp * point[2];
    const depth = cp * cy * point[0] + cp * sy * point[1] + sp * point[2];
    const perspectiveScale = camera.projection === 'orthographic' ? 1 : 7 / (7 - depth);
    const scale = Math.min(width, height) * .20 * zoom * perspectiveScale;
    const cr = Math.cos(camera.roll || 0), sr = Math.sin(camera.roll || 0);
    return { x: width / 2 + (cr * horizontal + sr * vertical) * scale, y: height / 2 - (-sr * horizontal + cr * vertical) * scale, depth };
  }
  function dragCamera(camera, dx, dy) {
    const cr = Math.cos(camera.roll || 0), sr = Math.sin(camera.roll || 0);
    return { ...camera, yaw: camera.yaw - (cr * dx + sr * dy) * .008, pitch: Math.max(-1.45, Math.min(1.45, camera.pitch + (-sr * dx + cr * dy) * .008)) };
  }
  class SpaceView {
    constructor(canvas) {
      this.canvas = canvas;
      this.camera = viewCamera('default');
      this.viewPreset = 'default';
      this.states = []; this.sample = null;
      this.trajectories = null; this.reference = null; this.showSPWM = true; this.showSVPWM = true;
      this.showTHIPWM = false; this.showDPWM5 = false; this.showDPWMMAX = false; this.showDPWMMIN = false;
      this.showCube = true; this.showABC = true;
      this.showAlphaBetaZero = true;
      this.latticeEdges = [];
      this.rotating = false; this.rotationFrame = null; this.rotationTime = null;
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopRotation(); });
      let drag = null;
      canvas.addEventListener('pointerdown', event => { if (event.button !== 0) return; this.stopRotation(); drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
      canvas.addEventListener('pointermove', event => {
        if (!drag) return;
        this.camera = dragCamera(this.camera, event.clientX - drag.x, event.clientY - drag.y);
        this.viewPreset = 'custom'; this.canvas.dispatchEvent(new Event('viewchange'));
        drag = { x: event.clientX, y: event.clientY }; this.draw();
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => canvas.addEventListener(name, () => { drag = null; }));
      canvas.addEventListener('wheel', event => { event.preventDefault(); this.camera.zoom = Math.max(.6, Math.min(1.8, this.camera.zoom * Math.exp(-event.deltaY * .001))); this.draw(); }, { passive: false });
      canvas.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
        event.preventDefault();
        this.stopRotation();
        if (event.key.startsWith('Arrow')) {
          const dx = event.key === 'ArrowLeft' ? -15 : event.key === 'ArrowRight' ? 15 : 0;
          const dy = event.key === 'ArrowUp' ? -15 : event.key === 'ArrowDown' ? 15 : 0;
          this.camera = dragCamera(this.camera, dx, dy);
          this.viewPreset = 'custom'; this.canvas.dispatchEvent(new Event('viewchange'));
        }
        if (event.key === '+' || event.key === '=') this.camera.zoom = Math.min(1.8, this.camera.zoom + .1);
        if (event.key === '-') this.camera.zoom = Math.max(.6, this.camera.zoom - .1);
        this.draw();
      });
    }
    stopRotation() {
      this.rotating = false;
      if (this.rotationFrame !== null) cancelAnimationFrame(this.rotationFrame);
      this.rotationFrame = null; this.rotationTime = null;
      this.canvas.dataset.rotating = 'false';
      this.canvas.dispatchEvent(new Event('rotationchange'));
    }
    startRotation() {
      this.reset();
      this.rotating = true;
      this.canvas.dataset.rotating = 'true';
      this.canvas.dispatchEvent(new Event('rotationchange'));
      const tick = time => {
        this.rotationFrame = null;
        if (!this.rotating) return;
        const elapsed = this.rotationTime === null ? 0 : Math.max(0, time - this.rotationTime);
        this.rotationTime = time;
        // C is the fixed ABC vertical axis; only camera azimuth changes.
        this.camera.yaw = ((this.camera.yaw + elapsed * Math.PI / 15000 + Math.PI) % (2 * Math.PI)) - Math.PI;
        if (elapsed > 0) {
          this.viewPreset = 'custom';
          this.canvas.dispatchEvent(new Event('viewchange'));
        }
        this.draw();
        this.rotationFrame = requestAnimationFrame(tick);
      };
      this.rotationFrame = requestAnimationFrame(tick);
    }
    setProjection(projection) {
      if (!['perspective', 'orthographic'].includes(projection)) throw new RangeError('未知显示投影方式');
      this.camera.projection = projection;
      this.draw();
    }
    setView(view) {
      this.stopRotation();
      if (view !== 'custom') this.camera = viewCamera(view, this.camera);
      this.viewPreset = view;
      this.draw();
      this.canvas.dispatchEvent(new Event('viewchange'));
    }
    reset() {
      this.camera.zoom = 1;
      this.setView('default');
    }
    setTrajectories(trajectories) {
      this.trajectories = trajectories;
      if (!trajectories) this.reference = null;
      this.draw();
    }
    update(states, sample, reference = null) {
      if (this.canvas.dataset.stateCount !== String(states.length)) this.latticeEdges = stateLatticeEdges(states);
      this.states = states.map(state => projectState(state.abc));
      this.sample = sample ? projectState(sample.abc) : null;
      this.reference = reference;
      this.canvas.dataset.stateCount = String(states.length);
      this.canvas.dataset.positionCount = String(new Set(this.states.map(state => `${state.alpha.toFixed(8)},${state.beta.toFixed(8)}`)).size);
      this.draw();
    }
    draw() {
      const canvas = this.canvas, bounds = canvas.getBoundingClientRect();
      const width = Math.max(250, bounds.width), height = Math.max(280, bounds.height), dpr = devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement), color = name => css.getPropertyValue('--' + name).trim();
      const colors = { bg: color('bg'), line: color('line'), text: color('text'), muted: color('muted'), plane: color('accent'), source: document.documentElement.dataset.theme === 'dark' ? '#e6a492' : '#b85e44' };
      const point = value => cameraPoint(value, this.camera, width, height);
      ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, height);
      ctx.font = '12px sans-serif'; ctx.lineCap = 'round';
      function line(a, b, stroke, dashed = false, weight = 1) {
        const start = point(a), end = point(b); ctx.strokeStyle = stroke; ctx.lineWidth = weight; ctx.setLineDash(dashed ? [4, 5] : []);
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke(); ctx.setLineDash([]);
      }
      function dot(position, fill, radius = 3) {
        const p = point(position); ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      }
      function label(position, text, fill = colors.text) { const p = point(position); ctx.fillStyle = fill; ctx.fillText(text, p.x + 7, p.y - 7); }
      const inverse = (alpha, beta) => [alpha, -.5 * alpha + Math.sqrt(3) / 2 * beta, -.5 * alpha - Math.sqrt(3) / 2 * beta];
      const vertices = cubeProjectionHull();
      canvas.dataset.projectionHull = JSON.stringify(vertices);
      canvas.dataset.planeGrid = 'false';
      ctx.beginPath(); vertices.forEach((v, i) => { const p = point(v); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }); ctx.closePath();
      ctx.fillStyle = colors.plane; ctx.globalAlpha = .045; ctx.fill(); ctx.globalAlpha = .32; ctx.strokeStyle = colors.plane; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      canvas.dataset.planeOpacity = JSON.stringify({ fill: .045, edge: .32 });
      const dark = document.documentElement.dataset.theme === 'dark';
      const curveStyles = [
        ['spwm', 'showSPWM', dark ? '#96b3dc' : '#577bab'],
        ['svpwm', 'showSVPWM', dark ? '#e4ad84' : '#b36b3c'],
        ['thipwm', 'showTHIPWM', dark ? '#c1a0e2' : '#8961ad'],
        ['dpwm5', 'showDPWM5', dark ? '#df9fb4' : '#ad5576'],
        ['dpwmmax', 'showDPWMMAX', dark ? '#dec57e' : '#917623'],
        ['dpwmmin', 'showDPWMMIN', dark ? '#79c7cc' : '#287e87']
      ];
      const sineTrajectory = this.trajectories?.spwm;
      const clampRail = v => Math.max(...v) >= -Math.min(...v);
      function curve(points, stroke, discontinuous = false) {
        ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.beginPath();
        points.forEach((v, i) => {
          const p = point(v);
          const jump = discontinuous && i > 0 && sineTrajectory && clampRail(sineTrajectory[i]) !== clampRail(sineTrajectory[i - 1]);
          i && !jump ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        }); ctx.stroke();
      }
      if (this.trajectories) {
        for (const [key, property, stroke] of curveStyles) {
          if (this[property] && this.trajectories[key]) curve(this.trajectories[key], stroke, key === 'dpwm5');
        }
        canvas.dataset.trajectories = JSON.stringify({ ...Object.fromEntries(curveStyles.map(([key]) => [key, this.trajectories[key]?.length || 0])), zeroRange: [Math.min(...this.trajectories.zero), Math.max(...this.trajectories.zero)] });
      } else { delete canvas.dataset.trajectories; }
      if (this.reference) {
        for (const [key, property, stroke] of curveStyles) if (this[property] && this.reference[key]) dot(this.reference[key], stroke, 5);
        canvas.dataset.reference = JSON.stringify(this.reference);
      } else { delete canvas.dataset.reference; }
      canvas.dataset.visibleTrajectories = JSON.stringify(Object.fromEntries(curveStyles.map(([key, property]) => [key, this[property]])));
      const corners = [];
      for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) corners.push([a, b, c]);
      let cubeEdgeCount = 0;
      for (let i = 0; i < corners.length; i++) for (let j = i + 1; j < corners.length; j++) {
        if (corners[i].filter((value, axis) => value !== corners[j][axis]).length !== 1) continue;
        if (this.showCube) { line(corners[i], corners[j], colors.muted, false, 1.6); cubeEdgeCount++; }
      }
      canvas.dataset.cubeEdgeCount = String(cubeEdgeCount);
      const internalEdges = this.latticeEdges.filter(([a, b]) => [0, 1, 2].some(axis => a[axis] === 0 && b[axis] === 0));
      if (this.showCube) {
        ctx.globalAlpha = .5;
        for (const [a, b] of internalEdges) line(a, b, colors.muted);
        ctx.globalAlpha = 1;
      }
      canvas.dataset.latticeEdgeCount = String(this.showCube ? internalEdges.length : 0);
      if (this.showABC) for (let axis = 0; axis < 3; axis++) { const end = [0, 0, 0]; end[axis] = 1.9; line([0, 0, 0], end, colors.muted); label(end, ['A', 'B', 'C'][axis]); }
      if (this.showAlphaBetaZero) { line([0, 0, 0], inverse(1.8, 0), colors.plane); label(inverse(1.8, 0), 'α', colors.plane); }
      if (this.showAlphaBetaZero) { line([0, 0, 0], inverse(0, 1.8), colors.plane); label(inverse(0, 1.8), 'β', colors.plane); }
      const zeroAxis = { negative: [-1.3, -1.3, -1.3], positive: [1.3, 1.3, 1.3], negativeLabel: this.states.length === 8 ? '−Zero · 000' : '−Zero · (−1,−1,−1)', positiveLabel: this.states.length === 8 ? '+Zero · 111' : '+Zero · (1,1,1)' };
      if (this.showAlphaBetaZero) {
        line(zeroAxis.negative, zeroAxis.positive, colors.muted, true);
        label(zeroAxis.negative, zeroAxis.negativeLabel, colors.muted);
        label(zeroAxis.positive, zeroAxis.positiveLabel, colors.muted);
      }
      canvas.dataset.zeroAxis = JSON.stringify(zeroAxis);
      canvas.dataset.visibleGeometry = JSON.stringify({ cube: this.showCube, abc: this.showABC, alphaBetaZero: this.showAlphaBetaZero });
      canvas.dataset.projectionLinkCount = this.sample ? '1' : '0';
      this.states.slice().sort((a, b) => point(a.abc).depth - point(b.abc).depth).forEach(state => { dot(state.abc, colors.muted, 3.5); dot(state.plane, colors.plane, 2.5); });
      if (this.sample) {
        const s = this.sample;
        line(s.abc, s.plane, colors.source, true, 2.5); line([0, 0, 0], s.abc, colors.source, false, 1.8); line([0, 0, 0], s.plane, colors.plane, false, 3);
        dot(s.abc, colors.source, 7); dot(s.plane, colors.plane, 6);
        label(s.abc, `ABC [${s.abc.join(', ')}]`, colors.source); label(s.plane, `投影 P₀`, colors.plane);
        canvas.dataset.projection = JSON.stringify({ abc: s.abc, plane: s.plane, alpha: s.alpha, beta: s.beta, zero: s.zero });
        canvas.setAttribute('aria-label', `ABC 三维开关状态 [${s.abc.join(', ')}] 沿零序方向映射到 A+B+C=0 平面；α=${s.alpha.toFixed(3)}，β=${s.beta.toFixed(3)}。拖拽或方向键旋转，滚轮或加减键缩放。`);
      } else { delete canvas.dataset.projection; }
      canvas.dataset.viewPreset = this.viewPreset;
      canvas.dataset.camera = JSON.stringify(this.camera);
      canvas.dataset.projectionMode = this.camera.projection;
    }
  }
  const api = { projectState, cubePlaneSection, cubeProjectionHull, stateLatticeEdges, viewCamera, cameraPoint, dragCamera, SpaceView };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpatialProjection = api;
})(typeof globalThis === 'object' ? globalThis : this);
