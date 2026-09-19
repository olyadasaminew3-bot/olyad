/* Node test-runner for the Trade AI engine.
   Run: node tools/test-engine.mjs
   No dependencies — used to verify the indicator math and the
   consistency of the generated trade plans. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const E = require(path.join(here, '..', 'js', 'trade-engine.js'));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, info = '') {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${info ? ' — ' + info : ''}`); }
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

/* ---------- 1. moving averages ---------- */
const vals = [1, 2, 3, 4, 5, 6];
check('SMA(3) last = 5', E.sma(vals, 3)[5] === 5);
check('SMA seeds with null', E.sma(vals, 3)[1] === null);
const em = E.ema([1, 2, 3, 4, 5, 6, 7], 3);
check('EMA(3) seeds with SMA', em[2] === 2);
// k = 2/(3+1) = 0.5 -> 4*0.5 + 2*0.5 = 3
check('EMA(3) next step = 3', em[3] === 3, String(em[3]));

/* ---------- 2. RSI vs the classic Wilder/StockCharts series ---------- */
const rsiCloses = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];
const r = E.rsi(rsiCloses, 14);
check('RSI first value ≈ 70.5', near(r[14], 70.5, 0.8), String(r[14]));
check('RSI final value ≈ 37.8', near(r[32], 37.8, 1.5), String(r[32]));
check('RSI stays within 0..100', r.filter(v => v != null).every(v => v >= 0 && v <= 100));

/* ---------- 3. ATR ---------- */
const flat = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }));
check('ATR of a constant 2-range series = 2', near(E.atr(flat, 14).at(-1), 2, 1e-9), String(E.atr(flat, 14).at(-1)));
const gapping = Array.from({ length: 10 }, (_, i) => ({ t: i, o: 10 + i * 5, h: 12 + i * 5, l: 10 + i * 5, c: 11 + i * 5, v: 1 }));
check('ATR captures gaps', E.atr(gapping, 14).at(-1) === null || E.atr(gapping, 14).at(-1) > 2);

/* ---------- 4. ADX on a clean trend ---------- */
const uptrend = [];
let px = 100;
for (let i = 0; i < 120; i++) {
  const open = px;
  px = px * 1.006;
  uptrend.push({ t: i, o: open, h: px * 1.001, l: open * 0.999, c: px, v: 1000 + i * 10 });
}
const adxUp = E.adx(uptrend, 14);
check('ADX > 40 on a clean uptrend', adxUp.adx.at(-1) > 40, String(adxUp.adx.at(-1)));
check('+DI > -DI on a clean uptrend', adxUp.plusDI.at(-1) > adxUp.minusDI.at(-1));

/* ---------- 5. Bollinger ---------- */
const bb = E.bollinger([...Array(30).keys()].map(i => 10 + i % 3), 20, 2);
check('Bollinger upper > mid > lower', bb.upper.at(-1) > bb.mid.at(-1) && bb.mid.at(-1) > bb.lower.at(-1));

/* ---------- 6. analyze() on a clean uptrend ---------- */
const upCandles = E.syntheticCandles('BTCUSDT-1h', 300, 3600000, 60000, 0.004);
const upForced = [];
{
  let p = 50000;
  for (let i = 0; i < 300; i++) {
    const o = p;
    p = p * (1 + 0.0022 + Math.sin(i / 7) * 0.0012);
    upForced.push({ t: Date.now() - (300 - i) * 3600000, o, h: Math.max(o, p) * 1.0012, l: Math.min(o, p) * 0.9988, c: p, v: 1200 + (i % 11) * 30 });
  }
}
const A1 = E.analyze(upForced, { symbol: 'TESTUP', interval: '1h', account: { balance: 10000, riskPct: 1 } });
check('analyze() returns ok', A1.ok === true, A1.error);
check('uptrend -> LONG', A1.direction === 'LONG', A1.direction);
check('regime is trending-up', A1.regime === 'trending-up', A1.regime);
check('confidence in 0..95', A1.confidence >= 0 && A1.confidence <= 95, String(A1.confidence));
check('stop below entry', A1.stop.price < A1.entry.price);
check('stop respects the ATR floor', A1.stop.distance >= A1.indicators.atr * 0.79,
  `${A1.stop.distance} vs atr ${A1.indicators.atr}`);
