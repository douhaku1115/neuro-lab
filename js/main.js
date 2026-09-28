// main.js
// 画面の組み立てと、時間を進めるループ。
// 各段は「作る／進める／描く」の 3 つを持つオブジェクトになっていて、
// 段を切り替えるとそれを差し替えるだけ。

(function () {

  var el = {};
  ['stepbar', 'lesson', 'controls', 'tries', 'playBtn', 'resetBtn', 'speedSel', 'speedBox', 'clock',
   'stage', 'scope', 'readout', 'glossaryBtn', 'glossary', 'glossaryClose', 'glossaryList',
   'stagePanel', 'scopePanel', 'stageZoom', 'scopeZoom']
    .forEach(function (id) { el[id] = document.getElementById(id); });

  // 開いた直後は止めておく（「開始」を押すと動き出す）
  var state = { index: 0, mode: null, playing: false, speed: 1, last: 0, modelMs: 0 };
  var closeZoom = null;                         // 図の拡大を閉じる（下で中身を入れる）

  // 表示用のならし。発火率は「直近 50 ms に何発あったか」から出しているので、
  // そのまま棒の高さにすると毎フレーム跳ねて読めない。絵にするときだけ、
  // もう一段ゆっくりならす（計算そのものには触らない）。
  function smooth(shown, src, ms, tau) {
    var k = 1 - Math.exp(-ms / tau);
    for (var i = 0; i < src.length; i++) shown[i] += (src[i] - shown[i]) * k;
    return shown;
  }

  // 段に入った直後の表示用に、落ち着いた発火率を測る。
  // 瞬間値をそのまま初期値にすると、たまたまその 50 ms に何発あったかで
  // 棒の高さがばらつき、最初に見る絵が形を誤って伝えてしまう。
  function settledRates(net, ids, ms) {
    var counts = NETWORK.countSpikes(net, ms, ids);
    return ids.map(function (i) { return counts[i] / (ms / 1000); });
  }

  // ───────────────────────────────────────────── 操作部品
  function ctlRange(label, o) {
    var row = document.createElement('div'); row.className = 'ctl';
    var lab = document.createElement('label'); lab.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'range'; inp.min = o.min; inp.max = o.max; inp.step = o.step; inp.value = o.value;
    var val = document.createElement('span'); val.className = 'val';
    function show() { val.textContent = o.fmt(Number(inp.value)); }
    inp.addEventListener('input', function () { show(); o.on(Number(inp.value)); });
    show();
    row.appendChild(lab); row.appendChild(inp); row.appendChild(val);
    if (o.hint) {
      var h = document.createElement('div'); h.className = 'hint'; h.textContent = o.hint;
      row.appendChild(h);
    }
    el.controls.appendChild(row);
    return { input: inp, refresh: show };
  }

  function ctlSeg(label, items, value, on) {
    var row = document.createElement('div'); row.className = 'ctl';
    var lab = document.createElement('label'); lab.textContent = label;
    var seg = document.createElement('div'); seg.className = 'seg';
    var btns = [];
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on'); on(it.value);
      });
      if (it.value === value) b.classList.add('on');
      seg.appendChild(b); btns.push(b);
    });
    row.appendChild(lab); row.appendChild(seg);
    row.appendChild(document.createElement('span'));
    el.controls.appendChild(row);
  }

  // ───────────────────────────────────────────── 段1: 多入力の加重
  var sumMode = {
    build: function () {
      var m = this;
      m.nIn = 12; m.active = 4; m.epsp = 1.2; m.rate = 60; m.arrival = 'poisson';
      m.c = CIRCUITS.summation({ nIn: m.nIn });
      m.v = new PLOT.Scope(1200); m.sp = new PLOT.Scope(1200);
      m.apply();

      ctlRange('入力の本数', {
        min: 1, max: 12, step: 1, value: m.active,
        fmt: function (x) { return x + ' 本'; },
        on: function (x) { m.active = x; m.apply(); }
      });
      ctlRange('1 本の強さ', {
        min: 0.2, max: 4, step: 0.1, value: m.epsp,
        fmt: function (x) { return x.toFixed(1) + ' mV'; },
        hint: '静止 −52 mV から閾値 −45 mV までは 7 mV',
        on: function (x) { m.epsp = x; m.apply(); }
      });
      ctlRange('入力の発火率', {
        min: 5, max: 200, step: 5, value: m.rate,
        fmt: function (x) { return x + ' Hz'; },
        on: function (x) { m.rate = x; m.apply(); }
      });
      ctlSeg('来かた', [
        { label: 'ばらばら', value: 'poisson' },
        { label: 'そろって', value: 'sync' },
        { label: '順ぐりに', value: 'async' }
      ], m.arrival, function (x) { m.arrival = x; m.apply(); });
    },
    apply: function () {
      this.c.setActive(this.active, this.epsp);
      this.drv = this.c.driver(this.rate, this.arrival, 1234);
    },
    reset: function () { NETWORK.reset(this.c.net); this.v.clear(); this.sp.clear(); this.apply(); },
    step: function (ms) {
      var net = this.c.net, out = this.c.out;
      var chunks = Math.max(1, Math.round(ms / 0.5));
      for (var k = 0; k < chunks; k++) {
        var fired = 0;
        NETWORK.run(net, 0.5, this.drv);
        if (net.spiked[out]) fired = 1;
        // 発火の瞬間は膜電位がリセットされてしまうので、山として描けるよう上へ振る
        this.v.push(fired ? -40 : net.v[out]);
        this.sp.push(fired);
      }
    },
    stage: function (g) {
      var net = this.c.net, ctx = g.ctx;
      var ox = g.w * 0.74, oy = g.h * 0.5;
      var ix = g.w * 0.22;

      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

      for (var i = 0; i < this.nIn; i++) {
        var t = this.nIn === 1 ? 0.5 : i / (this.nIn - 1);
        var y = g.h * 0.12 + t * g.h * 0.76;
        var on = i < this.active;
        ctx.strokeStyle = on ? '#c3d4ee' : '#eef1f5';
        ctx.lineWidth = on ? 1.4 : 1;
        ctx.beginPath(); ctx.moveTo(ix + 11, y); ctx.lineTo(ox - 21, oy); ctx.stroke();
      }
      for (i = 0; i < this.nIn; i++) {
        t = this.nIn === 1 ? 0.5 : i / (this.nIn - 1);
        y = g.h * 0.12 + t * g.h * 0.76;
        on = i < this.active;
        ctx.beginPath(); ctx.arc(ix, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = on ? PLOT.heat(net.rate[i], 200) : '#f4f6f9';
        ctx.fill();
        ctx.strokeStyle = on ? '#9fb6d8' : '#e4e9f0'; ctx.lineWidth = 1.4; ctx.stroke();
      }

      ctx.beginPath(); ctx.arc(ox, oy, 21, 0, Math.PI * 2);
      ctx.fillStyle = PLOT.heat(net.rate[this.c.out], 200); ctx.fill();
      ctx.strokeStyle = '#6f88ab'; ctx.lineWidth = 2; ctx.stroke();

      ctx.fillStyle = '#68727f';
      ctx.fillText('入力ニューロン', ix, g.h * 0.055);
      ctx.fillText('出力ニューロン', ox, g.h * 0.055);
      ctx.fillStyle = '#1e2530'; ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(net.rate[this.c.out].toFixed(0) + ' Hz', ox, oy + 38);
    },
    scope: function (g) {
      PLOT.drawTrace(g, this.v, {
        min: -54, max: -39,
        marks: [{ v: -45, color: '#d9453d', label: '閾値' }, { v: -52, color: '#9aa5b1', label: '静止' }],
        spikes: this.sp, label: '出力ニューロンの膜電位（直近 0.6 秒）', right: 'mV'
      });
    },
    readout: function () {
      var net = this.c.net;
      var one = SYNAPSE.epspPeak(net.w[this.c.syn[0]], net.p, net.tauSyn);
      return [
        ['出力の発火率', net.rate[this.c.out].toFixed(0) + ' Hz'],
        ['1 本ぶんの EPSP', one.toFixed(2) + ' mV'],
        ['同時に全部来たら', (one * this.active).toFixed(1) + ' mV'],
        ['閾値まで', '7.0 mV']
      ];
    }
  };

  // ───────────────────────────────────────────── 段2: 側方抑制
  var PROFILES = {
    step: [0.10, 0.10, 0.10, 0.10, 0.10, 0.17, 0.17, 0.17, 0.17],
    peak: [0.09, 0.10, 0.12, 0.15, 0.20, 0.15, 0.12, 0.10, 0.09],
    flat: [0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14, 0.14]
  };

  var lateralMode = {
    build: function () {
      var m = this;
      m.profile = 'step'; m.inh = 1;
      m.c = CIRCUITS.lateral();
      m.raster = []; m.shown = [];
      for (var i = 0; i < m.c.m; i++) { m.raster.push(new PLOT.Scope(600)); m.shown.push(0); }
      m.apply();
      // 段に入った時点で落ち着いた形を見せる。0 から立ち上がる様子を見たいときは
      //「やり直す」を押せばよい（そちらは何も先回りしない）。
      NETWORK.run(m.c.net, 500);
      m.shown = settledRates(m.c.net, m.c.E, 1000);

      ctlSeg('入力のかたち', [
        { label: '段差', value: 'step' }, { label: '山', value: 'peak' }, { label: '一様', value: 'flat' }
      ], m.profile, function (x) { m.profile = x; m.apply(); });
      ctlRange('抑制の強さ', {
        min: 0, max: 13, step: 0.5, value: m.inh,
        fmt: function (x) { return x === 0 ? '切' : '×' + x.toFixed(1); },
        hint: '0 にすると入力がそのまま出る',
        on: function (x) { m.inh = x; m.apply(); }
      });
    },
    apply: function () { this.c.setInput(PROFILES[this.profile]); this.c.setInhibition(this.inh); },
    reset: function () {
      NETWORK.reset(this.c.net); this.apply();
      this.raster.forEach(function (s) { s.clear(); });
      for (var i = 0; i < this.shown.length; i++) this.shown[i] = 0;
    },
    step: function (ms) {
      var net = this.c.net, E = this.c.E, m = this;
      var chunks = Math.max(1, Math.round(ms / 1));
      for (var k = 0; k < chunks; k++) {
        var hit = new Uint8Array(E.length);
        for (var s = 0; s < 10; s++) {
          NETWORK.step(net);
          for (var j = 0; j < E.length; j++) if (net.spiked[E[j]]) hit[j] = 1;
        }
        for (j = 0; j < E.length; j++) m.raster[j].push(hit[j]);
      }
      smooth(m.shown, m.c.rates(), ms, 500);
    },
    stage: function (g) {
      var ctx = g.ctx, input = PROFILES[this.profile], rates = this.shown;
      var pad = 40, w = g.w - pad * 2;
      var labels = []; for (var i = 0; i < input.length; i++) labels.push(String(i));

      // 入力は電流 [pA]、出力は発火率 [Hz]。単位が違うので別々の目盛りで描く。
      PLOT.drawBars(g, { x: pad, y: 28, w: w, h: g.h * 0.28 },
        input.map(function (x) { return x * 1000; }),
        { max: 220, color: '#9fb6d8', labels: labels, title: '入力（電流 pA）' });

      PLOT.drawBars(g, { x: pad, y: g.h * 0.52, w: w, h: g.h * 0.34 }, rates,
        { max: 110, colors: rates.map(function (r) { return PLOT.heat(r, 110); }),
          labels: labels, title: '出力（発火率 Hz）', showValue: true });

      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#68727f'; ctx.textBaseline = 'top';
      ctx.fillText('列', g.w / 2, g.h - 14);
    },
    scope: function (g) {
      var labels = []; for (var i = 0; i < this.raster.length; i++) labels.push(String(i));
      PLOT.drawRaster(g, this.raster, {
        labels: labels, color: '#2f6fd0', label: '各列の興奮性ニューロンの発火（直近 0.6 秒）'
      });
    },
    readout: function () {
      var r = this.shown;
      var alive = r.filter(function (x) { return x > 5; }).length;
      var hi = Math.max.apply(null, r);
      return [
        ['発火している列', alive + ' / ' + r.length],
        ['いちばん強い列', hi.toFixed(0) + ' Hz'],
        ['抑制', this.inh === 0 ? '切' : '×' + this.inh.toFixed(1)]
      ];
    }
  };

  // ───────────────────────────────────────────── 段3: リングアトラクタ
  var ringMode = {
    build: function () {
      var m = this;
      m.cueOn = true; m.cueSector = 4; m.inh = 1; m.exc = 1;
      m.c = CIRCUITS.ring();
      m.raster = []; m.shown = []; m.idx = [];
      for (var i = 0; i < m.c.n; i++) { m.raster.push(new PLOT.Scope(700)); m.shown.push(0); m.idx.push(i); }
      m.apply();
      // 段に入った時点で山が立っている状態にしておく。立ち上がる様子は
      //「やり直す」で最初から見られる。
      NETWORK.run(m.c.net, 600);
      m.shown = settledRates(m.c.net, m.c.EPG, 800);

      ctlSeg('目印（ランドマーク）', [
        { label: '見えている', value: 1 }, { label: '消す（暗闇）', value: 0 }
      ], 1, function (x) { m.cueOn = !!x; m.apply(); });
      ctlRange('目印の向き', {
        min: 0, max: 15.5, step: 0.5, value: m.cueSector,
        fmt: function (x) { return (x / 16 * 360).toFixed(0) + '°'; },
        on: function (x) { m.cueSector = x; m.apply(); }
      });
      ctlRange('Δ7 の抑制', {
        min: 0, max: 2, step: 0.05, value: 1,
        fmt: function (x) { return x === 0 ? '切' : '×' + x.toFixed(2); },
        hint: '切ると山が立たず、円環じゅうが光る',
        on: function (x) { m.inh = x; m.apply(); }
      });
      ctlRange('EPG どうしの励起', {
        min: 0, max: 1.6, step: 0.05, value: 1,
        fmt: function (x) { return x === 0 ? '切' : '×' + x.toFixed(2); },
        hint: '切ると、目印があるあいだしか山が立たない＝覚えていられない',
        on: function (x) { m.exc = x; m.apply(); }
      });
    },
    apply: function () {
      this.c.setCue(this.cueOn, this.cueSector);
      this.c.setInhibition(this.inh);
      this.c.setExcitation(this.exc);
    },
    reset: function () {
      NETWORK.reset(this.c.net); this.apply();
      this.raster.forEach(function (s) { s.clear(); });
      for (var i = 0; i < this.shown.length; i++) this.shown[i] = 0;
    },
    step: function (ms) {
      var net = this.c.net, EPG = this.c.EPG, m = this;
      var chunks = Math.max(1, Math.round(ms / 1));
      for (var k = 0; k < chunks; k++) {
        var hit = new Uint8Array(EPG.length);
        for (var s = 0; s < 10; s++) {
          NETWORK.step(net);
          for (var j = 0; j < EPG.length; j++) if (net.spiked[EPG[j]]) hit[j] = 1;
        }
        for (j = 0; j < EPG.length; j++) m.raster[j].push(hit[j]);
      }
      smooth(m.shown, m.c.rates(), ms, 300);
    },
    stage: function (g) {
      var r = Math.min(g.w, g.h) * 0.38;
      RINGVIEW.draw(g, {
        rates: this.shown, cx: g.w / 2, cy: g.h / 2 + 6, r: r, max: 130,
        cue: this.cueOn ? this.cueSector : null,
        bump: CIRCUITS.bumpVector(this.shown, this.idx)
      });
      var ctx = g.ctx;
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#68727f';
      ctx.fillText('楕円体の 16 扇形（EPG の発火率）', g.w / 2, 6);
    },
    scope: function (g) {
      var labels = []; for (var i = 0; i < this.raster.length; i++) labels.push(i % 2 ? '' : String(i));
      PLOT.drawRaster(g, this.raster, {
        labels: labels, color: '#2f6fd0', label: '16 個の EPG の発火（直近 0.7 秒）'
      });
    },
    readout: function () {
      var b = CIRCUITS.bumpVector(this.shown, this.idx);
      return [
        ['山の向き', b.peak > 3 ? b.angle.toFixed(0) + '°' : '— '],
        ['山の高さ', b.peak.toFixed(0) + ' Hz'],
        ['山の幅', b.width + ' / 16 扇形'],
        ['尖り', b.strength.toFixed(2)]
      ];
    }
  };

  // ───────────────────────────────────────────── 段4: ハエを回す
  var compassMode = {
    build: function () {
      var m = this;
      m.heading = 0; m.omega = 0; m.cueOn = true; m.drag = false;
      m.c = CIRCUITS.ring();
      m.headTrace = new PLOT.Scope(700); m.bumpTrace = new PLOT.Scope(700);
      m.headUnwrap = 0; m.bumpUnwrap = 0; m.prevBump = null;
      m.shown = []; m.idx = [];
      for (var i = 0; i < m.c.n; i++) { m.shown.push(0); m.idx.push(i); }
      m.apply();
      // 最初にバンプを立てておく（暗闇から始めると何も見えない）
      m.c.setCue(true, 0);
      NETWORK.run(m.c.net, 600);
      m.shown = settledRates(m.c.net, m.c.EPG, 800);

      ctlSeg('目印（ランドマーク）', [
        { label: '見えている', value: 1 }, { label: '消す（暗闇）', value: 0 }
      ], 1, function (x) { m.cueOn = !!x; m.apply(); });
      ctlSeg('回す', [
        { label: '← 左へ', value: -1 }, { label: '止める', value: 0 }, { label: '右へ →', value: 1 }
      ], 0, function (x) { m.autoTurn = x; });
      var row = document.createElement('div'); row.className = 'ctl';
      var hint = document.createElement('div'); hint.className = 'hint';
      hint.textContent = '絵のハエを直接ドラッグしても回せます。';
      row.appendChild(hint); el.controls.appendChild(row);

      m.bindDrag();
    },
    bindDrag: function () {
      var m = this, cv = el.stage;
      cv.classList.add('grab');
      function angleAt(ev) {
        var r = cv.getBoundingClientRect();
        var cx = r.width * 0.28, cy = r.height * 0.52;
        var dx = (ev.clientX - r.left) - cx, dy = (ev.clientY - r.top) - cy;
        return Math.atan2(dx, -dy) * 180 / Math.PI;    // 真上を 0、時計回りを正
      }
      m._down = function (ev) {
        m.drag = true; m.dragFrom = angleAt(ev); m.dragHead = m.heading;
        cv.classList.add('grabbing'); cv.setPointerCapture(ev.pointerId);
      };
      m._move = function (ev) {
        if (!m.drag) return;
        var d = angleAt(ev) - m.dragFrom;
        m.target = m.dragHead + d;
      };
      m._up = function (ev) {
        // 目標は消さない。離した時点でまだ追いついていないことがあり、
        // そこで捨てると、素早いドラッグがまるごと無かったことになる。
        m.drag = false; cv.classList.remove('grabbing');
        if (cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
      };
      cv.addEventListener('pointerdown', m._down);
      cv.addEventListener('pointermove', m._move);
      cv.addEventListener('pointerup', m._up);
      cv.addEventListener('pointercancel', m._up);
    },
    unbind: function () {
      var cv = el.stage;
      cv.classList.remove('grab', 'grabbing');
      cv.removeEventListener('pointerdown', this._down);
      cv.removeEventListener('pointermove', this._move);
      cv.removeEventListener('pointerup', this._up);
      cv.removeEventListener('pointercancel', this._up);
    },
    apply: function () {
      // 目印は「景色から割り出した向き」。見えているあいだはバンプをそこへ引き寄せる。
      this.c.setCue(this.cueOn, ((this.heading / 360 * 16) % 16 + 16) % 16);
    },
    reset: function () {
      NETWORK.reset(this.c.net);
      this.heading = 0; this.omega = 0; this.headUnwrap = 0; this.bumpUnwrap = 0; this.prevBump = null;
      this.headTrace.clear(); this.bumpTrace.clear();
      for (var i = 0; i < this.shown.length; i++) this.shown[i] = 0;
      this.target = null; this.autoTurn = 0;
      this.c.setCue(true, 0); NETWORK.run(this.c.net, 900);
      this.apply();
    },
    step: function (ms) {
      var m = this, dtS = ms / 1000;

      // 向きを更新する。ドラッグ中はポインタを追い、ボタンなら一定の速さで回る。
      var prev = m.heading;
      if (m.target !== null && m.target !== undefined) {
        m.heading += (m.target - m.heading) * Math.min(1, dtS * 9);
        if (!m.drag && Math.abs(m.target - m.heading) < 0.5) { m.heading = m.target; m.target = null; }
      } else if (m.autoTurn) {
        m.heading += m.autoTurn * 90 * dtS;
      }
      var inst = (m.heading - prev) / Math.max(1e-6, dtS);        // [度/秒]
      m.omega += (inst - m.omega) * Math.min(1, dtS * 8);          // なめらかに

      // 角速度を PEN への入力に直す。扇形/秒 に直してから目盛りを引く。
      var level = CIRCUITS.rotationForSpeed(m.omega / 360 * 16);
      m.c.setRotation(Math.max(-1, Math.min(1, level)));
      m.apply();

      var chunks = Math.max(1, Math.round(ms / 2));
      for (var k = 0; k < chunks; k++) {
        NETWORK.run(m.c.net, 2);
        var b = m.c.bump();
        // 折り返しで線が飛ばないよう、角度をつなげて記録する
        if (m.prevBump === null) m.prevBump = b.sector;
        m.bumpUnwrap += CIRCUITS.sectorDiff(b.sector, m.prevBump, 16) / 16 * 360;
        m.prevBump = b.sector;
        m.headUnwrap = m.heading;
        m.headTrace.push(m.headUnwrap);
        m.bumpTrace.push(m.bumpUnwrap);
      }
      // 針の位置は生の値で追う（ここが遅れると追従して見えなくなる）。
      // 扇形の色だけ、ちらつかないようにならす。
      smooth(m.shown, m.c.rates(), ms, 200);
    },
    stage: function (g) {
      var ctx = g.ctx;
      var fx = g.w * 0.28, fy = g.h * 0.52, fr = Math.min(g.w * 0.26, g.h * 0.42);
      RINGVIEW.landscape(g, fx, fy, fr, this.heading, this.cueOn ? 0 : null);
      RINGVIEW.fly(g, fx, fy, fr * 1.15, this.heading);

      var rx = g.w * 0.74, ry = g.h * 0.50, rr = Math.min(g.w * 0.21, g.h * 0.33);
      RINGVIEW.draw(g, {
        rates: this.shown, cx: rx, cy: ry, r: rr, max: 130,
        cue: null, bump: this.c.bump(),
        // 本当の向きは輪の外側の目盛りで示す。針（赤・内側）と重ならないので、
        // ぴったり一致しているときも、ずれているときも両方見える。
        mark: ((this.heading / 360 * 16) % 16 + 16) % 16
      });

      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#68727f';
      ctx.fillText('ハエ（ドラッグで回る）', fx, 6);
      ctx.fillText('脳のコンパス', rx, 6);
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#d9453d'; ctx.fillText('内の赤い針 ＝ 脳が思っている向き', rx, g.h - 16);
      ctx.fillStyle = '#8a95a2'; ctx.fillText('外の灰色の印 ＝ 本当の向き', rx, g.h - 3);
    },
    scope: function (g) {
      var n = this.headTrace.n;
      if (n < 2) { PLOT.clear(g); return; }
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < n; i++) {
        lo = Math.min(lo, this.headTrace.at(i), this.bumpTrace.at(i));
        hi = Math.max(hi, this.headTrace.at(i), this.bumpTrace.at(i));
      }
      var pad = Math.max(30, (hi - lo) * 0.15);
      // 本当の向き（灰）は太く、脳の向き（赤）は細く重ねる。
      // 2 本がぴったり一致しているときでも、下の灰がはみ出して見える。
      PLOT.drawTrace(g, this.headTrace, {
        min: lo - pad, max: hi + pad, color: '#c2cad3', width: 4,
        label: '向きの推移 ── 灰＝本当の向き／赤＝脳の向き（直近 1.4 秒）', right: '度'
      });
      var ctx = g.ctx, x0 = 46, w = g.w - 54, y0 = 10, h = g.h - 28;
      var Y = function (v) { return y0 + h - (v - (lo - pad)) / ((hi + pad) - (lo - pad)) * h; };
      ctx.strokeStyle = '#d9453d'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (i = 0; i < this.bumpTrace.n; i++) {
        var x = x0 + i / (this.bumpTrace.len - 1) * w, v = this.bumpTrace.at(i);
        if (i === 0) ctx.moveTo(x, Y(v)); else ctx.lineTo(x, Y(v));
      }
      ctx.stroke();
    },
    readout: function () {
      var b = this.c.bump();
      var err = this.bumpTrace.n ? this.bumpTrace.at(this.bumpTrace.n - 1) - this.heading : 0;
      return [
        ['ハエの向き', this.heading.toFixed(0) + '°'],
        ['回転の速さ', this.omega.toFixed(0) + ' °/秒'],
        ['山の高さ', b.peak.toFixed(0) + ' Hz'],
        ['脳と実際のずれ', (err >= 0 ? '+' : '') + err.toFixed(0) + '°']
      ];
    }
  };

  // ───────────────────────────────────────── 段5: 本物の配線
  var realMode = {
    build: function () {
      var m = this;
      m.cueOn = true; m.cueTurn = 0; m.inh = 1; m.rot = 0;
      m.c = CIRCUITS.connectome(CXDATA);
      m.order = m.c.EPG.slice().sort(function (a, b) { return m.c.pos[a] - m.c.pos[b]; });
      m.shown = []; for (var i = 0; i < m.order.length; i++) m.shown.push(0);

      // 配線から測る「何度ずれた相手に効いているか」。1 度だけ計算すればよい。
      m.prof = {
        ee: CIRCUITS.pathProfile(m.c),
        d7: CIRCUITS.pathProfile(m.c, 'Delta7'),
        penL: CIRCUITS.pathProfile(m.c, 'PEN_b', 'L'),
        penR: CIRCUITS.pathProfile(m.c, 'PEN_b', 'R')
      };
      m.tally = CIRCUITS.inputTally(m.c);
      m.apply();
      NETWORK.run(m.c.net, 1200);
      m.shown = settledRates(m.c.net, m.order, 800);

      ctlSeg('目印（ランドマーク）', [
        { label: '見えている', value: 1 }, { label: '消す（暗闇）', value: 0 }
      ], 1, function (x) { m.cueOn = !!x; m.apply(); });
      ctlRange('目印の向き', {
        min: 0, max: 0.97, step: 0.03, value: 0,
        fmt: function (x) { return (x * 360).toFixed(0) + '°'; },
        on: function (x) { m.cueTurn = x; m.apply(); }
      });
      ctlRange('抑制の強さ', {
        min: 0, max: 1.5, step: 0.05, value: 1,
        fmt: function (x) { return x === 0 ? '切' : '×' + x.toFixed(2); },
        hint: 'ER と Δ7 をまとめて。0 にすると円環じゅうが光る',
        on: function (x) { m.inh = x; m.c.setInhibition(x); }
      });
      ctlRange('回転入力', {
        min: 0, max: 0.10, step: 0.002, value: CIRCUITS.CONNECTOME_DEFAULTS.rotDrive,
        fmt: function (x) { return (x * 1000).toFixed(0) + ' pA'; },
        hint: '60 pA あたりで PEN が一斉に火を噴き、山が壊れる',
        on: function (x) { m.rebuild(x); }
      });
      ctlSeg('回す向き', [
        { label: '← 左', value: -1 }, { label: '止', value: 0 }, { label: '右 →', value: 1 }
      ], 0, function (x) { m.rot = x; m.c.setRotation(x); });
    },
    // 回転入力の強さは配線に混ぜていないので、作り直さずに済む
    rebuild: function (rotDrive) {
      this.c.opts.rotDrive = rotDrive;
      this.c.setRotation(this.rot);
    },
    apply: function () { this.c.setCue(this.cueOn, this.cueTurn); },
    reset: function () {
      NETWORK.reset(this.c.net);
      this.apply(); this.c.setInhibition(this.inh); this.c.setRotation(this.rot);
      for (var i = 0; i < this.shown.length; i++) this.shown[i] = 0;
    },
    step: function (ms) {
      NETWORK.run(this.c.net, ms);
      var live = [];
      for (var i = 0; i < this.order.length; i++) live.push(this.c.net.rate[this.order[i]]);
      smooth(this.shown, live, ms, 300);
    },
    stage: function (g) {
      var ctx = g.ctx;
      var r = Math.min(g.w * 0.30, g.h * 0.38);
      var cx = g.w * 0.27, cy = g.h * 0.52;
      RINGVIEW.draw(g, {
        rates: this.shown, cx: cx, cy: cy, r: r, max: 110,
        cue: this.cueOn ? this.cueTurn * this.shown.length : null,
        bump: CIRCUITS.ringVector(this.c.net.rate, this.order, this.c.pos)
      });

      // どの型が EPG をどれだけ動かしているか
      var x0 = g.w * 0.56, y0 = 34, bw = g.w * 0.40;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#68727f';
      ctx.fillText('EPG 1 個が受け取るシナプス数（型別）', x0, 16);
      var max = this.tally[0].per;
      for (var i = 0; i < Math.min(7, this.tally.length); i++) {
        var t = this.tally[i], y = y0 + i * 20;
        var w = t.per / max * (bw - 96);
        ctx.fillStyle = t.sign > 0 ? '#2f6fd0' : '#c2521c';
        ctx.fillRect(x0 + 52, y - 6, Math.max(2, w), 12);
        ctx.fillStyle = '#1e2530'; ctx.textAlign = 'right';
        ctx.fillText(t.type, x0 + 46, y);
        ctx.fillStyle = '#68727f'; ctx.textAlign = 'left';
        ctx.fillText(t.per.toFixed(0), x0 + 58 + Math.max(2, w), y);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#2f6fd0'; ctx.fillText('■ 興奮性', x0, y0 + 7 * 20 + 4);
      ctx.fillStyle = '#c2521c'; ctx.fillText('■ 抑制性', x0 + 60, y0 + 7 * 20 + 4);

      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#68727f';
      ctx.fillText('EPG 47 個（配線から復元した円環の順）', cx, 6);
    },
    scope: function (g) {
      // 配線から測ったずれのプロファイル。ここが段5 のいちばんの見どころ。
      var ctx = g.ctx;
      var pad = { l: 46, r: 10, t: 16, b: 20 };
      var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1; ctx.strokeRect(x0 + .5, y0 + .5, w - 1, h - 1);

      var series = [
        { p: this.prof.ee, c: '#2f6fd0', label: 'EPG→EPG' },
        { p: this.prof.d7, c: '#c2521c', label: 'Δ7' },
        { p: this.prof.penL, c: '#1f7a4d', label: 'PEN左' },
        { p: this.prof.penR, c: '#8a5bd6', label: 'PEN右' }
      ];
      ctx.font = '10px system-ui, sans-serif';
      // ずれ 0 の線
      var xz = x0 + w / 2;
      ctx.strokeStyle = '#c9d2dd'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xz, y0); ctx.lineTo(xz, y0 + h); ctx.stroke();
      ctx.setLineDash([]);

      for (var s = 0; s < series.length; s++) {
        var p = series[s].p, v = p.values;
        var mx = Math.max.apply(null, v) || 1;
        ctx.strokeStyle = series[s].c; ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (var i = 0; i < v.length; i++) {
          var x = x0 + i / (v.length - 1) * w, y = y0 + h - v[i] / mx * (h - 6);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // 凡例は曲線に重ならないよう、枠の上に 1 行で並べる
      ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
      var lx = x0;
      for (s = 0; s < series.length; s++) {
        var txt = series[s].label + ' ' +
          (series[s].p.peakDeg >= 0 ? '+' : '−') + Math.abs(series[s].p.peakDeg).toFixed(0) + '°';
        ctx.fillStyle = series[s].c;
        ctx.fillRect(lx, y0 - 9, 9, 3);
        ctx.fillText(txt, lx + 13, y0 - 3);
        lx += 13 + ctx.measureText(txt).width + 14;
      }
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('相手が何度ずれているか（中央が 0°、両端が ±180°／高さは型ごとに正規化）',
        x0 + w / 2, y0 + h + 4);
    },
    readout: function () {
      var b = CIRCUITS.ringVector(this.c.net.rate, this.order, this.c.pos);
      var mean = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; };
      var pen = this.c.ratesOf('PEN_a').concat(this.c.ratesOf('PEN_b'));
      return [
        ['山の向き', b.peak > 3 ? b.angle.toFixed(0) + '°' : '— '],
        ['山の高さ', b.peak.toFixed(0) + ' Hz'],
        ['光っている EPG', b.width + ' / 47'],
        ['Δ7', mean(this.c.ratesOf('Delta7')).toFixed(0) + ' Hz'],
        ['PEN', mean(pen).toFixed(0) + ' Hz'],
        ['ER', mean(this.c.ratesOf('ER')).toFixed(0) + ' Hz']
      ];
    }
  };

  // ───────────────────────────────────────── 段6: 全脳 13.9 万個
  // ここだけは計算済みの結果を読むだけ。13.9 万ニューロンはブラウザには重すぎるので、
  // 隣の fly-brain フォルダで Python（Brian2）が計算したものを表示する。
  var brainMode = {
    static: true,                     // 目の前で計算していない、を main に伝える
    build: function () {
      var m = this;
      m.D = globalThis.BRAINDATA;
      m.win = 1000;                   // ラスターで見る時間の幅 [ms]
      m.view = 'bitter';              // 下の図: 苦味を足す / 1 個ずつ黙らせる / 苦味スイッチ
      m.top = 'raster';               // 上の図: ラスター / 回路図
      m.taste = 0;                    // 回路図で見る条件: 0＝甘味だけ / 200＝甘味＋苦味 200 Hz / 'w'＝水だけ
      if (m.D.circuit)
        ctlSeg('上の図', [
          { label: 'スパイク', value: 'raster' },
          { label: '回路図', value: 'circuit' }
        ], m.top, function (x) { m.top = x; });

      ctlRange('見る時間', {
        min: 0, max: 5, step: 1, value: 5,
        fmt: function (i) { return [30, 50, 100, 200, 500, 1000][i] + ' ms'; },
        hint: '縮めると、活動が 1 個ずつ広がっていく坂がはっきり見えます',
        on: function (i) { m.win = [30, 50, 100, 200, 500, 1000][i]; }
      });
      if (m.D.circuit)
        ctlSeg('回路図の味', [
          { label: '甘味だけ', value: 0 },
          { label: '水だけ', value: 'w' },
          { label: '甘味＋苦味', value: 200 }
        ], m.taste, function (x) { m.taste = x; });
      if (m.D.silence) {
        var views = [
          { label: '苦味を足す', value: 'bitter' },
          { label: '黙らせる（甘味）', value: 'silence' }
        ];
        if (m.D.silenceWater) views.push({ label: '黙らせる（水）', value: 'silenceWater' });
        if (m.D.circuit) views.push({ label: '苦味スイッチ', value: 'switch' });
        if (m.D.groom) views.push({ label: '触角 → 身づくろい', value: 'groom' });
        if (m.D.escape) views.push({ label: '迫る影 → 逃げる', value: 'escape' });
        ctlSeg('下の図', views, m.view, function (x) { m.view = x; });
      }
    },
    reset: function () { this.win = 1000; this.view = 'bitter'; this.top = 'raster'; this.taste = 0; },
    step: function () { },            // 計算するものが無い

    stage: function (g) {
      if (this.top === 'circuit') return this.stageCircuit(g);
      var D = this.D, ctx = g.ctx;
      // 右端の目盛りに「1000 ms」と単位まで入るので、その幅だけ空けておく
      var pad = { l: 52, r: 30, t: 10, b: 28 };
      var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      this.box = { x0: x0, y0: y0, w: w, h: h };

      var win = this.win;
      var X = function (ms) { return x0 + ms / win * w; };
      var Y = function (i) { return y0 + (i + 0.5) / D.nNeurons * h; };

      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(x0, y0, w, h);

      // 時間の目盛り
      var stepMs = win <= 50 ? 10 : win <= 200 ? 50 : win <= 500 ? 100 : 200;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (var ms = 0; ms <= win; ms += stepMs) {
        ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(ms) + .5, y0); ctx.lineTo(X(ms) + .5, y0 + h); ctx.stroke();
        ctx.fillStyle = '#68727f';
        ctx.fillText(ms + (ms === win ? ' ms' : ''), X(ms), y0 + h + 5);
      }
      ctx.strokeStyle = '#c9d2dd';
      ctx.beginPath(); ctx.moveTo(x0, y0 + h + .5); ctx.lineTo(x0 + w, y0 + h + .5); ctx.stroke();

      // 刺激した 20 個の帯を薄く敷く
      var sy = Y(D.nSugarRows - 0.5);
      ctx.fillStyle = '#2f6fd0'; ctx.globalAlpha = .07;
      ctx.fillRect(x0, y0, w, sy - y0);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#c9d2dd'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x0, sy); ctx.lineTo(x0 + w, sy); ctx.stroke();
      ctx.setLineDash([]);

      // MN9 の行
      var my = Y(D.mn9Y);
      ctx.fillStyle = '#eb6834'; ctx.globalAlpha = .13;
      ctx.fillRect(x0, my - 4, w, 8);
      ctx.globalAlpha = 1;

      // スパイク。大事なものが下に隠れないよう、その他 → 甘味 → MN9 の順に描く
      var cols = ['#9aa5b1', '#2f6fd0', '#eb6834'];
      var alpha = [.55, .95, 1], size = [1.5, 2.2, 2.8];
      for (var k = 0; k < 3; k++) {
        ctx.fillStyle = cols[k]; ctx.globalAlpha = alpha[k];
        for (var i = 0; i < D.raster.length; i++) {
          var p = D.raster[i];
          if (p[2] !== k || p[1] > win) continue;
          ctx.fillRect(X(p[1]) - size[k] / 2, Y(p[0]) - size[k] / 2, size[k], size[k]);
        }
      }
      ctx.globalAlpha = 1;

      // MN9 が最初に発火した瞬間
      if (D.mn9FirstMs <= win) {
        var mx = X(D.mn9FirstMs);
        ctx.strokeStyle = '#eb6834'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(mx, y0); ctx.lineTo(mx, y0 + h); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 図のなかに説明を置く。説明文を読まなくても何の図か分かるように。
      function chip(text, x, y, color, align) {
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        var tw = ctx.measureText(text).width;
        if (align === 'right') x -= tw + 12;
        x = Math.max(x0 + 2, Math.min(x, x0 + w - tw - 14));
        ctx.fillStyle = '#ffffff'; ctx.globalAlpha = .82;
        ctx.fillRect(x, y - 8, tw + 12, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.fillText(text, x + 6, y);
      }
      chip('↑ こちらが刺激した甘味ニューロン ' + D.nSugarRows + ' 個', x0 + 6, y0 + 10, '#2f6fd0');
      chip('↓ 配線が勝手に起こした活動（上ほど早く動き出した）', x0 + 6, sy + 12, '#5c6672');
      chip('MN9 ＝ 口を伸ばす運動ニューロン', x0 + w - 6, my - 14, '#c2521c', 'right');
      if (D.mn9FirstMs <= win)
        chip('ここで MN9 が発火  ' + D.mn9FirstMs.toFixed(1) + ' ms', X(D.mn9FirstMs) + 4, my + 16, '#c2521c');

      ctx.save(); ctx.translate(13, y0 + h / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#68727f';
      ctx.fillText('1 行が 1 個のニューロン（全 ' + D.nNeurons + ' 個）', 0, 0);
      ctx.restore();
    },

    stageCircuit: function (g) {
      // 黙らせる実験で特定したニューロンを 1 枚にまとめた回路図。
      // 丸の色＝発火率（段1〜5 と同じ色）、線の太さ＝シナプス数、
      // 矢印＝興奮性、先が平らな線（⊣）＝抑制性。送り手が黙っている線は薄くする。
      var C = this.D.circuit, ctx = g.ctx, fb = this.taste;
      var rk = fb === 'w' ? 'rw' : fb ? 'r200' : 'r0';
      var P = {
        sugar:      [.09, .22, '甘味センサー'],
        water:      [.09, .50, '水センサー'],
        mid:        [.33, .30, '中継'],
        roundup:    [.58, .30, 'Roundup'],
        brake:      [.45, .08, 'ブレーキ'],
        para:       [.72, .62, 'MN9 の手前'],
        mn9:        [.91, .40, 'MN9（口）'],
        bitter:     [.09, .80, '苦味センサー'],
        switchMain: [.33, .68, '苦味スイッチ 主役'],
        switchRest: [.33, .90, '苦味スイッチ 残り']
      };
      var inhib = { brake: 1, switchMain: 1, switchRest: 1 };
      // 下に凡例の 1 行ぶんを空ける
      var pad = 22, W = g.w - pad * 2, H = g.h - pad * 2 - 30;
      var at = function (k) { return [pad + P[k][0] * W, pad + 14 + P[k][1] * H]; };
      var R = function (k) { return k === 'mn9' || k === 'roundup' ? 17 : 14; };

      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(0, 0, g.w, g.h);

      // 線。太さはシナプス数の対数。送り手がほぼ黙っていたら薄く
      C.edges.forEach(function (e) {
        var a = at(e[0]), b = at(e[1]), n = e[2];
        if (!n) return;
        var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
        // ブレーキとの往復は 2 本が重ならないよう、進む向きの右側へ少しずらす
        // （向きが逆なので、同じ量ずらせば左右に分かれる）
        var off = (e[0] === 'brake' || e[1] === 'brake') ? 5 : 0;
        var ox = -uy * off, oy = ux * off;
        var x1 = a[0] + ux * R(e[0]) + ox, y1 = a[1] + uy * R(e[0]) + oy;
        var x2 = b[0] - ux * (R(e[1]) + 3) + ox, y2 = b[1] - uy * (R(e[1]) + 3) + oy;
        var live = C.nodes[e[0]][rk] >= 1;
        var col = inhib[e[0]] ? '#c2521c' : '#5c6672';
        ctx.globalAlpha = live ? .85 : .15;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.lineWidth = Math.max(1, Math.log10(n) * 1.6);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        if (inhib[e[0]]) {             // ⊣ 抑制
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(x2 - uy * 7, y2 + ux * 7); ctx.lineTo(x2 + uy * 7, y2 - ux * 7); ctx.stroke();
        } else {                       // → 興奮
          ctx.beginPath(); ctx.moveTo(x2 + ux * 3, y2 + uy * 3);
          ctx.lineTo(x2 - ux * 6 - uy * 4, y2 - uy * 6 + ux * 4);
          ctx.lineTo(x2 - ux * 6 + uy * 4, y2 - uy * 6 - ux * 4); ctx.closePath(); ctx.fill();
        }
      });
      ctx.globalAlpha = 1;

      // 丸。色は発火率、下に名前・個数・発火率
      Object.keys(P).forEach(function (k) {
        var c = at(k), nd = C.nodes[k], r = nd[rk];
        ctx.beginPath(); ctx.arc(c[0], c[1], R(k), 0, Math.PI * 2);
        ctx.fillStyle = PLOT.heat(r, 120); ctx.fill();
        ctx.lineWidth = inhib[k] ? 2 : 1.2;
        ctx.strokeStyle = inhib[k] ? '#c2521c' : '#5c6672';
        if (inhib[k]) ctx.setLineDash([3, 2]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = '#1e2530';
        ctx.fillText(P[k][2] + (nd.n > 1 ? '（' + nd.n + ' 個）' : ''), c[0], c[1] + R(k) + 3);
        ctx.fillStyle = r < 1 ? '#9aa5b1' : '#2f6fd0';
        ctx.fillText(r < 1 ? '黙っている' : r.toFixed(0) + ' Hz', c[0], c[1] + R(k) + 16);
      });

      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#1e2530';
      ctx.fillText(fb === 'w' ? '水 ' + this.D.waterHz + ' Hz だけ：甘味と同じ中継・Roundup を通って MN9 に届く'
                 : fb ? '甘味 100 Hz ＋ 苦味 200 Hz：苦味スイッチが Roundup を止め、MN9 まで黙る'
                 : '甘味 100 Hz だけ：Roundup を通って MN9 まで届く', 8, 6);
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('→ 興奮性　⊣ 抑制性（点線の丸）　線の太さ＝シナプス数', g.w - 8, g.h - 4);
    },

    scope: function (g) {
      if (this.view === 'groom') return this.scopeGroom(g);
      if (this.view === 'escape') return this.scopeGroom(g, this.D.escape,
        '右目の LC4 ' + this.D.escape.nLC4 + ' 個・LPLC2 ' + this.D.escape.nLPLC2 + ' 個を刺激したときの GF（' + this.D.escape.runs + ' 試行の平均 ± 標準偏差）',
        '横軸＝LC4・LPLC2 への刺激 [Hz]');
      if (this.view === 'switch') return this.scopeSilence(g, this.D.circuit.switchRows,
        '苦味スイッチを黙らせたときの MN9（甘味＋苦味 200 Hz のまま・' + this.D.circuit.switchRows[1].n + ' 試行の平均）');
      if (this.view === 'silence') return this.scopeSilence(g);
      if (this.view === 'silenceWater') return this.scopeSilence(g, this.D.silenceWater.rows,
        'ニューロンを黙らせたときの MN9（水 ' + this.D.waterHz + ' Hz のまま・' +
        this.D.silenceWater.rows[0].n + ' 試行の平均）');
      // 苦味を足したときの MN9。甘味の刺激は動かしていない。
      var D = this.D, ctx = g.ctx;
      var pad = { l: 52, r: 14, t: 20, b: 30 };
      var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      var n = D.doses.length, max = 70;
      var gap = 14, bw = Math.min(70, (w - gap * (n - 1)) / n);
      var left = x0 + 4;

      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var v = 0; v <= 60; v += 30) {
        var y = y0 + h - v / max * h;
        ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y + .5); ctx.lineTo(x0 + w, y + .5); ctx.stroke();
        ctx.fillStyle = '#68727f'; ctx.fillText(v + (v === 60 ? ' Hz' : ''), x0 - 6, y);
      }
      ctx.strokeStyle = '#c9d2dd';
      ctx.beginPath(); ctx.moveTo(x0, y0 + h + .5); ctx.lineTo(x0 + w, y0 + h + .5); ctx.stroke();

      this.bars = [];
      for (var i = 0; i < n; i++) {
        var r = D.mn9Rate[i], bh = r / max * h, x = left + i * (bw + gap);
        this.bars.push({ x: x, w: bw, i: i });
        ctx.textAlign = 'center';
        if (r > 0) {
          ctx.fillStyle = '#2f6fd0';
          ctx.fillRect(x, y0 + h - bh, bw, bh);
          ctx.fillStyle = '#1e2530'; ctx.textBaseline = 'bottom';
          ctx.fillText(r.toFixed(1), x + bw / 2, y0 + h - bh - 4);
        } else {
          ctx.strokeStyle = '#c9d2dd'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(x, y0 + h - 1); ctx.lineTo(x + bw, y0 + h - 1); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#c2521c'; ctx.textBaseline = 'bottom';
          ctx.fillText('発火せず', x + bw / 2, y0 + h - 6);
        }
        ctx.fillStyle = '#68727f'; ctx.textBaseline = 'top';
        ctx.fillText(D.doses[i] + ' Hz', x + bw / 2, y0 + h + 6);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#1e2530';
      ctx.fillText('苦味を足したときの MN9 の発火率（甘味の刺激は 100 Hz のまま）', x0, 2);
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'right';
      ctx.fillText('横軸＝苦味ニューロンへの刺激', x0 + w, y0 + h + 6);
    },

    // 触角の機械感覚ニューロン（JON）を刺激したときの、中継 aBN1 と前脚への下行ニューロン aDN1・aDN2。
    // 横軸＝刺激の強さ、縦軸＝発火率（試行の平均 ± 標準偏差）
    scopeGroom: function (g, Gin, title, xlabel) {
      var G = Gin || this.D.groom, ctx = g.ctx;
      var pad = { l: 52, r: 70, t: 22, b: 30 };
      var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      var fmax = G.freqs[G.freqs.length - 1], max = 10;
      Object.keys(G.cells).forEach(function (k) {
        G.cells[k].rate.forEach(function (r, i) { max = Math.max(max, r + G.cells[k].std[i]); });
      });
      max = Math.ceil(max / 20) * 20;
      var X = function (f) { return x0 + f / fmax * w; }, Y = function (r) { return y0 + h - r / max * h; };
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var v = 0; v <= max; v += max / 4) {
        ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, Y(v) + .5); ctx.lineTo(x0 + w, Y(v) + .5); ctx.stroke();
        ctx.fillStyle = '#68727f'; ctx.fillText(v + (v === max ? ' Hz' : ''), x0 - 6, Y(v));
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      G.freqs.forEach(function (f) { ctx.fillText(f, X(f), y0 + h + 6); });
      var col = { aBN1: '#1a9e8f', aDN1: '#b5467a', aDN2: '#2f6fd0', 'GF（右）': '#1e2530', 'GF（左）': '#9aa3ad' };
      Object.keys(G.cells).forEach(function (k) {
        var c = G.cells[k], cl = col[k] || '#1e2530';
        ctx.strokeStyle = cl; ctx.fillStyle = cl; ctx.lineWidth = 2;
        ctx.beginPath();
        c.rate.forEach(function (r, i) { var x = X(G.freqs[i]), y = Y(r); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        ctx.lineWidth = 1;
        c.rate.forEach(function (r, i) {
          var x = X(G.freqs[i]);
          ctx.beginPath(); ctx.moveTo(x, Y(r - c.std[i])); ctx.lineTo(x, Y(r + c.std[i])); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, Y(r), 3, 0, Math.PI * 2); ctx.fill();
        });
        var last = c.rate[c.rate.length - 1];
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(k + ' ' + last.toFixed(0) + ' Hz', X(fmax) + 8, Y(last));
      });
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#1e2530';
      ctx.fillText(title || '触角の機械感覚ニューロン ' + G.nJon + ' 個を刺激したときの発火率（' + G.runs + ' 試行の平均 ± 標準偏差）', x0, 3);
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'right';
      ctx.fillText(xlabel || '横軸＝JON への刺激 [Hz]', x0 + w, y0 + h + 18);
    },

    scopeSilence: function (g, rowsIn, title) {
      // 甘味 100 Hz のまま、ニューロンを黙らせたときの MN9（10 試行の平均 ± 標準偏差）。
      // 横棒 1 本が 1 つの条件。縦の点線が 1 本目（基準）の値。
      // 苦味スイッチの図も同じ形なので、rows と見出しを差し替えて使う。
      var ctx = g.ctx, rows = rowsIn || this.D.silence.rows;
      var pad = { l: 250, r: 64, t: 22, b: 24 };
      var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      var max = 100, rh = h / rows.length;
      var X = function (v) { return x0 + v / max * w; };
      var col = { ref: '#9aa5b1', down: '#c2521c', up: '#2f6fd0', back: '#2f6fd0' };
      var ref = rows[0].rate;

      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'top'; ctx.textAlign = 'center';
      for (var v = 0; v <= max; v += 25) {
        ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(v) + .5, y0); ctx.lineTo(X(v) + .5, y0 + h); ctx.stroke();
        ctx.fillStyle = '#68727f'; ctx.fillText(v + (v === max ? ' Hz' : ''), X(v), y0 + h + 6);
      }

      var bh = Math.max(4, Math.min(14, rh * .6));
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], cy = y0 + (i + .5) * rh;
        ctx.fillStyle = '#1e2530'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(r.label, x0 - 8, cy);
        ctx.fillStyle = col[r.kind];
        ctx.fillRect(x0, cy - bh / 2, X(r.rate) - x0, bh);
        if (r.rate === 0) {
          ctx.fillStyle = '#c2521c'; ctx.textAlign = 'left';
          ctx.fillText('発火せず', x0 + 6, cy);
          continue;
        }
        // ばらつき（± 標準偏差）
        ctx.strokeStyle = '#1e2530'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(X(r.rate - r.sd), cy); ctx.lineTo(X(r.rate + r.sd), cy);
        ctx.moveTo(X(r.rate - r.sd), cy - 3); ctx.lineTo(X(r.rate - r.sd), cy + 3);
        ctx.moveTo(X(r.rate + r.sd), cy - 3); ctx.lineTo(X(r.rate + r.sd), cy + 3);
        ctx.stroke();
        ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left';
        ctx.fillText(Math.round(r.rate / ref * 100) + '%', X(r.rate + r.sd) + 6, cy);
      }

      // 何も黙らせないときの値
      ctx.strokeStyle = '#68727f'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(ref) + .5, y0); ctx.lineTo(X(ref) + .5, y0 + h); ctx.stroke();
      ctx.setLineDash([]);

      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#1e2530';
      ctx.fillText(title || ('ニューロンを黙らせたときの MN9 の発火率（甘味 100 Hz のまま・' +
                   rows[0].n + ' 試行の平均）'), 8, 2);
    },

    readout: function () {
      var D = this.D;
      if (this.view === 'escape' && this.top !== 'circuit') {
        var Es = D.escape, ne = Es.freqs.length - 1;
        return [
          ['刺激した神経（右目）', 'LC4 ' + Es.nLC4 + '・LPLC2 ' + Es.nLPLC2 + ' 個・最大 ' + Es.freqs[ne] + ' Hz'],
          ['GF（右）', Es.cells['GF（右）'].rate[ne].toFixed(1) + ' Hz'],
          ['GF（左）', Es.cells['GF（左）'].rate[ne].toFixed(1) + ' Hz']
        ];
      }
      if (this.view === 'groom' && this.top !== 'circuit') {
        var G = D.groom, n = G.freqs.length - 1, c = G.cells;
        return [
          ['刺激した触角の神経（JON）', G.nJon + ' 個・最大 ' + G.freqs[n] + ' Hz'],
          ['aBN1（中継）', c.aBN1.rate[n].toFixed(1) + ' Hz'],
          ['aDN1（前脚へ）', c.aDN1.rate[n].toFixed(1) + ' Hz'],
          ['aDN2（前脚へ）', c.aDN2.rate[n].toFixed(1) + ' Hz']
        ];
      }
      if (this.top === 'circuit') {
        var N = D.circuit.nodes, rk = this.taste === 'w' ? 'rw' : this.taste ? 'r200' : 'r0';
        var hz = function (k) { return N[k][rk] < 1 ? '黙っている' : N[k][rk].toFixed(0) + ' Hz'; };
        return [
          ['見ている条件', this.taste === 'w' ? '水だけ' : this.taste ? '甘味＋苦味 200 Hz' : '甘味だけ'],
          ['苦味スイッチ（主役）', hz('switchMain')],
          ['Roundup', hz('roundup')],
          ['ブレーキ', hz('brake')],
          ['MN9', hz('mn9')]
        ];
      }
      if (this.view === 'switch') {
        var sr = D.circuit.switchRows;
        return [
          ['苦味なし', sr[0].rate.toFixed(1) + ' Hz'],
          ['苦味 200 Hz', sr[1].rate < 1 ? '発火せず' : sr[1].rate.toFixed(1) + ' Hz'],
          ['主役 1 個を黙らせる', sr[2].rate.toFixed(1) + ' Hz'],
          ['スイッチ ' + D.circuit.nSwitch + ' 個を黙らせる', sr[3].rate.toFixed(1) + ' Hz']
        ];
      }
      if (this.view === 'silence' || this.view === 'silenceWater') {
        var S = this.view === 'silence' ? D.silence : D.silenceWater, rs = S.rows, ref = rs[0].rate;
        var pct = function (k) {
          var best = null;
          rs.forEach(function (r) {
            if (r.kind !== k || r.label.indexOf('1 個') < 0) return;
            if (!best || (k === 'down' ? r.rate < best.rate : r.rate > best.rate)) best = r;
          });
          return Math.round(best.rate / ref * 100) + '%';
        };
        return [
          ['試したニューロン', S.nCandidates + ' 個'],
          ['何も黙らせないとき', ref.toFixed(1) + ' Hz'],
          ['1 個で最も落とす', pct('down')],
          ['1 個で最も上げる', pct('up')],
          ['1 個で止まるもの', 'なし']
        ];
      }
      return [
        ['刺激したニューロン', D.nSugar + ' 個'],
        ['発火したニューロン', D.nActive30 + ' / ' + D.totalNeurons.toLocaleString() + ' 個'],
        ['味から口の筋肉まで', D.mn9FirstMs.toFixed(1) + ' ms'],
        ['MN9 の発火率', D.mn9Rate30.toFixed(1) + ' Hz'],
        ['苦味 200 Hz では', '発火せず']
      ];
    }
  };


  // ───────────────────────────────────────── 段7: 目で見る（flyvis）
  // flyvis の学習済みモデルに動く縁を見せた結果を再生する。計算は隣の fly-vision フォルダ。
  // 上の図: 目の画素（六角形 721 個）を縁が横切る動画と、そのときの T4a〜d の反応。
  // 下の図: 各細胞が 12 方向のどれに強く反応したか（極座標）と、65 種類の方向選択性。
  var visionMode = {
    build: function () {
      var m = this;
      m.V = globalThis.VISIONDATA;
      m.angle = '0'; m.t = 0; m.view = 'polar';
      // 六角形の座標（軸座標 u, v）→ 画面。縦横比をそろえた単位で持っておく
      m.hx = m.V.hexU.map(function (u, i) { return Math.sqrt(3) * (u + m.V.hexV[i] / 2); });
      m.hy = m.V.hexV.map(function (v) { return 1.5 * v; });
      // 縁が動く向きを、刺激そのものから測る（明るい部分の重心の動き）。
      // flyvis の角度と画面の向きの対応を、決め打ちせずデータから取るため。
      m.dir = {};
      Object.keys(m.V.movie).forEach(function (a) {
        var S = m.V.movie[a].stim, pts = [];
        S.forEach(function (row) {
          var n = 0, sx = 0, sy = 0;
          row.forEach(function (v, i) { if (v >= 5) { n++; sx += m.hx[i]; sy += m.hy[i]; } });
          var f = n / row.length;
          if (f > .1 && f < .9) pts.push([sx / n, sy / n]);
        });
        var a0 = pts[0], a1 = pts[pts.length - 1];
        var dx = a1[0] - a0[0], dy = a1[1] - a0[1], L = Math.hypot(dx, dy) || 1;
        m.dir[a] = [dx / L, dy / L];
      });
      // 色の基準: 縁が来る前からの増え方の、4 種類・4 方向を通した最大。
      // 細胞ごとに最大を 1 にすると、ほとんど反応しない細胞まで明るく光ってしまうので共通にする
      m.max = 0;
      Object.keys(m.V.movie).forEach(function (a) {
        var t4 = m.V.movie[a].t4;
        Object.keys(t4).forEach(function (c) {
          t4[c].forEach(function (v) { m.max = Math.max(m.max, v - t4[c][0]); });
        });
      });
      m.max = m.max || 1;

      ctlSeg('縁の向き', Object.keys(m.V.movie).map(function (a) {
        return { label: a + '°', value: a };
      }), m.angle, function (x) { m.angle = x; m.t = 0; });
      ctlSeg('下の図', [
        { label: '向きの好み', value: 'polar' },
        { label: '65 種類', value: 'rank' }
      ], m.view, function (x) { m.view = x; });
    },
    reset: function () { this.t = 0; },
    // 再生。模型の 1 ms ＝ 表示の 1 ms。速さのつまみで遅くできる
    step: function (ms) {
      var M = this.V.movieMs, span = M[M.length - 1] - M[0] + 300;   // 最後に少し止めてから繰り返す
      this.t = (this.t + ms) % span;
    },
    frameIndex: function () {
      var M = this.V.movieMs, t = M[0] + this.t, k = 0;
      while (k < M.length - 1 && M[k + 1] <= t) k++;
      return k;
    },
    // flyvis の角度 θ を画面の向きへ。0° と 90° の実測の向きを基底にして回す
    screenDir: function (deg) {
      var r = deg * Math.PI / 180, e0 = this.dir['0'], e9 = this.dir['90'];
      var x = Math.cos(r) * e0[0] + Math.sin(r) * e9[0], y = Math.cos(r) * e0[1] + Math.sin(r) * e9[1];
      var L = Math.hypot(x, y) || 1;
      return [x / L, y / L];
    },
    arrow: function (ctx, x, y, d, len, col, w) {
      var x2 = x + d[0] * len, y2 = y + d[1] * len;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w || 2;
      ctx.beginPath(); ctx.moveTo(x - d[0] * len, y - d[1] * len); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2 + d[0] * 2, y2 + d[1] * 2);
      ctx.lineTo(x2 - d[0] * 7 - d[1] * 5, y2 - d[1] * 7 + d[0] * 5);
      ctx.lineTo(x2 - d[0] * 7 + d[1] * 5, y2 - d[1] * 7 - d[0] * 5); ctx.closePath(); ctx.fill();
    },

    stage: function (g) {
      var m = this, V = m.V, ctx = g.ctx, k = m.frameIndex(), mv = V.movie[m.angle];
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(0, 0, g.w, g.h);

      // 左: 目の画素
      var W = g.w * .58, cx = W / 2 + 6, cy = g.h / 2 + 8;
      var ext = 0;
      m.hx.forEach(function (x, i) { ext = Math.max(ext, Math.abs(x), Math.abs(m.hy[i])); });
      var s = Math.min(W, g.h - 40) / 2 / (ext + 1);
      var row = mv.stim[k];
      for (var i = 0; i < row.length; i++) {
        var v = row[i] / 9, c = Math.round(40 + v * 200);
        ctx.fillStyle = 'rgb(' + c + ',' + c + ',' + Math.round(c * .96 + 8) + ')';
        ctx.beginPath(); ctx.arc(cx + m.hx[i] * s, cy + m.hy[i] * s, s * .95, 0, Math.PI * 2); ctx.fill();
      }
      m.arrow(ctx, cx, cy, m.dir[m.angle], Math.min(W, g.h) * .18, '#eb6834', 3);
      ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('目の画素 ' + row.length + ' 個（ハエの複眼 1 個ぶん）　オレンジ＝縁が動く向き', 8, 6);

      // 右: T4a〜d。丸の中の矢印＝その細胞が好む向き、色＝いまの反応
      var names = ['T4a', 'T4b', 'T4c', 'T4d'], x0 = W + 30, rr = Math.min(26, (g.h - 70) / 9);
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'left';
      ctx.fillText('T4（明るい縁の動きを感じる）', x0 - 10, 26);
      names.forEach(function (c, j) {
        var y = 70 + j * (rr * 2 + 18), r = mv.t4[c][k] - mv.t4[c][0];   // 縁が来る前からの増え方
        ctx.beginPath(); ctx.arc(x0 + rr, y, rr, 0, Math.PI * 2);
        ctx.fillStyle = PLOT.heat(Math.max(0, r) / m.max * 100, 100); ctx.fill();
        ctx.strokeStyle = '#5c6672'; ctx.lineWidth = 1; ctx.stroke();
        m.arrow(ctx, x0 + rr, y, m.screenDir(V.cells[c].pd), rr * .55, '#1e2530', 1.5);
        ctx.fillStyle = '#1e2530'; ctx.textBaseline = 'middle';
        ctx.fillText(c + '  ' + (r >= 0 ? '+' : '') + r.toFixed(2), x0 + rr * 2 + 8, y);
      });
      ctx.fillStyle = '#68727f'; ctx.textBaseline = 'bottom';
      ctx.fillText((V.movieMs[k] < 0 ? '縁が来る前 ' : '') + V.movieMs[k] + ' ms', x0 - 10, g.h - 6);
    },

    scope: function (g) {
      if (this.view === 'rank') return this.scopeRank(g);
      // 極座標: 12 方向への反応（最大を 1）。向きは画面と同じに回してある
      var m = this, V = m.V, ctx = g.ctx;
      var names = ['T4a', 'T4b', 'T4c', 'T4d', 'Mi1', 'Tm3'];
      var n = names.length, cw = g.w / n, R = Math.min(cw * .4, (g.h - 44) / 2);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('12 方向の縁への反応（最大を 1。外に張り出した向きが好み）  ' + V.nModels + ' モデルの平均', 8, 2);
      names.forEach(function (c, j) {
        var C = V.cells[c], x = cw * (j + .5), y = 20 + R + 4;
        ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        C.tuning.forEach(function (v, i) {
          var d = m.screenDir(V.angles[i]);
          var px = x + d[0] * R * v, py = y + d[1] * R * v;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        });
        ctx.closePath();
        var col = c.indexOf('T4') === 0 ? '#2f6fd0' : '#9aa5b1';
        ctx.fillStyle = col; ctx.globalAlpha = .25; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#1e2530'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(c + (j >= 4 ? '（手前）' : ''), x, y + R + 3);
        ctx.fillStyle = '#68727f';
        ctx.fillText('DSI ' + C.dsi.toFixed(2), x, y + R + 16);
      });
    },

    scopeRank: function (g) {
      // 65 種類の方向選択性（ON と OFF の大きいほう）。T4・T5 がどこにいるか
      var V = this.V, ctx = g.ctx, rows = V.allDsi.slice().sort(function (a, b) { return b[1] - a[1]; });
      var pad = { l: 40, r: 10, t: 20, b: 22 };
      var w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b, bw = w / rows.length;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('視葉の細胞 ' + rows.length + ' 種類の方向選択性（DSI、左ほど向きにうるさい）', 8, 2);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#68727f';
      [0, .25, .5].forEach(function (v) {
        var y = pad.t + h - v / .6 * h;
        ctx.strokeStyle = '#e4e9f0'; ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(pad.l + w, y + .5); ctx.stroke();
        ctx.fillText(v.toFixed(2), pad.l - 4, y);
      });
      rows.forEach(function (r, i) {
        var c = r[0], col = c.indexOf('T4') === 0 ? '#2f6fd0' : c.indexOf('T5') === 0 ? '#eb6834' : '#c9d2dd';
        var bh = Math.min(1, r[1] / .6) * h;
        ctx.fillStyle = col; ctx.fillRect(pad.l + i * bw + .5, pad.t + h - bh, Math.max(1, bw - 1), bh);
      });
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#2f6fd0'; ctx.fillText('■ T4', pad.l, pad.t + h + 5);
      ctx.fillStyle = '#eb6834'; ctx.fillText('■ T5', pad.l + 44, pad.t + h + 5);
      ctx.fillStyle = '#68727f'; ctx.fillText('■ そのほか', pad.l + 88, pad.t + h + 5);
    },

    readout: function () {
      var V = this.V, mv = V.movie[this.angle], k = this.frameIndex(), m = this;
      var best = null;
      ['T4a', 'T4b', 'T4c', 'T4d'].forEach(function (c) {
        var r = (mv.t4[c][k] - mv.t4[c][0]) / m.max;
        if (!best || r > best[1]) best = [c, r];
      });
      var mean = function (l) { return l.reduce(function (s, c) { return s + V.cells[c].dsi; }, 0) / l.length; };
      return [
        ['縁の向き', this.angle + '°'],
        ['いちばん反応している T4', V.movieMs[k] < 0 || best[1] < .2 ? '—' : best[0]],
        ['T4 の DSI', mean(['T4a', 'T4b', 'T4c', 'T4d']).toFixed(2)],
        ['手前の細胞の DSI', mean(['Mi1', 'Tm3', 'Mi4', 'Mi9']).toFixed(2)]
      ];
    },
    clock: function () { return 'flyvis で計算済みの結果を再生（' + this.V.movieMs[this.frameIndex()] + ' ms）'; }
  };


  // ───────────────────────────────────────── 段8: 歩く（FlyGym / NeuroMechFly）
  // FlyGym で体の物理シミュレーションをした記録を 3D で再生する。計算は隣の fly-body フォルダ（WSL）。
  // 3D は外部ライブラリを使わず、ここで座標を回して平行投影し、奥から順に描く。
  var LEG_JP = { lf: '左前', lm: '左中', lh: '左後', rf: '右前', rm: '右中', rh: '右後' };
  var TRIPOD_A = { lf: 1, rm: 1, lh: 1 };      // 三脚歩行で一緒に動く組（もう一組は rf・lm・rh）

  // 体の色。体は灰色、目は濃い赤、脚は三脚歩行の 2 組を青と緑で塗り分ける（目の赤と混ざらないように）
  var BODY_COL = { antenna: '#e0b400', body: '#8e9399', thorax: '#8e9399', head: '#555a61', headpart: '#555a61', mouth: '#b58a5c', abd: '#b8bdc4', eye: '#8f1d1d', wing: '#b8c7d8',
                   legA: '#2f6fd0', legB: '#2e9e5b' };

  // 部位を 1 つ描く。頭と目は丸いので球（円）で、それ以外は太さのある棒で描く。
  // 全部を「いちばん長い軸の棒」にすると、頭が縦長になり、目が横に突き出て見えた
  function drawPart(ctx, a, b, kd, width, S) {
    if (kd === 'antenna') {
      ctx.strokeStyle = BODY_COL.antenna; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.2, 0.05 * S);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      return;
    }
    // 触角の部品そのものは描かない（antennaLines の線で描く）
    if (kd === 'headpart') return;
    ctx.globalAlpha = kd === 'wing' ? .45 : 1;
    if (kd === 'head' || kd === 'eye' || kd === 'thorax') {
      ctx.fillStyle = BODY_COL[kd];
      ctx.beginPath();
      ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(1.5, width * (kd === 'eye' ? 1.0 : 1.15) * S), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = BODY_COL[kd]; ctx.lineCap = 'round';
      // 口（吸い口）は細く。形の大きさから太さを出すと、実物より太い棒に見えた
      ctx.lineWidth = Math.max(1, width * 2 * S * (kd === 'mouth' ? 0.4 : 1));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 果物（段9 のごちそう）を描く。x, y は画面上の中心、r は半径
  function drawFruit(ctx, kind, x, y, r) {
    function disc(cx, cy, rr, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill(); }
    if (kind === 'grape') {
      [[0, .35], [.5, .35], [-.25, .8], [.25, .8], [0, -.2]].forEach(function (d) {
        disc(x + d[0] * r, y + d[1] * r - r * .3, r * .5, '#6b1f7d');
      });
    } else if (kind === 'banana') {
      disc(x, y, r, '#e6c629'); disc(x, y, r * .82, '#fbf0a6');
    } else {
      disc(x, y, r, '#c41414');
      ctx.strokeStyle = '#5a3514'; ctx.lineWidth = Math.max(1, r * .15);
      ctx.beginPath(); ctx.moveTo(x, y - r * .8); ctx.lineTo(x, y - r * 1.3); ctx.stroke();
      ctx.fillStyle = '#3c9a2a'; ctx.beginPath();
      ctx.ellipse(x + r * .35, y - r * 1.2, r * .4, r * .16, -0.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 触角（柄節・梗節・毛）の番号を左右ごとに集める
  function antennaIdx(parts) {
    return ['l', 'r'].map(function (sd) {
      return ['pedicel', 'funiculus', 'arista'].map(function (n) { return parts.indexOf(sd + '_' + n); })
        .filter(function (i) { return i >= 0; });
    });
  }
  // 触角を、頭に付いている根元を中心に k 倍に伸ばした部位の並びを返す（元の並びは変えない）。
  // 3 つの部品を 1 本ずつ伸ばすと、つなぎ目がずれるので、根元からまとめて引き伸ばす
  function stretchAntennae(F, ant, headIdx, k) {
    var G = F.slice(), h = F[headIdx];
    var hc = [(h[0] + h[3]) / 2, (h[1] + h[4]) / 2, (h[2] + h[5]) / 2];
    ant.forEach(function (idx) {
      if (!idx.length) return;
      var p = F[idx[0]];                                  // 柄節の両端のうち、頭に近いほうが根元
      var d0 = Math.hypot(p[0] - hc[0], p[1] - hc[1], p[2] - hc[2]);
      var d1 = Math.hypot(p[3] - hc[0], p[4] - hc[1], p[5] - hc[2]);
      var b = d0 < d1 ? [p[0], p[1], p[2]] : [p[3], p[4], p[5]];
      idx.forEach(function (i) {
        var q = F[i];
        G[i] = [0, 1, 2, 3, 4, 5].map(function (j) { return b[j % 3] + (q[j] - b[j % 3]) * k; });
      });
    });
    return G;
  }

  // 触角を 1 本の細長い線にする（黄色）。部品の形をそのまま棒にすると、頭の前を横切る横棒になり
  // 吸い口と十字に見えたので、付け根（柄節の中心）から「前へ・少し外へ・少し上へ」まっすぐ伸ばす。
  // 返す値は [根元 x, y, z, 先端 x, y, z]（部位と同じ 1/100 mm 単位）。L は長さ
  function antennaLines(F, ant, headIdx, L) {
    function mid(q) { return [(q[0] + q[3]) / 2, (q[1] + q[4]) / 2, (q[2] + q[5]) / 2]; }
    function unit(v) { var n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
    var hc = mid(F[headIdx]), tc = mid(F[0]);
    var fw = unit([hc[0] - tc[0], hc[1] - tc[1], 0]);          // 体の前向き（水平）
    return ant.filter(function (idx) { return idx.length; }).map(function (idx) {
      var r = mid(F[idx[0]]);
      var o = [r[0] - hc[0], r[1] - hc[1], 0], f = o[0] * fw[0] + o[1] * fw[1];
      var side = unit([o[0] - f * fw[0], o[1] - f * fw[1], 0]); // 頭の中心から見た外向き
      var d = unit([fw[0] + side[0] * .45, fw[1] + side[1] * .45, .35]);
      return [r[0], r[1], r[2], r[0] + d[0] * L, r[1] + d[1] * L, r[2] + d[2] * L];
    });
  }

  // 吸い口（根元 rostrum → 先端 haustellum）を、根元から先端へ向かう 1 本の線にそろえる。
  // どちらも「形のいちばん長い向きの棒」で描くと、先端の部品は横幅のほうが長いので横向きになり、
  // 根元の縦の棒と直角に交わって十字に見えた
  function alignMouth(F, parts, ext) {
    var r = parts.indexOf('c_rostrum'), h = parts.indexOf('c_haustellum');
    if (r < 0 || h < 0) return F;
    var G = F.slice();
    var mid = function (q) { return [(q[0] + q[3]) / 2, (q[1] + q[4]) / 2, (q[2] + q[5]) / 2]; };
    var a = mid(F[r]), b = mid(F[h]);
    var e = ext === undefined ? 0.8 : ext;
    var tip = [0, 1, 2].map(function (j) { return b[j] + (b[j] - a[j]) * e; });
    G[r] = a.concat(b);
    G[h] = b.concat(tip);
    return G;
  }

  // 頭の先の地面に、ハエが向いている向きの矢印を描く。P は mm → 画面の関数、F はそのコマの部位
  function headArrow(ctx, P, F, headIdx) {
    var th = F[0], hd = F[headIdx];
    var tx = (th[0] + th[3]) / 200, ty = (th[1] + th[4]) / 200;
    var hx = (hd[0] + hd[3]) / 200, hy = (hd[1] + hd[4]) / 200;
    var dx = hx - tx, dy = hy - ty, L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    var a = P(hx + dx * 0.5, hy + dy * 0.5, 0), b = P(hx + dx * 2.2, hy + dy * 2.2, 0);
    var vx = b[0] - a[0], vy = b[1] - a[1], vl = Math.hypot(vx, vy) || 1;
    vx /= vl; vy /= vl;
    ctx.strokeStyle = '#1e2530'; ctx.fillStyle = '#1e2530'; ctx.globalAlpha = .55; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0] - vx * 6, b[1] - vy * 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - vx * 11 - vy * 6, b[1] - vy * 11 + vx * 6);
    ctx.lineTo(b[0] - vx * 11 + vy * 6, b[1] - vy * 11 - vx * 6); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  var walkMode = {
    build: function () {
      var m = this;
      m.B = globalThis.BODYDATA;
      m.gait = 'tripod'; m.t = 0;
      m.yaw = -0.6; m.pitch = 0.45;           // 視点（ラジアン）
      m.rate = 0.2;                           // 再生の速さ: 実時間の 1/5（「速さ」のつまみと掛け合わせる）
      // 部位ごとの色の種類
      m.kind = m.B.parts.map(function (p) {
        var leg = p.slice(0, 2);
        if (LEG_JP[leg] && p.charAt(2) === '_') return TRIPOD_A[leg] ? 'legA' : 'legB';
        if (p.indexOf('wing') > -1) return 'wing';
        if (p.indexOf('eye') > -1) return 'eye';
        if (/head/.test(p)) return 'head';
        if (p === 'c_thorax') return 'thorax';
        if (/rostrum|haustellum/.test(p)) return 'mouth';            // 口（吸い口）
        if (/pedicel|funiculus|arista/.test(p)) return 'headpart';     // 触角
        if (p.indexOf('abdomen') > -1) return 'abd';
        return 'body';
      });
      m.headIdx = m.B.parts.indexOf('c_head');
      m.ant = antennaIdx(m.B.parts);
      m.foot = {};                            // 脚の名前 → 脚先（tarsus5）の部位番号
      m.B.parts.forEach(function (p, i) { if (/_tarsus5$/.test(p)) m.foot[p.slice(0, 2)] = i; });

      ctlSeg('歩き方', [
        { label: '三脚', value: 'tripod' },
        { label: '四脚', value: 'tetrapod' },
        { label: '波', value: 'wave' }
      ], m.gait, function (x) { m.gait = x; m.t = 0; });
      ctlSeg('視点', [
        { label: '斜め', value: 'oblique' },
        { label: '横', value: 'side' },
        { label: '真上', value: 'top' }
      ], 'oblique', function (x) {
        var v = { oblique: [-0.6, 0.45], side: [0, 0.05], top: [0, 1.5] }[x];
        m.yaw = v[0]; m.pitch = v[1];
      });

      // ドラッグで視点を回す
      var cv = el.stage;
      cv.classList.add('grab');
      m._down = function (ev) {
        m.drag = [ev.clientX, ev.clientY, m.yaw, m.pitch];
        cv.classList.add('grabbing'); cv.setPointerCapture(ev.pointerId);
      };
      m._move = function (ev) {
        if (!m.drag) return;
        m.yaw = m.drag[2] + (ev.clientX - m.drag[0]) * 0.01;
        m.pitch = Math.max(-0.1, Math.min(1.55, m.drag[3] + (ev.clientY - m.drag[1]) * 0.01));
      };
      m._up = function (ev) {
        m.drag = null; cv.classList.remove('grabbing');
        if (cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
      };
      cv.addEventListener('pointerdown', m._down);
      cv.addEventListener('pointermove', m._move);
      cv.addEventListener('pointerup', m._up);
      cv.addEventListener('pointercancel', m._up);
      // ホイールで拡大縮小。ページがスクロールしないよう止める
      m.zoom = 1;
      m._wheel = function (ev) {
        if (ev.preventDefault) ev.preventDefault();
        m.zoom = Math.max(0.3, Math.min(6, m.zoom * Math.exp(-(ev.deltaY || 0) * 0.0015)));
      };
      cv.addEventListener('wheel', m._wheel, { passive: false });
    },
    unbind: function () {
      var cv = el.stage;
      cv.classList.remove('grab', 'grabbing');
      cv.removeEventListener('pointerdown', this._down);
      cv.removeEventListener('pointermove', this._move);
      cv.removeEventListener('pointerup', this._up);
      cv.removeEventListener('pointercancel', this._up);
      cv.removeEventListener('wheel', this._wheel);
    },
    reset: function () { this.t = 0; },
    step: function (ms) { this.t = (this.t + ms * this.rate) % (this.B.seconds * 1000); },
    frame: function () {
      var G = this.B.gaits[this.gait];
      return Math.min(G.pos.length - 1, Math.floor(this.t / 1000 * this.B.fps));
    },

    stage: function (g) {
      var m = this, B = m.B, ctx = g.ctx, G = B.gaits[m.gait], k = m.frame(), F = G.pos[k];
      var cy = Math.cos(m.yaw), sy = Math.sin(m.yaw), cp = Math.cos(m.pitch), sp = Math.sin(m.pitch);
      // 視点の中心 = 胸（部位 0）の真ん中。歩いても画面の中央に置く
      var c0 = [(F[0][0] + F[0][3]) / 200, (F[0][1] + F[0][4]) / 200, 0];
      var S = Math.min(g.w, g.h) / 5.5 * m.zoom; // 1 mm が何ピクセルか（ホイールで拡大縮小）
      var ox = g.w / 2, oy = g.h * 0.55;
      function P(x, y, z) {                      // mm → 画面。戻り値の [2] は奥行き（大きいほど奥）
        x -= c0[0]; y -= c0[1]; z -= c0[2];
        var xr = cy * x - sy * y, yr = sy * x + cy * y;
        // 上から見下ろす視点: 奥（yr が大きい）ほど画面の上へ、高い（z が大きい）ほど手前。
        // 以前は奥行きの符号が逆で、下から見上げた裏返しの絵になっていた
        return [ox + xr * S, oy - (z * cp + yr * sp) * S, yr * cp - z * sp];
      }
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(0, 0, g.w, g.h);

      // 地面の格子（1 mm 刻み）。歩いた分だけ流れて見える
      ctx.strokeStyle = '#e1e6ee'; ctx.lineWidth = 1;
      var gx0 = Math.floor(c0[0]) - 6, gy0 = Math.floor(c0[1]) - 6;
      for (var i = 0; i <= 12; i++) {
        var a = P(gx0 + i, gy0, 0), b = P(gx0 + i, gy0 + 12, 0);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        a = P(gx0, gy0 + i, 0); b = P(gx0 + 12, gy0 + i, 0);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      // 胸が通ってきた跡
      ctx.strokeStyle = '#c9d2dd'; ctx.lineWidth = 2; ctx.beginPath();
      for (var j = 0; j <= k; j++) {
        var q = P((G.pos[j][0][0] + G.pos[j][0][3]) / 200, (G.pos[j][0][1] + G.pos[j][0][4]) / 200, 0);
        if (j) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      }
      ctx.stroke();
      // 踏ん張っている脚先の、地面の上の印
      B.legs.forEach(function (leg, li) {
        if (!G.stance[li][k]) return;
        var f = F[m.foot[leg]], q = P(f[3] / 100, f[4] / 100, 0);
        ctx.fillStyle = TRIPOD_A[leg] ? BODY_COL.legA : BODY_COL.legB; ctx.globalAlpha = .35;
        ctx.beginPath(); ctx.ellipse(q[0], q[1], 7, 7 * Math.max(.25, Math.sin(m.pitch)), 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      });

      headArrow(ctx, P, F, m.headIdx);

      // 体の部位を、奥から順に太さのある棒として描く
      var segs = alignMouth(F, m.B.parts).map(function (s, i) {
        var a = P(s[0] / 100, s[1] / 100, s[2] / 100), b = P(s[3] / 100, s[4] / 100, s[5] / 100);
        return { a: a, b: b, d: (a[2] + b[2]) / 2, i: i };
      }).sort(function (u, v) { return v.d - u.d; });
      antennaLines(F, m.ant, m.headIdx, 80).forEach(function (s) {
        var a = P(s[0] / 100, s[1] / 100, s[2] / 100), b = P(s[3] / 100, s[4] / 100, s[5] / 100);
        segs.push({ a: a, b: b, d: (a[2] + b[2]) / 2, i: -1 });
      });
      segs.sort(function (u, v) { return v.d - u.d; });
      segs.forEach(function (s) { drawPart(ctx, s.a, s.b, s.i < 0 ? 'antenna' : m.kind[s.i], B.width[s.i], S); });

      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('ドラッグで回転・ホイールで拡大縮小　格子は 1 mm　黒い矢印＝頭の向き（頭は濃い灰・目は赤）', 8, 6);
      ctx.fillStyle = '#2f6fd0'; ctx.fillText('■ 左前・右中・左後', 8, 22);
      ctx.fillStyle = BODY_COL.legB; ctx.fillText('■ 右前・左中・右後', 120, 22);
    },

    scope: function (g) {
      // 歩行図: 脚ごとに、踏ん張っている時間を帯で描く。縦線がいま
      var m = this, B = m.B, G = B.gaits[m.gait], ctx = g.ctx, k = m.frame();
      var order = ['lf', 'lm', 'lh', 'rf', 'rm', 'rh'];
      var pad = { l: 44, r: 12, t: 22, b: 22 };
      var w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b, rh = h / 6, n = G.pos.length;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('歩行図: 帯＝その脚が地面を踏ん張っている時間（' + B.seconds + ' 秒ぶん）', 8, 2);
      order.forEach(function (leg, r) {
        var li = B.legs.indexOf(leg), y = pad.t + r * rh;
        ctx.fillStyle = '#68727f'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(LEG_JP[leg], pad.l - 6, y + rh / 2);
        ctx.fillStyle = TRIPOD_A[leg] ? BODY_COL.legA : BODY_COL.legB;
        for (var j = 0; j < n; j++) {
          if (!G.stance[li][j]) continue;
          ctx.fillRect(pad.l + j / n * w, y + rh * .18, w / n + .6, rh * .64);
        }
      });
      var x = pad.l + (k + .5) / n * w;
      ctx.strokeStyle = '#1e2530'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + h); ctx.stroke();
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText('時間 →', pad.l + w, pad.t + h + 5);
    },

    readout: function () {
      var B = this.B, G = B.gaits[this.gait], k = this.frame();
      var on = G.stance.reduce(function (s, row) { return s + row[k]; }, 0);
      return [
        ['歩き方', { tripod: '三脚', tetrapod: '四脚', wave: '波' }[this.gait]],
        ['速さ', G.speed.toFixed(1) + ' mm/s'],
        ['いま踏ん張っている脚', on + ' 本'],
        ['脚のリズム', B.freqHz + ' 回/秒']
      ];
    },
    clock: function () {
      return 'FlyGym で計算済みの結果を再生（実時間の 1/' + Math.round(1 / this.rate) + '・' +
        Math.round(this.t) + ' ms）';
    }
  };


  // ───────────────────────────────────────── 段9: 脳で動く（目 → 視覚系モデル → 曲がる → 脚）
  // FlyGym の体を、flyvis の視覚系モデルと簡単な規則で操縦させた記録を再生する。計算は fly-body（WSL）。
  var driveMode = {
    build: function () {
      var m = this;
      // 配置ごとの記録。run_patterns.py が runs にまとめる（古い形の 1 回ぶんにも対応）
      m.runs = globalThis.BRAINDRIVE.runs || [globalThis.BRAINDRIVE];
      if (!(m.run < m.runs.length)) m.run = 0;
      m.R = m.runs[m.run];
      m.t = 0; m.cam = 'follow'; m.yaw = -0.5; m.pitch = 0.6;
      m.rate = 0.25;                          // 実時間の 1/4
      m.kind = m.R.parts.map(function (p) {
        var leg = p.slice(0, 2);
        if (LEG_JP[leg] && p.charAt(2) === '_') return TRIPOD_A[leg] ? 'legA' : 'legB';
        if (p.indexOf('wing') > -1) return 'wing';
        if (p.indexOf('eye') > -1) return 'eye';
        if (/head/.test(p)) return 'head';
        if (p === 'c_thorax') return 'thorax';
        if (/rostrum|haustellum/.test(p)) return 'mouth';            // 口（吸い口）
        if (/pedicel|funiculus|arista/.test(p)) return 'headpart';     // 触角
        if (p.indexOf('abdomen') > -1) return 'abd';
        return 'body';
      });
      // 六角形の画素の画面上の位置。目の上半分（空が見える列）が上に来るよう回す
      var hx = m.R.hexU.map(function (u, i) { return Math.sqrt(3) * (u + m.R.hexV[i] / 2); });
      var hy = m.R.hexV.map(function (v) { return 1.5 * v; });
      m.hexXY = [0, 1].map(function (e) {
        var up = m.R.upper[e], ux = 0, uy = 0, n = 0;
        up.forEach(function (f, i) { if (f) { ux += hx[i]; uy += hy[i]; n++; } });
        var a = Math.atan2(uy / n, ux / n) - Math.PI / 2;            // 上半分の重心が真上に来る角度
        var ca = Math.cos(a), sa = Math.sin(a);
        return hx.map(function (x, i) { return [ca * x + sa * hy[i], -(-sa * x + ca * hy[i])]; });
      });
      m.headIdx = m.R.parts.indexOf('c_head');
      m.ant = antennaIdx(m.R.parts);
      m.hexExt = 0;
      m.hexXY[0].forEach(function (q) { m.hexExt = Math.max(m.hexExt, Math.abs(q[0]), Math.abs(q[1])); });

      if (m.runs.length > 1)
        ctlSeg('配置', m.runs.map(function (r, i) {
          var n = r.foods.filter(function (f) { return f[3] !== null; }).length;
          return { label: (i + 1) + '（' + n + '/' + r.foods.length + '個）', value: i };
        }), m.run, function (i) { m.run = i; m.R = m.runs[i]; m.t = 0; });
      ctlSeg('視点', [
        { label: '追いかける', value: 'follow' },
        { label: '真上から全体', value: 'top' }
      ], m.cam, function (x) {
        m.cam = x;
        if (x === 'top') { m.yaw = 0; m.pitch = 1.5; } else { m.yaw = -0.5; m.pitch = 0.6; }
      });
      var cv = el.stage;
      cv.classList.add('grab');
      m._down = function (ev) { m.drag = [ev.clientX, ev.clientY, m.yaw, m.pitch]; cv.setPointerCapture(ev.pointerId); };
      m._move = function (ev) {
        if (!m.drag) return;
        m.yaw = m.drag[2] + (ev.clientX - m.drag[0]) * 0.01;
        m.pitch = Math.max(0, Math.min(1.55, m.drag[3] + (ev.clientY - m.drag[1]) * 0.01));
      };
      m._up = function (ev) {
        m.drag = null;
        if (cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
      };
      cv.addEventListener('pointerdown', m._down);
      cv.addEventListener('pointermove', m._move);
      cv.addEventListener('pointerup', m._up);
      cv.addEventListener('pointercancel', m._up);
      // ホイールで拡大縮小。ページがスクロールしないよう止める
      m.zoom = 1;
      m._wheel = function (ev) {
        if (ev.preventDefault) ev.preventDefault();
        m.zoom = Math.max(0.3, Math.min(6, m.zoom * Math.exp(-(ev.deltaY || 0) * 0.0015)));
      };
      cv.addEventListener('wheel', m._wheel, { passive: false });
    },
    unbind: function () {
      var cv = el.stage;
      cv.classList.remove('grab', 'grabbing');
      cv.removeEventListener('pointerdown', this._down);
      cv.removeEventListener('pointermove', this._move);
      cv.removeEventListener('pointerup', this._up);
      cv.removeEventListener('pointercancel', this._up);
      cv.removeEventListener('wheel', this._wheel);
    },
    reset: function () { this.t = 0; },
    step: function (ms) { this.t = (this.t + ms * this.rate) % (this.R.seconds * 1000); },
    frame: function () { return Math.min(this.R.t.length - 1, Math.floor(this.t / 1000 * this.R.fps)); },

    // いまの判断。目の規則の 2 つの項のどちらが効いているか、または触覚の反射か
    decision: function (k) {
      var R = this.R, md = R.mode[k];
      if (md === 1) return ['後ずさり（触覚の反射）', '#c2521c'];
      if (md === 2) return ['向きを変える（触覚の反射）', '#c2521c'];
      if (md === 3) return [(R.turn[k] > 0 ? '右' : '左') + 'へサッカード（目: T4・T5）', '#2f6fd0'];
      if (md === 4) return ['ごちそうが近い: ゆっくり・その場で向きを変える（目: 色）', '#1a9e8f'];
      if (md === 5) return ['味見: 止まって口を付ける', '#9a7b12'];
      if (md === 11) return ['影が迫る → LC4 ' + R.loom[k].toFixed(0) + ' Hz → 全脳で GF ' + R.gf[k].toFixed(0) + ' Hz: 飛び立って逃げる', '#1e2530'];
      if (R.loom && R.loom[k] > 0) return ['影が迫る: LC4 ' + R.loom[k].toFixed(0) + ' Hz → GF ' + R.gf[k].toFixed(0) + ' Hz', '#5a6270'];
      if (md === 10) return ['触角に汚れ → 全脳で aDN1 ' + R.adn1[k].toFixed(0) + ' Hz: 前脚で身づくろい', '#b5467a'];
      if (md === 6) return ['甘い → MN9 ' + R.mn9[k].toFixed(0) + ' Hz: 吸い口を伸ばして食べる（段6 の全脳）', '#2e8b3e'];
      if (md === 7) return ['苦い → MN9 ' + R.mn9[k].toFixed(0) + ' Hz: 食べない。もう寄らない（苦味スイッチ）', '#c2521c'];
      if (Math.abs(R.turn[k]) < 0.12) return ['まっすぐ', '#68727f'];
      return [(R.turn[k] > 0 ? '右' : '左') + 'のごちそうへ（目: 色）', '#1a9e8f'];
    },

    stage: function (g) {
      var m = this, R = m.R, ctx = g.ctx, k = m.frame(), F = R.pos[k];
      ctx.fillStyle = '#fbfcfe'; ctx.fillRect(0, 0, g.w, g.h);
      var W = g.w * 0.62;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, g.h); ctx.clip();
      m.draw3d(ctx, W, g.h, k, F);
      ctx.restore();
      m.drawEyes(ctx, W + 6, g.w - W - 10, g.h, k);
    },

    draw3d: function (ctx, w, h, k, F) {
      var m = this, R = m.R;
      var cy = Math.cos(m.yaw), sy = Math.sin(m.yaw), cp = Math.cos(m.pitch), sp = Math.sin(m.pitch);
      var c0, S;
      if (m.cam === 'top') {
        var xs = R.pillars.concat(R.foods).map(function (o) { return o[0]; }).concat([0]);
        var ys = R.pillars.concat(R.foods).map(function (o) { return o[1]; }).concat([0]);
        c0 = [(Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2, 0];
        S = Math.min(w / (Math.max.apply(null, xs) - Math.min.apply(null, xs) + 6), h / (Math.max.apply(null, ys) - Math.min.apply(null, ys) + 6)) * m.zoom;
      } else {
        c0 = [(F[0][0] + F[0][3]) / 200, (F[0][1] + F[0][4]) / 200, 0];
        S = Math.min(w, h) / 9 * m.zoom;
      }
      var ox = w / 2, oy = h * 0.55;
      function P(x, y, z) {
        x -= c0[0]; y -= c0[1]; z -= c0[2];
        var xr = cy * x - sy * y, yr = sy * x + cy * y;
        // 上から見下ろす視点: 奥（yr が大きい）ほど画面の上へ、高い（z が大きい）ほど手前。
        // 以前は奥行きの符号が逆で、下から見上げた裏返しの絵になっていた
        return [ox + xr * S, oy - (z * cp + yr * sp) * S, yr * cp - z * sp];
      }
      // 地面の格子（2 mm 刻み）
      ctx.strokeStyle = '#e1e6ee'; ctx.lineWidth = 1;
      var gx0 = Math.floor(c0[0] / 2) * 2 - 16, gy0 = Math.floor(c0[1] / 2) * 2 - 16;
      for (var i = 0; i <= 16; i++) {
        var a = P(gx0 + i * 2, gy0, 0), b = P(gx0 + i * 2, gy0 + 32, 0);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        a = P(gx0, gy0 + i * 2, 0); b = P(gx0 + 32, gy0 + i * 2, 0);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      // 歩いた跡。触覚の反射中はオレンジ
      for (var j = 1; j <= k; j++) {
        var p0 = R.pos[j - 1][0], p1 = R.pos[j][0];
        var q0 = P((p0[0] + p0[3]) / 200, (p0[1] + p0[4]) / 200, 0), q1 = P((p1[0] + p1[3]) / 200, (p1[1] + p1[4]) / 200, 0);
        ctx.strokeStyle = R.mode[j] ? '#eb6834' : '#9aa5b1'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke();
      }
      headArrow(ctx, P, F, m.headIdx);

      // 柱・ごちそう・体を、奥から順に描く
      var items = [];
      // 柱は円柱として描く（側面に左右の影、上面の楕円、輪郭線）。太い線で描くと板に見え、
      // 重なると見分けがつかなかった
      R.pillars.forEach(function (pl) {
        var b = P(pl[0], pl[1], 0), t = P(pl[0], pl[1], 6);
        items.push({ d: (b[2] + t[2]) / 2, draw: function () {
          var R0 = pl[2] * S, ax = t[0] - b[0], ay = t[1] - b[1], L = Math.hypot(ax, ay) || 1;
          var nx = -ay / L, ny = ax / L;                             // 軸に垂直な向き（画面上）
          var ry = R0 * Math.max(0.08, Math.abs(Math.sin(m.pitch))); // 上面の楕円のつぶれ具合
          var ang = Math.atan2(ny, nx);
          var gr = ctx.createLinearGradient(b[0] - nx * R0, b[1] - ny * R0, b[0] + nx * R0, b[1] + ny * R0);
          gr.addColorStop(0, '#565d69'); gr.addColorStop(0.45, '#2a2e35'); gr.addColorStop(1, '#15171b');
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.moveTo(b[0] + nx * R0, b[1] + ny * R0); ctx.lineTo(t[0] + nx * R0, t[1] + ny * R0);
          ctx.lineTo(t[0] - nx * R0, t[1] - ny * R0); ctx.lineTo(b[0] - nx * R0, b[1] - ny * R0);
          ctx.ellipse(b[0], b[1], R0, ry, ang, Math.PI, 0, true);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#0b0c0e'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = '#6b7380';                                   // 上面
          ctx.beginPath(); ctx.ellipse(t[0], t[1], R0, ry, ang, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } });
      });
      var now = R.t[k];
      R.foods.forEach(function (f) {
        if (f[3] !== null && now >= f[3]) return;                   // 食べたあとは消す
        var c = P(f[0], f[1], f[2]), r = Math.max(3, f[2] * S);
        var nope = f[6] !== null && f[6] !== undefined && now >= f[6];     // 苦くて食べなかった
        items.push({ d: c[2], draw: function () {
          drawFruit(ctx, f[4] || 'apple', c[0], c[1], r);
          if (nope) {
            ctx.strokeStyle = '#c2521c'; ctx.lineWidth = Math.max(2, r * .25);
            ctx.beginPath(); ctx.moveTo(c[0] - r, c[1] - r * 2.4); ctx.lineTo(c[0] + r, c[1] - r * 0.8);
            ctx.moveTo(c[0] + r, c[1] - r * 2.4); ctx.lineTo(c[0] - r, c[1] - r * 0.8); ctx.stroke();
          }
        } });
      });
      // 迫る影 = ハエたたき（面と網目と柄）。記録の位置と向き（四元数）から角を出して描く
      if (R.threat && R.threat[k]) {
        var tq = R.threat[k], qq = (R.threatQ && R.threatQ[k]) || [1, 0, 0, 0];
        var rot = function (v) {                                   // 四元数で回して位置を足す
          var w = qq[0], x = qq[1], y = qq[2], z = qq[3];
          var tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
          return P(tq[0] + v[0] + w * tx + (y * tz - z * ty), tq[1] + v[1] + w * ty + (z * tx - x * tz),
                   tq[2] + v[2] + w * tz + (x * ty - y * tx));
        };
        var SW = 3.2, SH = 2.8, cs = [[-SW, -SH, 0], [SW, -SH, 0], [SW, SH, 0], [-SW, SH, 0]].map(rot);
        var h0 = rot([0, SH, 0]), h1 = rot([0, SH + 16, -8]);
        items.push({ d: rot([0, 0, 0])[2], draw: function () {
          ctx.strokeStyle = '#1b1f26'; ctx.lineWidth = Math.max(2, .7 * S); ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(h0[0], h0[1]); ctx.lineTo(h1[0], h1[1]); ctx.stroke();
          ctx.fillStyle = 'rgba(20,23,30,.88)'; ctx.beginPath();
          cs.forEach(function (c, i) { if (i) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]); });
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(120,130,145,.8)'; ctx.lineWidth = 1;
          for (var g = -3; g <= 3; g++) {                         // 網目
            var a = rot([g * SW / 4, -SH, 0]), b = rot([g * SW / 4, SH, 0]);
            var c = rot([-SW, g * SH / 4, 0]), e = rot([SW, g * SH / 4, 0]);
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
          }
        } });
      }
      // 食べている間（MN9 が発火している間）は吸い口を伸ばす
      alignMouth(F, m.R.parts, R.mode[k] === 6 ? 3.5 : 0.8).forEach(function (s, i) {
        var a = P(s[0] / 100, s[1] / 100, s[2] / 100), b = P(s[3] / 100, s[4] / 100, s[5] / 100);
        items.push({ d: (a[2] + b[2]) / 2, draw: function () { drawPart(ctx, a, b, m.kind[i], R.width[i], S); } });
      });
      antennaLines(F, m.ant, m.headIdx, 80).forEach(function (s) {
        var a = P(s[0] / 100, s[1] / 100, s[2] / 100), b = P(s[3] / 100, s[4] / 100, s[5] / 100);
        items.push({ d: (a[2] + b[2]) / 2, draw: function () { drawPart(ctx, a, b, 'antenna', 0, S); } });
      });
      items.sort(function (u, v) { return v.d - u.d; }).forEach(function (it) { it.draw(); });

      var dc = m.decision(k);
      ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff'; ctx.globalAlpha = .85; ctx.fillRect(4, 4, 380, 36); ctx.globalAlpha = 1;
      ctx.fillStyle = dc[1]; ctx.fillText('いまの判断: ' + dc[0], 8, 7);
      ctx.fillStyle = '#68727f'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('果物＝ごちそう　■ 柱　黒い矢印＝頭の向き　ドラッグで回転・ホイールで拡大', 8, 24);
    },

    drawEyes: function (ctx, x0, w, h, k) {
      // 上: 目に映った明るさ　下: T4・T5（動きを感じる細胞）の反応。左右の目を並べる
      var m = this, R = m.R;
      var cw = w / 2, rows = [['目に映った明るさ', R.eye[k], 'lum'], ['T4・T5 の反応（動き）', R.motion[k], 'mot']];
      var rh = (h - 24) / 2, s = Math.min(cw, rh - 14) / 2 / (m.hexExt + 1);
      ctx.font = '11px system-ui, sans-serif';
      rows.forEach(function (row, r) {
        ctx.fillStyle = '#1e2530'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(row[0], x0, 4 + r * rh);
        [0, 1].forEach(function (e) {
          var cx = x0 + cw * (e + .5), cyy = 18 + r * rh + (rh - 14) / 2 + 6, vals = row[1][e];
          for (var i = 0; i < vals.length; i++) {
            var q = m.hexXY[e][i], v = vals[i] / 9;
            ctx.fillStyle = row[2] === 'lum'
              ? 'rgb(' + Math.round(30 + v * 215) + ',' + Math.round(30 + v * 215) + ',' + Math.round(34 + v * 215) + ')'
              : PLOT.heat(v * 100, 100);
            ctx.fillRect(cx + q[0] * s - s * .8, cyy + q[1] * s - s * .8, s * 1.6, s * 1.6);
          }
          if (r === 1) {
            ctx.fillStyle = '#68727f'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText((e ? '右目 ' : '左目 ') + (R.flow[k][e] >= 0 ? '+' : '') + R.flow[k][e].toFixed(2),
                         cx, Math.min(h - 13, cyy + (m.hexExt + 1) * s + 2));
          }
        });
      });
    },

    scope: function (g) {
      // 時間の流れ: 左右の目の流れ（よける信号）、ごちそうの見え方、曲がる指令。反射中は色を敷く
      var R = this.R, ctx = g.ctx, k = this.frame(), n = R.t.length;
      var pad = { l: 40, r: 12, t: 20, b: 20 };
      var w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
      var X = function (j) { return pad.l + j / (n - 1) * w; };
      ctx.font = '11px system-ui, sans-serif';
      for (var j = 0; j < n; j++) {
        if (!R.mode[j]) continue;
        ctx.fillStyle = { 3: '#2f6fd0', 4: '#1a9e8f', 5: '#d4a514', 6: '#2e8b3e', 7: '#c2521c', 10: '#b5467a', 11: '#1e2530' }[R.mode[j]] || '#eb6834';
        ctx.globalAlpha = .15;
        ctx.fillRect(X(j), pad.t, w / n + 1, h); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#c9d2dd'; ctx.beginPath(); ctx.moveTo(pad.l, pad.t + h / 2 + .5); ctx.lineTo(pad.l + w, pad.t + h / 2 + .5); ctx.stroke();
      function line(get, col, scale) {
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
        for (var j = 0; j < n; j++) {
          var y = pad.t + h / 2 - Math.max(-1, Math.min(1, get(j) * scale)) * h / 2;
          if (j) ctx.lineTo(X(j), y); else ctx.moveTo(X(j), y);
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      // よける信号をためた量。しきい値（点線）を図の半分の高さに合わせる
      line(function (j) { return R.avoid[j] / R.saccThresh / 2; }, '#2f6fd0', 1);
      // サッカードに入る線（よける信号がこれを超えると入る）
      ctx.strokeStyle = '#2f6fd0'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      [1, -1].forEach(function (sg) {
        var y = pad.t + h / 2 - sg * 0.5 * h / 2;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
      });
      ctx.setLineDash([]);
      line(function (j) { return R.food[j][0] - R.food[j][1]; }, '#1a9e8f', 1);
      line(function (j) { return R.turn[j]; }, '#1e2530', 1);
      if (R.mn9) line(function (j) { return R.mn9[j] / 60; }, '#8a3fb0', 1);     // MN9（上端＝60 Hz）
      if (R.adn1) line(function (j) { return R.adn1[j] / 60; }, '#b5467a', 1);   // aDN1（身づくろい、上端＝60 Hz）
      if (R.gf) line(function (j) { return R.gf[j] / 60; }, '#6b7280', 1);       // GF（逃避、上端＝60 Hz）
      ctx.strokeStyle = '#1e2530'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(k), pad.t); ctx.lineTo(X(k), pad.t + h); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      var lg = [['よける信号（点線でサッカード）', '#2f6fd0'], ['ごちそう 左−右', '#1a9e8f'], ['曲がる指令（上＝右）', '#1e2530'],
                ['MN9（口）', '#8a3fb0'], ['触覚の反射', '#eb6834'], ['味見', '#d4a514'], ['食べる', '#2e8b3e'], ['苦い', '#c2521c'], ['aDN1・身づくろい', '#b5467a'], ['GF・逃げる', '#6b7280']];
      var x = 8;
      lg.forEach(function (it) { ctx.fillStyle = it[1]; ctx.fillText('■ ' + it[0], x, 3); x += ctx.measureText('■ ' + it[0]).width + 12; });
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'right';
      ctx.fillText(R.seconds + ' 秒 →', pad.l + w, pad.t + h + 4);
    },

    readout: function () {
      var R = this.R, k = this.frame(), now = R.t[k];
      var ate = R.foods.filter(function (f) { return f[3] !== null && f[3] <= now; }).length;
      var nopes = R.foods.filter(function (f) { return f[6] !== null && f[6] !== undefined && f[6] <= now; }).length;
      var tasted = 0;                                    // 味見を始めた回数（モード 5 に入った回数）
      for (var j = 0; j <= k; j++) if (R.mode[j] === 5 && (j === 0 || R.mode[j - 1] !== 5)) tasted++;
      return [
        ['時刻', now.toFixed(2) + ' 秒'],
        // 味見の回数 ＝ 食べた ＋ 苦くて離れた ＋ いま味見・食べている途中
        ['味見した', tasted + ' 回（食べた ' + ate + '・苦い ' + nopes + (tasted - ate - nopes > 0 ? '・途中 ' + (tasted - ate - nopes) : '') + '）'],
        ['食べた', ate + ' / ' + R.foods.length],
        ['苦くて食べなかった', nopes + ' 個'],
        ['逃げる', R.threatAt === undefined || R.threatAt === null ? 'なし' : now < R.threatAt ? R.threatAt.toFixed(1) + ' 秒にハエたたき' :
          R.escapeAt !== null && now >= R.escapeAt ? R.escapeAt.toFixed(2) + ' 秒に飛び立った（GF ' + Math.max.apply(null, R.gf).toFixed(0) + ' Hz）' : '影が迫る（LC4 ' + R.loom[k].toFixed(0) + ' Hz）'],
        ['身づくろい', R.groom && R.groomAt !== null ? (now < R.groomAt ? R.groomAt.toFixed(1) + ' 秒から' : now < R.groomAt + R.groomDur ? '中（aBN1 ' + R.abn1[k].toFixed(0) + '・aDN1 ' + R.adn1[k].toFixed(0) + ' Hz）' : '済み') : 'なし'],
        ['曲がる指令', (R.turn[k] >= 0 ? '右 ' : '左 ') + Math.abs(R.turn[k]).toFixed(2)],
        ['柱に触れた時間（全体）', R.touchSeconds.toFixed(2) + ' 秒']
      ];
    },
    clock: function () { return 'FlyGym ＋ flyvis で計算済みの結果を再生（実時間の 1/' + Math.round(1 / this.rate) + '）'; }
  };

  var MODES = [sumMode, lateralMode, ringMode, compassMode, realMode, brainMode, visionMode, walkMode, driveMode];

  // ───────────────────────────────────────────── 段の切り替え
  function buildStepbar() {
    LESSONS.STEPS.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'stepchip';
      b.innerHTML = '<span class="n">' + (i + 1) + '</span>' + s.chip;
      b.addEventListener('click', function () { setStep(i); });
      el.stepbar.appendChild(b);
    });
  }

  function setStep(i) {
    if (typeof closeZoom === 'function') closeZoom();       // 拡大したまま段を替えると、拡大が残ってしまう
    if (state.mode && state.mode.unbind) state.mode.unbind();
    state.index = i;
    state.modelMs = 0;
    var s = LESSONS.STEPS[i];

    Array.prototype.forEach.call(el.stepbar.children, function (c, k) {
      c.classList.toggle('on', k === i);
    });

    el.lesson.innerHTML =
      '<h2>' + s.title + '</h2><p class="lead">' + s.lead + '</p>' +
      '<dl>' +
      '<dt>なに</dt><dd>' + s.what + '</dd>' +
      '<dt class="why">なぜ</dt><dd>' + s.why + '</dd>' +
      '<dt class="fly">ハエ</dt><dd>' + s.fly + '</dd>' +
      '</dl>' +
      (s.note ? '<div class="note">' + s.note + '</div>' : '');

    el.tries.innerHTML = s.tries.map(function (t) { return '<li>' + t + '</li>'; }).join('');

    el.controls.innerHTML = '';
    state.mode = MODES[i];
    state.mode.build();

    // 目の前で計算していない段では、再生・速さのつまみは意味がないので隠す
    var still = !!state.mode.static;
    el.playBtn.style.display = still ? 'none' : '';
    el.speedBox.style.display = still ? 'none' : '';
    el.resetBtn.style.display = still ? 'none' : '';
  }

  // ───────────────────────────────────────────── ループ
  function frame(now) {
    var dt = state.last ? Math.min(50, now - state.last) : 16;
    state.last = now;

    var still = state.mode && state.mode.static;   // 計算済みの結果を見るだけの段
    if (state.playing && state.mode && !still) {
      var ms = dt * state.speed;
      state.mode.step(ms);
      state.modelMs += ms;
    }

    if (state.mode) {
      var gs = PLOT.fit(el.stage); PLOT.clear(gs);
      state.mode.stage(gs);
      var gc = PLOT.fit(el.scope); PLOT.clear(gc);
      state.mode.scope(gc);

      el.readout.innerHTML = state.mode.readout().map(function (r) {
        return '<span>' + r[0] + ' <b>' + r[1] + '</b></span>';
      }).join('');
      el.clock.textContent = state.mode.clock ? state.mode.clock()
        : still
        ? 'Python で計算済みの結果'
        : '模型の時間 ' + (state.modelMs / 1000).toFixed(1) + ' 秒';
    }
    requestAnimationFrame(frame);
  }

  // ───────────────────────────────────────────── 起動
  buildStepbar();

  el.playBtn.addEventListener('click', function () {
    state.playing = !state.playing;
    el.playBtn.textContent = state.playing ? '一時停止' : '再開';
  });
  el.resetBtn.addEventListener('click', function () {
    if (state.mode && state.mode.reset) state.mode.reset();
    state.modelMs = 0;
  });
  el.speedSel.addEventListener('change', function () { state.speed = Number(el.speedSel.value); });

  el.glossaryList.innerHTML = LESSONS.GLOSSARY.map(function (g) {
    return '<dt>' + g[0] + '</dt><dd>' + g[1] + '</dd>';
  }).join('');
  function openGlossary(on) { el.glossary.hidden = !on; }
  el.glossaryBtn.addEventListener('click', function () { openGlossary(true); });
  el.glossaryClose.addEventListener('click', function () { openGlossary(false); });
  el.glossary.addEventListener('click', function (e) { if (e.target === el.glossary) openGlossary(false); });
  // 図の拡大。枠に zoomed を付けて画面いっぱいに広げる。一度に 1 つだけ
  var zoomed = null;
  function setZoom(panel, btn) {
    var on = zoomed !== panel;
    [[el.stagePanel, el.stageZoom], [el.scopePanel, el.scopeZoom]].forEach(function (pb) {
      pb[0].classList.remove('zoomed'); pb[1].textContent = '拡大';
    });
    zoomed = on ? panel : null;
    if (on) { panel.classList.add('zoomed'); btn.textContent = '戻す'; }
    document.body.classList.toggle('has-zoom', on);
  }
  closeZoom = function () { if (zoomed) setZoom(zoomed, null); };
  el.stageZoom.addEventListener('click', function () { setZoom(el.stagePanel, el.stageZoom); });
  el.scopeZoom.addEventListener('click', function () { setZoom(el.scopePanel, el.scopeZoom); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && zoomed) setZoom(zoomed, null);
    if (e.key === 'Escape') openGlossary(false);
    if (e.key === '?' || e.key === '/') openGlossary(true);
  });

  setStep(0);
  requestAnimationFrame(frame);
})();
