/* ============================================================
 * 异步电机稳态分析 (Induction Machine Steady-State Analysis)
 * 基于 T 型等值电路 · 标幺值系统
 * ============================================================ */

/* ---------- 复数运算类 ---------- */
class C {
    constructor(re, im = 0) { this.re = re; this.im = im; }
    static fromPolar(r, theta) { return new C(r * Math.cos(theta), r * Math.sin(theta)); }
    add(b) { const o = toC(b); return new C(this.re + o.re, this.im + o.im); }
    sub(b) { const o = toC(b); return new C(this.re - o.re, this.im - o.im); }
    mul(b) { const o = toC(b); return new C(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re); }
    div(b) {
        const o = toC(b);
        const d = o.re * o.re + o.im * o.im;
        return new C((this.re * o.re + this.im * o.im) / d, (this.im * o.re - this.re * o.im) / d);
    }
    scale(k) { return new C(this.re * k, this.im * k); }
    abs() { return Math.hypot(this.re, this.im); }
    arg() { return Math.atan2(this.im, this.re); }
    conj() { return new C(this.re, -this.im); }
    neg() { return new C(-this.re, -this.im); }
}
function toC(x) { return x instanceof C ? x : new C(Number(x), 0); }
const j = new C(0, 1);

/* ---------- 读取输入参数 ---------- */
function $(id) { return document.getElementById(id); }
function num(id) { return parseFloat($(id).value); }

function readParams() {
    return {
        Rs: num('Rs'), Rr: num('Rr'),
        Lls: num('Lls'), Llr: num('Llr'), Lm: num('Lm'),
        p: num('p'),
        Us: num('Us'), fs: num('fs'),
    };
}

/* ---------- 核心：给定 s 计算稳态工作点 ---------- */
function solveFromSlip(P, s) {
    const ws = P.fs;                         // 标幺值 ωs = fs
    const Ls = P.Lls + P.Lm;
    const Lr = P.Llr + P.Lm;

    // 防止 s=0 引起除零
    const ss = Math.abs(s) < 1e-6 ? (s < 0 ? -1e-6 : 1e-6) : s;

    // T 型等值电路阻抗（标幺值）
    const Zs  = new C(P.Rs, ws * P.Lls);                // 定子支路
    const Zr  = new C(P.Rr / ss, ws * P.Llr);           // 转子支路 (Rr/s + jXlr)
    const Zm  = new C(0, ws * P.Lm);                    // 励磁支路 jXm

    // 励磁与转子并联
    const Zp  = Zm.mul(Zr).div(Zm.add(Zr));
    const Zin = Zs.add(Zp);

    // 取 Us 沿实轴方向
    const Us_vec = new C(P.Us, 0);
    const Is = Us_vec.div(Zin);
    const Um = Us_vec.sub(Zs.mul(Is));            // 气隙电压 (=并联支路电压)
    const Ir = Um.div(Zr);                        // 转子支路电流(节点→中性点方向)
    const Im = Um.div(Zm);                        // 励磁电流

    // 磁链 ψ = U_L / (jω) ；或 ψ = L·I
    const Psi_m = Um.div(j.scale(ws));                    // 气隙磁链 = Lm·Im
    const Psi_s = new C(P.Lls, 0).mul(Is).add(Psi_m);     // 定子磁链
    const Psi_r = new C(P.Llr, 0).mul(Ir).add(Psi_m);     // 转子磁链

    // 电磁功率（气隙传到转子的功率）
    const Pe = Ir.abs() * Ir.abs() * (P.Rr / ss);
    // 电磁转矩 (标幺值，以同步速为基值) T = Pe / ωs
    const Tem = Pe / ws;
    // 机械功率、转速
    const Pm = Pe * (1 - ss);
    const n  = 1 - ss;                                   // 转速 (pu, 同步速=1)
    const ns = 1;                                        // 同步速(pu)

    // 输入功率与功率因数
    const Sin = Us_vec.mul(Is.conj());                    // 复功率
    const Pin = Sin.re;
    const Q   = Sin.im;
    const pf  = (Sin.abs() > 1e-9) ? Pin / Sin.abs() : 0;
    const pfSign = (Pin >= 0) ? 1 : -1;

    // 损耗
    const Ps_cu = Is.abs() ** 2 * P.Rs;                   // 定子铜耗
    const Pr_cu = Ir.abs() ** 2 * P.Rr;                   // 转子铜耗 (实际 Rr)
    const Pfe   = 0;                                      // 铁耗(忽略)

    return {
        s: ss, ws, Ls, Lr, Zs, Zr, Zm, Zp, Zin,
        Us: Us_vec, Is, Ir, Im, Um,
        Psi_s, Psi_r, Psi_m,
        Tem, Pe, Pm, Pin, Q, pf, pfSign, n, ns,
        Ps_cu, Pr_cu, Pfe, eff: (Pin > 1e-6 ? Pm / Pin : 0)
    };
}

