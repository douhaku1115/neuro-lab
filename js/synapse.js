// synapse.js
// ニューロンとニューロンのつなぎ目。
// スパイクが届くと、受け手に電流をひと突き入れて、あとは指数関数で消えていく。
// 「どの相手に、どれだけの強さで、どれだけ遅れて」を決めるのがシナプス。

globalThis.SYNAPSE = (function () {

  var DEFAULTS = {
    tauSyn: 5,      // シナプス電流の時定数 [ms]。膜時定数 20 ms より速い
    delay:  1.0     // 伝達遅延 [ms]。軸索を信号が伝わる時間
  };

  // 1 ステップぶんの減衰率。毎ステップこれを掛けるだけで指数関数になる。
  function decay(dt, tauSyn) { return Math.exp(-dt / tauSyn); }

  // 円環上の符号つき最短距離。i から見て j がどちら回りに何個ぶん離れているか。
  // リング回路で「隣」を決めるのに使う。n=16 のとき 15 と 1 の距離は 14 ではなく −2。
  function ringDistance(i, j, n) {
    var d = ((i - j) % n + n) % n;
    return d > n / 2 ? d - n : d;
  }

  // 距離に応じた結合の強さ。近いほど強く、遠いほど 0 に近づく。
  function gaussian(d, sigma) { return Math.exp(-(d * d) / (2 * sigma * sigma)); }

  // 重み w [nA] のシナプスが 1 発で起こす膜電位の山（EPSP）の高さ [mV]。
  // 閾値下で線形に振る舞う範囲での解析解:
  //   ΔV(t) = R·w·τs/(τm−τs)·( e^(−t/τm) − e^(−t/τs) )
  // 「このシナプス 1 本では閾値に届かない」を数字で示すのに使う。
  function epspPeak(w, p, tauSyn) {
    var R = NEURON.resistance(p), tm = p.tauM, ts = tauSyn;
    if (Math.abs(tm - ts) < 1e-9) return R * w / Math.E;   // τ が一致する場合の極限
    var tPeak = (tm * ts / (tm - ts)) * Math.log(tm / ts);
    return R * w * (ts / (tm - ts)) * (Math.exp(-tPeak / tm) - Math.exp(-tPeak / ts));
  }

  // 逆に、欲しい EPSP の高さ [mV] から重み [nA] を求める。
  // 回路を組むとき「1 本あたり 0.3 mV」のように生理学の言葉で指定できる。
  function weightForEpsp(mv, p, tauSyn) {
    return mv / epspPeak(1, p, tauSyn);
  }

  // 発火率 f [Hz] で届き続けるスパイクが作る、平均のシナプス電流 [nA]。
  // 1 発ごとに w を足して τs で減衰するので、時間平均は w·τs·f/1000。
  // 回路の重みを見積もるときの目安になる（レオベース 0.077 nA と比べる）。
  function meanCurrent(w, f, tauSyn) { return w * tauSyn * f / 1000; }

  return {
    DEFAULTS: DEFAULTS,
    decay: decay,
    ringDistance: ringDistance,
    gaussian: gaussian,
    epspPeak: epspPeak,
    weightForEpsp: weightForEpsp,
    meanCurrent: meanCurrent
  };
})();
