// network.js
// ニューロンの集団を 1 ステップずつ進めるエンジン。
// 画面にはいっさい触らない。ここが正しくないと上の段のレッスンが全部嘘になるので、
// test.mjs で解析解と突き合わせてある。

globalThis.NETWORK = (function () {

  // dt は 0.1 ms。膜時定数 20 ms・不応期 2.2 ms に対して十分細かい。
  var DEFAULT_DT = 0.1;
  var DEFAULT_TAU_RATE = 50;   // 発火率を見るときの平滑化の時定数 [ms]

  function create(opts) {
    opts = opts || {};
    var n = opts.n | 0;
    var dt = opts.dt || DEFAULT_DT;
    var tauSyn = opts.tauSyn || SYNAPSE.DEFAULTS.tauSyn;
    var maxDelay = opts.maxDelay || 20;                      // [ms]
    var dSteps = Math.max(1, Math.round(maxDelay / dt) + 1);

    // 遅延はリングバッファで実現する。スパイクした瞬間に「何ステップ先の相手に
    // どれだけ足すか」を置いておき、その時刻が来たら取り出すだけ。
    var queue = new Array(dSteps);
    for (var d = 0; d < dSteps; d++) queue[d] = new Float64Array(n);

    var net = {
      n: n,
      dt: dt,
      t: 0,
      steps: 0,
      p: NEURON.params(opts.params),
      tauSyn: tauSyn,
      tauRate: opts.tauRate || DEFAULT_TAU_RATE,

      v: new Float64Array(n),        // 膜電位 [mV]
      s: new Float64Array(n),        // シナプス電流 [nA]（受け取ったスパイクの名残）
      iExt: new Float64Array(n),     // 外から刺す電流 [nA]
      // 不応期がいつ明けるかを「絶対時刻」で持つ。残り時間から dt を引いていく書き方だと
      // 2.2 − 0.1×22 が浮動小数で 0 にならず、1 ステップぶん長い不応期になる。
      // また、明ける時刻がステップの途中でも、その端数から積分を再開できる。
      refUntil: new Float64Array(n),
      spiked: new Uint8Array(n),     // このステップで発火したか
      rate: new Float64Array(n),     // 平滑化した発火率 [Hz]

      // 入力役のニューロン。膜電位を持たず、forced を立てられたときだけ発火する。
      // 「外から来るスパイク列」を回路の中で同じように扱えるようにするため。
      isSource: new Uint8Array(n),
      forced: new Uint8Array(n),

      pre: [], post: [], w: [], dly: [],   // シナプス（w は途中で書き換えてよい）
      out: [],                             // out[i] = ニューロン i から出るシナプスの番号

      queue: queue,
      dSteps: dSteps,
      onSpike: null
    };

    for (var i = 0; i < n; i++) {
      net.v[i] = net.p.vRest;
      net.refUntil[i] = -Infinity;
      net.out.push([]);
    }
    return net;
  }

  // pre → post を重み w [nA]、遅延 delay [ms] でつなぐ。
  // 返り値はシナプス番号。あとから net.w[番号] を書き換えれば強さを変えられる
  // （リング回路の「回転入力で経路の強さが変わる」はこれでやる）。
  function connect(net, pre, post, w, delay) {
    var d = Math.round((delay === undefined ? SYNAPSE.DEFAULTS.delay : delay) / net.dt);
    if (d >= net.dSteps) throw new Error('遅延が maxDelay を超えている: ' + delay + ' ms');
    var id = net.pre.length;
    net.pre.push(pre); net.post.push(post); net.w.push(w); net.dly.push(d);
    net.out[pre].push(id);
    return id;
  }

  function reset(net) {
    for (var i = 0; i < net.n; i++) {
      net.v[i] = net.p.vRest;
      net.s[i] = 0; net.refUntil[i] = -Infinity; net.spiked[i] = 0;
      net.rate[i] = 0; net.forced[i] = 0;
    }
    for (var d = 0; d < net.dSteps; d++) net.queue[d].fill(0);
    net.t = 0; net.steps = 0;
  }

  function step(net) {
    var n = net.n, dt = net.dt, p = net.p;
    var slot = net.steps % net.dSteps;
    var inbox = net.queue[slot];

    // 1. いま届くぶんのスパイクを受け取る
    for (var i = 0; i < n; i++) { net.s[i] += inbox[i]; inbox[i] = 0; }

    // 2. 膜電位を進めて、閾値を超えたら発火
    for (i = 0; i < n; i++) {
      net.spiked[i] = 0;
      if (net.isSource[i]) {
        if (net.forced[i]) { net.spiked[i] = 1; net.forced[i] = 0; }
        continue;
      }
      var tEnd = net.t + dt;
      if (net.refUntil[i] >= tEnd) {
        // 不応期のあいだは何が来ても動かない。これが発火率の上限を作る。
        net.v[i] = p.vReset;
        continue;
      }

      // 不応期がこのステップの途中で明けるなら、明けた時刻から積分を再開する。
      var h = dt;
      if (net.refUntil[i] > net.t) { h = tEnd - net.refUntil[i]; net.v[i] = p.vReset; }

      var I = net.iExt[i] + net.s[i];
      var v0 = net.v[i];
      net.v[i] = NEURON.advance(v0, I, h, p);

      if (net.v[i] >= p.vTh) {
        // 閾値を跨いだ瞬間をステップの途中まで遡って求める。
        // 「ステップの終わりに発火した」で済ませると、発火間隔が刻み幅ぶん長くなり、
        // 速く発火しているときに発火率が数 % ずれる。
        var vInf = NEURON.steadyState(I, p);
        var tCross = p.tauM * Math.log((v0 - vInf) / (p.vTh - vInf));
        if (!(tCross >= 0 && tCross <= h)) tCross = h;     // 数値のはずみで外れたとき
        net.v[i] = p.vReset;
        net.refUntil[i] = tEnd - h + tCross + p.tRef;
        net.spiked[i] = 1;
      }
    }

    // 3. 発火したニューロンから、遅延ぶん先の箱へ配る
    for (i = 0; i < n; i++) {
      if (!net.spiked[i]) continue;
      var outs = net.out[i];
      for (var k = 0; k < outs.length; k++) {
        var sid = outs[k];
        var target = (net.steps + net.dly[sid]) % net.dSteps;
        net.queue[target][net.post[sid]] += net.w[sid];
      }
      if (net.onSpike) net.onSpike(i, net.t);
    }

    // 4. シナプス電流の減衰と、発火率の平滑化
    var ds = SYNAPSE.decay(dt, net.tauSyn);
    var dr = Math.exp(-dt / net.tauRate), bump = 1000 / net.tauRate;
    for (i = 0; i < n; i++) {
      net.s[i] *= ds;
      net.rate[i] = net.rate[i] * dr + (net.spiked[i] ? bump : 0);
    }

    net.steps++;
    net.t += dt;
  }

  // ms ミリ秒ぶん走らせる。cb はステップごと（刺激を時間変化させたいとき用）。
  function run(net, ms, cb) {
    var k = Math.round(ms / net.dt);
    for (var i = 0; i < k; i++) {
      if (cb) cb(net, i);
      step(net);
    }
  }

  // ある区間の発火数を数える。発火率の実測に使う。
  function countSpikes(net, ms, ids, cb) {
    var k = Math.round(ms / net.dt);
    var counts = {};
    for (var j = 0; j < ids.length; j++) counts[ids[j]] = 0;
    for (var i = 0; i < k; i++) {
      if (cb) cb(net, i);
      step(net);
      for (j = 0; j < ids.length; j++) if (net.spiked[ids[j]]) counts[ids[j]]++;
    }
    return counts;
  }

  // 発火率 [Hz] の実測。窓のなかの発火数を数えるより、最初と最後の発火の間隔から
  // 求めるほうが正確（窓の端に half-spike が入るかどうかに振り回されない）。
  function measureRate(net, ms, id, cb) {
    var k = Math.round(ms / net.dt), first = -1, last = -1, count = 0;
    for (var i = 0; i < k; i++) {
      if (cb) cb(net, i);
      step(net);
      if (net.spiked[id]) { if (first < 0) first = net.t; last = net.t; count++; }
    }
    if (count < 2) return 0;
    return 1000 * (count - 1) / (last - first);
  }

  return {
    DEFAULT_DT: DEFAULT_DT,
    create: create,
    connect: connect,
    reset: reset,
    step: step,
    run: run,
    countSpikes: countSpikes,
    measureRate: measureRate
  };
})();