/* ---------- 转矩模式：数值求根 (T(s) = T_target) ---------- */
function solveSlipFromTorque(P, Ttarget) {
    // 用二分法（在合理转差率区间内 T 单调）
    // 电动机运行：s ∈ (0, ~2]，T 单调上升至 Tmax 后下降；这里采用多区间搜索 + 二分
    const fT = (s) => solveFromSlip(P, s).Tem - Ttarget;

    // 找包含根的区间
    let a = 1e-4, b = 1.5;
    const N = 60;
    let sPrev = a, fPrev = fT(a);
    let found = null;
    for (let i = 1; i <= N; i++) {
        const sCur = a + (b - a) * i / N;
        const fCur = fT(sCur);
        if (fPrev * fCur < 0) { found = [sPrev, sCur]; break; }
        sPrev = sCur; fPrev = fCur;
    }
    if (!found) {
        // 反向(发电)区间也试一下
        a = -1.5; b = -1e-4;
        sPrev = a; fPrev = fT(a);
        for (let i = 1; i <= N; i++) {
            const sCur = a + (b - a) * i / N;
            const fCur = fT(sCur);
            if (fPrev * fCur < 0) { found = [sPrev, sCur]; break; }
            sPrev = sCur; fPrev = fCur;
        }
    }
    if (!found) return null;

    // 二分细化
    let [lo, hi] = found;
    for (let k = 0; k < 60; k++) {
        const mid = 0.5 * (lo + hi);
        if (fT(lo) * fT(mid) < 0) hi = mid; else lo = mid;
    }
    return 0.5 * (lo + hi);
}

/* ---------- 转差频率模式：s = ωsl / ωs ---------- */
function solveSlipFromSlipFreq(P, wsl) {
    return wsl / P.fs;
}

/* ---------- 根据当前模式解算工作点 ---------- */
function computeOp() {
    const P = readParams();
    const mode = $('mode').value;
    let s;
    if (mode === 'rotor') {
        // 转子频率控制：给定 f_r，s = f_r / f_s
        const fr = num('fr-input');
        s = P.fs > 1e-6 ? fr / P.fs : 0;
    } else { // torque
        const Tt = num('T-input');
        s = solveSlipFromTorque(P, Tt);
        if (s === null) s = 0.03;
    }
    if (!isFinite(s) || isNaN(s)) s = 0.001;
    // 限制范围
    s = Math.max(-2, Math.min(2, s));
    return { P, mode, s, op: solveFromSlip(P, s) };
}

/* ---------- 派生参数显示 ---------- */
function updateDerived() {
    const P = readParams();
    const Ls = P.Lls + P.Lm, Lr = P.Llr + P.Lm;
    const sigma = 1 - (P.Lm * P.Lm) / (Ls * Lr);
    $('dLs').textContent = Ls.toFixed(3);
    $('dLr').textContent = Lr.toFixed(3);
    $('dSigma').textContent = sigma.toFixed(4);
    $('dWs').textContent = P.fs.toFixed(3);
}

