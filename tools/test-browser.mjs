/* Runs the whole Trade AI page logic inside a minimal fake DOM so that
   timer/DOM wiring bugs surface without a browser. The network is stubbed
   to fail, which also verifies the DEMO fallback path.
   Run: node tools/test-browser.mjs                                        */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const results = [];
const check = (name, cond, info = '') => {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${info ? ' — ' + info : ''}`); }
};

/* ---------------------------------------------------------------
   Minimal DOM
   --------------------------------------------------------------- */
function makeClassList(el) {
  return {
    add: (...c) => c.forEach((x) => el._classes.add(x)),
    remove: (...c) => c.forEach((x) => el._classes.delete(x)),
    contains: (c) => el._classes.has(c),
    toggle: (c, force) => {
      const want = force === undefined ? !el._classes.has(c) : !!force;
      if (want) el._classes.add(c); else el._classes.delete(c);
      return want;
    },
  };
}

const registry = new Map();      // #id -> element
const byAttr = new Map();        // 'data-x' -> [elements]
let drawCalls = 0;

function makeElement(tag = 'div', id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    _html: '',
    _classes: new Set(),
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    attributes: {},
    value: '',
    textContent: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 100,
    offsetWidth: 180,
    offsetHeight: 120,
    clientWidth: 900,
    clientHeight: 460,
    parentElement: null,
    roundRect: undefined,
  };
  el.classList = makeClassList(el);
  el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
  el.removeEventListener = () => {};
  el.appendChild = (c) => { el.children.push(c); c.parentElement = el; return c; };
  el.remove = () => {};
  el.scrollIntoView = () => {};
  el.setAttribute = (k, v) => { el.attributes[k] = v; };
  el.getAttribute = (k) => el.attributes[k];
  el.focus = () => {};
  el.click = () => {};
  el.matches = () => false;
  el.querySelector = (sel) => query(sel, el);
  el.querySelectorAll = (sel) => queryAll(sel, el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight });
  el.getContext = () => {
    const noop = () => { drawCalls++; };
    return new Proxy({
      measureText: (t) => ({ width: String(t).length * 6 }),
      setTransform: () => {},
      canvas: el,
    }, {
      get: (target, prop) => (prop in target ? target[prop] : (prop === 'canvas' ? el : noop)),
      set: () => true,
    });
  };
  el.toDataURL = () => 'data:image/png;base64,stub';
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (value) => {
      el._html = String(value);
      el.children = [];
      // register ids and data-attributes declared in the injected markup
      for (const m of el._html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) {
        const child = makeElement('div', m[1]);
        child.parentElement = el;
        registry.set(m[1], child);
        el.children.push(child);
      }
      for (const m of el._html.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) {
        const key = m[1];
        const child = makeElement('div');
        child.dataset[key.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
        (byAttr.get(key) || byAttr.set(key, []).get(key)).push(child);
        el.children.push(child);
      }
    },
  });
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  if (id) registry.set(id, el);
  return el;
}

// pre-create the elements declared in trade.html
for (const m of read('trade.html').matchAll(/\sid="([^"]+)"/g)) makeElement('div', m[1]);

function query(sel, scope) {
  const s = String(sel).trim();
  if (s.startsWith('#')) return registry.get(s.slice(1)) || null;
  if (s.startsWith('[data-')) {
    const key = s.slice(1, s.indexOf(']'));
    const list = byAttr.get(key) || [];
    return list[0] || null;
  }
  if (scope && scope._classes && s.startsWith('.')) return scope._classes.has(s.slice(1)) ? scope : null;
  return null;
}
function queryAll(sel) {
  const s = String(sel).trim();
  if (s.startsWith('[data-')) {
    // support compound selectors like [data-close] within a scope: return all
    const key = s.slice(1, s.indexOf(']'));
    return (byAttr.get(key) || []).slice();
  }
  if (s.startsWith('#')) return [registry.get(s.slice(1))].filter(Boolean);
  if (s.startsWith('.')) return [...registry.values()].filter((e) => e._classes.has(s.slice(1)));
  return [];
}

const document = {
  readyState: 'complete',
  body: makeElement('body'),
  documentElement: makeElement('html'),
  createElement: (tag) => makeElement(tag),
  getElementById: (id) => registry.get(id) || null,
  querySelector: (sel) => query(sel),
  querySelectorAll: (sel) => queryAll(sel),
  addEventListener: () => {},
  hidden: false,
  execCommand: () => {},
};

const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const timers = [];
const context = {
  console,
  document,
  localStorage,
  navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } }, userAgent: 'node' },
  location: { origin: 'http://localhost:8000', pathname: '/trade.html', search: '', href: '' },
  URLSearchParams,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  requestAnimationFrame: (cb) => { cb(); return 1; },
  cancelAnimationFrame: () => {},
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  devicePixelRatio: 1,
  AbortController,
  fetch: () => Promise.reject(new Error('network blocked in this harness')),
  alert: () => {},
  confirm: () => true,
  prompt: () => {},
  Intl,
  Date,
  Math,
  JSON,
};
context.addEventListener = () => {};
context.removeEventListener = () => {};
context.window = context;
context.self = context;
context.globalThis = context;
vm.createContext(context);

/* load the five scripts in page order */
for (const file of ['js/trade-engine.js', 'js/trade-data.js', 'js/trade-chart.js', 'js/trade-bot.js', 'js/trade-ai.js']) {
  try {
    vm.runInContext(read(file), context, { filename: file });
    check(`${file} loads without throwing`, true);
  } catch (e) {
    check(`${file} loads without throwing`, false, e.message);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));
await settle();
await settle();

const App = context.TradeApp;
check('app bootstraps and exposes TradeApp', !!App);
if (!App) {
  console.log('\nDoro Trade AI — page smoke tests (fake DOM)\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
check('fallback produced an analysis', !!(App && App.analysis && App.analysis.ok), App && App.analysis && App.analysis.error);
check('analysis is flagged as demo when offline', !!(App && App.analysis && App.analysis.isDemo));
check('verdict card rendered entry/stop/targets',
  /Entry/.test(registry.get('verdictCard')._html) && /Stop loss/.test(registry.get('verdictCard')._html)
  && /TP1/.test(registry.get('verdictCard')._html),
  registry.get('verdictCard')._html.slice(0, 90));
check('plan card rendered (no-trade or ticket)',
  /ta-ticket|ta-notrade/.test(registry.get('planCard')._html));
check('trade-lines card rendered', /ta-lines/.test(registry.get('linesCard')._html));
check('signal breakdown rendered', /ta-signal/.test(registry.get('signalsCard')._html));
check('key levels rendered', /ta-level|none nearby/.test(registry.get('levelsCard')._html));
check('narrative rendered', /Working for the trade/.test(registry.get('narrativeCard')._html));
check('journal rendered with stats', /ta-stats/.test(registry.get('journalCard')._html));
check('watchlist rendered', /Watchlist|Scan watchlist/.test(registry.get('watchCard')._html));
check('status strip rendered', /updated/.test(registry.get('statusBar')._html));
check('chart drew on the canvas', drawCalls > 20, `drawCalls=${drawCalls}`);
check('chart title set', /USDT|Gold|BTC/.test(registry.get('chartTitle').textContent + registry.get('chartTitle')._html));

/* chat */
const chatBefore = registry.get('chatLog').children.length;
await App.ask('analyze');
await settle();
check('chat adds a user + bot message', registry.get('chatLog').children.length >= chatBefore + 2,
  `children=${registry.get('chatLog').children.length}`);
await App.ask('stop loss');
await settle();
const log = registry.get('chatLog');
const lastBot = log.children.filter((c) => c._classes.has('bot')).pop();
check('bot answered the stop-loss question', /break-even|stop/i.test(lastBot ? lastBot._html : ''), lastBot ? lastBot._html.slice(0, 80) : 'no bot message');

/* symbol switch via chat triggers a reload */
await App.ask('analyse ETH on 4h');
await settle();
check('chat switched market to ETH 4h', App.state.symbol === 'ETHUSDT' && App.state.interval === '4h',
  `${App.state.symbol} ${App.state.interval}`);
check('re-analysis produced ETH plan', App.analysis && /Ethereum/.test(App.analysis.symbol), App.analysis && App.analysis.symbol);

/* scanner */
await App.scan();
await settle();
check('scanner analysed the watchlist', App.state.watchlist.length > 0, `n=${App.state.watchlist.length}`);
check('scanner table rendered', /ta-table/.test(registry.get('watchCard')._html));

/* journal: logging a real analysis entry through the public API */
const journal = App.state.journal;
const before = journal.length;
vm.runInContext('window.__logBtnHandler = document.querySelector("#logBtn");', context);
if (App.analysis && App.analysis.direction !== 'NEUTRAL') {
  // the renderer attaches a click handler to #logBtn; invoke it the way the browser would
  const btn = context.window.__logBtnHandler;
  const handlers = btn && btn.listeners && btn.listeners.click;
  if (handlers && handlers.length) handlers[0]();
  check('logging the current plan adds a journal entry', App.state.journal.length === before + 1,
    `before=${before} after=${App.state.journal.length}`);
  check('journal entry carries market id, stop and targets', (() => {
    const t = App.state.journal[0];
    return !!t.marketId && !!t.stop && Array.isArray(t.targets) && t.targets.length === 3;
  })());
  check('journal table renders the new trade', /ta-table/.test(registry.get('journalCard')._html));
} else {
  check('logging the current plan adds a journal entry', true, 'no active setup — skipped');
}

/* chart toggles */
const chart = App.state.chart;
check('chart toggles work', chart && typeof chart.toggle === 'function' && chart.toggle('ema') === false && chart.toggle('ema') === true);
check('chart export returns a data URL', chart.exportPNG().startsWith('data:image/png'));
check('chart zoom/reset do not throw', (() => { try { chart.zoom(0.8); chart.zoom(1.3); chart.reset(); chart.render(); return true; } catch (e) { return false; } })());

/* engine + data modules exposed globally */
check('globals attached', !!context.TradeEngine && !!context.TradeData && !!context.TradeBot && !!context.TradeChart);

console.log('\nDoro Trade AI — page smoke tests (fake DOM)\n' + results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
