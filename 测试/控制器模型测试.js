const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../页面/控制原理/PI控制器/控制器模型.js');
const Flow=require('../页面/控制原理/PI控制器/流场轨迹.js');
const near=(a,b,tol=1e-7)=>assert.ok(Math.abs(a-b)<tol,a+' != '+b);
test('恒力的一阶线性响应与解析解一致',()=>{
  const p=M.parameters({kp:0,ki:0,friction:0,damping:1.3,mass:1.7,force0:2.1,speed0:-.4,load:.2});
  for(const q of M.simulate(p)){
    const steady=(p.force0-p.load)/p.damping;
    near(q.v,steady+(p.speed0-steady)*Math.exp(-p.damping/p.mass*q.t),1e-8);
    near(q.f,p.force0);
  }
});
test('无阻尼纯积分闭环与谐振解析解一致，并守恒能量',()=>{
  const p=M.parameters({kp:0,ki:3,friction:0,damping:0,mass:1.4,target:.8,force0:.6,speed0:-.3});
  const w=Math.sqrt(p.ki/p.mass),a=p.speed0-p.target,b=p.force0/(p.mass*w),energy=p.force0**2/(2*p.mass)+p.ki*a*a/2;
  for(const q of M.simulate(p)){
    near(q.v,p.target+a*Math.cos(w*q.t)+b*Math.sin(w*q.t),2e-7);
    near(q.f,p.mass*w*(-a*Math.sin(w*q.t)+b*Math.cos(w*q.t)),2e-7);
    near(q.f**2/(2*p.mass)+p.ki*(q.v-p.target)**2/2,energy,1e-7);
  }
  assert.equal(M.stability(p).type,'center');
});
test('PI克服正负恒载与平滑摩擦，收敛至真实目标平衡点',()=>{
  for(const target of [-1,0,1]){
    const p=M.parameters({target,load:.7,duration:30,kp:2,ki:3,friction:.5,force0:0});
    const eq=M.equilibrium(p),d=M.field(eq,p),q=M.simulate(p).at(-1);
    near(d.f,0);near(d.v,0);near(q.v,target,2e-6);near(q.f,eq.f,3e-6);
  }
});
test('关闭积分保留初始积分贡献，纯P稳态误差不被误消除',()=>{
  const p=M.parameters({kp:1.4,ki:0,friction:0,damping:.6,force0:1.4,speed0:0,duration:30});
  const points=M.simulate(p);
  for(const q of points)near(M.integral(q,p),0,1e-10);
  near(points.at(-1).v,.7,1e-8);
  assert.equal(M.equilibrium(p),null);
});
test('状态方程保持并联PI积分律，摩擦耗散且反向时变号',()=>{
  const p=M.parameters({load:0,damping:0});
  for(const v of [-3,-.2,0,.2,3]){
    const q={f:.7,v},d=M.field(q,p);
    near(d.f+p.kp*d.v,p.ki*(p.target-v),1e-12);
    assert.ok(M.resistance(v,p)*v>=0);
    near(M.resistance(v,p),-M.resistance(-v,p),1e-12);
  }
});
test('小惯量强摩擦极端参数的步长细化保持一致',()=>{
  const p=M.parameters({mass:.2,damping:4,friction:3,epsilon:.04,kp:8,ki:12,target:-.2,force0:20,speed0:-5,duration:4});
  const a=M.simulate(p,null,720),b=M.simulate(p,null,1440);
  for(let i=0;i<a.length;i++){near(a[i].f,b[2*i].f,2e-4);near(a[i].v,b[2*i].v,2e-4);}
});
test('非法参数被拒绝，时间抽样正确处理起终点',()=>{
  for(const bad of [{mass:0},{epsilon:0},{ki:-1},{target:NaN},{duration:Infinity}])assert.throws(()=>M.parameters(bad),RangeError);
  const p=M.parameters(),points=M.simulate(p);
  assert.deepEqual(M.sample(points,-1),points[0]);assert.deepEqual(M.sample(points,99),points.at(-1));
});
test('负阻尼的稳定边界两侧与极点实部对应，负实系数不再误报为中心',()=>{
  for(const [kp,regime,real] of [[.4,'unstable',.3],[1,'boundary',0],[2,'stable',-.5]]){
    const p=M.parameters({damping:-1,friction:0,kp,ki:2}),a=M.stability(p);
    assert.equal(a.regime,regime);near(a.kpCritical,1);near(a.maxReal,real);
    for(const pole of a.poles){
      near(p.mass*(pole.re**2-pole.im**2)+(kp-1)*pole.re+2,0);
      near(2*p.mass*pole.re*pole.im+(kp-1)*pole.im,0);
    }
  }
  for(const ki of [.01,2,12])assert.equal(M.stability(M.parameters({damping:-1,friction:0,kp:.4,ki})).regime,'unstable');
});
test('负阻尼发散轨迹与不稳定线性系统的解析解一致',()=>{
  const p=M.parameters({damping:-1,friction:0,kp:.4,ki:2,force0:-.8,speed0:.8,duration:10});
  const sigma=.3,w=Math.sqrt(2-sigma**2),A=-.2,B=-sigma*A/w;
  for(const q of M.simulate(p)){
    const cosine=Math.cos(w*q.t),sine=Math.sin(w*q.t),exp=Math.exp(sigma*q.t);
    const x=exp*(A*cosine+B*sine),dv=exp*((sigma*A+w*B)*cosine+(sigma*B-w*A)*sine);
    near(q.v,1+x,2e-7);near(q.f,dv-q.v,3e-7);
  }
});
test('增大Kp稳定同一个负阻尼对象，目标与负载平衡保持正确',()=>{
  const p=M.parameters({damping:-1,friction:0,kp:2,ki:2,force0:-.8,speed0:.8,duration:30});
  const q=M.simulate(p).at(-1);near(q.v,1,2e-7);near(q.f,-1,3e-7);
  assert.equal(M.stability(p).globalSufficient,true);
});
test('有摩擦时临界线只报告线性化临界，不宣称非线性等幅振荡',()=>{
  const p=M.parameters({damping:-4,friction:.3,epsilon:.1,target:0,kp:1,ki:2});
  const a=M.stability(p);
  near(a.beff,-1);assert.equal(a.regime,'boundary');assert.equal(a.type,'nonhyperbolic');
});
test('目标附近摩擦斜率只给局部保证，小扰动收敛而大扰动可以逃离',()=>{
  const p=M.parameters({damping:-.8,friction:.5,epsilon:.12,kp:.2,ki:2,target:0,force0:-.006,speed0:.03,duration:30});
  const a=M.stability(p),small=M.simulate(p),large=M.simulate(p,{f:-1,v:5});
  assert.equal(a.regime,'stable');assert.equal(a.globalSufficient,false);
  near(small.at(-1).v,0,1e-7);
  assert.ok(Math.max(...large.map(q=>Math.abs(q.v)))>20);
  const h=1e-6;near((M.resistance(h,p)-M.resistance(-h,p))/(2*h),a.beff,1e-8);
});
test('发散保护在真实时间终止，不限幅状态或伪造剩余时间的平直轨迹',()=>{
  const p=M.parameters({mass:.2,damping:-4,friction:0,kp:0,ki:0,force0:0,speed0:1,duration:30});
  const points=M.simulate(p),last=points.at(-1);
  assert.equal(points.termination.reason,'state-limit');
  assert.ok(last.t>=Math.log(M.MAX_STATE)/20&&last.t<Math.log(M.MAX_STATE)/20+.012);
  assert.ok(last.v>=M.MAX_STATE&&last.v<M.MAX_STATE*1.3);assert.ok(last.t<p.duration);
  assert.deepEqual(M.sample(points,30),last);
  const prev=points.at(-2),mid=M.sample(points,(prev.t+last.t)/2);near(mid.v,(prev.v+last.v)/2,1e-8);
  assert.ok(points.every(q=>Number.isFinite(q.f)&&Number.isFinite(q.v)));
});
test('相平面散度等于两个状态导数的对角偏导和',()=>{
  const p=M.parameters({damping:-.8,friction:.5,epsilon:.12,kp:.2,mass:1.3}),h=1e-6;
  for(const v of [-1,-.12,0,.12,1]){
    const dF=(M.field({f:.7+h,v},p).f-M.field({f:.7-h,v},p).f)/(2*h);
    const dv=(M.field({f:.7,v:v+h},p).v-M.field({f:.7,v:v-h},p).v)/(2*h);
    near(M.divergence({f:.7,v},p),dF+dv,2e-9);
  }
  assert.ok(M.divergence({v:0},p)<0);assert.ok(M.divergence({v:1},p)>0);
});
test('短轨迹保留真实时间和速度，匹配解析解与局部面积变化',()=>{
  const p=M.parameters({kp:0,ki:0,friction:0,damping:1,mass:1,load:0}),initial={f:2,v:0};
  for(const q of Flow.trace(p,initial,1.2)) {near(q.f,2);near(q.v,2*(1-Math.exp(-q.t)),1e-9);}
  const h=1e-4,T=.6,origin=Flow.trace(p,initial,T).at(-1);
  const alongF=Flow.trace(p,{f:2+h,v:0},T).at(-1),alongV=Flow.trace(p,{f:2,v:h},T).at(-1);
  const area=((alongF.f-origin.f)*(alongV.v-origin.v)-(alongF.v-origin.v)*(alongV.f-origin.f))/(h*h);
  near(area,Math.exp(-T),1e-8);
});
test('散度加密可重复、有基础覆盖，恒定或零散度时退化为均匀播种',()=>{
  const bounds={f:[-2,2],v:[-1,1]},p=M.parameters({damping:0,kp:0,friction:1,epsilon:.12});
  const uniform=Flow.seeds(p,bounds,24,24),absolute=Flow.seeds(p,bounds,24,24,'absolute'),square=Flow.seeds(p,bounds,24,24,'square');
  const central=seeds=>seeds.points.filter(q=>Math.abs(q.v)<.12).length;
  assert.ok(central(absolute)>central(uniform)*2);assert.ok(central(square)>central(uniform)*2);
  assert.equal(absolute.points.length,uniform.points.length);assert.deepEqual(absolute,Flow.seeds(p,bounds,24,24,'absolute'));
  for(const group of [uniform,absolute,square]) {
    assert.ok(group.points.every(q=>q.f>-2&&q.f<2&&q.v>-1&&q.v<1));
    assert.ok(group.points.some(q=>q.v<-.8)&&group.points.some(q=>q.v>.8));
  }
  for(const kp of [0,1]){
    const q=M.parameters({damping:0,kp,friction:0});
    for(const mode of ['absolute','square'])assert.deepEqual(Flow.seeds(q,bounds,24,24,mode).points,Flow.seeds(q,bounds,24,24).points);
  }
});
test('短轨迹在平衡点不漂移，并在离开视窗的真实时间停止',()=>{
  const p=M.parameters({damping:-1,kp:.4,ki:2,friction:0}),eq=M.equilibrium(p);
  for(const q of Flow.trace(p,eq,5)) {near(q.f,eq.f);near(q.v,eq.v);}
  const fast=M.parameters({mass:.2,damping:-4,friction:0,kp:0,ki:0});
  const track=Flow.trace(fast,{f:0,v:1},3,96,{f:[-1,1],v:[0,2]}),last=track.at(-1);
  assert.ok(last.t>=Math.log(2)/20&&last.t<Math.log(2)/20+M.maxStep(fast));
  assert.ok(last.v>=2&&track.every(q=>Number.isFinite(q.f)&&Number.isFinite(q.v)));
  assert.throws(()=>Flow.trace(p,eq,0),RangeError);
});