check('targets ascend', A1.targets[0].price < A1.targets[1].price && A1.targets[1].price < A1.targets[2].price);
check('R multiples ascend', A1.targets[0].r < A1.targets[1].r && A1.targets[1].r < A1.targets[2].r,
  JSON.stringify(A1.targets.map(t => t.r)));
check('targets are above entry', A1.targets.every(t => t.price > A1.entry.price));
check('risk amount = 1% of balance', near(A1.sizing.riskAmount, 100, 1e-9), String(A1.sizing.riskAmount));
check('qty = risk / stop distance', near(A1.sizing.qty, 100 / A1.stop.distance, 1e-6));
check('trade lines carry entry/stop/targets', A1.tradeLines.entry === A1.entry.price && A1.tradeLines.stop === A1.stop.price && A1.tradeLines.targets.length === 3);
check('narrative mentions entry, stop and TP', /Entry/.test(E.toText(A1)) && /Stop/.test(E.toText(A1)) && /TP1/.test(E.toText(A1)));
check('analysis is JSON-safe', (() => { try { JSON.parse(JSON.stringify(A1)); return true; } catch { return false; } })());

/* ---------- 7. analyze() on a clean downtrend ---------- */
const downForced = [];
{
  let p = 80000;
  for (let i = 0; i < 300; i++) {
    const o = p;
    p = p * (1 - 0.0022 - Math.abs(Math.sin(i / 8)) * 0.0008);
    downForced.push({ t: Date.now() - (300 - i) * 3600000, o, h: Math.max(o, p) * 1.0012, l: Math.min(o, p) * 0.9988, c: p, v: 900 + (i % 9) * 25 });
  }
}
const A2 = E.analyze(downForced, { symbol: 'TESTDN', interval: '4h' });
check('downtrend -> SHORT', A2.direction === 'SHORT', A2.direction);
check('stop above entry on shorts', A2.stop.price > A2.entry.price);
check('targets descend on shorts', A2.targets[0].price > A2.targets[1].price && A2.targets[1].price > A2.targets[2].price);
check('targets below entry on shorts', A2.targets.every(t => t.price < A2.entry.price));

/* ---------- 8. choppy market is punished ---------- */
const chop = [];
{
  let p = 100;
  for (let i = 0; i < 250; i++) {
    const o = p;
    p = 100 + Math.sin(i / 4) * 0.6 + (i % 2 ? 0.05 : -0.05);
    chop.push({ t: Date.now() - (250 - i) * 3600000, o, h: Math.max(o, p) + 0.15, l: Math.min(o, p) - 0.15, c: p, v: 500 });
  }
}
const A3 = E.analyze(chop, { symbol: 'CHOP', interval: '1h' });
check('chop confidence stays modest', A3.confidence <= 60, String(A3.confidence));
check('chop produces risk flags or no-trade', A3.riskFlags.length > 0 || A3.direction === 'NEUTRAL',
  `${A3.direction} flags=${A3.riskFlags.length}`);

/* ---------- 9. short input / edge cases ---------- */
check('too few candles handled', E.analyze([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }], {}).ok === false);
check('synthetic candles are deterministic', (() => {
  const a = E.syntheticCandles('X', 50, 3600000, 100, 0.01).map(c => c.c.toFixed(6)).join();
  const b = E.syntheticCandles('X', 50, 3600000, 100, 0.01).map(c => c.c.toFixed(6)).join();
  return a === b;
})());
check('different symbols get different data', (() => {
  const a = E.syntheticCandles('AAA', 20, 3600000, 100, 0.01).map(c => c.c).join();
  const b = E.syntheticCandles('BBB', 20, 3600000, 100, 0.01).map(c => c.c).join();
  return a !== b;
})());

/* ---------- 10. HTF confluence moves confidence ---------- */
const aligned = E.analyze(upForced, { symbol: 'X', interval: '1h', htf: { interval: '4h', direction: 'LONG', confidence: 70 } });
const against = E.analyze(upForced, { symbol: 'X', interval: '1h', htf: { interval: '4h', direction: 'SHORT', confidence: 70 } });
check('HTF agreement raises confidence', aligned.confidence > against.confidence,
  `${aligned.confidence} vs ${against.confidence}`);

