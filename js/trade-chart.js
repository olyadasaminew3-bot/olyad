/* ============================================================
   Doro Trade AI — canvas chart
   Draws candles, EMA overlays, volume, support/resistance and the
   trade lines produced by the engine: entry, stop loss, TP1-TP3
   and the fitted trend line. Supports crosshair, zoom and pan.
   ============================================================ */
(function (root, factory) {
  root.TradeChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COL = {
    bg: '#0b1220',
    grid: 'rgba(148,163,184,0.10)',
    axis: 'rgba(148,163,184,0.55)',
    text: '#cbd5e1',
    up: '#22c55e',
    down: '#ef4444',
    upFill: 'rgba(34,197,94,0.85)',
    downFill: 'rgba(239,68,68,0.85)',
    ema: '#38bdf8',
    ema2: '#a78bfa',
    entry: '#fbbf24',
    stop: '#f87171',
    tp: '#34d399',
    trend: '#22d3ee',
    level: 'rgba(148,163,184,0.45)',
    crosshair: 'rgba(226,232,240,0.55)',
  };

  function create(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const host = canvas.parentElement;
    let tooltip = null;
    let candles = [];
    let analysis = null;
    let show = { ema: true, levels: true, trade: true, volume: true, trend: true };
    let view = { from: 0, to: 0 };
    let hover = null;
    let raf = null;

    /* ---------- sizing ---------- */
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || host.clientWidth || 800;
      const h = canvas.clientHeight || 420;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    const PAD = { l: 10, r: 96, t: 14, b: 26 };   // right gutter holds the price chips

    function plotBox(w, h) {
      return { x: PAD.l, y: PAD.t, w: w - PAD.l - PAD.r, h: h - PAD.t - PAD.b };
    }

    /* ---------- scales ---------- */
    function visible() {
      const to = Math.max(1, Math.min(candles.length, view.to));
      const from = Math.max(0, Math.min(view.from, to - 2));
      return candles.slice(from, to).map((c, i) => Object.assign({ idx: from + i }, c));
    }

    function priceRange(bars) {
      if (!bars.length) return { lo: 0, hi: 1 };
      let lo = Infinity, hi = -Infinity;
      for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
      const extra = [];
      if (analysis && analysis.ok && show.trade) {
        if (analysis.entry) extra.push(analysis.entry.low, analysis.entry.high);
        if (analysis.stop && analysis.stop.price) extra.push(analysis.stop.price);
        (analysis.targets || []).forEach((t) => extra.push(t.price));
      }
      for (const v of extra) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const pad = (hi - lo) * 0.07 || hi * 0.01 || 1;
      return { lo: lo - pad, hi: hi + pad };
    }

    function makeScales(w, h) {
      const box = plotBox(w, h);
      const bars = visible();
      const { lo, hi } = priceRange(bars);
      const n = Math.max(bars.length, 1);
      const step = box.w / n;
      const y = (p) => box.y + box.h - ((p - lo) / (hi - lo || 1)) * box.h;
      const x = (i) => box.x + (i + 0.5) * step;
      return { box, bars, lo, hi, step, y, x, n };
    }

    /* ---------- primitives ---------- */
    function line(s, x1, y1, x2, y2, color, width = 1, dash = null) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function chip(s, text, price, color, dash, rightLabel = true) {
      const { box, y } = s;
      const inside = price <= s.hi && price >= s.lo;
      const yy = Math.max(box.y + 6, Math.min(box.y + box.h - 6, y(price)));
      line(s, box.x, yy, box.x + box.w, yy, color, 1.2, dash);
      if (!inside) {
        // off-screen marker
        const up = price > s.hi;
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        const cx = box.x + box.w - 8;
        ctx.moveTo(cx, yy + (up ? -4 : 4));
        ctx.lineTo(cx - 5, yy + (up ? 4 : -4));
        ctx.lineTo(cx + 5, yy + (up ? 4 : -4));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      if (!rightLabel) return;
      ctx.save();
      ctx.font = '600 9.5px Poppins, system-ui, sans-serif';
      const label = text;
      const tw = ctx.measureText(label).width + 10;
      const tx = box.x + box.w + 4;
      ctx.fillStyle = color;
      ctx.globalAlpha = inside ? 1 : 0.55;
      roundRect(tx, yy - 8, Math.min(tw, PAD.r - 8), 16, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#08111f';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tx + 5, yy + 0.5);
      ctx.restore();
    }

    function label(text, x, y, color, align = 'left', font = '600 11px Poppins, system-ui, sans-serif') {
      ctx.save();
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    /* ---------- main render ---------- */
    function render() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }

    function draw() {
      raf = null;
      const { w, h } = resize();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, w, h);

      if (!candles.length) {
        label('Waiting for data…', w / 2, h / 2, COL.axis, 'center', '500 12px Poppins, system-ui, sans-serif');
        return;
      }

      const s = makeScales(w, h);
      const { box, bars, x, y, lo, hi } = s;
      const volH = show.volume ? box.h * 0.16 : 0;

      /* grid + price axis */
      ctx.save();
      ctx.strokeStyle = COL.grid;
      ctx.lineWidth = 1;
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const yy = box.y + (box.h / steps) * i;
        ctx.beginPath();
        ctx.moveTo(box.x, yy);
        ctx.lineTo(box.x + box.w, yy);
        ctx.stroke();
        const p = hi - ((hi - lo) / steps) * i;
        label(formatPrice(p), box.x + box.w + 6, yy, COL.axis, 'left', '500 10px Poppins, system-ui, sans-serif');
      }
      ctx.restore();

      /* volume */
      if (show.volume && bars.length) {
        const maxV = Math.max(...bars.map((b) => b.v || 0), 1);
        const base = box.y + box.h;
        for (const b of bars) {
          const bh = ((b.v || 0) / maxV) * volH;
          ctx.fillStyle = b.c >= b.o ? 'rgba(34,197,94,0.20)' : 'rgba(239,68,68,0.20)';
          ctx.fillRect(x(b.idx) - s.step * 0.32, base - bh, Math.max(1, s.step * 0.64), bh);
        }
      }

      /* support / resistance levels */
      if (show.levels && analysis && analysis.ok && analysis.levels) {
        const draw = (arr, color) => (arr || []).slice(0, 3).forEach((lv) => {
          if (lv.price < lo || lv.price > hi) return;
          line(s, box.x, y(lv.price), box.x + box.w, y(lv.price), color, 1, [2, 4]);
        });
        draw(analysis.levels.resistances, 'rgba(248,113,113,0.35)');
        draw(analysis.levels.supports, 'rgba(52,211,153,0.35)');
      }

      /* trend line (drawn under candles) */
      if (show.trend && analysis && analysis.ok && analysis.trendlines) {
        const tl = analysis.trendlines.support || analysis.trendlines.resistance;
        if (tl && (tl.endPrice !== tl.startPrice)) {
          const a = bars[0], b = bars[bars.length - 1];
          const y1 = tl.slope * a.idx + tl.intercept;
          const y2 = tl.slope * b.idx + tl.intercept;
          if ([y1, y2].some((v) => isFinite(v))) {
            ctx.save();
            ctx.beginPath();
            const yy1 = Math.max(box.y - 40, Math.min(box.y + box.h + 40, y(y1)));
            const yy2 = Math.max(box.y - 40, Math.min(box.y + box.h + 40, y(y2)));
            ctx.moveTo(x(a.idx), yy1);
            ctx.lineTo(x(b.idx), yy2);
            ctx.strokeStyle = COL.trend;
            ctx.lineWidth = 1.6;
            ctx.setLineDash([7, 4]);
            ctx.globalAlpha = 0.85;
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      /* EMA overlays */
      if (show.ema && analysis && analysis.ok && analysis.series) {
        const drawEma = (arr, color) => {
          if (!arr) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          let started = false;
          bars.forEach((b) => {
            const v = arr[b.idx];
            if (v == null) return;
            if (!started) { ctx.moveTo(x(b.idx), y(v)); started = true; }
            else ctx.lineTo(x(b.idx), y(v));
          });
          ctx.stroke();
          ctx.restore();
        };
        drawEma(analysis.series.ema20, COL.ema);
        drawEma(analysis.series.ema50, COL.ema2);
      }

      /* candles */
      const bw = Math.max(1, Math.min(s.step * 0.68, 16));
      for (const b of bars) {
        const cx = x(b.idx);
        const up = b.c >= b.o;
        ctx.strokeStyle = up ? COL.up : COL.down;
        ctx.fillStyle = up ? COL.upFill : COL.downFill;
        ctx.lineWidth = Math.min(1.4, Math.max(0.8, bw * 0.12));
        ctx.beginPath();
        ctx.moveTo(cx, y(b.h));
        ctx.lineTo(cx, y(b.l));
        ctx.stroke();
        const yo = y(b.o), yc = y(b.c);
        const top = Math.min(yo, yc);
        const hgt = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(cx - bw / 2, top, bw, hgt);
      }

      /* trade lines — the entry / stop / targets the bot recommends */
      if (show.trade && analysis && analysis.ok && analysis.direction !== 'NEUTRAL') {
        chip(s, `TP3 ${formatPrice(analysis.targets[2].price)}`, analysis.targets[2].price, COL.tp, [4, 3]);
        chip(s, `TP2 ${formatPrice(analysis.targets[1].price)}`, analysis.targets[1].price, COL.tp, [5, 3]);
        chip(s, `TP1 ${formatPrice(analysis.targets[0].price)}`, analysis.targets[0].price, COL.tp, [6, 3]);
        if (analysis.stop.price) chip(s, `STOP ${formatPrice(analysis.stop.price)}`, analysis.stop.price, COL.stop, [6, 4]);
        chip(s, `ENTRY ${formatPrice(analysis.entry.price)}`, analysis.entry.price, COL.entry, [7, 4]);

        /* entry zone band */
        const zt = y(analysis.entry.high), zb = y(analysis.entry.low);
        ctx.save();
        ctx.fillStyle = 'rgba(251,191,36,0.10)';
        ctx.fillRect(box.x, Math.min(zt, zb), box.w, Math.max(2, Math.abs(zb - zt)));
        ctx.restore();

        /* R:R risk / reward shading along the last bars */
        const rx = box.x + box.w - Math.min(70, box.w * 0.14);
        ctx.save();
        ctx.fillStyle = 'rgba(248,113,113,0.10)';
        ctx.fillRect(rx, y(analysis.entry.price), 44, y(analysis.stop.price) - y(analysis.entry.price));
        ctx.fillStyle = 'rgba(52,211,153,0.10)';
        ctx.fillRect(rx, y(analysis.targets[2].price), 44, y(analysis.entry.price) - y(analysis.targets[2].price));
        ctx.restore();
      }

      /* last price marker */
      if (bars.length) {
        const last = bars[bars.length - 1];
        chip(s, formatPrice(last.c), last.c, '#e2e8f0', null);
      }

      /* time axis */
      ctx.save();
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + box.h);
      ctx.lineTo(box.x + box.w, box.y + box.h);
      ctx.stroke();
      ctx.restore();
      const ticks = Math.max(2, Math.min(6, Math.floor(box.w / 120)));
      for (let i = 0; i <= ticks; i++) {
        const b = bars[Math.min(bars.length - 1, Math.round((bars.length - 1) * (i / ticks)))];
        if (!b) continue;
        const tx = x(b.idx);
        label(timeLabel(b.t, analysis && analysis.interval), Math.min(tx, box.x + box.w - 30), box.y + box.h + 13,
          COL.axis, i === 0 ? 'left' : i === ticks ? 'right' : 'center', '500 10px Poppins, system-ui, sans-serif');
      }

      /* legend chips */
      const legend = [];
      if (show.trade && analysis && analysis.ok && analysis.direction !== 'NEUTRAL') {
        legend.push(['ENTRY', COL.entry], ['STOP LOSS', COL.stop], ['TAKE PROFIT', COL.tp]);
      }
      if (show.trend) legend.push(['TREND LINE', COL.trend]);
      if (show.ema) legend.push(['EMA20', COL.ema], ['EMA50', COL.ema2]);
      legend.forEach((lg, i) => {
        const lx = box.x + 6 + i * 92;
        if (lx > box.x + box.w - 70) return;
        ctx.save();
        ctx.fillStyle = lg[1];
        ctx.fillRect(lx, box.y + 2, 10, 3);
        ctx.restore();
        label(lg[0], lx + 14, box.y + 4, 'rgba(203,213,225,0.75)', 'left', '600 9px Poppins, system-ui, sans-serif');
      });

      /* watermark for demo data */
      if (analysis && analysis.isDemo) {
        label('DEMO DATA — no live feed', box.x + box.w - 8, box.y + 14, 'rgba(251,191,36,0.75)', 'right', '700 10px Poppins, system-ui, sans-serif');
      }

      /* crosshair */
      if (hover) {
        const b = bars.find((x2) => x2.idx === hover.idx);
        if (b) {
          line(s, x(b.idx), box.y, x(b.idx), box.y + box.h, COL.crosshair, 1, [4, 4]);
          line(s, box.x, y(b.c), box.x + box.w, y(b.c), COL.crosshair, 1, [4, 4]);
          const price = hi - ((hover.py - box.y) / box.h) * (hi - lo);
          ctx.save();
          ctx.fillStyle = '#e2e8f0';
          const lx = box.x + box.w + 4;
          roundRect(lx, hover.py - 8, PAD.r - 8, 16, 4);
          ctx.fill();
          ctx.fillStyle = '#08111f';
          ctx.font = '600 10px Poppins, system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(formatPrice(price), lx + 5, hover.py + 0.5);
          ctx.restore();
          positionTooltip(evalTooltip(b, price), hover.px, hover.py);
        }
      } else hideTooltip();
    }

    function evalTooltip(b, price) {
      const rows = [
        ['Time', new Date(b.t).toLocaleString()],
        ['Open', formatPrice(b.o)],
        ['High', formatPrice(b.h)],
        ['Low', formatPrice(b.l)],
        ['Close', formatPrice(b.c)],
        ['Volume', b.v ? compact(b.v) : '—'],
        ['Cursor', formatPrice(price)],
      ];
      if (analysis && analysis.ok && analysis.direction !== 'NEUTRAL') {
        const pc = (v) => `${v >= 0 ? '+' : ''}${(((price - v) / v) * 100).toFixed(2)}%`;
        const rMult = analysis.stop.distance ? ((price - analysis.entry.price) / analysis.stop.distance) : 0;
        rows.push(['—', '']);
        rows.push(['vs Entry', pc(analysis.entry.price)]);
        rows.push(['vs Stop', pc(analysis.stop.price)]);
        rows.push(['R multiple', `${rMult >= 0 ? '+' : ''}${rMult.toFixed(2)}R`]);
      }
      return rows;
    }

    function positionTooltip(rows, px, py) {
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'ta-tooltip';
        host.appendChild(tooltip);
      }
      tooltip.innerHTML = rows.map((r) => r[1] === ''
        ? '<div class="ta-tt-sep"></div>'
        : `<div class="ta-tt-row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('');
      tooltip.style.display = 'block';
      const bw = tooltip.offsetWidth || 150;
      const bh = tooltip.offsetHeight || 100;
      let left = px + 14, top = py + 14;
      if (left + bw > canvas.clientWidth - 8) left = px - bw - 14;
      if (top + bh > canvas.clientHeight - 8) top = Math.max(4, canvas.clientHeight - bh - 8);
      tooltip.style.left = `${Math.max(4, left)}px`;
      tooltip.style.top = `${top}px`;
    }

    function hideTooltip() { if (tooltip) tooltip.style.display = 'none'; }

    /* ---------- formatting helpers ---------- */
    function formatPrice(p) {
      if (!isFinite(p)) return '—';
      const abs = Math.abs(p);
      const d = abs >= 1000 ? 2 : abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
      return p.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function compact(v) {
      if (!isFinite(v)) return '—';
      const u = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
      for (const [n, suf] of u) if (Math.abs(v) >= n) return `${(v / n).toFixed(1)}${suf}`;
      return String(Math.round(v));
    }
    function timeLabel(t, interval) {
      const d = new Date(t);
      if (interval === '1d') return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
      if (interval === '4h') return `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}h`;
      return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
    }

    /* ---------- interaction ---------- */
    function nearestIndex(clientX) {
      const w = canvas.clientWidth;
      const s = makeScales(w, canvas.clientHeight);
      const rel = clientX - canvas.getBoundingClientRect().left - s.box.x;
      const i = Math.floor(rel / s.step);
      const b = s.bars[Math.max(0, Math.min(s.bars.length - 1, i))];
      return b ? b.idx : null;
    }

    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (dragging) {
        const s = makeScales(canvas.clientWidth, canvas.clientHeight);
        const shift = Math.round((dragging.px - px) / Math.max(s.step, 1));
        if (shift) {
          const span = dragging.to - dragging.from;
          let from = dragging.from + shift;
          from = Math.max(0, Math.min(candles.length - span, from));
          view.from = from;
          view.to = from + span;
          render();
        }
        return;
      }
      hover = { idx: nearestIndex(e.clientX), px, py };
      render();
    }

    let dragging = null;
    function onDown(e) {
      dragging = { px: e.clientX, from: view.from, to: view.to };
      canvas.style.cursor = 'grabbing';
    }
    function onUp() {
      dragging = null;
      canvas.style.cursor = 'crosshair';
    }
    function onWheel(e) {
      e.preventDefault();
      const s = makeScales(canvas.clientWidth, canvas.clientHeight);
      const focus = nearestIndex(e.clientX) ?? Math.round((view.from + view.to) / 2);
      const factor = e.deltaY > 0 ? 1.18 : 0.85;
      let span = Math.round((view.to - view.from) * factor);
      span = Math.max(24, Math.min(candles.length, span));
      const ratio = (focus - view.from) / Math.max(1, view.to - view.from);
      let from = Math.round(focus - span * ratio);
      from = Math.max(0, Math.min(candles.length - span, from));
      view.from = from;
      view.to = from + span;
      render();
    }
    function onLeave() { hover = null; render(); }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        hover = { idx: nearestIndex(t.clientX), px: t.clientX - canvas.getBoundingClientRect().left, py: t.clientY - canvas.getBoundingClientRect().top };
        render();
      }
    }, { passive: true });
    window.addEventListener('resize', render);

    /* ---------- public API ---------- */
    return {
      setData({ candles: cs, analysis: an, windowSize }) {
        candles = cs || [];
        analysis = an || null;
        const span = Math.max(30, Math.min(candles.length, windowSize || 130));
        view = { from: Math.max(0, candles.length - span), to: candles.length };
        hover = null;
        render();
      },
      toggle(key, value) {
        show[key] = value === undefined ? !show[key] : !!value;
        render();
        return show[key];
      },
      get show() { return Object.assign({}, show); },
      zoom(factor) {
        const span = Math.round((view.to - view.from) * factor);
        const size = Math.max(24, Math.min(candles.length, span));
        view.from = Math.max(0, view.to - size);
        render();
      },
      reset() {
        const span = Math.max(30, Math.min(candles.length, 130));
        view = { from: Math.max(0, candles.length - span), to: candles.length };
        render();
      },
      exportPNG() { return canvas.toDataURL('image/png'); },
      render,
      destroy() {
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('resize', render);
        tooltip && tooltip.remove();
        if (raf) cancelAnimationFrame(raf);
      },
    };
  }

  return { create, COL };
});
