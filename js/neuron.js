// neuron.js
// 漏れ積分発火（LIF）ニューロン 1 個ぶんの決まりごと。
// ここには「膜電位が入力電流でどう動くか」しか書かない。
// つなぎ方は synapse.js、たくさん同時に動かすのは network.js の仕事。

globalThis.NEURON = (function () {

  // 既定のパラメータ。Shiu et al. (2024) の全脳モデルが使う値に合わせてある。
  // 段6 の全脳モデル（Python 側）に同じ数字が出てくるので、ここで見慣れておくと繋がる。
  var DEFAULTS = {
    vRest:  -52,    // 静止膜電位 [mV]
    vTh:    -45,    // 閾値 [mV]。静止から 7 mV だけ上
    vReset: -52,    // 発火した直後に戻る電位 [mV]
    tauM:    20,    // 膜時定数 [ms]。入力に対する反応の鈍さ
    tRef:   2.2,    // 不応期 [ms]。発火直後は何を入れても動かない
    cM:     220     // 膜容量 [pF]
  };

  function params(over) {
    var p = {};
    for (var k in DEFAULTS) p[k] = DEFAULTS[k];
    if (over) for (var k2 in over) if (over[k2] !== undefined) p[k2] = over[k2];
    return p;
  }

  // 膜抵抗 [MΩ]。τ = R·C から決まる。
  // 単位は ms / pF を MΩ に直して 1000 倍。こうしておくと電流を nA で扱ったとき
  // R·I がそのまま mV になり、電位の式に余計な換算が出てこない。
  function resistance(p) { return 1000 * p.tauM / p.cM; }

  // 電流 I [nA] を入れ続けたとき、最後に落ち着く膜電位 [mV]
  function steadyState(I, p) { return p.vRest + resistance(p) * I; }

  // 発火に必要な最小の電流（レオベース）[nA]。
  // これより弱い入力は、どれだけ長く入れても漏れに負けて閾値に届かない。
  function rheobase(p) { return (p.vTh - p.vRest) / resistance(p); }

  // 一定電流 I [nA] を流し続けたときの発火率 [Hz]（解析解）。
  // 閾値まで登る時間 τ·ln((V∞−V_reset)/(V∞−V_th)) に不応期を足したものが発火間隔。
  function rateFor(I, p) {
    var vInf = steadyState(I, p);
    if (vInf <= p.vTh) return 0;              // 閾値に届かない＝いつまでも発火しない
    var isi = p.tRef + p.tauM * Math.log((vInf - p.vReset) / (vInf - p.vTh));
    return 1000 / isi;
  }

  // 不応期だけで決まる発火率の上限 [Hz]。どんなに電流を上げてもこれは超えられない。
  function maxRate(p) { return 1000 / p.tRef; }

  // dt [ms] だけ時間を進めた膜電位。
  // dt のあいだ I が一定なら、これは近似ではなく厳密解。前進オイラーでも書けるが、
  // それだと刻み幅を変えるたびに答えがずれる（教材で「刻みのせい」を説明したくない）。
  function advance(v, I, dt, p) {
    var vInf = steadyState(I, p);
    return vInf + (v - vInf) * Math.exp(-dt / p.tauM);
  }

  return {
    DEFAULTS: DEFAULTS,
    params: params,
    resistance: resistance,
    steadyState: steadyState,
    rheobase: rheobase,
    rateFor: rateFor,
    maxRate: maxRate,
    advance: advance
  };
})();