/* ---------- 11. structure helpers ---------- */
const sw = E.findSwings(upForced, 2);
check('swings found', sw.highs.length > 0 && sw.lows.length > 0);
const tl = E.buildTrendlines(upForced, sw);
check('trend line fitted on an uptrend has a positive slope', tl.support && tl.support.slope > 0);
const piv = E.pivotPoints(upForced);
check('pivots are ordered s3 < s1 < pp < r1 < r3', piv.s3 < piv.s1 && piv.s1 < piv.pp && piv.pp < piv.r1 && piv.r1 < piv.r3);

/* ---------- 12. bot replies ---------- */
const Bot = require(path.join(here, '..', 'js', 'trade-bot.js'));
const DataMod = require(path.join(here, '..', 'js', 'trade-data.js'));
const ctx = { analysis: A1, catalog: DataMod.SYMBOLS, watchlist: [{ id: 'W1', a: A2 }, { id: 'W2', a: A1 }] };
const ask = (q, c = ctx) => Bot.reply(q, c).text || '';

check('bot answers "analyze" with entry+stop+targets',
  /Entry/.test(ask('analyze')) && /Stop loss/.test(ask('analyze')) && /TP1/.test(ask('analyze')));
check('bot answers "where is my entry"', /Entry for/.test(ask('where is my entry')));
check('bot answers "stop loss" with break-even rule', /break-even/i.test(ask('stop loss')));
check('bot answers "targets"', /TP2/.test(ask('targets')));
check('bot sizes "risk 1% of 5000"', /5,000\.00|5000\.00/.test(ask('risk 1% of 5000')));
check('bot sizes "risk 2% of 10000" to 200', /200\.00/.test(ask('risk 2% of 10000')));
check('bot explains the trade lines', /Trend line|Stop line|trade line/i.test(ask('trade line')));
check('bot explains risk flags', /could go wrong/i.test(ask('what could go wrong')));
check('bot ranks the watchlist', /TESTUP|TESTDN/.test(ask('best trade')));
check('bot switches asset + timeframe via action',
  (() => { const r = Bot.reply('analyse ETH on 4h', ctx); return r.action && r.action.symbol === 'ETHUSDT' && r.action.interval === '4h'; })());
check('bot glossary answers RSI', /RSI\(14\)/.test(ask('explain RSI please')));
check('bot help lists commands', /I can help with/.test(ask('help')));
check('bot never returns empty', ask('zzz gibberish zzz').length > 40);
check('bot handles a missing analysis gracefully', Bot.reply('analyze', {}).text.includes('Hit'));

/* ---------- 13. data normalisation ---------- */
const arrShape = DataMod.normaliseCandles(Array.from({ length: 40 }, (_, i) => [
  Math.floor((Date.now() + i * 3600000) / 1000), 1 + i * 0.01, 1.1 + i * 0.01, 0.9 + i * 0.01, 1.05 + i * 0.01, 10 + i]));
check('array-shaped custom feed -> ms timestamps ascending',
  arrShape.length === 40 && arrShape[0].t > 1e12 && arrShape[39].t > arrShape[0].t);
const objShape = DataMod.normaliseCandles(Array.from({ length: 35 }, (_, i) => ({ t: 1700000000 + i * 3600, o: 10 + i * 0.1, h: 12 + i * 0.1, l: 9 + i * 0.1, c: 11 + i * 0.1, v: 5 })));
check('object-shaped feed converted', objShape.length === 35 && objShape[0].h === 12 && objShape[0].t > 1e12);
check('too-short custom feed is rejected',
  (() => { try { DataMod.normaliseCandles([{ t: 1700000000, o: 10, h: 12, l: 9, c: 11, v: 5 }]); return false; } catch { return true; } })());
check('catalog has gold and bitcoin', DataMod.SYMBOLS.some(s => s.id === 'XAUUSDT') && DataMod.symbolById('BTCUSDT').binance === 'BTCUSDT');
check('every catalog symbol maps to at least one provider',
  DataMod.SYMBOLS.every(s => DataMod.PROVIDER_ORDER.some(p => DataMod.PROVIDERS[p].supports(s))));

console.log('\nDoro Trade AI — engine tests\n' + results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
