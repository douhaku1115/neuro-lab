// circuits.js
// レッスンで使う回路の組み立て。ここも画面には触らない。
//
//   段1 summation  たくさんの入力を 1 個のニューロンが足し合わせる
//   段2 lateral    隣どうしが抑制しあう
//   段3/4 ring     円環に繋ぐと「向きの記憶」が生まれる（ハエの中枢複合体）
//
// どの回路も NETWORK のうえに乗っているだけで、特別な仕掛けは無い。
// 繋ぎ方を変えただけで振る舞いが変わる、というのがこのレッスンの主題。

globalThis.CIRCUITS = (function () {

  // 再現できる乱数。テストで毎回同じ答えが出るようにするため、Math.random は使わない。
  function rng(seed) {
    var a = (seed | 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 入力役のニューロンを発火させ続ける「ドライバ」。run の毎ステップ呼ぶ。
  //   poisson … バラバラに来る（本物の神経に近い）
  //   sync    … 全部そろって同時に来る（空間的加重を見せるとき）
  //   async   … 一定間隔で、互いに位相をずらして来る
  function driver(ids, rateHz, mode, seed) {
    var rand = rng(seed || 12345);
    var phase = [];
    for (var i = 0; i < ids.length; i++) phase.push(mode === 'sync' ? 0 : i / ids.length);
    return function (net) {
      if (rateHz <= 0) return;
      if (mode === 'poisson') {
        var p = rateHz * net.dt / 1000;
        for (var k = 0; k < ids.length; k++) if (rand() < p) net.forced[ids[k]] = 1;
        return;
      }
      var period = 1000 / rateHz;                       // [ms]
      for (k = 0; k < ids.length; k++) {
        var prev = Math.floor((net.t - net.dt) / period + phase[k]);
        var now  = Math.floor(net.t / period + phase[k]);
        if (now > prev) net.forced[ids[k]] = 1;
      }
    };
  }

  // ─────────────────────────────────────────── 段1: 多入力の加重
  // 入力 nIn 個 → 出力 1 個。本数（空間的加重）と発火率（時間的加重）の
  // どちらを上げても出力の発火率が上がる、という同じ結論に二通りで辿り着ける。
  function summation(opts) {
    opts = opts || {};
    var nIn = opts.nIn || 8;
    var net = NETWORK.create({ n: nIn + 1, dt: opts.dt });
    var out = nIn, ins = [], syn = [];

    for (var i = 0; i < nIn; i++) { net.isSource[i] = 1; ins.push(i); }
    var w = SYNAPSE.weightForEpsp(opts.epsp === undefined ? 1.0 : opts.epsp, net.p, net.tauSyn);
    for (i = 0; i < nIn; i++) syn.push(NETWORK.connect(net, i, out, w, 1.0));

    return {
      net: net, out: out, inputs: ins, syn: syn,
      // 1 本あたりの EPSP の高さ [mV] を変える
      setEpsp: function (mv) {
        var ww = SYNAPSE.weightForEpsp(mv, net.p, net.tauSyn);
        for (var k = 0; k < syn.length; k++) net.w[syn[k]] = ww;
      },
      // 先頭 k 本だけを使う（残りは重み 0 にして繋がっていないことにする）
      setActive: function (k, mv) {
        var ww = SYNAPSE.weightForEpsp(mv === undefined ? 1.0 : mv, net.p, net.tauSyn);
        for (var j = 0; j < syn.length; j++) net.w[syn[j]] = j < k ? ww : 0;
      },
      driver: function (rateHz, mode, seed) {
        return driver(ins, rateHz, mode || 'poisson', seed);
      }
    };
  }

  // ─────────────────────────────────────────── 段2: 側方抑制
  // 縦に並んだ m 本の「列」。各列は興奮性 E と抑制性 I の 2 個組。
  // E は自分の I を動かし、I は「隣の列の E」を黙らせる（自分自身は抑えない）。
  // 抑制を別のニューロンにやらせているのは、本物の脳がそうなっているから。
  var LATERAL_DEFAULTS = {
    m: 9,
    wEI: 0.45,      // E → 自分の I [nA]。I が E に確実についていく強さ
    wIE: -0.11,     // 1 本の E が受ける抑制の「合計」[nA]（負＝抑制）
    sigma: 1.3,     // 抑制が届く広さ（列いくつぶんか）
    delay: 1.0
  };

  function lateral(opts) {
    var o = {}; for (var k in LATERAL_DEFAULTS) o[k] = LATERAL_DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];

    var m = o.m;
    var net = NETWORK.create({ n: 2 * m, dt: o.dt });
    var E = [], I = [];
    for (var i = 0; i < m; i++) { E.push(i); I.push(m + i); }

    // 列ごとに「受け取る抑制の合計」をそろえる。そろえないと、隣が片側にしか
    // 無い両端の列だけ抑制が半分になり、端が明るく見えるだけの図になってしまう。
    // 見たいのは端の事情ではなく、隣の強さの違いが作る差なので、そこを揃える。
    var shape = [], sum = [];
    for (i = 0; i < m; i++) {
      var s = 0, row = [];
      for (var j = 0; j < m; j++) {
        var g = i === j ? 0 : SYNAPSE.gaussian(Math.abs(i - j), o.sigma);  // 自分は抑えない
        row.push(g); s += g;
      }
      shape.push(row); sum.push(s);
    }

    var inhSyn = [];   // inhSyn[j][i] = I_i → E_j のシナプス番号
    for (j = 0; j < m; j++) {
      var col = {};
      for (i = 0; i < m; i++) {
        if (shape[j][i] < 0.02) continue;
        col[i] = NETWORK.connect(net, I[i], E[j], o.wIE * shape[j][i] / sum[j], o.delay);
      }
      inhSyn.push(col);
    }
    for (i = 0; i < m; i++) NETWORK.connect(net, E[i], I[i], o.wEI, o.delay);

    return {
      net: net, E: E, I: I, m: m, opts: o,
      // 列ごとの入力電流 [nA] を差し込む
      setInput: function (arr) { for (var t = 0; t < m; t++) net.iExt[E[t]] = arr[t]; },
      // 抑制の強さをまとめて変える（0 にすると入力がそのまま出る）
      setInhibition: function (scale) {
        for (var b = 0; b < m; b++) for (var a in inhSyn[b])
          net.w[inhSyn[b][a]] = o.wIE * shape[b][a] / sum[b] * scale;
      },
      rates: function () { var r = []; for (var t = 0; t < m; t++) r.push(net.rate[E[t]]); return r; }
    };
  }

  // ─────────────────────────────────────────── 段3/4: リングアトラクタ
  // ハエの楕円体（ellipsoid body）は 16 の扇形に分かれていて、そこに EPG という
  // ニューロンが並ぶ。EPG の活動の山（バンプ）が 1 か所だけ立ち、それがハエの
  // 「いま自分はどっちを向いているか」を表す。ここではその配線をそのまま作る。
  //
  //   EPG  ×16  円環そのもの。近いものどうしで励起しあう
  //   Δ7   ×8   全体を見て全体を抑える。山が 2 つ以上立たないようにする役
  //   PEN  ×16×2  「右に回った / 左に回った」を受け取り、EPG の 1 つ隣へ返す。
  //               これでバンプが回り、角速度が積分されて向きになる
  var RING_DEFAULTS = {
    n: 16, nD7: 8,
    sigmaE: 2.2,        // EPG どうしの励起が届く広さ（扇形いくつぶん）
    // EPG 全体にいつも流れている背景電流 [nA]。これ単独なら全員が発火してしまう
    // 強さにしておき、Δ7 の抑制で普段は黙らせる。山のところだけ、近所からの
    // 励起が抑制を上回って顔を出す。「押さえつけたうえで一か所だけ緩める」構成に
    // すると、飽和しない低い発火率のまま山が立ち、消しても残る。
    tonic: 0.150,
    // 重みは「1 個のニューロンが受け取る合計」で指定する。何本に分かれているかを
    // 変えても効き目が変わらないので、扇形の数や Δ7 の数を後から動かしやすい。
    wEE: 0.240,         // EPG → EPG のピーク重み [nA]（これだけは 1 本あたり）
    wED: 4.0,           // 全 EPG → Δ7 1 個ぶんの合計 [nA]
    wDE: -0.50,         // 全 Δ7 → EPG 1 個ぶんの合計 [nA]（負＝抑制）
    wEP: 0.17,          // EPG → PEN [nA]
    wPE: 0.12,          // PEN → EPG（1 つ隣へ）[nA]
    sigmaP: 1.2,        // PEN が返す先の広さ
    rotDrive: 0.055,    // 回転入力の最大電流 [nA]。単独では発火させない強さにする
    cueStrength: 0.07,  // 目印（ランドマーク）の電流 [nA]
    sigmaCue: 1.4,
    delay: 1.0
  };

  function ring(opts) {
    var o = {}; for (var k in RING_DEFAULTS) o[k] = RING_DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];

    var n = o.n, nD = o.nD7;
    var net = NETWORK.create({ n: n + nD + 2 * n, dt: o.dt });
    var EPG = [], D7 = [], PENR = [], PENL = [];
    var base = 0;
    for (var i = 0; i < n; i++) EPG.push(base + i); base += n;
    for (i = 0; i < nD; i++) D7.push(base + i); base += nD;
    for (i = 0; i < n; i++) PENR.push(base + i); base += n;
    for (i = 0; i < n; i++) PENL.push(base + i);

    // EPG → EPG（近いものどうしの励起）
    var excSyn = [], excW = [];
    for (i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      var d = SYNAPSE.ringDistance(i, j, n);
      var g = SYNAPSE.gaussian(d, o.sigmaE);
      if (g < 0.02) continue;
      excW.push(o.wEE * g);
      excSyn.push(NETWORK.connect(net, j, EPG[i], o.wEE * g, o.delay));
    }
    // EPG → Δ7 → EPG（全体をならす抑制）。Δ7 は円環のどこが光っていようと
    // 同じだけ受け取り、同じだけ返す。だから「合計の活動」だけを見ていることになる。
    for (i = 0; i < n; i++) for (var k3 = 0; k3 < nD; k3++)
      NETWORK.connect(net, EPG[i], D7[k3], o.wED / n, o.delay);
    var inhSyn = [];
    for (k3 = 0; k3 < nD; k3++) for (i = 0; i < n; i++)
      inhSyn.push(NETWORK.connect(net, D7[k3], EPG[i], o.wDE / nD, o.delay));

    // EPG → PEN（どこにバンプがあるかを伝える）
    for (i = 0; i < n; i++) {
      NETWORK.connect(net, EPG[i], PENR[i], o.wEP, o.delay);
      NETWORK.connect(net, EPG[i], PENL[i], o.wEP, o.delay);
    }
    // PEN → EPG（1 つ隣へ返す。ここがバンプを回す力）
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) {
      var gR = SYNAPSE.gaussian(SYNAPSE.ringDistance(j, i + 1, n), o.sigmaP);
      if (gR >= 0.02) NETWORK.connect(net, PENR[i], EPG[j], o.wPE * gR, o.delay);
      var gL = SYNAPSE.gaussian(SYNAPSE.ringDistance(j, i - 1, n), o.sigmaP);
      if (gL >= 0.02) NETWORK.connect(net, PENL[i], EPG[j], o.wPE * gL, o.delay);
    }

    var cue = { on: false, sector: 0 };

    function applyCue() {
      for (var t = 0; t < n; t++) {
        var g = cue.on ? SYNAPSE.gaussian(SYNAPSE.ringDistance(t, cue.sector, n), o.sigmaCue) : 0;
        net.iExt[EPG[t]] = o.tonic + o.cueStrength * g;
      }
    }
    applyCue();   // 目印が無くても背景電流は流れている

    return {
      net: net, EPG: EPG, D7: D7, PENR: PENR, PENL: PENL, n: n, opts: o,

      // 目印を見せる／隠す。sector は 0〜n−1（円環上の位置）。小数でもよい。
      setCue: function (on, sector) {
        cue.on = !!on;
        if (sector !== undefined) cue.sector = sector;
        applyCue();
      },
      // Δ7 の抑制の強さ。0 にすると山が立たず、円環じゅうが光ってしまう。
      setInhibition: function (scale) {
        for (var q = 0; q < inhSyn.length; q++) net.w[inhSyn[q]] = o.wDE / nD * scale;
      },
      // EPG どうしの励起の強さ。0 にすると、目印がある間しか山が立たない
      // ＝ 覚えていられない。
      setExcitation: function (scale) {
        for (var q = 0; q < excSyn.length; q++) net.w[excSyn[q]] = excW[q] * scale;
      },
      // 回転。正で右回り、負で左回り。level は 0〜1。
      setRotation: function (level) {
        var r = Math.max(0, level) * o.rotDrive, l = Math.max(0, -level) * o.rotDrive;
        for (var t = 0; t < n; t++) { net.iExt[PENR[t]] = r; net.iExt[PENL[t]] = l; }
      },
      rates: function () { var r = []; for (var t = 0; t < n; t++) r.push(net.rate[EPG[t]]); return r; },
      bump: function () { return bumpVector(net.rate, EPG); }
    };
  }

  // ─────────────────────────── 段5: 本物の配線（FlyWire コネクトーム）
  // 段3 で自分で組んだ円環と同じエンジンに、実測の配線をそのまま流し込む。
  // 決めるのは 2 つだけ ──「シナプス 1 個をどれだけの重みにするか」と
  // 「この部分回路の外から来ている入力をどれだけの電流で補うか」。
  // 残りは全部コネクトームに書いてあるとおり。
  // 背景電流は型ごとに持つ。この部分回路の外から来ている入力の代わりで、
  // 与えないとその型は一度も発火せず、回路から消えたのと同じになる。
  // とくに Δ7 を黙らせると、山が広がるのを止める者がいなくなる。
  var CONNECTOME_DEFAULTS = {
    unit: 0.0016,       // シナプス 1 個あたりの重み [nA]
    tonicEPG: 0.120,    // EPG [nA]
    tonicER: 0.140,     // ER・ExR [nA]（景色からの入力の代わり）
    tonicD7: 0.090,     // Δ7 [nA]。閾値のすぐ下に置き、EPG の活動で押し上げる
    tonicPEG: 0.000,    // PEG [nA]
    penBias: 0.000,     // PEN [nA]。回転入力はここに足される
    rotDrive: 0.026,    // 回転入力の最大電流 [nA]
    cueStrength: 0.150, // 目印の電流 [nA]
    sigmaCue: 0.075,    // 目印の広さ（円環一周を 1 とした長さ）
    delay: 1.0
  };

  // ハエでの符号。アセチルコリンが興奮性、GABA とグルタミン酸が抑制性。
  // グルタミン酸が抑制性なのは、受け手の GluCl が塩化物イオンを通すため
  // （脊椎動物とは逆になる。ここを間違えると配線の符号がごっそりずれる）。
  var NT_SIGN = { ACH: 1, GABA: -1, GLUT: -1 };

  function connectome(data, opts) {
    var o = {}; for (var k in CONNECTOME_DEFAULTS) o[k] = CONNECTOME_DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];

    var nz = data.neurons, N = nz.length;
    var net = NETWORK.create({ n: N, maxDelay: 5 });

    // 型ごとの一覧と、円環上の位置
    var group = {}, pos = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var t = data.types[nz[i][0]];
      (group[t] = group[t] || []).push(i);
      pos[i] = nz[i][3];
    }

    // 符号。伝達物質が付いていないニューロンは、同じ型の多数決で補う。
    var sign = new Int8Array(N), byType = {};
    for (i = 0; i < N; i++) {
      var s = NT_SIGN[nz[i][2]];
      sign[i] = s === undefined ? 0 : s;
      if (sign[i]) {
        var tt = nz[i][0];
        byType[tt] = byType[tt] || { p: 0, n: 0 };
        if (sign[i] > 0) byType[tt].p++; else byType[tt].n++;
      }
    }
    for (i = 0; i < N; i++) if (!sign[i]) {
      var b = byType[nz[i][0]];
      sign[i] = b && b.n > b.p ? -1 : 1;
    }

    var syn = [], synW = [];
    for (var e = 0; e < data.edges.length; e++) {
      var ed = data.edges[e];
      synW.push(sign[ed[0]] * o.unit * ed[2]);
      syn.push(NETWORK.connect(net, ed[0], ed[1], synW[e], o.delay));
    }

    var EPG = group.EPG, RING = (group.ER || []).concat(group.ExR || []);
    var PEN_L = [], PEN_R = [];
    var pens = (group.PEN_a || []).concat(group.PEN_b || []);
    for (i = 0; i < pens.length; i++) (nz[pens[i]][1] === 0 ? PEN_L : PEN_R).push(pens[i]);

    var st = { cue: false, cuePos: 0, rot: 0 };

    function drive() {
      for (var j = 0; j < EPG.length; j++) {
        var x = o.tonicEPG;
        if (st.cue) {
          var d = pos[EPG[j]] - st.cuePos; d -= Math.round(d);
          x += o.cueStrength * Math.exp(-(d * d) / (2 * o.sigmaCue * o.sigmaCue));
        }
        net.iExt[EPG[j]] = x;
      }
      for (j = 0; j < RING.length; j++) net.iExt[RING[j]] = o.tonicER;
      var D7 = group.Delta7 || [], PG = group.PEG || [];
      for (j = 0; j < D7.length; j++) net.iExt[D7[j]] = o.tonicD7;
      for (j = 0; j < PG.length; j++) net.iExt[PG[j]] = o.tonicPEG;
      // 左右の PEN は、コネクトーム上で逆向きに 1 扇形ずれている。
      // だから右回りのときは片側だけ、左回りのときはもう片側だけを働かせればよい。
      var r = Math.max(0, st.rot) * o.rotDrive, l = Math.max(0, -st.rot) * o.rotDrive;
      for (j = 0; j < PEN_L.length; j++) net.iExt[PEN_L[j]] = o.penBias + r;
      for (j = 0; j < PEN_R.length; j++) net.iExt[PEN_R[j]] = o.penBias + l;
    }
    drive();

    return {
      net: net, data: data, opts: o, group: group, pos: pos, sign: sign,
      EPG: EPG, RING: RING, PEN_L: PEN_L, PEN_R: PEN_R,
      setCue: function (on, p) { st.cue = !!on; if (p !== undefined) st.cuePos = ((p % 1) + 1) % 1; drive(); },
      setRotation: function (level) { st.rot = Math.max(-1, Math.min(1, level)); drive(); },
      // 抑制だけ強さを変える（切ると何が起きるかを見せるため）
      setInhibition: function (scale) {
        for (var q = 0; q < syn.length; q++)
          net.w[syn[q]] = synW[q] < 0 ? synW[q] * scale : synW[q];
      },
      rates: function () { var r = []; for (var j = 0; j < EPG.length; j++) r.push(net.rate[EPG[j]]); return r; },
      ratesOf: function (t) {
        var g = group[t] || [], r = [];
        for (var j = 0; j < g.length; j++) r.push(net.rate[g[j]]);
        return r;
      },
      bump: function () { return ringVector(net.rate, EPG, pos); }
    };
  }

  // 円環上のばらばらな位置にいるニューロンから山の位置を読む。
  // 段3 は等間隔の扇形だったが、こちらは実測なので間隔がそろっていない。
  function ringVector(rate, ids, pos) {
    var sx = 0, sy = 0, tot = 0, peak = 0;
    for (var i = 0; i < ids.length; i++) {
      var r = rate[ids[i]], a = pos[ids[i]] * 2 * Math.PI;
      sx += r * Math.cos(a); sy += r * Math.sin(a); tot += r;
      if (r > peak) peak = r;
    }
    var turn = ((Math.atan2(sy, sx) / (2 * Math.PI)) % 1 + 1) % 1;
    var width = 0;
    for (i = 0; i < ids.length; i++) if (rate[ids[i]] > peak / 2) width++;
    return {
      turn: turn, angle: turn * 360,
      strength: tot > 1e-9 ? Math.hypot(sx, sy) / tot : 0,
      peak: peak, mean: tot / ids.length, width: peak > 1 ? width : 0
    };
  }

  // 円環上の 2 点の差（一周を 1 とした長さ）。折り返しをまたいでも正しい。
  function turnDiff(a, b) { var d = a - b; return d - Math.round(d); }

  // 「EPG から、ある型を経由して、EPG へ」がどれだけずれた相手に効いているかを測る。
  // via を省くと EPG どうしの直接の繋がり。side を与えると片方の脳半球だけ。
  // 自作モデルでは山の形を自分で決めたが、こちらは配線から出てくる。
  function pathProfile(cx, via, side) {
    var data = cx.data, nz = data.neurons, N = nz.length;
    var W = [];
    for (var i = 0; i < N; i++) W.push(null);
    var edges = data.edges;

    // 必要な行だけ疎に持つ（455×455 を毎回作らない）
    function row(i) {
      if (!W[i]) W[i] = new Float64Array(N);
      return W[i];
    }
    for (var e = 0; e < edges.length; e++) row(edges[e][0])[edges[e][1]] += edges[e][2];

    var EPG = cx.EPG.slice().sort(function (a, b) { return cx.pos[a] - cx.pos[b]; });
    var m = EPG.length, prof = new Float64Array(m);

    var mid = null;
    if (via) {
      mid = (cx.group[via] || []).filter(function (j) {
        return side === undefined || nz[j][1] === (side === 'L' ? 0 : 1);
      });
    }

    for (var k = 0; k < m; k++) {
      var s = 0;
      for (var a = 0; a < m; a++) {
        var b = EPG[(a + k) % m];
        if (!mid) { s += W[EPG[a]] ? W[EPG[a]][b] : 0; }
        else {
          for (var q = 0; q < mid.length; q++) {
            var d = mid[q];
            var w1 = W[EPG[a]] ? W[EPG[a]][d] : 0;
            if (!w1) continue;
            s += w1 * (W[d] ? W[d][b] : 0);
          }
        }
      }
      prof[k] = s / m;
    }

    // ずれ 0 を真ん中にして並べ替え、山の位置を円環平均で出す
    var half = Math.floor(m / 2), centered = [];
    for (var t = -half; t <= half; t++) centered.push(prof[((t % m) + m) % m]);
    var sx = 0, sy = 0, tot = 0;
    for (k = 0; k < m; k++) {
      var ang = 2 * Math.PI * k / m;
      sx += prof[k] * Math.cos(ang); sy += prof[k] * Math.sin(ang); tot += prof[k];
    }
    return {
      values: centered,                       // 中央がずれ 0
      offsets: centered.map(function (_, j) { return (j - half) / m * 360; }),
      peakDeg: Math.atan2(sy, sx) / (2 * Math.PI) * 360,
      concentration: tot > 0 ? Math.hypot(sx, sy) / tot : 0,
      total: tot
    };
  }

  // ある型が EPG 1 個あたり何シナプス入れているか（興奮性か抑制性かも）
  function inputTally(cx) {
    var data = cx.data, nz = data.neurons;
    var isEPG = {}, out = {};
    for (var i = 0; i < cx.EPG.length; i++) isEPG[cx.EPG[i]] = 1;
    for (var e = 0; e < data.edges.length; e++) {
      var ed = data.edges[e];
      if (!isEPG[ed[1]]) continue;
      var t = data.types[nz[ed[0]][0]];
      out[t] = out[t] || { syn: 0, sign: cx.sign[ed[0]] };
      out[t].syn += ed[2];
    }
    var rows = [];
    for (var k in out) rows.push({ type: k, per: out[k].syn / cx.EPG.length, sign: out[k].sign });
    rows.sort(function (a, b) { return b.per - a.per; });
    return rows;
  }

  // 回転入力の目盛り。level を上げると山は速く回るが、比例はしない
  // （扇形が 16 個しかないので、山は格子に少し引っかかりながら進む）。
  // 実測した点を線形補間して「この速さで回したい」から level を逆引きする。
  var ROT_CAL = [[0, 0], [0.30, 1.2], [0.35, 2.6], [0.50, 4.3], [0.70, 5.8], [1.00, 8.6]];

  function rotationForSpeed(sectorsPerSec) {
    var v = Math.abs(sectorsPerSec), sign = sectorsPerSec < 0 ? -1 : 1;
    if (v <= 0) return 0;
    for (var i = 1; i < ROT_CAL.length; i++) {
      if (v <= ROT_CAL[i][1]) {
        var a = ROT_CAL[i - 1], b = ROT_CAL[i];
        return sign * (a[0] + (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]));
      }
    }
    return sign;
  }

  // 円環に並んだ発火率から「山の位置」を読み取る（population vector）。
  // 1 個ずつ見ても分からないが、全部を足し合わせると向きが 1 つ出てくる。
  // ハエ自身も、この山の位置を下流の回路で読んでいると考えられている。
  function bumpVector(rate, ids) {
    var n = ids.length, sx = 0, sy = 0, tot = 0, peak = 0;
    for (var i = 0; i < n; i++) {
      var r = rate[ids[i]], a = 2 * Math.PI * i / n;
      sx += r * Math.cos(a); sy += r * Math.sin(a); tot += r;
      if (r > peak) peak = r;
    }
    var len = Math.hypot(sx, sy);
    var sector = ((Math.atan2(sy, sx) / (2 * Math.PI) * n) % n + n) % n;
    // 山の幅は「ピークの半分より強く光っている扇形の数」で測る
    var width = 0;
    for (i = 0; i < n; i++) if (rate[ids[i]] > peak / 2) width++;
    return {
      sector: sector,                       // 0〜n の連続値
      angle: sector / n * 360,              // [度]
      strength: tot > 1e-9 ? len / tot : 0, // 1 に近いほど 1 か所に尖っている
      peak: peak, total: tot, width: peak > 1 ? width : 0
    };
  }

  // 円環上の 2 つの角度（扇形単位）の差。折り返しをまたいでも正しく測れる。
  function sectorDiff(a, b, n) {
    var d = ((a - b) % n + n) % n;
    return d > n / 2 ? d - n : d;
  }

  return {
    rng: rng,
    driver: driver,
    summation: summation,
    lateral: lateral, LATERAL_DEFAULTS: LATERAL_DEFAULTS,
    ring: ring, RING_DEFAULTS: RING_DEFAULTS,
    connectome: connectome, CONNECTOME_DEFAULTS: CONNECTOME_DEFAULTS, NT_SIGN: NT_SIGN,
    ringVector: ringVector, turnDiff: turnDiff,
    pathProfile: pathProfile, inputTally: inputTally,
    rotationForSpeed: rotationForSpeed,
    bumpVector: bumpVector,
    sectorDiff: sectorDiff
  };
})();
