// plot.js
// 描画の道具箱。膜電位のトレース、ラスタープロット、棒グラフ。
// ここから下（plot / ringview / lessons / main）は画面の担当で、計算はしない。

globalThis.PLOT = (function () {

  // canvas を CSS 上の大きさ × 画面の解像度に合わせる。
  // これをしないと、高解像度の画面で線がぼやける。
  // 図が「拡大」されているときは、ふだんの大きさ（幅 440・高さ base）で描いたものを
  // 拡大鏡のように k 倍して描く。枠だけ広げると文字や線は元の太さのままで間延びするため。
  var BASE_H = { stage: 330, scope: 150 };
  function fit(canvas) {
    var r = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    var k = 1, p = canvas.parentElement;
    if (p && p.classList && p.classList.contains('zoomed'))
      k = Math.max(1, Math.min(r.width / 440, r.height / (BASE_H[canvas.id] || 330)));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    return { ctx: ctx, w: r.width / k, h: r.height / k, zoom: k };
  }

  function clear(g, bg) {
    g.ctx.fillStyle = bg || '#ffffff';
    g.ctx.fillRect(0, 0, g.w, g.h);
  }

  // 時間とともに流れていく値の記録。古いものから捨てる輪っか。
  function Scope(len) {
    this.len = len; this.buf = new Float64Array(len); this.n = 0; this.head = 0;
  }
  Scope.prototype.push = function (v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.len;
    if (this.n < this.len) this.n++;
  };
  Scope.prototype.at = function (i) {                 // i=0 が最も古い
    return this.buf[(this.head - this.n + i + this.len * 2) % this.len];
  };
  Scope.prototype.clear = function () { this.n = 0; this.head = 0; };

  // 膜電位のトレース。閾値と静止電位の目安線も引く。
  function drawTrace(g, scope, opts) {
    opts = opts || {};
    var pad = { l: 46, r: 8, t: 10, b: 18 };
    var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
    var lo = opts.min !== undefined ? opts.min : -56, hi = opts.max !== undefined ? opts.max : -42;
    var ctx = g.ctx;
    var Y = function (v) { return y0 + h - (v - lo) / (hi - lo) * h; };

    ctx.fillStyle = '#fbfcfe'; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = '#e4e9f0'; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, y0 + .5, w - 1, h - 1);

    // 目安線（閾値・静止電位）
    var marks = opts.marks || [];
    ctx.font = '10px system-ui, sans-serif';
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], y = Y(m.v);
      if (y < y0 || y > y0 + h) continue;
      ctx.strokeStyle = m.color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(m.label, x0 - 5, y);
    }

    if (scope.n > 1) {
      ctx.strokeStyle = opts.color || '#2f6fd0'; ctx.lineWidth = opts.width || 1.5;
      ctx.beginPath();
      for (i = 0; i < scope.n; i++) {
        var x = x0 + i / (scope.len - 1) * w, v = scope.at(i);
        if (i === 0) ctx.moveTo(x, Y(v)); else ctx.lineTo(x, Y(v));
      }
      ctx.stroke();
    }

    // 発火の印。膜電位だけ見ていると「リセットで下がった」としか見えないので、
    // スパイクそのものを上に立てておく。
    if (opts.spikes && opts.spikes.n > 1) {
      ctx.strokeStyle = opts.spikeColor || '#d9453d'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (i = 0; i < opts.spikes.n; i++) {
        if (!opts.spikes.at(i)) continue;
        var sx = x0 + i / (opts.spikes.len - 1) * w;
        ctx.moveTo(sx, y0 + 2); ctx.lineTo(sx, y0 + 12);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#68727f'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (opts.label) ctx.fillText(opts.label, x0 + 4, y0 + h + 4);
    if (opts.right) { ctx.textAlign = 'right'; ctx.fillText(opts.right, x0 + w, y0 + h + 4); }
  }

  // ラスタープロット。1 本の横線が 1 個のニューロン、点が 1 発のスパイク。
  function drawRaster(g, scopes, opts) {
    opts = opts || {};
    var pad = { l: 46, r: 8, t: 8, b: 18 };
    var x0 = pad.l, y0 = pad.t, w = g.w - pad.l - pad.r, h = g.h - pad.t - pad.b;
    var ctx = g.ctx, m = scopes.length;
    var rowH = h / m;

    ctx.fillStyle = '#fbfcfe'; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = '#e4e9f0'; ctx.strokeRect(x0 + .5, y0 + .5, w - 1, h - 1);

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#68727f'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var j = 0; j < m; j++) {
      if (opts.labels && opts.labels[j] !== undefined && (m <= 10 || j % 2 === 0))
        ctx.fillText(opts.labels[j], x0 - 5, y0 + (j + .5) * rowH);
    }

    var colors = opts.colors;
    for (j = 0; j < m; j++) {
      var sc = scopes[j];
      ctx.fillStyle = colors ? colors[j] : (opts.color || '#2f6fd0');
      for (var i = 0; i < sc.n; i++) {
        if (!sc.at(i)) continue;
        var x = x0 + i / (sc.len - 1) * w;
        ctx.fillRect(x, y0 + j * rowH + rowH * .18, 1.6, rowH * .64);
      }
    }
    ctx.fillStyle = '#68727f'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (opts.label) ctx.fillText(opts.label, x0 + 4, y0 + h + 4);
  }

  // 横並びの棒グラフ。入力と出力を上下で見比べるのに使う。
  function drawBars(g, rect, values, opts) {
    opts = opts || {};
    var ctx = g.ctx, n = values.length;
    var max = opts.max || Math.max(1, Math.max.apply(null, values));
    var gap = 3, bw = (rect.w - gap * (n - 1)) / n;

    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (var i = 0; i < n; i++) {
      var v = Math.max(0, values[i]);
      var hh = Math.max(1, v / max * rect.h);
      var x = rect.x + i * (bw + gap);
      ctx.fillStyle = '#eef1f5';
      ctx.fillRect(x, rect.y, bw, rect.h);
      ctx.fillStyle = opts.colors ? opts.colors[i] : (opts.color || '#2f6fd0');
      ctx.fillRect(x, rect.y + rect.h - hh, bw, hh);
      if (opts.labels) {
        ctx.fillStyle = '#68727f'; ctx.textBaseline = 'top';
        ctx.fillText(opts.labels[i], x + bw / 2, rect.y + rect.h + 3);
      }
      if (opts.showValue) {
        ctx.fillStyle = '#1e2530'; ctx.textBaseline = 'bottom';
        ctx.fillText(v.toFixed(0), x + bw / 2, rect.y + rect.h - hh - 2);
      }
    }
    if (opts.title) {
      ctx.fillStyle = '#68727f'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(opts.title, rect.x, rect.y - 3);
    }
  }

  // 発火率の色。低いと薄く、高いと濃く。円環でもバーでも同じ色にする。
  function heat(rate, max) {
    var t = Math.max(0, Math.min(1, rate / (max || 100)));
    // 薄い灰 → 青 → 赤。値の大小が一目で分かる順に並べる。
    var stops = [[236, 239, 244], [120, 170, 235], [47, 111, 208], [190, 70, 60]];
    var f = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(f)), u = f - k;
    var a = stops[k], b = stops[k + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * u) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * u) + ')';
  }

  return {
    fit: fit, clear: clear, Scope: Scope,
    drawTrace: drawTrace, drawRaster: drawRaster, drawBars: drawBars, heat: heat
  };
})();