/* ---------- 工作点数值卡片 ---------- */
function updateOpCards(op) {
    const set = (id, v) => $(id).textContent = v;
    set('vIs', op.Is.abs().toFixed(3));
    set('aIs', '∠' + (op.Is.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vIr', op.Ir.abs().toFixed(3));
    set('aIr', '∠' + (op.Ir.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vIm', op.Im.abs().toFixed(3));
    set('aIm', '∠' + (op.Im.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vPm', op.Psi_m.abs().toFixed(3));
    set('aPm', '∠' + (op.Psi_m.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vPs', op.Psi_s.abs().toFixed(3));
    set('aPs', '∠' + (op.Psi_s.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vPr', op.Psi_r.abs().toFixed(3));
    set('aPr', '∠' + (op.Psi_r.arg() * 180 / Math.PI).toFixed(1) + '°');
    set('vT', op.Tem.toFixed(3));
    set('vPF', Math.abs(op.pf).toFixed(3));
    set('aPF', op.pfSign >= 0 ? '电动' : '发电');
    set('vN', op.n.toFixed(4));
}

/* ============ 相量图 ============ */
const VECTOR_DEFS = [
    { key: 'Us',   label: 'U_s 定子电压',   color: '#e74c3c', visible: true, get: op => op.Us,    unit: 'U' },
    { key: 'Is',   label: 'I_s 定子电流',   color: '#3498db', visible: true, get: op => op.Is,    unit: 'I' },
    { key: 'Ir',   label: 'I_r 转子电流',   color: '#9b59b6', visible: true, get: op => op.Ir,    unit: 'I' },
    { key: 'Im',   label: 'I_m 励磁电流',   color: '#16a085', visible: false,get: op => op.Im,    unit: 'I' },
    { key: 'Ps',   label: 'ψ_s 定子磁链',   color: '#d35400', visible: true, get: op => op.Psi_s, unit: 'ψ' },
    { key: 'Pr',   label: 'ψ_r 转子磁链',   color: '#27ae60', visible: true, get: op => op.Psi_r, unit: 'ψ' },
    { key: 'Pm',   label: 'ψ_m 气隙磁链',   color: '#f39c12', visible: true, get: op => op.Psi_m, unit: 'ψ' },
];

function buildVectorToggles() {
    const c = $('vector-toggles');
    c.innerHTML = '';
    VECTOR_DEFS.forEach(v => {
        const lbl = document.createElement('label');
        lbl.innerHTML = `<input type="checkbox" data-vec="${v.key}" ${v.visible ? 'checked' : ''}>
                         <span class="color-dot" style="background:${v.color}"></span>${v.label}`;
        lbl.querySelector('input').addEventListener('change', e => {
            v.visible = e.target.checked;
            renderAll();
        });
        c.appendChild(lbl);
    });
}

function renderPhasor(op) {
    // 固定满量程比例尺：满量程 2.5 pu，所有相量按真实大小线性缩放，
    // 这样改变 Us/Ir 等参数时，能直观看到相量长度的变化（不会因自适应归一化而被掩盖）。
    const FULL_SCALE = 2.5;
    const scale = 0.95 / FULL_SCALE;

    const data = [];
    const annotations = [];

    VECTOR_DEFS.forEach(v => {
        if (!v.visible) return;
        const vec = v.get(op);
        const x2 = vec.re * scale, y2 = vec.im * scale;
        data.push({
            x: [0, x2], y: [0, y2],
            type: 'scatter', mode: 'lines+markers+text',
            line: { color: v.color, width: 3 },
            marker: { size: 8, color: v.color },
            text: ['', `${v.label.split(' ')[0]}`],
            textposition: 'top right',
            showlegend: true,
            name: `${v.label}  |${v.unit}|=${vec.abs().toFixed(3)}, ∠${(vec.arg()*180/Math.PI).toFixed(1)}°`,
            hoverinfo: 'name',
        });
        annotations.push({
            ax: 0, ay: 0,
            axref: 'x', ayref: 'y',
            x: x2, y: y2,
            xref: 'x', yref: 'y',
            showarrow: true, arrowhead: 3, arrowsize: 1.2, arrowwidth: 2, arrowcolor: v.color,
            standoff: 4,
        });
    });

    const layout = {
        margin: { l: 40, r: 20, t: 20, b: 40 },
        xaxis: { title: 'Re (实轴, U_s 方向)', range: [-1.3, 1.3], gridcolor: '#ddd',
                 zeroline: true, zerolinecolor: '#888', scaleanchor: 'y' },
        yaxis: { title: 'Im (虚轴, +j)', range: [-1.3, 1.3], gridcolor: '#ddd',
                 zeroline: true, zerolinecolor: '#888' },
        showlegend: true,
        legend: { x: 1.02, y: 1, font: { size: 10 } },
        annotations: annotations,
        height: 420,
        plot_bgcolor: '#fafafa',
    };
    Plotly.react('plot-phasor', data, layout, { displayModeBar: false, responsive: true });
}

/* ============ 等值电路 SVG ============ */
function renderCircuit(op) {
    const fmtZ = (z) => `${z.re.toFixed(3)} ${z.im >= 0 ? '+' : '−'} j${Math.abs(z.im).toFixed(3)}`;

    // SVG尺寸
    const W = 900, H = 240;
    const xy = { // 关键节点
        in:    [80, 120],
        nodeA: [320, 120],
        nodeB: [600, 120],
        gnd1:  [600, 200],
        gnd2:  [820, 200],
        right: [820, 120],
    };

    // 各支路电压电流文本
    const infoIs = `Ī_s = ${op.Is.abs().toFixed(3)}∠${(op.Is.arg()*180/Math.PI).toFixed(1)}°`;
    const infoIr = `Ī_r = ${op.Ir.abs().toFixed(3)}∠${(op.Ir.arg()*180/Math.PI).toFixed(1)}°`;
    const infoIm = `Ī_m = ${op.Im.abs().toFixed(3)}∠${(op.Im.arg()*180/Math.PI).toFixed(1)}°`;
    const infoUs = `Ũ_s = ${op.Us.abs().toFixed(3)}∠0°`;
    const infoUm = `Ũ_m = ${op.Um.abs().toFixed(3)}∠${(op.Um.arg()*180/Math.PI).toFixed(1)}°`;

    const svg = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', sans-serif;">
      <!-- 主线 -->
      <line x1="${xy.in[0]}" y1="${xy.in[1]}" x2="${xy.right[0]}" y2="${xy.right[1]}" stroke="#2c3e50" stroke-width="2.5"/>
      <!-- 电源 -->
      <circle cx="${xy.in[0]}" cy="${xy.in[1]}" r="22" fill="#fff" stroke="#e74c3c" stroke-width="2"/>
      <text x="${xy.in[0]}" y="${xy.in[1]+5}" text-anchor="middle" font-size="14" fill="#e74c3c" font-weight="bold">~</text>
      <text x="${xy.in[0]-30}" y="${xy.in[1]-30}" font-size="12" fill="#e74c3c">${infoUs}</text>

      <!-- R_s 标签 -->
      <rect x="${xy.in[0]+60}" y="${xy.in[1]-10}" width="50" height="20" fill="#fff" stroke="#34495e" stroke-width="1.5"/>
      <text x="${xy.in[0]+85}" y="${xy.in[1]-16}" text-anchor="middle" font-size="11" fill="#2c3e50">R_s=${op.Zs.re.toFixed(3)}</text>
      <!-- jX_ls -->
      <path d="M ${xy.in[0]+140} ${xy.in[1]-7}
               q 6 -10 12 0 q 6 10 12 0 q 6 -10 12 0 q 6 10 12 0
               q 6 -10 12 0 q 6 10 12 0 q 6 -10 12 0" stroke="#34495e" stroke-width="1.5" fill="none"/>
      <text x="${xy.in[0]+175}" y="${xy.in[1]-16}" text-anchor="middle" font-size="11" fill="#2c3e50">jX_ls=${op.Zs.im.toFixed(3)}</text>

      <!-- 节点 A (定子→励磁/转子) -->
      <circle cx="${xy.nodeA[0]}" cy="${xy.nodeA[1]}" r="4" fill="#2c3e50"/>

      <!-- Is 流向标签 -->
      <text x="${xy.in[0]+90}" y="${xy.in[1]+32}" font-size="11" fill="#3498db">${infoIs}</text>

      <!-- 励磁支路 (从 A 下垂到 gnd) -->
      <line x1="${xy.nodeA[0]}" y1="${xy.nodeA[1]}" x2="${xy.nodeA[0]}" y2="${xy.nodeA[1]+40}" stroke="#f39c12" stroke-width="2"/>
      <!-- 励磁电感 -->
      <path d="M ${xy.nodeA[0]-15} ${xy.nodeA[1]+40}
               q 15 -10 30 0 q -15 10 0 0 m 0 0 q 15 -10 30 0 q -15 10 0 0" stroke="#f39c12" stroke-width="1.8" fill="none"/>
      <rect x="${xy.nodeA[0]-25}" y="${xy.nodeA[1]+38}" width="50" height="24" fill="none" stroke="transparent"/>
      <text x="${xy.nodeA[0]}" y="${xy.nodeA[1]+75}" text-anchor="middle" font-size="11" fill="#f39c12">jX_m=${op.Zm.im.toFixed(3)}</text>
      <text x="${xy.nodeA[0]+80}" y="${xy.nodeA[1]+55}" font-size="11" fill="#16a085">${infoIm}</text>
      <line x1="${xy.nodeA[0]}" y1="${xy.nodeA[1]+62}" x2="${xy.nodeA[0]}" y2="${xy.nodeA[1]+80}" stroke="#f39c12" stroke-width="2"/>
      <!-- 接地符号 -->
      <line x1="${xy.nodeA[0]-10}" y1="${xy.nodeA[1]+80}" x2="${xy.nodeA[0]+10}" y2="${xy.nodeA[1]+80}" stroke="#2c3e50" stroke-width="2"/>
      <line x1="${xy.nodeA[0]-7}"  y1="${xy.nodeA[1]+84}" x2="${xy.nodeA[0]+7}"  y2="${xy.nodeA[1]+84}" stroke="#2c3e50" stroke-width="1.5"/>
      <line x1="${xy.nodeA[0]-4}"  y1="${xy.nodeA[1]+88}" x2="${xy.nodeA[0]+4}"  y2="${xy.nodeA[1]+88}" stroke="#2c3e50" stroke-width="1.5"/>

      <!-- 节点 A→B 转子支路 -->
      <!-- R_r/s -->
      <rect x="${xy.nodeA[0]+50}" y="${xy.nodeA[1]-10}" width="60" height="20" fill="#fff" stroke="#34495e" stroke-width="1.5"/>
      <text x="${xy.nodeA[0]+80}" y="${xy.nodeA[1]-16}" text-anchor="middle" font-size="11" fill="#2c3e50">R_r/s=${op.Zr.re.toFixed(3)}</text>
      <!-- jX_lr -->
      <path d="M ${xy.nodeA[0]+150} ${xy.nodeA[1]-7}
               q 6 -10 12 0 q 6 10 12 0 q 6 -10 12 0 q 6 10 12 0
               q 6 -10 12 0 q 6 10 12 0 q 6 -10 12 0" stroke="#34495e" stroke-width="1.5" fill="none"/>
      <text x="${xy.nodeA[0]+185}" y="${xy.nodeA[1]-16}" text-anchor="middle" font-size="11" fill="#2c3e50">jX_lr=${op.Zr.im.toFixed(3)}</text>
      <!-- Ir 流向 -->
      <text x="${xy.nodeA[0]+100}" y="${xy.nodeA[1]+32}" font-size="11" fill="#9b59b6">${infoIr}</text>

      <!-- 节点 B (输出) -->
      <circle cx="${xy.nodeB[0]}" cy="${xy.nodeB[1]}" r="4" fill="#2c3e50"/>

      <!-- 输出(机械负载) - 用方框表示等效机械负载电阻 R_r(1-s)/s -->
      <line x1="${xy.nodeB[0]}" y1="${xy.nodeB[1]}" x2="${xy.right[0]}" y2="${xy.right[1]}" stroke="#27ae60" stroke-width="2.5"/>
      <rect x="${xy.right[0]-15}" y="${xy.right[1]-30}" width="30" height="20" fill="#fff" stroke="#27ae60" stroke-width="1.5"/>
      <text x="${xy.right[0]}" y="${xy.right[1]-15}" text-anchor="middle" font-size="11" fill="#27ae60">P_m</text>

      <!-- Um 气隙电压标识 -->
      <text x="${xy.nodeA[0]+120}" y="${xy.nodeA[1]-50}" text-anchor="middle" font-size="11" fill="#c0392b" font-weight="bold">${infoUm}</text>
      <line x1="${xy.nodeA[0]}" y1="${xy.nodeA[1]-40}" x2="${xy.nodeA[0]}" y2="${xy.nodeA[1]-45}" stroke="#c0392b"/>
      <line x1="${xy.nodeA[0]+240}" y1="${xy.nodeA[1]-40}" x2="${xy.nodeA[0]+240}" y2="${xy.nodeA[1]-45}" stroke="#c0392b"/>
      <line x1="${xy.nodeA[0]}" y1="${xy.nodeA[1]-42}" x2="${xy.nodeA[0]+240}" y2="${xy.nodeA[1]-42}" stroke="#c0392b" stroke-dasharray="4,3"/>

      <!-- 工况 -->
      <text x="20" y="${H-10}" font-size="11" fill="#666">
        s = ${op.s.toFixed(4)} · ω_s = ${op.ws.toFixed(3)} pu · T_em = ${op.Tem.toFixed(3)} pu · n = ${op.n.toFixed(4)} pu · cosφ = ${Math.abs(op.pf).toFixed(3)}
      </text>
    </svg>`;
    $('circuit-container').innerHTML = svg;
}

/* ============ 特性曲线 ============ */
function genCurveData(P, mode, fixedS) {
    const sArr = [];
    for (let s = -1.0; s <= 1.0; s += 0.005) {
        if (Math.abs(s) < 1e-4) s = 1e-4 * Math.sign(s || 1);
        sArr.push(s);
    }
    const tArr = [], isArr = [], irArr = [], pmArr = [], psArr = [], prArr = [], pmFluxArr = [];
    const pfArr = [], nArr = [];
    sArr.forEach(s => {
        try {
            const op = solveFromSlip(P, s);
            tArr.push(op.Tem);
            isArr.push(op.Is.abs());
            irArr.push(op.Ir.abs());
            pmArr.push(op.Pm);
            psArr.push(op.Psi_s.abs());
            prArr.push(op.Psi_r.abs());
            pmFluxArr.push(op.Psi_m.abs());
            pfArr.push(Math.abs(op.pf));
            nArr.push(op.n);
        } catch (e) {
            tArr.push(NaN); isArr.push(NaN); irArr.push(NaN); pmArr.push(NaN);
            psArr.push(NaN); prArr.push(NaN); pmFluxArr.push(NaN); pfArr.push(NaN); nArr.push(NaN);
        }
    });
    return { sArr, tArr, isArr, irArr, pmArr, psArr, prArr, pmFluxArr, pfArr, nArr };
}

function renderTorqueCurve(P, op) {
    const c = genCurveData(P);
    // 同时画 T-n 曲线：以 n 为横坐标
    const data = [{
        x: c.nArr, y: c.tArr, mode: 'lines',
        line: { color: '#3498db', width: 2.5 },
        name: 'T_em(n)',
    }];
    // 标记当前工作点
    data.push({
        x: [op.n], y: [op.Tem], mode: 'markers',
        marker: { size: 14, color: '#e74c3c', symbol: 'star', line: { width: 2, color: '#fff' } },
        name: `工作点: n=${op.n.toFixed(3)}, T=${op.Tem.toFixed(3)}`,
    });
    // 同步转速竖线
    const layout = {
        margin: { l: 60, r: 30, t: 20, b: 50 },
        xaxis: { title: '转速 n (pu, 同步速 = 1.0)', gridcolor: '#eee', zerolinecolor: '#aaa' },
        yaxis: { title: '电磁转矩 T_em (pu)', gridcolor: '#eee', zerolinecolor: '#aaa' },
        showlegend: true, legend: { x: 0.02, y: 0.98 },
        height: 380,
        shapes: [{ type: 'line', x0: 1, x1: 1, y0: 0, y1: 1, yref: 'paper', line: { color: '#888', dash: 'dash' } }],
        annotations: [{ x: 1, y: 1, yref: 'paper', text: 'n_s 同步速', showarrow: false, xanchor: 'left', font: { size: 10, color: '#888' } }],
        plot_bgcolor: '#fafafa',
    };
    Plotly.react('plot-torque', data, layout, { displayModeBar: false, responsive: true });
}

function renderCurrentCurve(P, op) {
    const c = genCurveData(P);
    const data = [
        { x: c.sArr, y: c.isArr, mode: 'lines', name: '|I_s| 定子电流',
          line: { color: '#3498db', width: 2.5 }, yaxis: 'y' },
        { x: c.sArr, y: c.irArr, mode: 'lines', name: '|I_r| 转子电流',
          line: { color: '#9b59b6', width: 2, dash: 'dot' }, yaxis: 'y' },
        { x: c.sArr, y: c.pfArr, mode: 'lines', name: 'cosφ 功率因数',
          line: { color: '#e67e22', width: 2 }, yaxis: 'y2' },
    ];
    data.push({
        x: [op.s], y: [op.Is.abs()], mode: 'markers',
        marker: { size: 12, color: '#e74c3c', symbol: 'star' },
        name: '工作点', yaxis: 'y',
    });
    const layout = {
        margin: { l: 60, r: 60, t: 20, b: 50 },
        xaxis: { title: '转差率 s', gridcolor: '#eee', zerolinecolor: '#aaa' },
        yaxis: { title: '电流 (pu)', gridcolor: '#eee', zerolinecolor: '#aaa', range: [0, null] },
        yaxis2: { title: 'cosφ', overlaying: 'y', side: 'right', range: [0, 1.05], gridcolor: '#eee' },
        showlegend: true, legend: { x: 0.02, y: 0.98 },
        height: 380,
        shapes: [{ type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper', line: { color: '#888', dash: 'dash' } }],
        annotations: [{ x: 0, y: 1, yref: 'paper', text: 's=0 同步速', showarrow: false, xanchor: 'left', font: { size: 10, color: '#888' } }],
        plot_bgcolor: '#fafafa',
    };
    Plotly.react('plot-current', data, layout, { displayModeBar: false, responsive: true });
}

function renderFluxCurve(P, op) {
    const c = genCurveData(P);
    const data = [
        { x: c.sArr, y: c.psArr,    mode: 'lines', name: '|ψ_s|', line: { color: '#d35400', width: 2.5 } },
        { x: c.sArr, y: c.prArr,    mode: 'lines', name: '|ψ_r|', line: { color: '#27ae60', width: 2.5 } },
        { x: c.sArr, y: c.pmFluxArr,mode: 'lines', name: '|ψ_m|', line: { color: '#f39c12', width: 2.5, dash: 'dash' } },
    ];
    data.push({
        x: [op.s], y: [op.Psi_s.abs()], mode: 'markers',
        marker: { size: 12, color: '#e74c3c', symbol: 'star' }, name: '工作点',
    });
    const layout = {
        margin: { l: 60, r: 30, t: 20, b: 50 },
        xaxis: { title: '转差率 s', gridcolor: '#eee', zerolinecolor: '#aaa' },
        yaxis: { title: '磁链 (pu)', gridcolor: '#eee', zerolinecolor: '#aaa' },
        showlegend: true, legend: { x: 0.02, y: 0.98 },
        height: 380,
        plot_bgcolor: '#fafafa',
    };
    Plotly.react('plot-flux', data, layout, { displayModeBar: false, responsive: true });
}

function renderPowerFlow(op) {
    const html = `
        <div class="power-item"><div class="p-label">输入功率 P_in</div><div class="p-value">${op.Pin.toFixed(3)}</div></div>
        <div class="power-item"><div class="p-label">定子铜耗 p_Cus</div><div class="p-value">${op.Ps_cu.toFixed(3)}</div></div>
        <div class="power-item"><div class="p-label">气隙功率 P_e</div><div class="p-value">${op.Pe.toFixed(3)}</div></div>
        <div class="power-item loss"><div class="p-label">转子铜耗 p_Cur</div><div class="p-value">${op.Pr_cu.toFixed(3)}</div></div>
        <div class="power-item out"><div class="p-label">机械功率 P_m</div><div class="p-value">${op.Pm.toFixed(3)}</div></div>
        <div class="power-item out"><div class="p-label">效率 η</div><div class="p-value">${(op.eff*100).toFixed(1)}%</div></div>
        <div class="power-item"><div class="p-label">无功功率 Q</div><div class="p-value">${op.Q.toFixed(3)}</div></div>
    `;
    $('power-container').innerHTML = html;
}

/* ============ 总刷新 ============ */
function renderAll() {
    updateDerived();
    const { P, mode, s, op } = computeOp();

    // 同步电源滑条数值显示
    $('val-Us').textContent = P.Us.toFixed(2);
    $('val-fs').textContent = P.fs.toFixed(2);

    // 同步模式输入框（滑条↔数值）
    if (mode === 'rotor') {
        const fr = num('fr-input');
        $('val-fr').textContent = fr.toFixed(3);
        $('fr-slider').value = fr;
        $('dS').textContent = (P.fs > 1e-6 ? (fr / P.fs) : 0).toFixed(4);
    } else if (mode === 'torque') {
        // 求解得到 s，显示出来供参考
        const fr_solved = s * P.fs;
        $('dS').textContent = s.toFixed(4);
    }

    updateOpCards(op);
    renderPhasor(op);
    renderCircuit(op);
    renderTorqueCurve(P, op);
    renderCurrentCurve(P, op);
    renderFluxCurve(P, op);
    renderPowerFlow(op);
}

/* ============ 事件绑定 ============ */
function bindEvents() {
    // 电机参数 / 电源
    ['Rs','Rr','Lls','Llr','Lm','p','Us','fs'].forEach(id => {
        $(id).addEventListener('input', renderAll);
    });

    // 模式切换
    $('mode').addEventListener('change', e => {
        const m = e.target.value;
        ['mode-rotor','mode-torque'].forEach(id => $(id).style.display = 'none');
        $('mode-' + (m === 'rotor' ? 'rotor' : 'torque')).style.display = 'block';
        renderAll();
    });

    // 滑条 ↔ 数值 同步（支持自定义小数位）
    const syncPair = (sliderId, inputId, decimals = 4) => {
        const sl = $(sliderId), ip = $(inputId);
        sl.addEventListener('input', e => { ip.value = parseFloat(e.target.value).toFixed(decimals); renderAll(); });
        ip.addEventListener('input', e => { sl.value = parseFloat(e.target.value); renderAll(); });
    };
    // 电源 Us / fs
    syncPair('Us-slider', 'Us', 2);
    syncPair('fs-slider', 'fs', 2);
    // 转子频率 / 转矩
    syncPair('fr-slider', 'fr-input', 3);
    syncPair('T-slider', 'T-input', 3);

    // 图表显示/隐藏
    const chartMap = {
        'show-phasor': 'block-phasor',
        'show-circuit': 'block-circuit',
        'show-torque-curve': 'block-torque-curve',
        'show-current-curve': 'block-current-curve',
        'show-flux-curve': 'block-flux-curve',
        'show-power-flow': 'block-power-flow',
    };
    Object.entries(chartMap).forEach(([chk, blk]) => {
        $(chk).addEventListener('change', e => {
            $(blk).style.display = e.target.checked ? 'block' : 'none';
        });
        // 初始状态
        $(blk).style.display = $(chk).checked ? 'block' : 'none';
    });

    // 重置
    $('btn-reset').addEventListener('click', () => {
        const defaults = { Rs:0.04, Rr:0.04, Lls:0.10, Llr:0.10, Lm:2.00, p:2,
                           Us:1.0, fs:1.0, 'Us-slider':1.0, 'fs-slider':1.0,
                           'fr-slider':0.03, 'fr-input':0.03,
                           'T-slider':1.0, 'T-input':1.0 };
        Object.entries(defaults).forEach(([k,v]) => $(k).value = v);
        renderAll();
    });
}

/* ============ 启动 ============ */
function renderMath() {
    if (typeof renderMathInElement !== 'undefined') {
        renderMathInElement(document.body, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$',  right: '$',  display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true},
            ],
            throwOnError: false,
        });
    }
}

window.addEventListener('DOMContentLoaded', () => {
    buildVectorToggles();
    bindEvents();
    renderAll();
    renderMath();
});
