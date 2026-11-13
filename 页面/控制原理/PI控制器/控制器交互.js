(() => {
  'use strict';
  const M = window.ControllerModel, Flow = window.ControllerFlow, $ = id => document.getElementById(id);
  const definitions = [
    ['target', '目标速度 / 转速', 'r', .05, 'controller'], ['kp', '比例增益', 'Kp', .05, 'controller'], ['ki', '积分增益', 'Ki', .05, 'controller'],
    ['mass', '等效惯量', 'M', .05, 'plant'], ['damping', '阻尼（可为负）', 'b', .05, 'plant'], ['friction', '库仑摩擦幅值', 'Fc', .05, 'plant'],
    ['epsilon', '摩擦过渡速度', 'vε', .01, 'plant'], ['load', '恒定负载', 'L', .05, 'plant'],
    ['force0', '初始驱动力', 'F₀', .05, 'initial'], ['speed0', '初始速度', 'v₀', .05, 'initial'], ['duration', '观察时长 / s', 'T', 1, 'initial']
  ];
  const presets = {
    unstable: { ...M.DEFAULTS, damping: -1, friction: 0, kp: .4, ki: 2, force0: -.8, speed0: .8, duration: 10 },
    boundary: { ...M.DEFAULTS, damping: -1, friction: 0, kp: 1, ki: 2, force0: -.8, speed0: .8, duration: 10 },
    stabilized: { ...M.DEFAULTS, damping: -1, friction: 0, kp: 2, ki: 2, force0: -.8, speed0: .8, duration: 10 },
    local: { ...M.DEFAULTS, damping: -.8, friction: .5, epsilon: .12, kp: .2, ki: 2, target: 0, force0: -.006, speed0: .03, duration: 15 },
    default: M.DEFAULTS,
    oscillation: { ...M.DEFAULTS, damping: .1, friction: 0, kp: .15, ki: 3, force0: .15, duration: 20 },
    smooth: { ...M.DEFAULTS, damping: 1.4, kp: 3, ki: 2, force0: 3, duration: 12 },
    friction: { ...M.DEFAULTS, target: .15, friction: 1.5, epsilon: .08, damping: .3, kp: 1.2, ki: 1.8, force0: .18, duration: 15 },
    proportional: { ...M.DEFAULTS, ki: 0, kp: 1.4, force0: 1.4 }
  };
  let p = M.parameters(), points = [], bounds, geometry, responseGeometry, gainGeometry, endTime = 0, time = 0, running = false, frame = null, lastTime = null, pending = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let flowCache = null, flowBands = [], flowRunning = !reducedMotion.matches, flowVisible = true, flowFrame = null, flowLast = null, flowElapsed = 1.2;
  const phase = $('phase'), response = $('response');
  const fmt = (v, n = 3) => (Math.abs(v) < .5 * 10 ** -n ? 0 : v).toFixed(n);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const tag = (name, attrs = {}, text = '') => '<' + name + ' ' + Object.entries(attrs).map(([k,v]) => k + '="' + v + '"').join(' ') + '>' + text + '</' + name + '>';
  const line = (x1,y1,x2,y2,cls) => tag('line', { x1,y1,x2,y2,class:cls });
  const label = (x,y,text,anchor='middle',cls='') => tag('text', { x,y,'text-anchor':anchor,class:cls },text);
  const path = (data, cls, id) => tag('path', { d:data, class:cls, ...(id ? {id} : {}) });
  const poly = (list, x, y) => list.map((s,i) => (i ? 'L' : 'M') + fmt(x(s),2) + ',' + fmt(y(s),2)).join(' ');
  const range = (values, minimum) => {
    let lo=Math.min(...values),hi=Math.max(...values),span=Math.max(hi-lo,minimum);
    const middle=(lo+hi)/2; return [middle-span*.68,middle+span*.68];
  };
  function ticks(lo,hi,count) {
    const raw=(hi-lo)/count,base=10**Math.floor(Math.log10(raw)),q=raw/base;
    const step=(q<=1?1:q<=2?2:q<=5?5:10)*base,result=[];
    for(let t=Math.ceil(lo/step)*step;t<=hi+step*1e-6;t+=step) result.push(Math.abs(t)<step*1e-6?0:t);
    return result;
  }
  for (const [key, title, symbol, step, section] of definitions) {
    const [min,max]=M.LIMITS[key];
    $(section+'-fields').insertAdjacentHTML('beforeend','<div class="parameter"><div class="parameter-top"><label for="'+key+'">'+title+' <em>'+symbol+'</em></label><input id="'+key+'" type="number" min="'+min+'" max="'+max+'" step="any" value="'+p[key]+'" required></div><input id="'+key+'-range" aria-label="'+title+'滑块" type="range" min="'+min+'" max="'+max+'" step="'+step+'" value="'+p[key]+'"></div>');
  }
  function fillInputs() {
    for(const [key] of definitions) { $(key).value=p[key];$(key+'-range').value=p[key];$(key).removeAttribute('aria-invalid'); }
  }
  function fit() {
    const eq=M.equilibrium(p);
    bounds={ f:range([0,...points.map(s=>s.f),...(eq?[eq.f]:[])],2.6), v:range([0,p.target,...points.map(s=>s.v)],1.8) };
  }
  function stop() {
    running=false; lastTime=null;
    if(frame!==null) cancelAnimationFrame(frame);
    frame=null;$('play').textContent='▶ 播放主轨迹';$('play').setAttribute('aria-pressed','false');
  }
  function rebuild(fitBounds=true) {
    stop();
    points=M.simulate(p);time=0;endTime=points.at(-1).t;
    if(fitBounds||!bounds) fit();
    $('timeline').max=endTime;$('timeline').step='any';
    const analysis=M.stability(p);
    $('stability').textContent=analysis.label;$('stability').dataset.regime=analysis.regime;
    phase.dataset.parameters=JSON.stringify(p);
    $('simulation-note').hidden=!points.termination;
    $('simulation-note').textContent=points.termination?'轨迹在 t = '+fmt(endTime,3)+' s 达到计算显示边界（|F| 或 |v| ≥ '+M.MAX_STATE+'），已停止积分。曲线不再延长；这不是执行器限幅，也不是稳定性判据。':'';
    $('plot-hint').textContent=p.ki===0?'Ki = 0：积分贡献冻结；终点依赖起点，可能存在稳态误差。':p.kp===0?'Kp = 0：控制力零变化线与目标速度线重合。点击图中可设置起点。':'点击图中设置主轨迹起点；背景短轨迹显示周围状态的演化。';
    drawPhase();drawResponse();drawAnalysis();update();
  }
  function flowMarkup() {
    const g=geometry,horizon=Number($('flow-horizon').value),density=Number($('flow-density').value),mode=$('flow-seeding').value;
    const key=JSON.stringify([p,bounds,g.W,g.H,horizon,density,mode]);
    if(flowCache?.key===key)return flowCache.markup;
    const spacing=[0,96,72,52,42,34][density],nx=clamp(Math.floor((g.R-g.L)/spacing),3,36),ny=clamp(Math.floor((g.B-g.T)/spacing),3,16);
    const seeded=Flow.seeds(p,bounds,nx,ny,mode),bands=48,paths=Array.from({length:bands},()=>['','','']);
    const kind=s=>{const d=M.divergence(s,p);return d < -1e-8?0:d > 1e-8?1:2;};
    const colors=['flow-contract','flow-expand','flow-neutral'];
    let dots='';
    for(const seed of seeded.points) {
      const track=Flow.trace(p,seed,horizon,96,bounds);
      if(track.length<2)continue;
      dots+=tag('circle',{cx:fmt(g.X(seed.f),2),cy:fmt(g.Y(seed.v),2),r:.9,class:colors[kind(seed)]});
      for(let i=1;i<track.length;i++) {
        const a=track[i-1],b=track[i],band=Math.min(bands-1,Math.floor((a.t+1e-10)/horizon*bands));
        const c=kind({v:(a.v+b.v)/2});
        paths[band][c]+='M'+fmt(g.X(a.f),2)+','+fmt(g.Y(a.v),2)+'L'+fmt(g.X(b.f),2)+','+fmt(g.Y(b.v),2);
      }
    }
    let markup='<g id="flow-field"><g class="flow-seeds">'+dots+'</g>';
    for(let i=0;i<bands;i++) {
      const opacity=.66*(1-i/(bands-1))**1.45;
      markup+='<g class="flow-band" data-start="'+(i*horizon/bands)+'" data-opacity="'+opacity+'" opacity="'+opacity+'">';
      for(let c=0;c<3;c++)if(paths[i][c])markup+=path(paths[i][c],'flow-line '+colors[c]);
      markup+='</g>';
    }
    markup+='</g>';
    flowCache={key,markup,horizon,count:seeded.points.length};flowElapsed=horizon;
    phase.dataset.flowCount=String(seeded.points.length);phase.dataset.flowMode=mode;phase.dataset.flowWeighted=String(seeded.weighted);
    phase.dataset.divergence=JSON.stringify([seeded.min,seeded.max]);
    $('flow-density-value').value=String(density);
    const detail=mode==='uniform'?'均匀起点：观察汇聚与扩张。':seeded.weighted?'高 |散度| 处起点更密；线密度包含采样偏置。':'此视窗内散度恒定，加密模式与均匀模式相同。';
    $('flow-note').textContent=seeded.points.length+' 个起点 · 散度 '+fmt(seeded.min,2)+(Math.abs(seeded.max-seeded.min)>1e-8?' ～ '+fmt(seeded.max,2):'')+' / s。'+detail;
    return markup;
  }
  function paintFlow() {
    if(!flowCache)return;
    const T=flowCache.horizon,t=Math.min(flowElapsed,T),fade=clamp(1-(flowElapsed-T-.5)/.7,0,1),field=$('flow-field');
    if(field) {
      field.setAttribute('opacity',String(fade));
      for(const band of flowBands)band.setAttribute('opacity',String(Number(band.dataset.opacity)*clamp((t-Number(band.dataset.start))/(T/48),0,1)));
    }
    $('flow-clock').value=fmt(t,2)+' / '+T+' s';
    phase.dataset.flowTime=String(t);phase.dataset.flowRunning=String(flowRunning);
    $('flow-animate').textContent=flowRunning?'Ⅱ 暂停流场':'▶ 展开流场';
    $('flow-animate').setAttribute('aria-pressed',String(flowRunning));
  }
  function cancelFlowFrame() {
    if(flowFrame!==null)cancelAnimationFrame(flowFrame);flowFrame=null;flowLast=null;
  }
  function scheduleFlow() {
    if(flowRunning&&flowVisible&&!document.hidden&&$('show-flow').checked&&flowFrame===null)flowFrame=requestAnimationFrame(animateFlow);
  }
  function animateFlow(now) {
    flowFrame=null;
    if(!flowRunning||!flowVisible||document.hidden||!$('show-flow').checked){flowLast=null;return;}
    if(flowLast===null)flowLast=now;
    if(now-flowLast>=32) {
      flowElapsed=(flowElapsed+Math.min(.1,(now-flowLast)/1000))%(flowCache.horizon+1.2);
      flowLast=now;paintFlow();
    }
    scheduleFlow();
  }
  function drawPhase() {
    const W=Math.max(270,phase.clientWidth),H=phase.clientHeight,L=W<500?49:60,R=W-24,T=35,B=H-48;
    const sx=(R-L)/(bounds.f[1]-bounds.f[0]),sy=(B-T)/(bounds.v[1]-bounds.v[0]);
    const X=f=>L+(f-bounds.f[0])*sx,Y=v=>B-(v-bounds.v[0])*sy;
    geometry={W,H,L,R,T,B,sx,sy,X,Y};
    phase.setAttribute('viewBox','0 0 '+W+' '+H);
    let markup='<defs><clipPath id="phase-clip"><rect x="'+L+'" y="'+T+'" width="'+(R-L)+'" height="'+(B-T)+'"/></clipPath></defs>';
    for(const f of ticks(...bounds.f,Math.max(3,Math.floor(W/115)))) {
      markup+=line(X(f),T,X(f),B,f===0?'zero-line':'grid-line')+label(X(f),B+21,fmt(f,1));
    }
    for(const v of ticks(...bounds.v,6)) markup+=line(L,Y(v),R,Y(v),v===0?'zero-line':'grid-line')+label(L-10,Y(v)+4,fmt(v,1),'end');
    markup+=label(L,19,'速度 / 转速 v · pu','start','axis-title')+label(R,H-10,'驱动力 F · pu','end','axis-title');
    let layer='';
    const background=flowMarkup();if($('show-flow').checked)layer+=background;
    layer+=line(L,Y(p.target),R,Y(p.target),'target-line');
    if($('show-nullclines').checked) {
      const samples=Array.from({length:401},(_,i)=>({v:bounds.v[0]+(bounds.v[1]-bounds.v[0])*i/400}));
      layer+=path(poly(samples,s=>X(M.resistance(s.v,p)),s=>Y(s.v)),'velocity-curve');
      if(p.kp>0) layer+=path(poly(samples,s=>X(M.resistance(s.v,p)+p.mass*p.ki/p.kp*(p.target-s.v)),s=>Y(s.v)),'force-curve');
      else if(p.ki>0) layer+=line(L,Y(p.target),R,Y(p.target),'force-curve');
    }
    layer+=path(poly(points,s=>X(s.f),s=>Y(s.v)),'preview-path')+path('','trace-path','active-trace');
    const eq=M.equilibrium(p);
    if(eq) layer+=path('M'+X(eq.f)+','+(Y(eq.v)-7)+'l7,7l-7,7l-7,-7Z','equilibrium');
    layer+=tag('circle',{cx:X(p.force0),cy:Y(p.speed0),r:4,class:'initial-dot'});
    layer+='<g id="moving-state"><circle id="state-halo" r="13" class="state-halo"/><circle id="state-dot" r="5.5" class="state-dot"/></g>';
    markup+='<g clip-path="url(#phase-clip)">'+layer+'</g>';
    markup+=tag('rect',{x:L,y:T,width:R-L,height:B-T,class:'frame-line'});
    phase.innerHTML=markup;
    phase.dataset.bounds=JSON.stringify(bounds);
    flowBands=Array.from(phase.querySelectorAll('.flow-band'));paintFlow();scheduleFlow();
  }
  function drawResponse() {
    const W=Math.max(270,response.clientWidth),H=250,L=49,R=W-24,TX=t=>L+t/p.duration*(R-L);
    const vr=range([0,p.target,...points.map(s=>s.v)],.5),fr=range([0,...points.map(s=>s.f)],.5);
    const YV=v=>105-(v-vr[0])/(vr[1]-vr[0])*77,YF=f=>213-(f-fr[0])/(fr[1]-fr[0])*77;
    responseGeometry={TX,YV,YF};
    let s=label(12,18,'v','start','axis-title')+label(12,126,'F','start','axis-title');
    for(const t of ticks(0,p.duration,Math.max(3,Math.floor(W/100))))s+=line(TX(t),28,TX(t),213,'grid-line')+label(TX(t),233,fmt(t,0));
    for(const v of ticks(...vr,3))s+=line(L,YV(v),R,YV(v),'grid-line')+label(L-8,YV(v)+4,fmt(v,1),'end');
    for(const f of ticks(...fr,3))s+=line(L,YF(f),R,YF(f),'grid-line')+label(L-8,YF(f)+4,fmt(f,1),'end');
    s+=line(L,YV(p.target),R,YV(p.target),'target-line');
    s+=path(poly(points,s=>TX(s.t),s=>YV(s.v)),'response-speed')+path(poly(points,s=>TX(s.t),s=>YF(s.f)),'response-force');
    if(points.termination) {
      s+=tag('rect',{x:TX(endTime),y:25,width:R-TX(endTime),height:191,fill:'var(--unstable-fill)'});
      s+=line(TX(endTime),25,TX(endTime),216,'gain-boundary');
      if(R-TX(endTime)>90)s+=label((TX(endTime)+R)/2,121,'积分已停止');
    }
    s+=tag('line',{id:'time-cursor',x1:L,x2:L,y1:25,y2:216,class:'time-cursor'});
    s+=tag('circle',{id:'response-speed-dot',r:3.5,fill:'var(--teal)'})+tag('circle',{id:'response-force-dot',r:3.5,fill:'var(--purple)'});
    s+=label(R,246,'时间 t / s','end');
    response.setAttribute('viewBox','0 0 '+W+' '+H);response.innerHTML=s;
  }
  function drawAnalysis() {
    const a=M.stability(p),pole=s=>fmt(s.re)+(s.im===0?'':(s.im>0?' + ':' − ')+fmt(Math.abs(s.im))+'i');
    $('stability-quick').dataset.regime=a.regime;
    $('quick-condition').textContent=p.ki===0?'Ki = 0：已关闭积分':'稳定需 Kp > '+fmt(a.kpCritical,3)+'，Ki > 0';
    $('quick-margin').textContent='当前 Kp + beff = '+fmt(a.margin,3);
    $('effective-damping').textContent=fmt(a.beff,4);
    $('damping-margin').textContent=fmt(a.margin,4);
    $('pole-values').textContent=a.poles?a.poles.map(pole).join('；'):'需在实际平衡点求解';
    $('max-real').textContent=a.maxReal===null?'—':fmt(a.maxReal,4)+' / s';
    let note;
    if(p.ki===0)note='积分贡献被冻结。目标点未必是可达平衡点，不能用目标处的二维 PI 判据宣称系统稳定。';
    else if(a.regime==='boundary')note=p.friction===0?'当前处于稳定边界：线性模型极点在虚轴上，扰动形成等幅振荡，不能渐近收敛。':'当前线性化极点在虚轴上；高阶非线性决定稳定性，不能把它当成严格的等幅振荡。';
    else if(a.regime==='unstable')note='存在正实部极点，目标平衡点不稳定。增大 Kp，使 Kp + beff > 0；只增大 Ki 不能改变这个稳定边界。';
    else if(p.friction===0)note='此时模型是线性的，该条件保证全局渐近稳定。Ki 调节振荡频率和极点位置；增大 Ki 不会单独跨过这条稳定边界。';
    else if(a.globalSufficient)note='线性化满足局部渐近稳定条件，并且 Kp + b > 0，满足本模型全局渐近稳定的充分条件。';
    else note='这里只保证目标附近的局部渐近稳定。摩擦斜率随速度改变，大扰动仍可能发散；可点击远处起点作对比。';
    $('stability-note').textContent=note;
    $('set-boundary').disabled=a.kpCritical<M.LIMITS.kp[0]||a.kpCritical>M.LIMITS.kp[1];
    $('set-stable').disabled=a.kpCritical>=M.LIMITS.kp[1];
    $('gain-map').dataset.analysis=JSON.stringify(a);
    drawGainMap();
  }
  function drawGainMap() {
    const svg=$('gain-map'),a=M.stability(p),W=Math.max(250,svg.clientWidth),H=svg.clientHeight,L=42,R=W-18,T=31,B=H-43;
    const X=kp=>L+kp/8*(R-L),Y=ki=>B-ki/12*(B-T),edge=X(clamp(a.kpCritical,0,8));
    gainGeometry={L,R,T,B,X,Y};svg.setAttribute('viewBox','0 0 '+W+' '+H);
    let s='<defs><clipPath id="gain-clip"><rect x="'+L+'" y="'+T+'" width="'+(R-L)+'" height="'+(B-T)+'"/></clipPath></defs>';
    s+=tag('rect',{x:L,y:T,width:edge-L,height:B-T,class:'gain-unstable'});
    s+=tag('rect',{x:edge,y:T,width:R-edge,height:B-T,class:'gain-stable'});
    for(const kp of [0,2,4,6,8])s+=line(X(kp),T,X(kp),B,'grid-line')+label(X(kp),B+19,String(kp));
    for(const ki of [0,3,6,9,12])s+=line(L,Y(ki),R,Y(ki),'grid-line')+label(L-8,Y(ki)+4,String(ki),'end');
    const modal=Array.from({length:161},(_,i)=>({kp:i/20,ki:(i/20+a.beff)**2/(4*p.mass)}));
    let overlay=path(poly(modal,s=>X(s.kp),s=>Y(s.ki)),'gain-modal');
    if(a.kpCritical>=0&&a.kpCritical<=8)overlay+=line(X(a.kpCritical),T,X(a.kpCritical),B,'gain-boundary');
    overlay+=line(L,Y(p.ki),X(p.kp),Y(p.ki),'gain-guide')+line(X(p.kp),B,X(p.kp),Y(p.ki),'gain-guide');
    s+='<g clip-path="url(#gain-clip)">'+overlay+'</g>';
    s+=line(L,B,R,B,'gain-boundary')+tag('rect',{x:L,y:T,width:R-L,height:B-T,class:'frame-line'});
    s+=tag('circle',{cx:X(p.kp),cy:Y(p.ki),r:5.5,class:'gain-point'});
    s+=label(L,18,'积分增益 Ki','start','axis-title')+label(R,H-5,'比例增益 Kp','end','axis-title');
    if(a.kpCritical>=0&&a.kpCritical<=8)s+=label(X(a.kpCritical)+5,T+15,'Kp* = '+fmt(a.kpCritical,2),'start');
    if(R-edge>95)s+=label((edge+R)/2,T+34,'局部稳定');
    if(edge-L>62)s+=label((L+edge)/2,T+54,'不稳定');
    svg.innerHTML=s;
  }
  function update() {
    if(!points.length||!geometry||!responseGeometry)return;
    const s=M.sample(points,time),d=M.field(s,p),g=geometry;
    const current=points.filter(q=>q.t<time);current.push(s);
    $('active-trace').setAttribute('d',poly(current,q=>g.X(q.f),q=>g.Y(q.v)));
    $('moving-state').setAttribute('transform','translate('+g.X(s.f)+','+g.Y(s.v)+')');
    phase.dataset.state=JSON.stringify(s);phase.dataset.derivative=JSON.stringify(d);phase.dataset.integral=String(M.integral(s,p));
    $('read-force').textContent=fmt(s.f);$('read-speed').textContent=fmt(s.v);$('read-error').textContent=fmt(p.target-s.v);
    $('read-df').textContent='dF/dt '+fmt(d.f);$('read-dv').textContent='dv/dt '+fmt(d.v);$('read-integral').textContent='积分贡献 I '+fmt(M.integral(s,p));
    $('read-resistance').textContent=fmt(M.resistance(s.v,p));
    $('read-components').textContent=[p.damping*s.v,p.friction*Math.tanh(s.v/p.epsilon),p.load].map(v=>fmt(v,2)).join(' / ');
    $('time-label').textContent=fmt(time,2)+' s';$('timeline').value=time;
    const r=responseGeometry,x=r.TX(time);$('time-cursor').setAttribute('x1',x);$('time-cursor').setAttribute('x2',x);
    for(const [id,y] of [['response-speed-dot',r.YV(s.v)],['response-force-dot',r.YF(s.f)]]){$(id).setAttribute('cx',x);$(id).setAttribute('cy',y);}
  }
  function animate(now) {
    frame=null;if(!running)return;
    if(lastTime!==null)time=Math.min(endTime,time+(now-lastTime)/1000*Number($('playback-rate').value));
    lastTime=now;update();
    if(time>=endTime)stop();else frame=requestAnimationFrame(animate);
  }
  function togglePlay() {
    if(running){stop();return;}
    if($('play').disabled)return;
    if(time>=endTime)time=0;
    running=true;lastTime=null;$('play').textContent='Ⅱ 暂停';$('play').setAttribute('aria-pressed','true');frame=requestAnimationFrame(animate);
  }
  function readParameters() {
    const values={};let invalid=null;
    for(const [key,title] of definitions) {
      const value=$(key).valueAsNumber,[min,max]=M.LIMITS[key];values[key]=value;
      const valid=Number.isFinite(value)&&value>=min&&value<=max;
      $(key).setAttribute('aria-invalid',String(!valid));
      if(!valid&&!invalid)invalid=title+'需要在 '+min+' 至 '+max+' 之间。';
    }
    $('input-error').hidden=!invalid;$('input-error').textContent=invalid||'';$('play').disabled=!!invalid;
    if(invalid){stop();return;}
    try{p=M.parameters(values);rebuild();}catch(error){stop();$('input-error').hidden=false;$('input-error').textContent=error.message;$('play').disabled=true;}
  }
  for(const [key] of definitions) {
    $(key).addEventListener('input',()=>{if(Number.isFinite($(key).valueAsNumber))$(key+'-range').value=$(key).value;queue();});
    $(key+'-range').addEventListener('input',()=>{$(key).value=$(key+'-range').value;queue();});
  }
  function queue() {
    $('preset').value='custom';stop();
    if(pending!==null)cancelAnimationFrame(pending);
    pending=requestAnimationFrame(()=>{pending=null;readParameters();});
  }
  function choosePreset(name) {
    if(pending!==null)cancelAnimationFrame(pending);pending=null;
    p=M.parameters(presets[name]);fillInputs();$('preset').value=name;$('input-error').hidden=true;$('play').disabled=false;rebuild();
  }
  $('parameters').addEventListener('submit',e=>{e.preventDefault();if(pending!==null)cancelAnimationFrame(pending);pending=null;readParameters();});
  $('preset').addEventListener('change',()=>{if(presets[$('preset').value])choosePreset($('preset').value);});
  function setGains(kp,ki) {
    if($('play').disabled)return;
    if(pending!==null)cancelAnimationFrame(pending);pending=null;
    p.kp=clamp(kp,...M.LIMITS.kp);p.ki=clamp(ki,...M.LIMITS.ki);fillInputs();$('preset').value='custom';rebuild();
  }
  $('set-boundary').addEventListener('click',()=>setGains(M.stability(p).kpCritical,p.ki||2));
  $('set-stable').addEventListener('click',()=>setGains(Math.max(0,M.stability(p).kpCritical+.5),p.ki||2));
  $('gain-map').addEventListener('click',event=>{
    const svg=$('gain-map'),pt=svg.createSVGPoint();pt.x=event.clientX;pt.y=event.clientY;
    const q=pt.matrixTransform(svg.getScreenCTM().inverse()),g=gainGeometry;
    if(q.x<g.L||q.x>g.R||q.y<g.T||q.y>g.B)return;
    setGains(Number((8*(q.x-g.L)/(g.R-g.L)).toFixed(3)),Number((12*(g.B-q.y)/(g.B-g.T)).toFixed(3)));
  });
  $('gain-map').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const d=event.shiftKey?.5:.05;
    setGains(Number((p.kp+({ArrowLeft:-d,ArrowRight:d}[event.key]||0)).toFixed(3)),Number((p.ki+({ArrowDown:-d,ArrowUp:d}[event.key]||0)).toFixed(3)));
  });
  $('reset-all').addEventListener('click',()=>choosePreset('default'));
  $('play').addEventListener('click',togglePlay);
  $('restart').addEventListener('click',()=>{stop();time=0;update();});
  $('timeline').addEventListener('input',()=>{stop();time=Number($('timeline').value);update();});
  $('fit-view').addEventListener('click',()=>{fit();drawPhase();update();});
  for(const id of ['show-flow','show-nullclines'])$(id).addEventListener('change',()=>{cancelFlowFrame();drawPhase();update();});
  for(const id of ['flow-seeding','flow-horizon','flow-density'])$(id).addEventListener(id==='flow-density'?'input':'change',()=>{cancelFlowFrame();drawPhase();update();});
  $('flow-animate').addEventListener('click',()=>{flowRunning=!flowRunning;cancelFlowFrame();if(flowRunning&&flowElapsed>=flowCache.horizon)flowElapsed=0;paintFlow();scheduleFlow();});
  $('flow-complete').addEventListener('click',()=>{flowRunning=false;cancelFlowFrame();flowElapsed=flowCache.horizon;paintFlow();});
  function setInitial(f,v) {
    if($('play').disabled)return;
    p.force0=Number(clamp(f,...M.LIMITS.force0).toFixed(3));p.speed0=Number(clamp(v,...M.LIMITS.speed0).toFixed(3));
    fillInputs();$('preset').value='custom';rebuild(false);
  }
  phase.addEventListener('click',event=>{
    const pt=phase.createSVGPoint();pt.x=event.clientX;pt.y=event.clientY;
    const local=pt.matrixTransform(phase.getScreenCTM().inverse()),g=geometry;
    if(local.x<g.L||local.x>g.R||local.y<g.T||local.y>g.B)return;
    setInitial(bounds.f[0]+(local.x-g.L)/g.sx,bounds.v[0]+(g.B-local.y)/g.sy);
  });
  phase.addEventListener('keydown',event=>{
    if(event.key===' '){event.preventDefault();togglePlay();return;}
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const delta=event.shiftKey?.25:.05;
    setInitial(p.force0+({ArrowLeft:-delta,ArrowRight:delta}[event.key]||0),p.speed0+({ArrowDown:-delta,ArrowUp:delta}[event.key]||0));
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();cancelFlowFrame();}else scheduleFlow();});
  addEventListener('pagehide',()=>{stop();cancelFlowFrame();});
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches){flowRunning=false;cancelFlowFrame();flowElapsed=flowCache.horizon;paintFlow();}});
  new IntersectionObserver(entries=>{flowVisible=entries[0].isIntersecting;if(flowVisible)scheduleFlow();else cancelFlowFrame();}).observe(phase);
  new ResizeObserver(()=>{if(points.length){drawPhase();drawResponse();drawGainMap();update();}}).observe(document.querySelector('.results-panel'));
  choosePreset('unstable');
})();
