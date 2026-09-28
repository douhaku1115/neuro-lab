// ringview.js
// 円環（楕円体）とハエの絵。
// 扇形の明るさが EPG の発火率、赤い針が「山の位置」＝ハエが思っている自分の向き。
// 本物のハエを上から見たときの向きと並べて置くので、ずれたらすぐ分かる。

globalThis.RINGVIEW = (function () {

  // 扇形 0 を真上（12 時）にして、番号が増える向きを時計回りにする。
  // 画面のハエも同じ向きに回るので、両者を見比べられる。
  function sectorAngle(sector, n) { return (sector / n) * Math.PI * 2 - Math.PI / 2; }

  function draw(g, opts) {
    var ctx = g.ctx;
    var rates = opts.rates, n = rates.length;
    var cx = opts.cx, cy = opts.cy, rOut = opts.r, rIn = rOut * 0.56;
    var max = opts.max || 100;

    // 扇形
    for (var i = 0; i < n; i++) {
      var a0 = sectorAngle(i - 0.5, n), a1 = sectorAngle(i + 0.5, n);
      ctx.beginPath();
      ctx.arc(cx, cy, rOut, a0, a1);
      ctx.arc(cx, cy, rIn, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = PLOT.heat(rates[i], max);
      ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // 目印（ランドマーク）。円環の外に置く。ハエが見ている景色の目印。
    if (opts.cue !== null && opts.cue !== undefined) {
      var ac = sectorAngle(opts.cue, n);
      var lx = cx + Math.cos(ac) * (rOut + 20), ly = cy + Math.sin(ac) * (rOut + 20);
      ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#f0b429'; ctx.fill();
      ctx.strokeStyle = '#b98613'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // 輪の外に付ける目盛り。「本当の向き」をここで示す。
    // 針と同じ向きに重ねて描くと、一致しているときに片方が消えてしまうので、
    // 内（針）と外（目盛り）で場所を分けておく。
    if (opts.mark !== null && opts.mark !== undefined) {
      var am = sectorAngle(opts.mark, n);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(am);
      ctx.beginPath();
      ctx.moveTo(rOut + 3, 0); ctx.lineTo(rOut + 15, 7); ctx.lineTo(rOut + 15, -7);
      ctx.closePath();
      ctx.fillStyle = opts.markColor || '#9aa5b1'; ctx.fill();
      ctx.restore();
    }

    // 山の位置を指す針。population vector そのもの。
    if (opts.bump && opts.bump.peak > 3) {
      var ab = sectorAngle(opts.bump.sector, n);
      var len = rIn * (0.35 + 0.6 * Math.min(1, opts.bump.strength / 0.8));
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(ab);
      ctx.beginPath();
      ctx.moveTo(len, 0); ctx.lineTo(len - 9, 5); ctx.lineTo(len - 9, -5);
      ctx.closePath();
      ctx.fillStyle = '#d9453d'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len - 8, 0);
      ctx.strokeStyle = '#d9453d'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#c9d2dd'; ctx.fill();
  }

  // 上から見たハエ。heading は度、0 が真上（12 時）で時計回り。
  function fly(g, cx, cy, size, heading, opts) {
    opts = opts || {};
    var ctx = g.ctx;
    var s = size / 100;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading * Math.PI / 180);
    ctx.scale(s, s);

    var body = opts.color || '#3b4350';

    // 脚（6 本）。体の下に置くので先に描く。
    ctx.strokeStyle = '#6b7482'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    var legs = [[-16, -20, -40, -42], [-15, 2, -44, -4], [-14, 24, -38, 46],
                [16, -20, 40, -42], [15, 2, 44, -4], [14, 24, 38, 46]];
    for (var i = 0; i < legs.length; i++) {
      var L = legs[i];
      ctx.beginPath(); ctx.moveTo(L[0], L[1]);
      ctx.quadraticCurveTo(L[2] * 0.7, L[1], L[2], L[3]);
      ctx.stroke();
    }

    // 翅
    ctx.fillStyle = 'rgba(190,205,225,.55)';
    ctx.strokeStyle = 'rgba(150,170,195,.8)'; ctx.lineWidth = 1.5;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      ctx.beginPath();
      ctx.ellipse(sgn * 17, 26, 12, 34, sgn * 0.42, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }

    // 腹部・胸部・頭
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, 30, 17, 32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -4, 18, 24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -32, 15, 15, 0, 0, Math.PI * 2); ctx.fill();

    // 目（赤）。前を向いていることが分かるように頭の左右に置く。
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.ellipse(-10, -34, 7, 9, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(10, -34, 7, 9, 0.3, 0, Math.PI * 2); ctx.fill();

    // 触角
    ctx.strokeStyle = body; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-5, -44); ctx.lineTo(-9, -54); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, -44); ctx.lineTo(9, -54); ctx.stroke();

    ctx.restore();
  }

  // ハエの周りの景色。目印がどこに見えているかを示す。
  function landscape(g, cx, cy, r, heading, cueAngle) {
    var ctx = g.ctx;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f2f5f9'; ctx.fill();
    ctx.strokeStyle = '#dde3ea'; ctx.lineWidth = 1; ctx.stroke();

    if (cueAngle !== null && cueAngle !== undefined) {
      var a = (cueAngle - 90) * Math.PI / 180;
      var x = cx + Math.cos(a) * (r - 14), y = cy + Math.sin(a) * (r - 14);
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#f0b429'; ctx.fill();
      ctx.strokeStyle = '#b98613'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  return { draw: draw, fly: fly, landscape: landscape, sectorAngle: sectorAngle };
})();
