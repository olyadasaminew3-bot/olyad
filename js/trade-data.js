/* ============================================================
   Doro Trade AI — Market data
   Fetches OHLCV candles from public exchange APIs (no API key),
   walking through several providers until one answers. If the
   network is unavailable the module falls back to deterministic
   demo candles so the analyser can always be demonstrated.

   Everything runs in the browser — deploy the static site as-is.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Engine = (typeof module === 'object' && module.exports)
    ? require('./trade-engine.js')
    : (typeof self !== 'undefined' ? self.TradeEngine : null);

  /* ---------------------------------------------------------
     Catalog
     --------------------------------------------------------- */
  const INTERVALS = [
    { id: '5m', label: '5 minutes', ms: 300000 },
    { id: '15m', label: '15 minutes', ms: 900000 },
    { id: '1h', label: '1 hour', ms: 3600000 },
    { id: '4h', label: '4 hours', ms: 14400000 },
    { id: '1d', label: '1 day', ms: 86400000 },
  ];

  const SYMBOLS = [
    { id: 'BTCUSDT', name: 'Bitcoin / USDT', binance: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT', coinbase: 'BTC-USD', kraken: 'XBTUSD', bitstamp: 'btcusd', base: 68000 },
    { id: 'ETHUSDT', name: 'Ethereum / USDT', binance: 'ETHUSDT', bybit: 'ETHUSDT', okx: 'ETH-USDT', coinbase: 'ETH-USD', kraken: 'ETHUSD', bitstamp: 'ethusd', base: 3500 },
    { id: 'BNBUSDT', name: 'BNB / USDT', binance: 'BNBUSDT', bybit: 'BNBUSDT', okx: 'BNB-USDT', base: 560 },
    { id: 'SOLUSDT', name: 'Solana / USDT', binance: 'SOLUSDT', bybit: 'SOLUSDT', okx: 'SOL-USDT', coinbase: 'SOL-USD', kraken: 'SOLUSD', base: 150 },
    { id: 'XRPUSDT', name: 'XRP / USDT', binance: 'XRPUSDT', bybit: 'XRPUSDT', okx: 'XRP-USDT', coinbase: 'XRP-USD', kraken: 'XRPUSD', bitstamp: 'xrpusd', base: 0.55 },
    { id: 'ADAUSDT', name: 'Cardano / USDT', binance: 'ADAUSDT', bybit: 'ADAUSDT', okx: 'ADA-USDT', kraken: 'ADAUSD', base: 0.45 },
    { id: 'DOGEUSDT', name: 'Dogecoin / USDT', binance: 'DOGEUSDT', bybit: 'DOGEUSDT', okx: 'DOGE-USDT', kraken: 'XDGUSD', bitstamp: 'dogeusd', base: 0.13 },
    { id: 'AVAXUSDT', name: 'Avalanche / USDT', binance: 'AVAXUSDT', bybit: 'AVAXUSDT', okx: 'AVAX-USDT', base: 32 },
    { id: 'LINKUSDT', name: 'Chainlink / USDT', binance: 'LINKUSDT', bybit: 'LINKUSDT', okx: 'LINK-USDT', coinbase: 'LINK-USD', kraken: 'LINKUSD', base: 15 },
    { id: 'TONUSDT', name: 'Toncoin / USDT', binance: 'TONUSDT', bybit: 'TONUSDT', okx: 'TON-USDT', base: 6.5 },
    { id: 'EURUSDT', name: 'Euro / USDT', binance: 'EURUSDT', bybit: 'EURUSDT', okx: 'EUR-USDT', base: 1.08 },
    { id: 'XAUUSDT', name: 'Gold (PAXG ≈ XAU/USD)', binance: 'PAXGUSDT', bybit: 'PAXGUSDT', okx: 'PAXG-USDT', base: 2400, note: 'Tracked through PAXG, the gold-backed token — a very close proxy for spot gold.' },
    { id: 'WBTCUSDT', name: 'Wrapped BTC / USDT', binance: 'WBTCUSDT', base: 67000 },
  ];

  const symbolById = (id) => SYMBOLS.find((s) => s.id === id) || SYMBOLS[0];

  /* interval mapping per provider ---------------------------- */
  const BINANCE_IV = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
  const BYBIT_IV = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  const OKX_IV = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
  // Coinbase granularities are 60/300/900/3600/21600/86400 — note 21600 is SIX hours,
  // so 4h candles are built by aggregating four 1h candles instead of asking for 6h data.
  const COINBASE_GRAN = { '5m': 300, '15m': 900, '1h': 3600, '4h': 3600, '1d': 86400 };
  const COINBASE_AGG = { '4h': 4 };
  const KRAKEN_IV = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  const BITSTAMP_STEP = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

  /* ---------------------------------------------------------
     Provider adapters. Each returns [{t,o,h,l,c,v}] ascending.
     --------------------------------------------------------- */
  function j(url, ms = 9000, init) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, Object.assign({ signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' }, init || {}))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .finally(() => timer && clearTimeout(timer));
  }

  /** Merge every `factor` consecutive candles into one (used when an exchange
      does not offer the requested timeframe, e.g. 4h on Coinbase). */
  function aggregate(candles, factor) {
    if (factor <= 1) return candles;
    const out = [];
    for (let i = 0; i + factor <= candles.length; i += factor) {
      const win = candles.slice(i, i + factor);
      out.push({
        t: win[0].t,
        o: win[0].o,
        h: Math.max(...win.map((c) => c.h)),
        l: Math.min(...win.map((c) => c.l)),
        c: win[win.length - 1].c,
        v: win.reduce((s2, c) => s2 + (c.v || 0), 0),
      });
    }
    return out;
  }

  const num = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) throw new Error('bad number in payload');
    return n;
  };

  const PROVIDERS = {
    binance: {
      label: 'Binance public API',
      hosts: ['https://api.binance.com', 'https://data-api.binance.vision'],
      supports: (sym) => !!sym.binance,
      async candles(sym, interval, limit) {
        let lastErr;
        for (const host of this.hosts) {
          try {
            const data = await j(`${host}/api/v3/klines?symbol=${sym.binance}&interval=${BINANCE_IV[interval]}&limit=${limit}`);
            if (!Array.isArray(data)) throw new Error('unexpected payload');
            return data.map((k) => ({
              t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]),
            }));
          } catch (e) { lastErr = e; }
        }
        throw lastErr;
      },
    },
    bybit: {
      label: 'Bybit public API',
      supports: (sym) => !!sym.bybit,
      async candles(sym, interval, limit) {
        const d = await j(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym.bybit}&interval=${BYBIT_IV[interval]}&limit=${Math.min(limit, 1000)}`);
        const list = d?.result?.list;
        if (!Array.isArray(list) || !list.length) throw new Error('empty payload');
        return list.map((k) => ({
          t: Number(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]),
        })).reverse();
      },
    },
    okx: {
      label: 'OKX public API',
      supports: (sym) => !!sym.okx,
      async candles(sym, interval, limit) {
        const d = await j(`https://www.okx.com/api/v5/market/candles?instId=${sym.okx}&bar=${OKX_IV[interval]}&limit=${Math.min(limit, 300)}`);
        const list = d?.data;
        if (!Array.isArray(list) || !list.length) throw new Error('empty payload');
        return list.map((k) => ({
          t: Number(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]),
        })).reverse();
      },
    },
    coinbase: {
      label: 'Coinbase Exchange public API',
      supports: (sym, interval) => !!sym.coinbase && ['5m', '15m', '1h', '4h', '1d'].includes(interval),
      async candles(sym, interval, limit) {
        const gran = COINBASE_GRAN[interval];
        const factor = COINBASE_AGG[interval] || 1;
        const d = await j(`https://api.exchange.coinbase.com/products/${sym.coinbase}/candles?granularity=${gran}`);
        if (!Array.isArray(d) || !d.length) throw new Error('empty payload');
        const hourly = d.map((k) => ({
          t: k[0] * 1000, o: num(k[3]), h: num(k[2]), l: num(k[1]), c: num(k[4]), v: num(k[5]),
        })).sort((a, b) => a.t - b.t);
        return aggregate(hourly, factor).slice(-limit);
      },
    },
    kraken: {
      label: 'Kraken public API',
      supports: (sym) => !!sym.kraken,
      async candles(sym, interval, limit) {
        const d = await j(`https://api.kraken.com/0/public/OHLC?pair=${sym.kraken}&interval=${KRAKEN_IV[interval]}`);
        if (d?.error?.length) throw new Error(d.error.join(' '));
        const key = Object.keys(d.result || {}).find((k) => k !== 'last');
        const list = d?.result?.[key];
        if (!Array.isArray(list) || !list.length) throw new Error('empty payload');
        return list.map((k) => ({
          t: k[0] * 1000, o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[6]),
        })).slice(-limit);
      },
    },
    bitstamp: {
      label: 'Bitstamp public API',
      supports: (sym) => !!sym.bitstamp,
      async candles(sym, interval, limit) {
        const d = await j(`https://www.bitstamp.net/api/v2/ohlc/${sym.bitstamp}/?step=${BITSTAMP_STEP[interval]}&limit=${Math.min(limit, 1000)}`);
        const list = d?.data?.ohlc;
        if (!Array.isArray(list) || !list.length) throw new Error('empty payload');
        return list.map((k) => ({
          t: Number(k.timestamp) * 1000, o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), v: num(k.volume),
        })).sort((a, b) => a.t - b.t);
      },
    },
  };

  const PROVIDER_ORDER = ['binance', 'bybit', 'okx', 'coinbase', 'kraken', 'bitstamp'];

  /* ---------------------------------------------------------
     Loader with fallback + demo mode
     --------------------------------------------------------- */
  const state = {
    customUrl: null,        // optional user-supplied JSON proxy
    preferred: null,        // provider id to try first
    lastProvider: null,
    lastError: null,
  };

  function setCustomUrl(url) { state.customUrl = url && url.trim() ? url.trim() : null; }
  function setPreferred(id) { state.preferred = id || null; }

  function normaliseCandles(raw) {
    if (!Array.isArray(raw)) throw new Error('custom feed did not return an array');
    const out = raw.map((c) => {
      if (Array.isArray(c)) return { t: Number(c[0]) < 1e11 ? Number(c[0]) * 1000 : Number(c[0]), o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: c[5] != null ? num(c[5]) : 0 };
      return { t: Number(c.t) < 1e11 ? Number(c.t) * 1000 : Number(c.t), o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: c.v != null ? num(c.v) : 0 };
    }).filter((c) => [c.o, c.h, c.l, c.c].every((v) => isFinite(v) && v > 0) && isFinite(c.t));
    out.sort((a, b) => a.t - b.t);
    if (out.length < 30) throw new Error(`custom feed returned only ${out.length} usable candles`);
    return out;
  }

  async function loadCandles(symbolId, interval, limit = 320) {
    const sym = symbolById(symbolId);
    const errors = [];

    if (state.customUrl) {
      try {
        const url = `${state.customUrl}${state.customUrl.includes('?') ? '&' : '?'}symbol=${encodeURIComponent(symbolId)}&interval=${encodeURIComponent(interval)}`;
        const candles = normaliseCandles(await j(url, 10000));
        state.lastProvider = 'custom feed';
        state.lastError = null;
        return { candles, provider: 'custom feed', symbol: sym, interval, demo: false };
      } catch (e) { errors.push(`custom: ${e.message}`); }
    }

    const order = state.preferred && PROVIDERS[state.preferred]
      ? [state.preferred, ...PROVIDER_ORDER.filter((p) => p !== state.preferred)]
      : PROVIDER_ORDER;

    for (const id of order) {
      const p = PROVIDERS[id];
      if (!p || !p.supports(sym, interval)) continue;
      try {
        const candles = await p.candles(sym, interval, limit);
        if (!Array.isArray(candles) || candles.length < 40) throw new Error(`only ${candles && candles.length} candles`);
        state.lastProvider = p.label;
        state.lastError = errors.length ? errors.join(' | ') : null;
        return { candles, provider: p.label, symbol: sym, interval, demo: false, attempts: errors };
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }

    /* Offline / blocked — deterministic demo candles so the tool still works. */
    state.lastProvider = 'DEMO (no live feed reachable)';
    state.lastError = errors.join(' | ');
    const iv = INTERVALS.find((i) => i.id === interval) || INTERVALS[2];
    const candles = Engine.syntheticCandles(`${symbolId}-${interval}`, limit, iv.ms, sym.base, 0.011);
    return { candles, provider: 'DEMO (no live feed reachable)', symbol: sym, interval, demo: true, attempts: errors };
  }

  /** Lightweight last-price lookup used by the alert engine (best effort). */
  async function getPrice(symbolId) {
    const sym = symbolById(symbolId);
    if (sym.binance) {
      try {
        const d = await j(`https://api.binance.com/api/v3/ticker/price?symbol=${sym.binance}`, 7000);
        const p = parseFloat(d?.price);
        if (isFinite(p) && p > 0) return { price: p, provider: 'Binance' };
      } catch { /* next */ }
    }
    if (sym.coinbase) {
      try {
        const d = await j(`https://api.exchange.coinbase.com/products/${sym.coinbase}/ticker`, 7000);
        const p = parseFloat(d?.price);
        if (isFinite(p) && p > 0) return { price: p, provider: 'Coinbase' };
      } catch { /* next */ }
    }
    if (sym.kraken) {
      try {
        const d = await j(`https://api.kraken.com/0/public/Ticker?pair=${sym.kraken}`, 7000);
        const key = Object.keys(d.result || {})[0];
        const p = parseFloat(d?.result?.[key]?.c?.[0]);
        if (isFinite(p) && p > 0) return { price: p, provider: 'Kraken' };
      } catch { /* next */ }
    }
    if (sym.bybit) {
      try {
        const d = await j(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym.bybit}`, 7000);
        const p = parseFloat(d?.result?.list?.[0]?.lastPrice);
        if (isFinite(p) && p > 0) return { price: p, provider: 'Bybit' };
      } catch { /* give up */ }
    }
    return { price: null, provider: null };
  }

  /** Fetch the higher timeframe used for confluence (best-effort). */
  async function loadHTF(symbolId, interval, limit = 260) {
    const idx = INTERVALS.findIndex((i) => i.id === interval);
    const htf = INTERVALS[Math.min(INTERVALS.length - 1, idx + 2)] || INTERVALS[INTERVALS.length - 1];
    if (htf.id === interval) return null;
    try {
      const { candles, demo } = await loadCandles(symbolId, htf.id, limit);
      if (demo) return null;
      const a = Engine.analyze(candles, { symbol: symbolId, interval: htf.id });
      if (!a.ok) return null;
      return {
        interval: htf.id, direction: a.direction, confidence: a.confidence, regime: a.regime,
        price: a.price, ema50: a.indicators.ema50, rsi: a.indicators.rsi,
      };
    } catch { return null; }
  }

  return {
    INTERVALS, SYMBOLS, PROVIDERS, PROVIDER_ORDER,
    symbolById, loadCandles, loadHTF, getPrice, normaliseCandles, aggregate,
    setCustomUrl, setPreferred,
    get status() {
      return { provider: state.lastProvider, error: state.lastError, preferred: state.preferred, customUrl: state.customUrl };
    },
  };
});
