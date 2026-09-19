/* ============================================================
   Doro Trade AI — Analysis Engine
   Pure functions only (no DOM). Works in the browser and in Node
   so the math can be unit-tested (see tools/test-engine.mjs).

   Pipeline:
     candles -> indicators -> market structure -> weighted signal
             -> trade plan (entry / stop / targets / trade lines)
             -> position sizing -> plain-English narrative
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------
     Small math helpers
     --------------------------------------------------------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const lastVal = (a) => (a && a.length ? a[a.length - 1] : null);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const round = (v, d = 2) => {
    if (!isNum(v)) return v;
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
  };

  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const win = values.slice(i - period + 1, i + 1);
      const m = mean(win);
      out[i] = Math.sqrt(mean(win.map((v) => (v - m) * (v - m))));
    }
    return out;
  }

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      if (i >= period) acc -= values[i - period];
      if (i >= period - 1) out[i] = acc / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    out[period - 1] = seed / period;
    for (let i = period; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }

  /** Wilder's RSI */
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  function trueRange(candles) {
    const out = new Array(candles.length).fill(null);
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      out[i] = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    }
    return out;
  }

  /** Wilder's ATR */
  function atr(candles, period = 14) {
    const tr = trueRange(candles);
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    let acc = 0;
    for (let i = 1; i <= period; i++) acc += tr[i];
    out[period] = acc / period;
    for (let i = period + 1; i < candles.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const line = closes.map((_, i) =>
      emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
    const defined = line.filter((v) => v != null);
    const signalDefined = ema(defined, signalPeriod);
    const signal = new Array(closes.length).fill(null);
    let k = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] != null) { signal[i] = signalDefined[k] ?? null; k++; }
    }
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return { line, signal, hist };
  }

  function bollinger(closes, period = 20, mult = 2) {
    const mid = sma(closes, period);
    const sd = stdev(closes, period);
    const upper = closes.map((_, i) => (mid[i] != null ? mid[i] + mult * sd[i] : null));
    const lower = closes.map((_, i) => (mid[i] != null ? mid[i] - mult * sd[i] : null));
    const width = closes.map((_, i) =>
      mid[i] ? (upper[i] - lower[i]) / mid[i] : null);
    return { mid, upper, lower, width, sd };
  }

  function stochastic(candles, period = 14, smoothK = 3) {
    const rawK = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      const win = candles.slice(i - period + 1, i + 1);
      const hh = Math.max(...win.map((c) => c.h));
      const ll = Math.min(...win.map((c) => c.l));
      rawK[i] = hh === ll ? 50 : ((candles[i].c - ll) / (hh - ll)) * 100;
    }
    const definedIdx = [];
    rawK.forEach((v, i) => { if (v != null) definedIdx.push(i); });
    const kSmooth = sma(definedIdx.map((i) => rawK[i]), smoothK);
    const k = new Array(candles.length).fill(null);
    definedIdx.forEach((idx, n) => { k[idx] = kSmooth[n]; });
    const definedK = k.filter((v) => v != null);
    const dArr = sma(definedK, 3);
    const d = new Array(candles.length).fill(null);
    let p = 0;
    for (let i = 0; i < k.length; i++) if (k[i] != null) { d[i] = dArr[p] ?? null; p++; }
    return { k, d };
  }

  /** Wilder ADX with +DI / -DI */
  function adx(candles, period = 14) {
    const n = candles.length;
    const plusDM = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);
    const tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = candles[i].h - candles[i - 1].h;
      const dn = candles[i - 1].l - candles[i].l;
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
      tr[i] = Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - candles[i - 1].c),
        Math.abs(candles[i].l - candles[i - 1].c)
      );
    }
    const wilder = (arr) => {
      const out = new Array(n).fill(null);
      if (n <= period) return out;
      let acc = 0;
      for (let i = 1; i <= period; i++) acc += arr[i];
      out[period] = acc;
      for (let i = period + 1; i < n; i++) out[i] = out[i - 1] - out[i - 1] / period + arr[i];
      return out;
    };
    const sTR = wilder(tr), sPDM = wilder(plusDM), sMDM = wilder(minusDM);
    const pdi = new Array(n).fill(null), mdi = new Array(n).fill(null);
    const dx = new Array(n).fill(null), adxv = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      if (sTR[i]) {
        pdi[i] = (100 * sPDM[i]) / sTR[i];
        mdi[i] = (100 * sMDM[i]) / sTR[i];
        const t = pdi[i] + mdi[i];
        dx[i] = t === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / t;
      }
    }
    const start = 2 * period;
    if (n > start) {
      const slice = dx.slice(period, start).filter((v) => v != null);
      if (slice.length) {
        adxv[start - 1] = mean(slice);
        for (let i = start; i < n; i++) {
          adxv[i] = adxv[i - 1] != null && dx[i] != null
            ? (adxv[i - 1] * (period - 1) + dx[i]) / period
            : adxv[i - 1];
        }
      }
    }
    return { adx: adxv, plusDI: pdi, minusDI: mdi };
  }

  /** Rolling VWAP over the supplied window (typical price * volume) */
  function vwap(candles, lookback = 96) {
    const slice = candles.slice(Math.max(0, candles.length - lookback));
    let pv = 0, vol = 0;
    for (const c of slice) {
      const tp = (c.h + c.l + c.c) / 3;
      const v = isNum(c.v) && c.v > 0 ? c.v : 1;
      pv += tp * v;
      vol += v;
    }
    return vol ? pv / vol : null;
  }

  /* ---------------------------------------------------------
     Market structure
     --------------------------------------------------------- */

  /** Fractal swing highs / lows (k bars on each side). */
  function findSwings(candles, k = 2, maxLookback = 220) {
    const highs = [], lows = [];
    const n = candles.length;
    const start = Math.max(k, n - maxLookback);
    for (let i = start; i < n - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= k; j++) {
        if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
        if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isLow = false;
      }
      if (isHigh) highs.push({ i, price: candles[i].h, time: candles[i].t, type: 'high' });
      if (isLow) lows.push({ i, price: candles[i].l, time: candles[i].t, type: 'low' });
    }

    /* A monotonic move (or a very smooth grind) produces no fractals at all.
       Fall back to rolling extremes inside non-overlapping windows so that
       stops, targets and trend lines still have real structure to anchor to. */
    const W = Math.max(4, Math.floor(Math.min(n, 120) / 10));
    const rollingExtremes = (wantHigh) => {
      const out = [];
      for (let end = n - 1; end - W >= 0 && out.length < 8; end -= W) {
        let best = end;
        for (let i = end - W; i <= end; i++) {
          if (wantHigh ? candles[i].h > candles[best].h : candles[i].l < candles[best].l) best = i;
        }
        out.push({
          i: best,
          price: wantHigh ? candles[best].h : candles[best].l,
          time: candles[best].t,
          type: wantHigh ? 'high' : 'low',
          approx: true,
        });
      }
      return out.reverse();
    };
    if (highs.length < 2) highs.push(...rollingExtremes(true));
    if (lows.length < 2) lows.push(...rollingExtremes(false));
    highs.sort((a, b) => a.i - b.i);
    lows.sort((a, b) => a.i - b.i);
    return { highs, lows };
  }

  /** Group swing points that sit within `tol` of each other into S/R zones. */
  function clusterLevels(points, tol, totalBars) {
    const sorted = points.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const p of sorted) {
      const c = clusters[clusters.length - 1];
      if (c && Math.abs(p.price - c.price) <= tol) {
        c.prices.push(p.price);
        c.price = mean(c.prices);
        c.touches += 1;
        c.lastIndex = Math.max(c.lastIndex, p.i);
        c.kinds.push(p.type);
      } else {
        clusters.push({
          price: p.price, prices: [p.price], touches: 1,
          lastIndex: p.i, kinds: [p.type],
        });
      }
    }
    const mostTouches = Math.max(1, ...clusters.map((c) => c.touches));
    return clusters.map((c) => {
      const barsAgo = totalBars - 1 - c.lastIndex;
      const recency = barsAgo < 20 ? 0.75 : barsAgo < 60 ? 0.35 : 0.08;
      return {
        price: c.price,
        touches: c.touches,
        barsAgo,
        side: c.kinds.filter((k) => k === 'high').length >= c.kinds.filter((k) => k === 'low').length
          ? 'resistance' : 'support',
        strength: round(clamp((c.touches / mostTouches) * 0.7 + recency, 0, 1), 2),
      };
    });
  }

  /** Least-squares line through (x=bar index, y=price). */
  function linreg(points) {
    const n = points.length;
    if (n < 2) return null;
    const xs = points.map((p) => p.i), ys = points.map((p) => p.price);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = my - slope * mx;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssTot += (ys[i] - my) ** 2;
      ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { slope, intercept, r2, from: xs[0], to: xs[xs.length - 1] };
  }

  /** Trend lines built from the most recent swings. */
  function buildTrendlines(candles, swings) {
    const build = (pts, kind) => {
      const use = pts.slice(-4);
      if (use.length < 2) return null;
      const fit = linreg(use);
      if (!fit) return null;
      const from = Math.max(0, use[0].i - 3);
      const to = candles.length - 1;
      const at = (i) => fit.slope * i + fit.intercept;
      return {
        kind,
        slope: fit.slope,
        intercept: fit.intercept,
        r2: round(clamp(fit.r2, 0, 1), 2),
        from, to,
        startPrice: round(at(from), 8),
        endPrice: round(at(to), 8),
        valueNow: round(at(to), 8),
        touches: use.length,
      };
    };
    return {
      support: build(swings.lows, 'support'),
      resistance: build(swings.highs, 'resistance'),
    };
  }

  /** Classic pivot points from the previous completed bar. */
  function pivotPoints(candles) {
    if (candles.length < 2) return null;
    const p = candles[candles.length - 2];
    const pp = (p.h + p.l + p.c) / 3;
    const range = p.h - p.l;
    return {
      pp: round(pp, 8),
      r1: round(2 * pp - p.l, 8),
      r2: round(pp + range, 8),
      r3: round(p.h + 2 * range, 8),
      s1: round(2 * pp - p.h, 8),
      s2: round(pp - range, 8),
      s3: round(p.l - 2 * range, 8),
    };
  }

  /** Simple, robust candlestick pattern detection on the last few bars. */
  function candlePatterns(candles) {
    const out = [];
    if (candles.length < 4) return out;
    const n = candles.length;
    const c0 = candles[n - 1], c1 = candles[n - 2], c2 = candles[n - 3];
    const body = (c) => Math.abs(c.c - c.o);
    const range = (c) => Math.max(c.h - c.l, 1e-12);
    const upWick = (c) => c.h - Math.max(c.c, c.o);
    const lowWick = (c) => Math.min(c.c, c.o) - c.l;
    const avgBody = mean(candles.slice(-14).map(body)) || 1e-12;
    const priorDown = c2.c < candles[Math.max(0, n - 6)].c;
    const priorUp = c2.c > candles[Math.max(0, n - 6)].c;

    if (c1.c < c1.o && c0.c > c0.o && c0.c >= c1.o && c0.o <= c1.c && body(c0) > body(c1) * 1.05)
      out.push({ name: 'Bullish engulfing', dir: 1, strength: 0.85 });
    if (c1.c > c1.o && c0.c < c0.o && c0.o >= c1.c && c0.c <= c1.o && body(c0) > body(c1) * 1.05)
      out.push({ name: 'Bearish engulfing', dir: -1, strength: 0.85 });
    if (lowWick(c0) >= body(c0) * 2 && upWick(c0) <= body(c0) * 0.9 && body(c0) < avgBody * 1.2 && priorDown)
      out.push({ name: 'Hammer / rejection wick', dir: 1, strength: 0.7 });
    if (upWick(c0) >= body(c0) * 2 && lowWick(c0) <= body(c0) * 0.9 && body(c0) < avgBody * 1.2 && priorUp)
      out.push({ name: 'Shooting star / rejection wick', dir: -1, strength: 0.7 });
    if (body(c0) <= range(c0) * 0.12 && range(c0) > avgBody * 1.1)
      out.push({ name: 'Doji — indecision', dir: 0, strength: 0.35 });
    if (c0.h <= c1.h && c0.l >= c1.l) out.push({ name: 'Inside bar (compression)', dir: 0, strength: 0.4 });
    if (c0.c > c0.o && c1.c > c1.o && c2.c > c2.o && c2.c > candles[n - 4].c && body(c0) > avgBody * 0.8)
      out.push({ name: 'Three white soldiers', dir: 1, strength: 0.6 });
    if (c0.c < c0.o && c1.c < c1.o && c2.c < c2.o && c2.c < candles[n - 4].c && body(c0) > avgBody * 0.8)
      out.push({ name: 'Three black crows', dir: -1, strength: 0.6 });
    return out;
  }

  /** RSI / price divergence between the two most recent matching swings. */
  function detectDivergence(candles, rsiArr, swings) {
    const check = (list, kind) => {
      const pts = list.filter((p) => rsiArr[p.i] != null).slice(-4);
      if (pts.length < 2) return null;
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const ra = rsiArr[a.i], rb = rsiArr[b.i];
      if (kind === 'low' && b.price < a.price && rb > ra + 2)
        return { dir: 1, note: `Bullish divergence: price made a lower low but RSI rose (${round(ra, 1)} → ${round(rb, 1)})` };
      if (kind === 'high' && b.price > a.price && rb < ra - 2)
        return { dir: -1, note: `Bearish divergence: price made a higher high but RSI fell (${round(ra, 1)} → ${round(rb, 1)})` };
      return null;
    };
    return check(swings.lows, 'low') || check(swings.highs, 'high');
  }

  /* ---------------------------------------------------------
     Synthetic candles — used only when no live data is reachable,
     so the page still demonstrates the full workflow (labelled DEMO).
     --------------------------------------------------------- */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function syntheticCandles(seedStr, count, stepMs, basePrice, volatility = 0.012) {
    const rand = mulberry32(hashSeed(String(seedStr)));
    const candles = [];
    let price = basePrice;
    let t = Date.now() - count * stepMs;
    let drift = 0;
    for (let i = 0; i < count; i++) {
      if (i % 45 === 0) drift = (rand() - 0.45) * volatility * 0.6; // regime shifts
      const shock = (rand() + rand() + rand() - 1.5) * volatility;
      const open = price;
      const close = Math.max(open * (1 + drift + shock), basePrice * 0.2);
      const wick = Math.abs(shock) * open * (0.6 + rand());
      const high = Math.max(open, close) + wick * rand();
      const low = Math.min(open, close) - wick * rand();
      const vol = (0.6 + rand() * 1.4) * 1000 * (1 + Math.abs(shock) * 40);
      candles.push({ t: t + i * stepMs, o: open, h: high, l: low, c: close, v: vol, demo: true });
      price = close;
    }
    return candles;
  }

  /* ---------------------------------------------------------
     Trade plan construction
     --------------------------------------------------------- */
  const TF_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000,
    '8h': 28800000, '12h': 43200000, '1d': 86400000, '3d': 259200000,
    '1w': 604800000,
  };

  function priceDecimals(price) {
    const p = Math.abs(price);
    if (p >= 10000) return 1;
    if (p >= 1000) return 2;
    if (p >= 100) return 2;
    if (p >= 1) return 4;
    if (p >= 0.01) return 5;
    return 8;
  }

  function fmtPrice(price) {
    if (!isNum(price)) return '—';
    return price.toFixed(priceDecimals(price));
  }

  function fmtPct(v, d = 2) {
    if (!isNum(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
  }

  /**
   * Build the trade plan.
   * @param {Array} candles  OHLCV objects {t,o,h,l,c,v}
   * @param {Object} opts    { symbol, interval, htf, account, minRR, spreadPct }
   */
  function analyze(candles, opts) {
    opts = opts || {};
    const symbol = opts.symbol || 'ASSET';
    const interval = opts.interval || '1h';
    if (!Array.isArray(candles) || candles.length < 30) {
      return { ok: false, error: 'Not enough candles to analyse (need at least 30).' };
    }

    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const volumes = candles.map((c) => (isNum(c.v) ? c.v : 0));
    const n = candles.length;
    const last = candles[n - 1];
    const price = last.c;

    /* ---------- indicators ---------- */
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, Math.min(50, Math.max(10, Math.floor(n / 3))));
    const ema200 = n >= 210 ? ema(closes, 200) : new Array(n).fill(null);
    const rsiArr = rsi(closes, 14);
    const atrArr = atr(candles, 14);
    const macdObj = macd(closes);
    const bb = bollinger(closes, 20, 2);
    const stoch = stochastic(candles, 14, 3);
    const adxObj = adx(candles, 14);
    const vw = vwap(candles, Math.min(96, n));

    const A = lastVal(atrArr) || (price * 0.01);
    const atrPct = (A / price) * 100;
    const rsiNow = lastVal(rsiArr);
    const adxNow = lastVal(adxObj.adx);
    const plusDI = lastVal(adxObj.plusDI);
    const minusDI = lastVal(adxObj.minusDI);
    const macdLine = lastVal(macdObj.line);
    const macdSig = lastVal(macdObj.signal);
    const macdHist = lastVal(macdObj.hist);
    const macdHistPrev = macdObj.hist[n - 2];
    const bbUpper = lastVal(bb.upper), bbLower = lastVal(bb.lower), bbMid = lastVal(bb.mid);
    const bbWidth = lastVal(bb.width);
    const bbWidthPrev20 = bb.width.slice(-20).filter((v) => v != null);
    const bbWidthAvg = bbWidthPrev20.length ? mean(bbWidthPrev20) : null;
    const volSma20 = lastVal(sma(volumes, 20));
    const volRatio = volSma20 ? last.v / volSma20 : 1;
    const stochK = lastVal(stoch.k), stochD = lastVal(stoch.d);
    const e20 = lastVal(ema20), e50 = lastVal(ema50), e200 = lastVal(ema200);

    /* ---------- structure ---------- */
    const swings = findSwings(candles, 2);
    const tol = A * 0.6;
    const levelsAll = clusterLevels([...swings.highs, ...swings.lows], tol, n);
    const resistances = levelsAll.filter((l) => l.price > price * 1.0005)
      .sort((a, b) => a.price - b.price).slice(0, 4);
    const supports = levelsAll.filter((l) => l.price < price * 0.9995)
      .sort((a, b) => b.price - a.price).slice(0, 4);
    const lookback = Math.min(n, 120);
    const rangeHigh = Math.max(...highs.slice(-lookback));
    const rangeLow = Math.min(...lows.slice(-lookback));
    const rangePos = rangeHigh === rangeLow ? 0.5 : (price - rangeLow) / (rangeHigh - rangeLow);
    const rangeHeight = rangeHigh - rangeLow;
    const trendlines = buildTrendlines(candles, swings);
    const pivots = pivotPoints(candles);
    const patterns = candlePatterns(candles);
    const divergence = detectDivergence(candles, rsiArr, swings);

    const priceVsEma20 = (price - e20) / A;
    const priceVsEma50 = e50 ? (price - e50) / A : 0;
    const higherHighs = swings.highs.length >= 2 &&
      swings.highs[swings.highs.length - 1].price > swings.highs[Math.max(0, swings.highs.length - 3)].price;
    const higherLows = swings.lows.length >= 2 &&
      swings.lows[swings.lows.length - 1].price > swings.lows[Math.max(0, swings.lows.length - 3)].price;
    const lowerHighs = swings.highs.length >= 2 &&
      swings.highs[swings.highs.length - 1].price < swings.highs[Math.max(0, swings.highs.length - 3)].price;
    const lowerLows = swings.lows.length >= 2 &&
      swings.lows[swings.lows.length - 1].price < swings.lows[Math.max(0, swings.lows.length - 3)].price;

    const trendUp = e200 ? (price > e50 && e50 > e200) : (e50 ? price > e50 : higherHighs && higherLows);
    const trendDown = e200 ? (price < e50 && e50 < e200) : (e50 ? price < e50 : lowerHighs && lowerLows);
    const adxStrong = isNum(adxNow) && adxNow >= 22;
    const adxWeak = !isNum(adxNow) || adxNow < 15;
    const tightBB = bbWidthAvg && bbWidth && bbWidth < bbWidthAvg * 0.75;
    const wideBB = bbWidthAvg && bbWidth && bbWidth > bbWidthAvg * 1.35;

    let regime;
    if (adxStrong && (trendUp || trendDown) && !wideBB) regime = trendUp ? 'trending-up' : 'trending-down';
    else if (tightBB && adxWeak) regime = 'compression';
    else if (wideBB && atrPct > 3) regime = 'volatile';
    else regime = 'ranging';

    /* ---------- weighted signals ---------- */
    const signals = [];
    const addSignal = (key, label, dir, strength, weight, note) => {
      signals.push({ key, label, dir, strength: clamp(strength, 0, 1), weight, note });
    };

    // 1. Trend structure (EMA stack)
    if (e50 != null) {
      const dir = trendUp ? 1 : trendDown ? -1 : 0;
      const strength = trendUp || trendDown
        ? clamp((Math.abs(priceVsEma50) / 2.5) + (e200 ? 0.35 : 0.2), 0.25, 1)
        : 0.2;
      addSignal('trend', 'Trend / EMA stack', dir, strength, 1.6,
        dir === 1 ? 'Price above rising EMA50/200 — bullish trend structure'
          : dir === -1 ? 'Price below falling EMA50/200 — bearish trend structure'
            : 'EMA stack is flat — no clean trend');
    }

    // 2. Market structure (HH/HL vs LH/LL)
    {
      const dir = higherHighs && higherLows ? 1 : lowerHighs && lowerLows ? -1 : 0;
      addSignal('structure', 'Swing structure', dir, dir ? 0.7 : 0.2, 1.1,
        dir === 1 ? 'Higher highs and higher lows — buyers in control'
          : dir === -1 ? 'Lower highs and lower lows — sellers in control'
            : 'Swing structure is mixed / overlapping');
    }

    // 3. Momentum — RSI
    if (isNum(rsiNow)) {
      let dir = 0, strength = 0.3, note = `RSI(14) = ${round(rsiNow, 1)}`;
      if (rsiNow >= 60) { dir = 1; strength = 0.75; note += ' — strong bullish momentum'; }
      else if (rsiNow > 52) { dir = 1; strength = 0.45; note += ' — mild bullish momentum'; }
      else if (rsiNow <= 40) { dir = -1; strength = 0.75; note += ' — strong bearish momentum'; }
      else if (rsiNow < 48) { dir = -1; strength = 0.45; note += ' — mild bearish momentum'; }
      else note += ' — neutral momentum';
      if (rsiNow > 78) { dir = dir > 0 ? 1 : dir; strength *= 0.55; note += ' (overbought — chasing risk)'; }
      if (rsiNow < 22) { dir = dir < 0 ? -1 : dir; strength *= 0.55; note += ' (oversold — bounce risk)'; }
      addSignal('rsi', 'RSI momentum', dir, strength, 1.0, note);
    }

    // 4. MACD
    if (isNum(macdHist)) {
      const rising = isNum(macdHistPrev) && macdHist > macdHistPrev;
      let dir = macdHist > 0 ? 1 : macdHist < 0 ? -1 : 0;
      const crossUp = isNum(macdHistPrev) && macdHistPrev <= 0 && macdHist > 0;
      const crossDown = isNum(macdHistPrev) && macdHistPrev >= 0 && macdHist < 0;
      const strength = clamp(
        0.35 + (crossUp || crossDown ? 0.35 : 0) + (rising === (dir > 0) ? 0.25 : 0), 0, 1);
      addSignal('macd', 'MACD momentum', dir, strength, 1.2,
        `Histogram ${macdHist > 0 ? 'positive' : 'negative'} and ${rising ? 'expanding' : 'fading'}` +
        (crossUp ? ' — fresh bullish cross' : crossDown ? ' — fresh bearish cross' : ''));
    }

    // 5. ADX trend quality (acts mostly as a confidence multiplier)
    if (isNum(adxNow)) {
      const dir = plusDI > minusDI ? 1 : -1;
      const strength = clamp((adxNow - 12) / 30, 0, 1);
      addSignal('adx', 'Trend strength (ADX)', adxStrong ? dir : 0, strength, 1.0,
        `ADX ${round(adxNow, 1)} — ${adxNow >= 25 ? 'healthy trend' : adxNow >= 18 ? 'developing trend' : 'weak / choppy'}`
        + ` (+DI ${round(plusDI, 1)} vs -DI ${round(minusDI, 1)})`);
    }

    // 6. Position vs EMA20 (pullback-quality / extension)
    if (e20 != null) {
      const dist = priceVsEma20;
      let dir = 0, strength = 0.3, note = '';
      if (Math.abs(dist) <= 0.5) {
        dir = trendDown ? -1 : 1;
        strength = 0.6;
        note = 'Price is trading right at EMA20 — low-risk pullback entry';
      } else if (dist > 0.5 && dist <= 1.6) {
        dir = 1; strength = trendUp ? 0.55 : 0.25;
        note = `Price is ${round(dist, 1)}× ATR above EMA20 — acceptable but not a discount entry`;
      } else if (dist > 1.6) {
        dir = -1; strength = 0.4;
        note = `Price is stretched ${round(dist, 1)}× ATR above EMA20 — mean-reversion risk`;
      } else if (dist < -0.5 && dist >= -1.6) {
        dir = -1; strength = trendDown ? 0.55 : 0.25;
        note = `Price is ${round(Math.abs(dist), 1)}× ATR below EMA20 — weak bounce territory`;
      } else {
        dir = 1; strength = 0.4;
        note = `Price is stretched ${round(Math.abs(dist), 1)}× ATR below EMA20 — oversold snap-back risk`;
      }
      addSignal('ema20', 'Distance from EMA20', dir, strength, 0.9, note);
    }

    // 7. Bollinger position
    if (bbUpper != null) {
      const pctB = (price - bbLower) / Math.max(bbUpper - bbLower, 1e-9);
      let dir = 0, strength = 0.3, note = `Price sits at ${Math.round(pctB * 100)}% of the Bollinger band`;
      if (pctB > 1) { dir = -1; strength = 0.45; note += ' — stretched above the upper band'; }
      else if (pctB < 0) { dir = 1; strength = 0.45; note += ' — stretched below the lower band'; }
      else if (pctB > 0.5) { dir = 1; strength = 0.4; note += ' (upper half = bullish bias)'; }
      else { dir = -1; strength = 0.4; note += ' (lower half = bearish bias)'; }
      if (tightBB) note += '. Bands are compressed — expect an expansion move';
      addSignal('bb', 'Bollinger position', dir, strength, 0.7, note);
    }

    // 8. Volume confirmation
    {
      const dir = last.c >= last.o ? 1 : -1;
      const strength = clamp((volRatio - 0.8) / 1.2, 0, 1);
      addSignal('volume', 'Volume confirmation', volRatio > 1.05 ? dir : 0, strength, 0.8,
        `Last bar volume is ${round(volRatio, 2)}× the 20-bar average` +
        (volRatio < 0.8 ? ' — thin participation, treat breakouts with caution' : ''));
    }

    // 9. VWAP
    if (isNum(vw)) {
      const dist = (price - vw) / A;
      addSignal('vwap', 'VWAP', price > vw ? 1 : -1, clamp(Math.abs(dist) / 1.5, 0.15, 0.7), 0.7,
        `${price > vw ? 'Above' : 'Below'} rolling VWAP (${fmtPrice(vw)}) — ${price > vw ? 'buyers' : 'sellers'} paying the better price`);
    }

    // 10. Candlestick patterns
    if (patterns.length) {
      const p = patterns[0];
      addSignal('pattern', 'Last candle pattern', p.dir, p.strength, 0.6, p.name);
    }

    // 11. Divergence
    if (divergence) {
      addSignal('divergence', 'Momentum divergence', divergence.dir, 0.65, 0.9, divergence.note);
    }

    // 12. Room to the next level
    {
      const nextRes = resistances[0];
      const nextSup = supports[0];
      const distRes = nextRes ? (nextRes.price - price) / A : 3;
      const distSup = nextSup ? (price - nextSup.price) / A : 3;
      const dir = distRes > distSup ? 1 : -1;
      const strength = clamp(Math.abs(distRes - distSup) / 3, 0, 1);
      addSignal('room', 'Room to move', dir, strength, 1.0,
        `Nearest resistance ${nextRes ? fmtPrice(nextRes.price) + ` (${round(distRes, 1)}× ATR away)` : 'none nearby'}, ` +
        `nearest support ${nextSup ? fmtPrice(nextSup.price) + ` (${round(distSup, 1)}× ATR away)` : 'none nearby'}`);
    }

    // 13. Higher timeframe alignment (supplied by the caller)
    const htf = opts.htf || null;
    if (htf && htf.direction) {
      const htfDir = htf.direction === 'LONG' ? 1 : htf.direction === 'SHORT' ? -1 : 0;
      addSignal('htf', `Higher timeframe (${htf.interval})`, htfDir,
        clamp((htf.confidence || 0) / 100, 0.2, 1) * (htfDir ? 1 : 0.3), 1.4,
        `HTF ${htf.interval} reads ${htf.direction}${htf.regime ? ` in a ${htf.regime} regime` : ''}`);
    }

    const totalWeight = sum(signals.map((s) => s.weight));
    const netScore = sum(signals.map((s) => s.dir * s.strength * s.weight)) / (totalWeight || 1);

    /* ---------- decide direction & regime override ---------- */
    let direction = netScore > 0.12 ? 'LONG' : netScore < -0.12 ? 'SHORT' : 'NEUTRAL';
    let planStyle = 'trend';
    if (regime === 'ranging' || regime === 'compression') {
      if (regime === 'ranging' && rangePos > 0.72 && netScore < 0.35) { direction = 'SHORT'; planStyle = 'range'; }
      else if (regime === 'ranging' && rangePos < 0.28 && netScore > -0.35) { direction = 'LONG'; planStyle = 'range'; }
      else if (regime === 'compression' && Math.abs(netScore) > 0.2) planStyle = 'breakout';
    }

    const noTradeReasons = [];
    if (adxWeak && regime === 'ranging' && rangePos > 0.35 && rangePos < 0.65)
      noTradeReasons.push('Price is mid-range with no trend (ADX below 15) — wait for the break or a retest of the edges');
    if (atrPct < 0.12) noTradeReasons.push('Volatility is unusually low — the move may not pay after costs');
    if (Math.abs(netScore) <= 0.12) noTradeReasons.push('Signals are balanced: no side has a real edge right now');

    /* ---------- entry / stop / targets ---------- */
    const isLong = direction === 'LONG';
    const spreadBuffer = A * 0.05;
    let entryType, entryLow, entryHigh, entryTrigger, entryPrice;

    if (direction === 'NEUTRAL') {
      entryType = 'stand-aside';
      entryPrice = price;
      entryLow = price - A * 0.25;
      entryHigh = price + A * 0.25;
      entryTrigger = 'No trade — wait for a clean break of the range with volume';
    } else if (planStyle === 'breakout') {
      const level = isLong ? rangeHigh + spreadBuffer : rangeLow - spreadBuffer;
      entryType = 'breakout stop';
      entryPrice = level;
      entryLow = level;
      entryHigh = level + (isLong ? A * 0.15 : -A * 0.15);
      entryTrigger = `Only enter on a ${isLong ? 'close above' : 'close below'} ${fmtPrice(isLong ? rangeHigh : rangeLow)}${isLong ? ' with rising volume' : ''}`;
    } else if (planStyle === 'range') {
      const edge = isLong ? rangeLow + A * 0.25 : rangeHigh - A * 0.25;
      entryType = 'range fade (limit)';
      entryPrice = edge;
      entryLow = edge - A * 0.35;
      entryHigh = edge + A * 0.35;
      entryTrigger = `Limit orders into ${isLong ? 'range support' : 'range resistance'} near ${fmtPrice(edge)} — do not chase mid-range`;
    } else {
      const anchor = e20 != null ? e20 : price;
      const extended = isLong ? priceVsEma20 > 1.1 : priceVsEma20 < -1.1;
      if (extended) {
        entryType = 'limit pullback';
        entryPrice = anchor;
        entryLow = anchor - A * 0.35;
        entryHigh = anchor + A * 0.35;
        entryTrigger = `Wait for a pullback into the EMA20 zone (${fmtPrice(entryLow)}–${fmtPrice(entryHigh)}) instead of chasing`;
      } else {
        entryType = 'market now / small limit';
        entryPrice = price;
        entryLow = price - A * 0.25;
        entryHigh = price + A * 0.25;
        entryTrigger = 'Entry is acceptable at market with a limit inside the zone; scale in on a retest';
      }
    }

    // Stop loss: nearest structure + volatility floor
    let stop, stopReason, stopDistance;
    if (direction === 'NEUTRAL') {
      stop = null; stopDistance = A * 1.5; stopReason = 'No position';
    } else {
      const swingStop = isLong
        ? (swings.lows.length ? Math.min(...swings.lows.slice(-3).map((s) => s.price)) - A * 0.35 : entryPrice - A * 1.5)
        : (swings.highs.length ? Math.max(...swings.highs.slice(-3).map((s) => s.price)) + A * 0.35 : entryPrice + A * 1.5);
      const volStop = isLong ? entryPrice - A * 1.5 : entryPrice + A * 1.5;
      const bandStop = isLong && bbLower != null ? bbLower - A * 0.3
        : !isLong && bbUpper != null ? bbUpper + A * 0.3 : null;
      const candidates = [swingStop, volStop, bandStop].filter(isNum);
      const minDist = Math.max(A * 0.8, entryPrice * 0.0018);
      const maxDist = A * 2.6;
      const valid = candidates
        .map((c) => (isLong ? entryPrice - c : c - entryPrice))
        .filter((d) => d >= minDist && d <= maxDist);
      stopDistance = valid.length ? Math.min(...valid) : Math.min(Math.max(A * 1.5, minDist), maxDist);
      stop = isLong ? entryPrice - stopDistance : entryPrice + stopDistance;
      const parts = [];
      if (swings.lows.length || swings.highs.length) parts.push('placed beyond the recent swing ' + (isLong ? 'low' : 'high'));
      if (stopDistance > A * 1.4) parts.push(`${round(stopDistance / A, 1)}× ATR wide for volatility`);
      stopReason = parts.join(' and ') || 'volatility-based (ATR) stop';
    }

    // Targets: structural levels first, ATR extensions as fallback
    const targets = [];
    if (direction !== 'NEUTRAL') {
      const levelList = (isLong ? resistances.map((l) => l.price) : supports.map((l) => l.price)).slice();
      const ext = isLong ? [rangeHigh + rangeHeight * 0.5, price + A * 3, price + A * 4.5]
        : [rangeLow - rangeHeight * 0.5, price - A * 3, price - A * 4.5];
      const pool = [...levelList, ...ext, ...(isLong
        ? [pivots ? pivots.r1 : null, pivots ? pivots.r2 : null, pivots ? pivots.r3 : null]
        : [pivots ? pivots.s1 : null, pivots ? pivots.s2 : null, pivots ? pivots.s3 : null])]
        .filter(isNum)
        .filter((p) => (isLong ? p > entryPrice + stopDistance * 0.55 : p < entryPrice - stopDistance * 0.55))
        .sort((a, b) => (isLong ? a - b : b - a));

      /* A limit/pullback entry sits away from the market, so a target can end up
         "behind" the live price and count as instantly filled. Every target must
         therefore also clear the current market price by a little. */
      const minTarget = isLong
        ? Math.max(entryPrice + stopDistance * 0.55, price + A * 0.25)
        : Math.min(entryPrice - stopDistance * 0.55, price - A * 0.25);

      const dedupe = [];
      for (const p of pool) {
        if (!dedupe.some((d) => Math.abs(d - p) < stopDistance * 0.35)) dedupe.push(p);
      }
      const picks = [];
      const floors = [1.0, 1.8, 2.6];
      let minR = 0;
      for (let idx = 0; idx < 3; idx++) {
        const needR = Math.max(floors[idx] - 0.25, minR + 0.45);
        let cand = dedupe.find((p) =>
          Math.abs(p - entryPrice) / stopDistance >= needR && (isLong ? p >= minTarget : p <= minTarget));
        if (!isNum(cand)) {
          const projected = entryPrice + (isLong ? 1 : -1) * stopDistance * Math.max(floors[idx], minR + 0.8);
          cand = isLong ? Math.max(projected, minTarget) : Math.min(projected, minTarget);
        }
        picks.push(cand);
        minR = Math.abs(cand - entryPrice) / stopDistance;
      }
      const basisFor = (p) => {
        const r = Math.abs(p - entryPrice) / stopDistance;
        if (resistances.some((l) => Math.abs(l.price - p) < 1e-6) || supports.some((l) => Math.abs(l.price - p) < 1e-6))
          return 'swing level';
        if (pivots && [pivots.r1, pivots.r2, pivots.r3, pivots.s1, pivots.s2, pivots.s3].some((v) => Math.abs(v - p) < 1e-6))
          return 'pivot level';
        if (r >= 2.5) return 'ATR extension / measured move';
        return `${round(r, 1)}R ATR projection`;
      };
      picks.forEach((p, i) => {
        const r = Math.abs(p - entryPrice) / stopDistance;
        targets.push({
          label: `TP${i + 1}`,
          price: p,
          r: round(r, 2),
          pct: round(((p - entryPrice) / entryPrice) * 100, 2),
          basis: basisFor(p),
          sizeHint: i === 0 ? '50%' : i === 1 ? '30%' : '20%',
        });
      });
    }

    const rr = {
      tp1: targets[0] ? targets[0].r : null,
      tp2: targets[1] ? targets[1].r : null,
      tp3: targets[2] ? targets[2].r : null,
      blended: targets.length
        ? round(0.5 * targets[0].r + 0.3 * (targets[1] ? targets[1].r : targets[0].r)
          + 0.2 * (targets[2] ? targets[2].r : targets[1] ? targets[1].r : targets[0].r), 2)
        : null,
    };
    const breakevenWinRate = rr.blended ? round(100 / (1 + rr.blended), 1) : null;

    /* ---------- confidence ---------- */
    const agree = Math.abs(netScore);
    let quality = 0.55;
    quality += adxStrong ? 0.12 : adxWeak ? -0.1 : 0.02;
    if (htf && htf.direction) quality += htf.direction === direction ? 0.12 : htf.direction === 'NEUTRAL' ? 0 : -0.12;
    if (volRatio > 1.15) quality += 0.06;
    if (volRatio < 0.7) quality -= 0.05;
    if (patternDirAgrees(patterns, direction)) quality += 0.05;
    if ((isLong && priceVsEma20 > 2.2) || (!isLong && priceVsEma20 < -2.2)) quality -= 0.08;
    if (rr.blended && rr.blended < 1.6) quality -= 0.08;
    if (rr.blended && rr.blended >= 2.4) quality += 0.05;
    if (noTradeReasons.length) quality -= 0.12 * noTradeReasons.length;
    quality = clamp(quality, 0.2, 1.15);

    let confidence = Math.round(clamp(agree * 150 * quality, 0, 95));
    if (direction === 'NEUTRAL') confidence = Math.min(confidence, 35);
    const grade = confidence >= 78 ? 'A' : confidence >= 65 ? 'B' : confidence >= 50 ? 'C' : confidence >= 35 ? 'D' : 'E';

    /* ---------- position sizing ---------- */
    const account = opts.account || {};
    const balance = isNum(account.balance) ? account.balance : 1000;
    const riskPct = isNum(account.riskPct) ? account.riskPct : 1;
    const riskAmount = (balance * riskPct) / 100;
    const sizing = { balance, riskPct, riskAmount, entry: entryPrice, stopDistance, qty: null, notional: null, leverageNote: null, perTarget: [] };
    if (direction !== 'NEUTRAL' && stopDistance > 0) {
      const qty = riskAmount / stopDistance;
      sizing.qty = qty;
      sizing.notional = qty * entryPrice;
      sizing.leverageNote = sizing.notional > balance
        ? `Notional ${round(sizing.notional / balance, 1)}× your account — that requires leverage/futures. Consider lowering risk % or using spot only.`
        : 'Position fits inside the account without leverage.';
      sizing.perTarget = targets.map((t) => ({
        label: t.label,
        fraction: t.sizeHint,
        profit: qty * Math.abs(t.price - entryPrice) * portion(t.sizeHint),
        rMultiple: t.r,
      }));
    }

    /* ---------- narratives ---------- */
    const confluences = signals
      .filter((s) => s.dir !== 0 && Math.sign(s.dir) === (isLong ? 1 : -1))
      .sort((a, b) => b.strength * b.weight - a.strength * a.weight)
      .slice(0, 6)
      .map((s) => ({ label: s.label, note: s.note }));
    const against = signals
      .filter((s) => s.dir !== 0 && Math.sign(s.dir) === (isLong ? -1 : 1))
      .sort((a, b) => b.strength * b.weight - a.strength * a.weight)
      .slice(0, 4)
      .map((s) => ({ label: s.label, note: s.note }));

    const riskFlags = noTradeReasons.slice();
    if (direction !== 'NEUTRAL' && Math.abs(netScore) < 0.25)
      riskFlags.push(`Signals only weakly agree (score ${round(netScore, 2)}) — the edge is thin, wait for more confluence or cut size`);
    if (adxWeak && direction !== 'NEUTRAL')
      riskFlags.push(`ADX ${isNum(adxNow) ? round(adxNow, 1) : '—'} shows no trend — chop can stop you out repeatedly; trade only the range edges`);
    if (rr.blended && rr.blended < 1.5 && direction !== 'NEUTRAL')
      riskFlags.push(`Reward-to-risk is only ${rr.blended}R to the blended targets — below the usual 2R minimum`);
    if (volRatio < 0.75) riskFlags.push('Volume is below average — moves can fake out');
    if (wideBB) riskFlags.push('Bollinger bands are unusually wide — size down, stops get hit by noise');
    if (htf && htf.direction && htf.direction !== direction && direction !== 'NEUTRAL')
      riskFlags.push(`Higher timeframe (${htf.interval}) disagrees — this is a counter-trend trade, take profits faster`);
    if (Math.abs(priceVsEma20) > 1.8 && direction !== 'NEUTRAL')
      riskFlags.push('Price is extended from the mean — a pullback entry would give a much better stop');

    const primaryTrendline = trendlines.support || trendlines.resistance;
    const tradeLines = {
      entry: entryPrice,
      stop,
      targets: targets.map((t) => ({ label: t.label, price: t.price })),
      trend: primaryTrendline ? {
        kind: primaryTrendline.kind,
        valueNow: primaryTrendline.valueNow,
        slopePerBar: primaryTrendline.slope,
        slopePctPerBar: round((primaryTrendline.slope / price) * 100, 3),
        quality: primaryTrendline.r2,
        note: `${primaryTrendline.kind === 'support' ? 'Rising support' : 'Falling resistance'} trend line, ${round(primaryTrendline.slope / A, 2)}× ATR per bar, fit quality ${primaryTrendline.r2}`,
      } : null,
    };

    const headline = direction === 'NEUTRAL'
      ? `${symbol} ${interval}: no-trade — wait for a clean setup`
      : `${symbol} ${interval}: ${direction} setup, ${grade} grade (${confidence}% confidence)`;

    const summaryParts = [];
    summaryParts.push(`${symbol} on the ${interval} is in a ${regime.replace('-', ' ')} regime with ADX ${isNum(adxNow) ? round(adxNow, 1) : '—'} and ATR ${round(atrPct, 2)}% of price.`);
    if (direction === 'NEUTRAL') {
      summaryParts.push('The weighted signal score is too close to zero to justify risking money, so the engine is telling you to stand aside until price breaks range.');
    } else {
      summaryParts.push(`Bias is ${direction} via a ${entryType} at ${fmtPrice(entryPrice)}, stop ${fmtPrice(stop)} (${round(stopDistance / A, 1)}× ATR), first target ${fmtPrice(targets[0] && targets[0].price)} at ${targets[0] && targets[0].r}R.`);
      summaryParts.push(`Risking ${riskPct}% of ${balance} means about ${round(sizing.qty, 6)} units (${round(sizing.notional, 2)} notional).`);
    }

    const plan = [];
    if (direction !== 'NEUTRAL') {
      plan.push(`1. ${entryTrigger}`);
      plan.push(`2. Place the stop at ${fmtPrice(stop)} — ${stopReason}.`);
      plan.push(`3. Scale out ${targets.map((t) => `${t.sizeHint} at ${t.label} ${fmtPrice(t.price)} (${t.r}R)`).join(', ')}.`);
      plan.push(`4. Move the stop to break-even after TP1 fills, and trail it under each new ${interval} swing ${isLong ? 'low' : 'high'}.`);
      plan.push(`5. The idea is dead if price closes ${isLong ? 'below' : 'above'} ${fmtPrice(planStyle === 'range' ? (isLong ? rangeLow : rangeHigh) : stop)} on a closing basis.`);
    } else {
      plan.push('1. No position. Set an alert on the range edges and re-run the analysis after a breakout close.');
      plan.push('2. Keep your risk budget intact — the best trades come from patience, not from forcing a setup.');
    }

    return {
      ok: true,
      symbol, interval,
      asOf: last.t,
      isDemo: !!last.demo,
      price,
      priceDecimals: priceDecimals(price),
      changePct: round(((price - closes[Math.max(0, n - 25)]) / closes[Math.max(0, n - 25)]) * 100, 2),
      direction, confidence, grade, regime, planStyle,
      score: round(netScore, 3),
      headline, summary: summaryParts.join(' '),
      indicators: {
        ema20: e20, ema50: e50, ema200: e200,
        rsi: rsiNow, atr: A, atrPct, adx: adxNow, plusDI, minusDI,
        macd: { line: macdLine, signal: macdSig, hist: macdHist },
        bb: { upper: bbUpper, mid: bbMid, lower: bbLower, widthPct: bbWidth ? round(bbWidth * 100, 2) : null },
        stoch: { k: stochK, d: stochD },
        vwap: vw,
        volRatio: round(volRatio, 2),
        bbWidthAvg,
      },
      series: { ema20, ema50, ema200 },
      levels: {
        supports, resistances, rangeHigh, rangeLow,
        rangePosPct: round(rangePos * 100, 1),
        pivots,
      },
      trendlines,
      patterns,
      signals,
      confluences,
      against,
      riskFlags,
      entry: { type: entryType, low: entryLow, high: entryHigh, price: entryPrice, trigger: entryTrigger },
      stop: { price: stop, distance: stopDistance, pct: stop ? round((Math.abs(stop - entryPrice) / entryPrice) * 100, 2) : null, atrMultiple: round(stopDistance / A, 2), reason: stopReason },
      targets,
      rr,
      breakevenWinRate,
      sizing,
      tradeLines,
      plan,
      noTrade: direction === 'NEUTRAL',
      candles: n,
      provider: opts.provider || null,
    };
  }

  function portion(sizeHint) {
    const v = parseFloat(sizeHint);
    return isNum(v) ? v / 100 : 0.33;
  }

  function patternDirAgrees(patterns, direction) {
    if (!patterns.length || direction === 'NEUTRAL') return false;
    const want = direction === 'LONG' ? 1 : -1;
    return patterns.some((p) => p.dir === want && p.strength >= 0.6);
  }

  /** Compact text version of an analysis — used by the chat bot & copy button. */
  function toText(a) {
    if (!a || !a.ok) return 'Analysis unavailable.';
    const L = [];
    L.push(`${a.headline}`);
    L.push(`Data: ${a.provider || 'demo'} · ${a.candles} candles · live price ${fmtPrice(a.price)} (${fmtPct(a.changePct)})`);
    if (a.direction === 'NEUTRAL') {
      L.push(`Reason: ${a.riskFlags[0] || 'signals are balanced'}`);
      L.push('Plan: stand aside, set alerts on the range edges.');
      return L.join('\n');
    }
    L.push(`Entry  : ${fmtPrice(a.entry.price)} [${a.entry.type}] zone ${fmtPrice(a.entry.low)} – ${fmtPrice(a.entry.high)}`);
    L.push(`Stop   : ${fmtPrice(a.stop.price)} (${a.stop.pct}% / ${a.stop.atrMultiple}× ATR) — ${a.stop.reason}`);
    a.targets.forEach((t) => L.push(`${t.label}     : ${fmtPrice(t.price)} (${t.r}R, ${t.basis})`));
    L.push(`R:R    : ${a.rr.tp1}R / ${a.rr.tp2}R / ${a.rr.tp3}R · blended ${a.rr.blended}R · breakeven win-rate ${a.breakevenWinRate}%`);
    L.push(`Size   : ${round(a.sizing.qty, 6)} units for ${a.sizing.riskPct}% risk of ${a.sizing.balance} (${round(a.sizing.notional, 2)} notional)`);
    if (a.tradeLines.trend) L.push(`Trade line: ${a.tradeLines.trend.note}`);
    return L.join('\n');
  }

  return {
    // indicators
    sma, ema, rsi, atr, macd, bollinger, stochastic, adx, vwap, stdev,
    // structure
    findSwings, clusterLevels, linreg, buildTrendlines, pivotPoints, candlePatterns, detectDivergence,
    // engine
    analyze, toText, syntheticCandles, TF_MS, fmtPrice, fmtPct, priceDecimals,
    version: '1.0.0',
  };
});
