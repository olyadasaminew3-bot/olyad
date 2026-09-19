/* Verifies the exchange adapters with mocked HTTP responses (this sandbox has
   no outbound internet, so the real endpoints cannot be reached here).
   Each provider's documented payload shape is replayed and the parsed candles
   are checked, including the fallback order and the offline DEMO path.
   Run: node tools/test-feed.mjs                                            */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const Data = require(path.join(here, '..', 'js', 'trade-data.js'));

let pass = 0, fail = 0;
const out = [];
const check = (name, cond, info = '') => {
  if (cond) { pass++; out.push(`  ok   ${name}`); }
  else { fail++; out.push(`  FAIL ${name}${info ? ' — ' + info : ''}`); }
};

const HOUR = 3600000;
const base = Date.now() - 400 * HOUR;
const N = 300;

/* ---------- payload builders (mirroring the real API shapes) ---------- */
const price = (i) => 100 + Math.sin(i / 9) * 6 + i * 0.05;

const payloads = {
  binance: (url) => {
    if (url.includes('/ticker/price')) return { price: '123.45' };
    if (!url.includes('/klines')) throw new Error('unexpected binance url ' + url);
    return Array.from({ length: N }, (_, i) => [base + i * HOUR, price(i).toFixed(2), (price(i) + 0.5).toFixed(2), (price(i) - 0.5).toFixed(2), (price(i) + 0.1).toFixed(2), '1234.5', base + i * HOUR + HOUR - 1, '0', 10, '0', '0', '0']);
  },
  bybit: () => ({
    retCode: 0,
    result: {
      list: Array.from({ length: N }, (_, i) => [String(base + i * HOUR), price(i).toFixed(2), (price(i) + 0.5).toFixed(2), (price(i) - 0.5).toFixed(2), (price(i) + 0.1).toFixed(2), '1234.5', '99999'])
        .reverse(),
    },
  }),
  okx: () => ({
    code: '0',
    data: Array.from({ length: N }, (_, i) => [String(base + i * HOUR), price(i).toFixed(2), (price(i) + 0.5).toFixed(2), (price(i) - 0.5).toFixed(2), (price(i) + 0.1).toFixed(2), '1234.5', '0', '0', '1'])
      .reverse(),
  }),
  coinbase: () => Array.from({ length: N }, (_, i) => [Math.floor((base + i * HOUR) / 1000), price(i) - 0.5, price(i) + 0.5, price(i), price(i) + 0.1, 12.5])
    .reverse(),
  kraken: () => ({
    error: [],
    result: {
      XXBTZUSD: Array.from({ length: N }, (_, i) => [Math.floor((base + i * HOUR) / 1000), price(i).toFixed(2), price(i).toFixed(2), price(i).toFixed(2), price(i).toFixed(2), price(i).toFixed(2), '12.5', 100]),
      last: 12345,
    },
  }),
  bitstamp: () => ({
    data: {
      ohlc: Array.from({ length: N }, (_, i) => ({
        high: (price(i) + 0.5).toFixed(2), timestamp: String(Math.floor((base + i * HOUR) / 1000)),
        volume: '42.5', low: (price(i) - 0.5).toFixed(2), open: price(i).toFixed(2), close: (price(i) + 0.1).toFixed(2),
      })).reverse(),
    },
  }),
};

const HOST_MAP = {
  'api.binance.com': 'binance', 'data-api.binance.vision': 'binance',
  'api.bybit.com': 'bybit', 'www.okx.com': 'okx',
  'api.exchange.coinbase.com': 'coinbase', 'api.kraken.com': 'kraken', 'www.bitstamp.net': 'bitstamp',
};

let calls = [];
let failHosts = new Set();
globalThis.fetch = async (url) => {
  calls.push(url);
  const host = new URL(url).host;
  const id = HOST_MAP[host];
  if (failHosts.has(id)) return { ok: false, status: 451, json: async () => ({}) };
  if (!id) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => payloads[id](url) };
};

const order = ['binance', 'bybit', 'okx', 'coinbase', 'kraken', 'bitstamp'];

/* ---------- each provider parses correctly when it is the only one up ---- */
for (const prov of order) {
  failHosts = new Set(order.filter((p) => p !== prov));
  Data.setPreferred(null);
  calls = [];
  const res = await Data.loadCandles('BTCUSDT', '1h', 300);
  const c = res.candles;
  check(`${prov}: used when the others fail`, !res.demo && res.provider.includes(prov === 'binance' ? 'Binance' : prov === 'okx' ? 'OKX' : prov[0].toUpperCase() + prov.slice(1)),
    `${res.provider} demo=${res.demo}`);
  check(`${prov}: parsed ${N} candles ascending`,
    c.length > 40 && c.every((x, i) => i === 0 || x.t > c[i - 1].t),
    `n=${c.length}`);
  check(`${prov}: OHLC fields are sane`, c.every((x) => x.h >= x.c && x.h >= x.o && x.l <= x.c && x.l <= x.o && x.v > 0));
}

/* ---------- 4h candles on Coinbase must be aggregated from 1h, not 6h ---- */
{
  failHosts = new Set(order.filter((p) => p !== 'coinbase'));
  calls = [];
  const res = await Data.loadCandles('BTCUSDT', '4h', 200);
  const c = res.candles;
  const gap = c.length > 2 ? c[1].t - c[0].t : 0;
  check('coinbase 4h: requests 1h granularity (21600 is 6h, not 4h)', calls.some((u) => u.includes('granularity=3600')), calls.join(' '));
  check('coinbase 4h: candles are spaced 4h apart', gap === 4 * HOUR, `${gap / HOUR}h`);
  check('coinbase 4h: aggregation sums volume and keeps wicks', c.length >= 50 && c[0].h >= c[0].c && c[0].v > 12.5);
}

/* ---------- preferred provider is tried first ---------- */
failHosts = new Set();
Data.setPreferred('okx');
calls = [];
await Data.loadCandles('BTCUSDT', '1h', 300);
check('preferred provider is called first', calls[0].includes('okx.com'), calls[0]);
Data.setPreferred(null);

/* ---------- every provider down => DEMO ---------- */
failHosts = new Set(order);
const demoRes = await Data.loadCandles('BTCUSDT', '1h', 200);
check('all providers down → demo candles', demoRes.demo === true && demoRes.candles.length >= 100, `n=${demoRes.candles.length}`);
check('demo candles are deterministic per symbol+interval',
  demoRes.candles[10].c === (await Data.loadCandles('BTCUSDT', '1h', 200)).candles[10].c);
check('demo provider is clearly labelled', /DEMO/.test(demoRes.provider));
check('attempt log lists the failures', demoRes.attempts.length >= 4, JSON.stringify(demoRes.attempts.slice(0, 2)));

/* ---------- spot price + HTF ---------- */
failHosts = new Set(order.filter((p) => p !== 'binance'));
const sp = await Data.getPrice('BTCUSDT');
check('getPrice returns the ticker price', sp.price === 123.45 && sp.provider === 'Binance', JSON.stringify(sp));
const htf = await Data.loadHTF('BTCUSDT', '1h');
check('HTF confluence is derived from the next timeframes up', htf && ['4h', '1h', '1d'].includes(htf.interval) && !!htf.direction, JSON.stringify(htf && htf.interval + ' ' + htf.direction));
const htfDemo = await (async () => { failHosts = new Set(order); return Data.loadHTF('BTCUSDT', '1h'); })();
check('HTF is skipped entirely when data is demo', htfDemo === null);

/* ---------- a full run through the engine with parsed candles ---------- */
failHosts = new Set(order.filter((p) => p !== 'kraken'));
const { candles } = await Data.loadCandles('ETHUSDT', '4h', 300);
const Engine = require(path.join(here, '..', 'js', 'trade-engine.js'));
const a = Engine.analyze(candles, { symbol: 'Ethereum / USDT', interval: '4h', account: { balance: 500, riskPct: 2 } });
check('parsed candles produce a valid analysis', a.ok && a.candles === candles.length, a.error);
check('sizing respects the 2% risk on a 500 account', a.sizing.riskAmount === 10, String(a.sizing.riskAmount));
check('Kraken symbol mapping used for ETH', calls.some((u) => u.includes('pair=ETHUSD')), calls.find((u) => u.includes('kraken')) || '');

console.log('\nDoro Trade AI — feed adapter tests\n' + out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
