/* ============================================================
   Doro Trade AI — application layer
   Controls, rendering, bot wiring, journal, alerts and exports.
   Depends on: trade-engine.js, trade-data.js, trade-chart.js, trade-bot.js
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const Engine = window.TradeEngine;
  const Data = window.TradeData;
  const Bot = window.TradeBot;

  const SETTINGS_KEY = 'doro_trade_settings_v1';
  const JOURNAL_KEY = 'doro_trade_journal_v1';
  const WATCH_KEY = 'doro_trade_watchlist_v1';
  const DEFAULT_WATCH = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'XAUUSDT'];

  const S = {
    symbol: 'BTCUSDT', interval: '1h', windowSize: 130,
    balance: 1000, riskPct: 1,
    auto: false, autoEvery: 60, nextAt: 0,
    candles: null, analysis: null, htf: null,
    provider: null, demo: false, attempts: [], busy: false, lastRun: null,
    watchlist: [], watch: DEFAULT_WATCH.slice(),
    journal: [], alertsEnabled: false, alerted: {}, chart: null,
  };

  /* =========================================================
     Small helpers
     ========================================================= */
  const money = (v, d = 2) => (isFinite(v) ? Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const qty = (v) => (isFinite(v) ? (Math.abs(v) < 1 ? v.toFixed(6) : v.toFixed(4)) : '—');
  const px = (v) => (isFinite(v) ? Engine.fmtPrice(v) : '—');
  const pc = (v, d = 2) => (isFinite(v) ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%` : '—');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dirClass = (d) => (d === 'LONG' ? 'long' : d === 'SHORT' ? 'short' : 'neutral');
  const dirArrow = (d) => (d === 'LONG' ? '▲' : d === 'SHORT' ? '▼' : '■');

  function toast(msg, type = 'info') {
    let stack = $('#taToasts');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'taToasts';
      stack.className = 'ta-toasts';
      document.body.appendChild(stack);
    }
    const t = document.createElement('div');
    t.className = `ta-toast ${type}`;
    t.innerHTML = `<i class="fas ${type === 'error' ? 'fa-circle-exclamation' : type === 'warning' ? 'fa-triangle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i><span>${esc(msg)}</span>`;
    stack.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, type === 'error' ? 6000 : 3800);
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        symbol: S.symbol, interval: S.interval, windowSize: S.windowSize,
        balance: S.balance, riskPct: S.riskPct, auto: S.auto, autoEvery: S.autoEvery,
        alertsEnabled: S.alertsEnabled, watch: S.watch, preferred: Data.status.preferred, customUrl: Data.status.customUrl,
      }));
    } catch { /* storage blocked — ignore */ }
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const url = new URLSearchParams(location.search);
      S.symbol = url.get('symbol') || raw.symbol || S.symbol;
      S.interval = url.get('interval') || raw.interval || S.interval;
      S.windowSize = raw.windowSize || S.windowSize;
      S.balance = raw.balance || S.balance;
      S.riskPct = raw.riskPct || S.riskPct;
      S.auto = !!raw.auto;
      S.autoEvery = raw.autoEvery || S.autoEvery;
      S.alertsEnabled = !!raw.alertsEnabled;
      S.watch = Array.isArray(raw.watch) && raw.watch.length ? raw.watch : S.watch;
      if (raw.preferred) Data.setPreferred(raw.preferred);
      if (raw.customUrl) Data.setCustomUrl(raw.customUrl);
    } catch { /* ignore */ }
  }

  const loadJournal = () => { try { S.journal = JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]') || []; } catch { S.journal = []; } };
  const saveJournal = () => { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(S.journal)); } catch { /* ignore */ } };

  /* =========================================================
     Analysis run
     ========================================================= */
  async function runAnalysis(reason) {
    if (S.busy) return;
    S.busy = true;
    const btn = $('#runBtn');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    $('#chartLoader')?.classList.remove('hidden');

    try {
      S.symbolName = Data.symbolById(S.symbol).name;   // keep the label in sync when the bot switches market
      const { candles, provider, demo, attempts } = await Data.loadCandles(S.symbol, S.interval, 320);
      S.candles = candles;
      S.provider = provider;
      S.demo = demo;
      S.attempts = attempts || [];

      S.htf = demo ? null : await Data.loadHTF(S.symbol, S.interval);

      const analysis = Engine.analyze(candles, {
        symbol: S.symbolName || S.symbol,
        interval: S.interval,
        provider,
        htf: S.htf,
        account: { balance: S.balance, riskPct: S.riskPct },
      });

      const prev = S.analysis;
      S.analysis = analysis;
      S.lastRun = Date.now();

      renderAll();

      if (prev && prev.ok && analysis.ok && prev.direction !== analysis.direction && prev.symbol === analysis.symbol) {
        toast(`${analysis.symbol} flipped ${prev.direction} → ${analysis.direction} on the ${S.interval}`, analysis.direction === 'NEUTRAL' ? 'warning' : 'info');
      }
      if (!reason && demo) toast('No live exchange feed reachable — showing clearly labelled DEMO candles.', 'warning');
    } catch (e) {
      console.error(e);
      toast(`Analysis failed: ${e.message}`, 'error');
    } finally {
      S.busy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
      $('#chartLoader')?.classList.add('hidden');
      updateCountdown();
    }
  }

  function renderAll() {
    renderStatus();
    renderVerdict();
    renderChart();
    renderPlan();
    renderLines();
    renderSignals();
    renderLevels();
    renderNarrative();
    renderJournal();
    renderWatchlist();
  }

  /* =========================================================
     Renderers
     ========================================================= */
  function renderStatus() {
    const el = $('#statusBar');
    if (!el) return;
    const a = S.analysis;
    const when = S.lastRun ? new Date(S.lastRun).toLocaleTimeString() : '—';
    const bits = [
      `<span class="ta-dot ${S.demo ? 'warn' : 'ok'}"></span>`,
      `<b>${esc(S.symbol)} · ${esc(S.interval)}</b>`,
      `<span class="ta-muted">feed: ${esc(S.provider || '—')}</span>`,
      `<span class="ta-muted">updated ${esc(when)}</span>`,
      a && a.candles ? `<span class="ta-muted">${a.candles} candles</span>` : '',
      S.htf ? `<span class="ta-muted">HTF ${esc(S.htf.interval)}: ${esc(S.htf.direction)}</span>` : '',
    ].filter(Boolean).join(' <span class="ta-sep">·</span> ');
    el.innerHTML = bits + (S.demo
      ? ` <span class="ta-pill warn">DEMO DATA</span> <a href="#data" class="ta-link">why / fix</a>`
      : '') + (S.attempts.length ? ` <details class="ta-details-inline"><summary>feed notes</summary><div>${esc(S.attempts.join(' | '))}</div></details>` : '');
  }

  function renderVerdict() {
    const a = S.analysis;
    const box = $('#verdictCard');
    if (!box) return;
    if (!a || !a.ok) { box.innerHTML = `<p class="ta-muted">No analysis yet.</p>`; return; }

    const rows = [
      ['Live price', px(a.price), pc(a.changePct)],
      ['Entry', px(a.entry.price), a.entry.type],
      ['Stop loss', a.stop.price ? px(a.stop.price) : '—', a.stop.price ? `${a.stop.pct}% · ${a.stop.atrMultiple}× ATR` : 'no position'],
      ['TP1', a.targets[0] ? px(a.targets[0].price) : '—', a.targets[0] ? `${a.targets[0].r}R` : '—'],
      ['TP2', a.targets[1] ? px(a.targets[1].price) : '—', a.targets[1] ? `${a.targets[1].r}R` : '—'],
      ['TP3', a.targets[2] ? px(a.targets[2].price) : '—', a.targets[2] ? `${a.targets[2].r}R` : '—'],
      ['Reward:risk', a.rr.blended ? `${a.rr.blended}R` : '—', `breakeven win-rate ${a.breakevenWinRate || '—'}%`],
      ['ATR (14)', px(a.indicators.atr), `${a.indicators.atrPct}% of price`],
      ['ADX (14)', isFinite(a.indicators.adx) ? a.indicators.adx.toFixed(1) : '—', a.regime.replace('-', ' ')],
      ['RSI (14)', isFinite(a.indicators.rsi) ? a.indicators.rsi.toFixed(1) : '—', a.indicators.rsi > 70 ? 'overbought' : a.indicators.rsi < 30 ? 'oversold' : 'neutral'],
    ];

    box.innerHTML = `
      <div class="ta-verdict-head">
        <div class="ta-dir ${dirClass(a.direction)}">
          <span class="ta-dir-arrow">${dirArrow(a.direction)}</span>
          <span class="ta-dir-label">${a.direction === 'NEUTRAL' ? 'NO TRADE' : a.direction}</span>
        </div>
        <div class="ta-verdict-main">
          <h2>${esc(a.symbol)} <span class="ta-muted">· ${esc(a.interval)}</span></h2>
          <p class="ta-headline">${esc(a.headline)}</p>
          <div class="ta-conf">
            <div class="ta-conf-bar"><span style="width:${a.confidence}%"></span></div>
            <div class="ta-conf-meta">
              <b>${a.confidence}%</b> confidence
              <span class="ta-pill ${a.grade === 'A' || a.grade === 'B' ? 'ok' : a.grade === 'C' ? 'warn' : 'bad'}">grade ${a.grade}</span>
              <span class="ta-pill">score ${a.score}</span>
              <span class="ta-pill">${esc(a.regime.replace('-', ' '))}</span>
              <span class="ta-pill">${esc(a.planStyle)} plan</span>
            </div>
          </div>
        </div>
      </div>
      <div class="ta-kv">
        ${rows.map((r) => `<div class="ta-kv-item"><span>${r[0]}</span><b>${r[1]}</b><i>${r[2] || ''}</i></div>`).join('')}
      </div>
      <p class="ta-summary">${esc(a.summary)}</p>
      <div class="ta-actions">
        <button class="ta-btn primary" id="copyBtn"><i class="fas fa-copy"></i> Copy plan</button>
        <button class="ta-btn" id="jsonBtn"><i class="fas fa-file-code"></i> JSON</button>
        <button class="ta-btn" id="pngBtn"><i class="fas fa-image"></i> Chart PNG</button>
        <button class="ta-btn" id="shareBtn"><i class="fas fa-link"></i> Share link</button>
        <button class="ta-btn" id="logBtn"><i class="fas fa-bookmark"></i> Log this trade</button>
        <button class="ta-btn" id="askBotBtn"><i class="fas fa-robot"></i> Explain like I'm new</button>
      </div>`;

    $('#copyBtn')?.addEventListener('click', copyPlan);
    $('#jsonBtn')?.addEventListener('click', downloadJson);
    $('#pngBtn')?.addEventListener('click', downloadPng);
    $('#shareBtn')?.addEventListener('click', shareLink);
    $('#logBtn')?.addEventListener('click', logCurrentTrade);
    $('#askBotBtn')?.addEventListener('click', () => {
      $('#chatSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sendChat('explain the plan like I am a beginner');
    });
  }

  function renderChart() {
    if (!S.chart) return;
    if (!S.candles) return;
    S.chart.setData({ candles: S.candles, analysis: S.analysis, windowSize: S.windowSize });
    ['chartTitle'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = `${S.symbol} · ${S.interval}`;
    });
  }

  function renderPlan() {
    const a = S.analysis;
    const box = $('#planCard');
    if (!box) return;
    if (!a || !a.ok || a.direction === 'NEUTRAL') {
      box.innerHTML = `
        <div class="ta-notrade">
          <h3><i class="fas fa-hand"></i> No trade on ${esc(a ? a.symbol : '')} ${esc(S.interval)}</h3>
          <p>The engine refuses to invent a setup. Reasons:</p>
          <ul>${(a && a.riskFlags.length ? a.riskFlags : ['Signals are balanced.']).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          <p class="ta-muted">Wait for a candle close outside ${px(a ? a.levels.rangeLow : 0)} – ${px(a ? a.levels.rangeHigh : 0)} with above-average volume, then press <b>Analyse</b> again.</p>
        </div>`;
      return;
    }
    const t = a.targets;
    box.innerHTML = `
      <div class="ta-ticket">
        <div class="ta-ticket-side ${dirClass(a.direction)}">
          <span>${dirArrow(a.direction)} ${a.direction}</span>
          <b>${esc(a.symbol)} · ${esc(a.interval)}</b>
          <i>${a.confidence}% confidence · grade ${a.grade}</i>
        </div>
        <div class="ta-ticket-rows">
          <div class="ta-ticket-row entry">
            <span class="lbl">ENTRY <i>${esc(a.entry.type)}</i></span>
            <b>${px(a.entry.price)}</b>
            <span class="sub">zone ${px(a.entry.low)} – ${px(a.entry.high)}</span>
          </div>
          <div class="ta-ticket-row stop">
            <span class="lbl">STOP LOSS <i>${a.stop.atrMultiple}× ATR</i></span>
            <b>${px(a.stop.price)}</b>
            <span class="sub">${a.stop.pct}% away · risk ${money(a.sizing.riskAmount)}</span>
          </div>
          ${t.map((x) => `
          <div class="ta-ticket-row tp">
            <span class="lbl">${x.label} <i>${esc(x.basis)}</i></span>
            <b>${px(x.price)}</b>
            <span class="sub">${x.r}R · ${pc(x.pct)} · exit ${x.sizeHint} · +${money(a.sizing.qty * Math.abs(x.price - a.entry.price))}</span>
          </div>`).join('')}
        </div>
        <div class="ta-ticket-side boxes">
          <div><span>Position size</span><b>${qty(a.sizing.qty)}</b></div>
          <div><span>Notional</span><b>${money(a.sizing.notional)}</b></div>
          <div><span>Max loss</span><b class="red">-${money(a.sizing.riskAmount)}</b></div>
          <div><span>Blended R:R</span><b>${a.rr.blended}R</b></div>
        </div>
      </div>
      <h4 class="ta-sub">How to place it</h4>
      <ol class="ta-steps">${a.plan.map((p) => `<li>${esc(p.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
      <p class="ta-muted small">${esc(a.sizing.leverageNote || '')}</p>`;
  }

  function renderLines() {
    const a = S.analysis;
    const box = $('#linesCard');
    if (!box) return;
    if (!a || !a.ok) { box.innerHTML = ''; return; }
    const tl = a.tradeLines.trend;
    box.innerHTML = `
      <div class="ta-lines">
        ${a.direction === 'NEUTRAL' ? `<p class="ta-muted">No active lines — the market is undecided. Watch the range edges ${px(a.levels.rangeLow)} / ${px(a.levels.rangeHigh)}.</p>` : `
        <div class="ta-line entry"><span>Entry line</span><b>${px(a.tradeLines.entry)}</b></div>
        <div class="ta-line stop"><span>Stop line (invalidates the idea)</span><b>${px(a.tradeLines.stop)}</b></div>
        ${a.tradeLines.targets.map((t, i) => `<div class="ta-line tp"><span>${t.label} line · exit ${a.targets[i].sizeHint}</span><b>${px(t.price)}</b></div>`).join('')}
        ${tl ? `<div class="ta-line trend"><span>Trend line (${esc(tl.kind)})</span><b>${px(tl.valueNow)}</b><i>${esc(tl.note)}</i></div>` : `<div class="ta-line trend muted"><span>Trend line</span><b>none</b><i>no clean swing fit — ranging market</i></div>`}`}
      </div>
      <div class="ta-line-note">
        <i class="fas fa-chart-line"></i>
        <p>${a.direction === 'NEUTRAL'
          ? 'Lines appear here as soon as a valid setup exists.'
          : `Draw these four levels on your own chart: entry <b>${px(a.entry.price)}</b>, stop <b>${px(a.stop.price)}</b>, targets <b>${a.targets.map((t) => px(t.price)).join(' / ')}</b>${tl ? `, plus the ${tl.kind} trend line currently at <b>${px(tl.valueNow)}</b>` : ''}. ${a.direction === 'LONG' ? 'The plan survives while price stays above the stop line.' : 'The plan survives while price stays below the stop line.'}`}</p>
      </div>`;
  }

  function renderSignals() {
    const a = S.analysis;
    const box = $('#signalsCard');
    if (!box || !a || !a.ok) return;
    const rows = a.signals.map((s) => {
      const cls = s.dir === 1 ? 'long' : s.dir === -1 ? 'short' : 'neutral';
      const strength = Math.round(s.strength * 100);
      return `<div class="ta-signal ${cls}">
        <div class="ta-signal-top">
          <span class="ta-signal-dir">${s.dir === 1 ? '▲' : s.dir === -1 ? '▼' : '■'}</span>
          <b>${esc(s.label)}</b>
          <span class="ta-muted">weight ${s.weight}</span>
        </div>
        <div class="ta-signal-bar"><span style="width:${strength}%"></span></div>
        <p>${esc(s.note)}</p>
      </div>`;
    }).join('');
    box.innerHTML = `
      <div class="ta-signal-summary">
        <div><span>For</span><b>${a.confluences.length}</b></div>
        <div><span>Against</span><b>${a.against.length}</b></div>
        <div><span>Net score</span><b>${a.score}</b></div>
        <div><span>Regime</span><b>${esc(a.regime.replace('-', ' '))}</b></div>
      </div>
      <div class="ta-signals">${rows}</div>`;
  }

  function renderLevels() {
    const a = S.analysis;
    const box = $('#levelsCard');
    if (!box || !a || !a.ok) return;
    const lvl = (arr, type) => arr.length
      ? arr.map((l) => `<div class="ta-level ${type}"><b>${px(l.price)}</b><span>${l.touches} touch${l.touches > 1 ? 'es' : ''} · ${l.barsAgo} bars ago · strength ${l.strength}</span></div>`).join('')
      : '<p class="ta-muted small">none nearby</p>';
    box.innerHTML = `
      <div class="ta-levels-grid">
        <div><h4>Resistance</h4>${lvl(a.levels.resistances, 'res')}</div>
        <div><h4>Support</h4>${lvl(a.levels.supports, 'sup')}</div>
      </div>
      <div class="ta-levels-foot">
        <div><span>Range (last ${Math.min(a.candles, 120)} bars)</span><b>${px(a.levels.rangeLow)} → ${px(a.levels.rangeHigh)}</b><i>price at ${a.levels.rangePosPct}%</i></div>
        ${a.levels.pivots ? `<div><span>Pivots</span><b>S1 ${px(a.levels.pivots.s1)} · PP ${px(a.levels.pivots.pp)} · R1 ${px(a.levels.pivots.r1)}</b></div>` : ''}
      </div>`;
  }

  function renderNarrative() {
    const a = S.analysis;
    const box = $('#narrativeCard');
    if (!box || !a || !a.ok) return;
    box.innerHTML = `
      <div class="ta-narr">
        <div>
          <h4><i class="fas fa-check-circle"></i> Working for the trade</h4>
          ${a.confluences.length ? `<ul>${a.confluences.map((c) => `<li><b>${esc(c.label)}</b> — ${esc(c.note)}</li>`).join('')}</ul>` : '<p class="ta-muted small">Nothing strong on either side.</p>'}
        </div>
        <div>
          <h4><i class="fas fa-triangle-exclamation"></i> Risk flags</h4>
          ${a.riskFlags.length ? `<ul>${a.riskFlags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="ta-muted small">No unusual risks detected.</p>'}
        </div>
      </div>
      ${a.patterns.length ? `<p class="ta-muted small"><b>Last candle:</b> ${a.patterns.map((p) => esc(p.name)).join(', ')}</p>` : ''}`;
  }

  /* =========================================================
     Journal / performance
     ========================================================= */
  function logCurrentTrade() {
    const a = S.analysis;
    if (!a || !a.ok || a.direction === 'NEUTRAL') { toast('Nothing to log — no active setup.', 'warning'); return; }
    S.journal.unshift({
      id: `t${Date.now()}`,
      ts: Date.now(),
      marketId: S.symbol,
      symbol: a.symbol, interval: a.interval, direction: a.direction,
      entry: a.entry.price, stop: a.stop.price,
      targets: a.targets.map((t) => t.price),
      confidence: a.confidence, grade: a.grade, provider: a.provider,
      status: 'open', r: null, tp1Hit: false,
    });
    saveJournal();
    renderJournal();
    toast('Trade logged to the journal.', 'success');
  }

  function liveR(t, price) {
    if (!isFinite(price) || !t.stop || t.stop === t.entry) return null;
    const dist = Math.abs(t.entry - t.stop);
    const move = t.direction === 'LONG' ? price - t.entry : t.entry - price;
    return move / dist;
  }

  function renderJournal() {
    const box = $('#journalCard');
    if (!box) return;
    const closed = S.journal.filter((t) => t.status !== 'open');
    const wins = closed.filter((t) => t.r > 0);
    const totalR = closed.reduce((s, t) => s + (t.r || 0), 0);
    const grossWin = closed.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
    const grossLoss = Math.abs(closed.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0));
    const stats = {
      trades: S.journal.length, closed: closed.length,
      winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
      avgR: closed.length ? totalR / closed.length : 0,
      totalR,
      profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : 0),
      best: closed.length ? Math.max(...closed.map((t) => t.r)) : 0,
      worst: closed.length ? Math.min(...closed.map((t) => t.r)) : 0,
      open: S.journal.filter((t) => t.status === 'open').length,
    };

    const rows = S.journal.slice(0, 40).map((t) => {
      const live = t.status === 'open' && S.analysis && S.analysis.symbol === t.symbol ? liveR(t, S.analysis.price) : null;
      return `<tr>
        <td><b>${esc(t.symbol)}</b><span class="ta-muted"> ${esc(t.interval)}</span></td>
        <td><span class="ta-tag ${dirClass(t.direction)}">${t.direction}</span></td>
        <td>${px(t.entry)}</td>
        <td>${px(t.stop)}</td>
        <td>${t.targets.map((x) => px(x)).join(' / ')}</td>
        <td>${t.confidence}%</td>
        <td>${live != null ? `<b class="${live >= 0 ? 'green' : 'red'}">${live >= 0 ? '+' : ''}${live.toFixed(2)}R</b>` : '—'}</td>
        <td>${t.status === 'open' ? `<span class="ta-tag open">open${t.tp1Hit ? ' · TP1 hit' : ''}</span>` : `<span class="ta-tag ${t.r > 0 ? 'win' : t.r < 0 ? 'loss' : 'be'}">${t.status} ${t.r >= 0 ? '+' : ''}${(t.r || 0).toFixed(2)}R</span>`}</td>
        <td class="ta-right">
          ${t.status === 'open' ? `
            <button class="ta-mini" data-close="${t.id}" data-r="1" title="Take profit at +1R">+1R</button>
            <button class="ta-mini" data-close="${t.id}" data-r="2" title="Take profit at +2R">+2R</button>
            <button class="ta-mini danger" data-close="${t.id}" data-r="-1" title="Stop loss hit">SL</button>
            <button class="ta-mini" data-close="${t.id}" data-r="0" title="Close at break-even">BE</button>` : ''}
          <button class="ta-mini danger" data-del="${t.id}" title="Delete"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join('');

    box.innerHTML = `
      <div class="ta-stats">
        <div><span>Trades</span><b>${stats.trades}</b></div>
        <div><span>Open</span><b>${stats.open}</b></div>
        <div><span>Closed</span><b>${stats.closed}</b></div>
        <div><span>Win rate</span><b>${stats.winRate}%</b></div>
        <div><span>Avg R</span><b class="${stats.avgR >= 0 ? 'green' : 'red'}">${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R</b></div>
        <div><span>Total R</span><b class="${stats.totalR >= 0 ? 'green' : 'red'}">${stats.totalR >= 0 ? '+' : ''}${stats.totalR.toFixed(2)}R</b></div>
        <div><span>Profit factor</span><b>${isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}</b></div>
        <div><span>Best / worst</span><b>${stats.best.toFixed(1)}R / ${stats.worst.toFixed(1)}R</b></div>
      </div>
      ${S.journal.length ? `
      <div class="ta-table-wrap">
        <table class="ta-table">
          <thead><tr><th>Market</th><th>Side</th><th>Entry</th><th>Stop</th><th>Targets</th><th>Conf</th><th>Live R</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<p class="ta-muted">No trades logged yet. Press <b>Log this trade</b> above whenever you follow a plan — the journal turns your signals into a measurable track record.</p>`}
      <div class="ta-actions">
        <button class="ta-btn" id="csvBtn"><i class="fas fa-file-csv"></i> Export CSV</button>
        <button class="ta-btn danger" id="clearJournalBtn"><i class="fas fa-trash"></i> Clear journal</button>
        <span class="ta-muted small">Outcomes are recorded in R (risk multiples), so a 500 account and a 50,000 account can compare.</span>
      </div>`;

    $$('[data-close]', box).forEach((b) => b.addEventListener('click', () => {
      const t = S.journal.find((x) => x.id === b.dataset.close);
      if (!t) return;
      const r = parseFloat(b.dataset.r);
      t.r = r; t.status = r > 0 ? 'win' : r < 0 ? 'loss' : 'be';
      t.closedAt = Date.now();
      saveJournal(); renderJournal();
      toast(`Trade closed at ${r >= 0 ? '+' : ''}${r}R`, r >= 0 ? 'success' : 'warning');
    }));
    $$('[data-del]', box).forEach((b) => b.addEventListener('click', () => {
      S.journal = S.journal.filter((x) => x.id !== b.dataset.del);
      saveJournal(); renderJournal();
    }));
    $('#clearJournalBtn')?.addEventListener('click', () => {
      if (confirm('Delete the whole trade journal?')) { S.journal = []; saveJournal(); renderJournal(); }
    });
    $('#csvBtn')?.addEventListener('click', () => {
      const head = 'date,symbol,interval,direction,entry,stop,tp1,tp2,tp3,confidence,grade,status,r_result\n';
      const body = S.journal.map((t) => [new Date(t.ts).toISOString(), t.symbol, t.interval, t.direction, t.entry, t.stop,
        ...(t.targets || [null, null, null]), t.confidence, t.grade, t.status, t.r == null ? '' : t.r].join(',')).join('\n');
      downloadBlob('doro-trade-journal.csv', head + body, 'text/csv');
    });
  }

  /* =========================================================
     Watchlist scanner
     ========================================================= */
  async function scanWatchlist() {
    const btn = $('#scanBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning…'; }
    const out = [];
    for (const id of S.watch) {
      try {
        const { candles, provider, demo } = await Data.loadCandles(id, S.interval, 260);
        const a = Engine.analyze(candles, {
          symbol: Data.symbolById(id).name,
          interval: S.interval, provider, account: { balance: S.balance, riskPct: S.riskPct },
        });
        out.push({ id, a });
      } catch (e) { out.push({ id, a: null, error: e.message }); }
      renderWatchlist(out);
    }
    S.watchlist = out;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-radar"></i> Scan watchlist'; }
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(out.map((w) => ({ id: w.id, a: w.a ? { symbol: w.a.symbol, direction: w.a.direction, confidence: w.a.confidence, price: w.a.price } : null })))); } catch { /* ignore */ }
    toast(`Scanned ${out.length} markets on the ${S.interval}`, 'success');
  }

  function renderWatchlist(results) {
    const box = $('#watchCard');
    if (!box) return;
    const data = results || S.watchlist;
    const chips = S.watch.map((id) => `<span class="ta-chip">${esc(id.replace('USDT', ''))}<button data-rm="${id}" title="Remove">×</button></span>`).join('');
    const rows = data.length ? data.map((w) => {
      const a = w.a;
      if (!a || !a.ok) return `<tr><td>${esc(w.id)}</td><td colspan="6" class="ta-muted">no data</td></tr>`;
      const good = a.confidence >= 65 && a.direction !== 'NEUTRAL';
      return `<tr class="${good ? 'good' : ''}">
        <td><b>${esc(a.symbol)}</b></td>
        <td><span class="ta-tag ${dirClass(a.direction)}">${a.direction === 'NEUTRAL' ? 'NO TRADE' : a.direction}</span></td>
        <td>${a.confidence}% <span class="ta-muted">(${a.grade})</span></td>
        <td>${px(a.price)}</td>
        <td>${a.direction === 'NEUTRAL' ? '—' : px(a.entry.price)}</td>
        <td>${a.direction === 'NEUTRAL' ? '—' : px(a.stop.price)}</td>
        <td>${a.direction === 'NEUTRAL' ? '—' : `${a.rr.blended}R`}</td>
        <td><button class="ta-mini" data-load="${w.id}">Open</button></td>
      </tr>`;
    }).join('') : '';

    box.innerHTML = `
      <div class="ta-watch-chips">
        <span class="ta-muted small">Watchlist:</span> ${chips}
        <select id="watchAdd" class="ta-select small"><option value="">+ add market…</option>
          ${Data.SYMBOLS.filter((s) => !S.watch.includes(s.id)).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      ${data.length ? `<div class="ta-table-wrap"><table class="ta-table">
        <thead><tr><th>Market</th><th>Signal</th><th>Confidence</th><th>Price</th><th>Entry</th><th>Stop</th><th>Blended R:R</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<p class="ta-muted">Press <b>Scan watchlist</b> to rank the markets you care about on the ${esc(S.interval)} timeframe.</p>`}`;

    $$('[data-load]', box).forEach((b) => b.addEventListener('click', () => {
      S.symbol = b.dataset.load;
      $('#symbolSelect').value = S.symbol;
      saveSettings();
      runAnalysis('watchlist');
      $('#verdictCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $$('[data-rm]', box).forEach((b) => b.addEventListener('click', () => {
      S.watch = S.watch.filter((x) => x !== b.dataset.rm);
      saveSettings(); renderWatchlist();
    }));
    $('#watchAdd')?.addEventListener('change', (e) => {
      if (!e.target.value) return;
      S.watch.push(e.target.value);
      saveSettings(); renderWatchlist();
    });
  }

  /* =========================================================
     Alerts
     ========================================================= */
  function notify(title, body) {
    toast(`${title} — ${body}`, 'warning');
    try {
      if (S.alertsEnabled && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: undefined });
      }
    } catch { /* ignore */ }
  }

  function fire(key, title, body) {
    if (S.alerted[key]) return;
    S.alerted[key] = Date.now();
    notify(title, body);
  }

  async function checkAlerts() {
    if (!S.alertsEnabled) return;
    const open = S.journal.filter((t) => t.status === 'open');
    const symbols = Array.from(new Set([S.symbol, ...open.map((t) => t.marketId || t.symbol)])).filter(Boolean).slice(0, 6);
    for (const symId of symbols) {
      const id = Data.SYMBOLS.some((s) => s.id === symId) ? symId
        : Data.SYMBOLS.find((s) => s.name === symId)?.id;
      if (!id) continue;
      const { price } = await Data.getPrice(id);
      if (!isFinite(price)) continue;

      // current plan
      const a = S.analysis;
      if (a && a.ok && S.symbol === id && a.direction !== 'NEUTRAL') {
        const near = (level, tolPct = 0.15) => Math.abs(price - level) / level * 100 <= tolPct;
        if (near(a.entry.price)) fire(`entry-${symId}-${a.entry.price}`, `${symId} at entry`, `Price ${px(price)} reached your entry zone ${px(a.entry.price)}`);
        if (a.stop.price && ((a.direction === 'LONG' && price <= a.stop.price) || (a.direction === 'SHORT' && price >= a.stop.price)))
          fire(`stop-${symId}-${a.stop.price}`, `${symId} stop hit`, `Price ${px(price)} crossed the stop line ${px(a.stop.price)}`);
        a.targets.forEach((t, i) => {
          if ((a.direction === 'LONG' && price >= t.price) || (a.direction === 'SHORT' && price <= t.price))
            fire(`tp${i}-${symId}-${t.price}`, `${symId} TP${i + 1} reached`, `Price ${px(price)} hit ${px(t.price)} (${t.r}R)`);
        });
      }

      // open journal trades
      for (const t of open) {
        if ((t.marketId || t.symbol) !== id && t.marketId !== id) continue;
        const rNow = liveR(t, price);
        if (rNow == null) continue;
        if (rNow <= -1) {
          t.status = 'loss'; t.r = -1; t.closedAt = Date.now(); saveJournal(); renderJournal();
          fire(`jl-${t.id}`, `${t.symbol} stopped out`, `Journal updated: -1R at ${px(price)}`);
        } else if (t.targets && t.targets[0] && !t.tp1Hit) {
          const hit = t.direction === 'LONG' ? price >= t.targets[0] : price <= t.targets[0];
          if (hit) { t.tp1Hit = true; saveJournal(); renderJournal(); fire(`jt-${t.id}`, `${t.symbol} TP1 reached`, `Price ${px(price)} hit TP1 ${px(t.targets[0])} — move the stop to break-even`); }
        }
      }
    }
  }

  /* =========================================================
     Exports
     ========================================================= */
  function planText() {
    const a = S.analysis;
    if (!a || !a.ok) return 'No analysis yet.';
    const L = [Engine.toText(a), '', 'PLAN'];
    a.plan.forEach((p) => L.push(`- ${p}`));
    if (a.riskFlags.length) { L.push('', 'RISK FLAGS'); a.riskFlags.forEach((r) => L.push(`- ${r}`)); }
    L.push('', `Generated by Doro Trade AI · ${new Date().toLocaleString()} · data: ${a.provider}`);
    return L.join('\n');
  }

  async function copyPlan() {
    const text = planText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Trade plan copied — paste it into your broker notes.', 'success');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Trade plan copied.', 'success');
    }
  }

  function downloadBlob(name, content, type = 'application/json') {
    try {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      // sandboxed iframes can block downloads — fall back to a copyable window
      toast(`Download blocked by the browser (${e.message}). Copy the plan instead.`, 'warning');
    }
  }

  function downloadJson() {
    if (!S.analysis) return;
    downloadBlob(`doro-trade-${S.analysis.symbol}-${S.interval}-${Date.now()}.json`, JSON.stringify(S.analysis, null, 2));
    toast('Analysis JSON downloaded.', 'success');
  }

  function downloadPng() {
    if (!S.chart) return;
    try {
      const url = S.chart.exportPNG();
      const a = document.createElement('a');
      a.href = url;
      a.download = `doro-trade-chart-${S.symbol}-${S.interval}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Chart image downloaded.', 'success');
    } catch (e) {
      toast(`Could not export the chart image (${e.message}).`, 'error');
    }
  }

  async function shareLink() {
    const url = `${location.origin}${location.pathname}?symbol=${S.symbol}&interval=${S.interval}`;
    try { await navigator.clipboard.writeText(url); toast('Share link copied.', 'success'); }
    catch { prompt('Copy this link:', url); }
  }

  /* =========================================================
     Bot chat
     ========================================================= */
  function mdLite(text) {
    const safe = esc(text);
    return safe
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .split('\n')
      .map((line) => {
        if (/^\s*[-•]\s+/.test(line)) return `<div class="ta-li">• ${line.replace(/^\s*[-•]\s+/, '')}</div>`;
        if (/^\s*\d+\.\s+/.test(line)) return `<div class="ta-li">${line}</div>`;
        if (!line.trim()) return '<div class="ta-gap"></div>';
        return `<div>${line}</div>`;
      }).join('');
  }

  function pushMsg(role, text, meta) {
    const log = $('#chatLog');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `ta-msg ${role}`;
    div.innerHTML = `${role === 'bot' ? '<div class="ta-avatar"><i class="fas fa-robot"></i></div>' : ''}<div class="ta-bubble">${role === 'bot' ? mdLite(text) : esc(text)}${meta ? `<div class="ta-msg-meta">${esc(meta)}</div>` : ''}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function sendChat(text) {
    const input = $('#chatInput');
    const q = (text || (input && input.value) || '').trim();
    if (!q) return;
    if (input) input.value = '';
    pushMsg('user', q);

    const res = Bot.reply(q, { analysis: S.analysis, marketId: S.symbol, catalog: Data.SYMBOLS, watchlist: S.watchlist });
    pushMsg('bot', res.text, S.analysis ? `${S.analysis.symbol} · ${S.analysis.interval} · ${S.analysis.provider}` : null);

    if (res.action) {
      if (res.action.symbol) { S.symbol = res.action.symbol; $('#symbolSelect').value = S.symbol; }
      if (res.action.interval) { S.interval = res.action.interval; syncIntervalButtons(); }
      saveSettings();
      pushMsg('bot', `Loading ${S.symbol} on the ${S.interval} timeframe…`);
      await runAnalysis('chat');
      pushMsg('bot', `Updated. ${S.analysis && S.analysis.ok ? S.analysis.headline : 'No data.'}`);
    }
  }

  function syncIntervalButtons() {
    $$('#intervalGroup button').forEach((b) => b.classList.toggle('active', b.dataset.iv === S.interval));
  }

  /* =========================================================
     Controls
     ========================================================= */
  function updateCountdown() {
    const el = $('#autoCount');
    if (!el) return;
    if (!S.auto) { el.textContent = 'off'; return; }
    const left = Math.max(0, Math.round((S.nextAt - Date.now()) / 1000));
    el.textContent = `${left}s`;
  }

  function bindControls() {
    const sel = $('#symbolSelect');
    if (sel) {
      const groups = [['Crypto', Data.SYMBOLS.filter((s) => s.id !== 'XAUUSDT')], ['Gold', Data.SYMBOLS.filter((s) => s.id === 'XAUUSDT')]];
      sel.innerHTML = groups.map(([label, list]) => `<optgroup label="${label}">${list.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.id)}</option>`).join('')}</optgroup>`).join('');
      sel.value = S.symbol;
      sel.addEventListener('change', () => {
        S.symbol = sel.value;
        saveSettings(); runAnalysis('manual');
      });
    }

    $$('#intervalGroup button').forEach((b) => b.addEventListener('click', () => {
      S.interval = b.dataset.iv;
      syncIntervalButtons(); saveSettings(); runAnalysis('manual');
    }));

    const bal = $('#balanceInput');
    if (bal) {
      bal.value = S.balance;
      bal.addEventListener('change', () => {
        S.balance = Math.max(1, parseFloat(bal.value) || S.balance);
        saveSettings(); if (S.analysis) runAnalysis('settings'); else runAnalysis();
      });
    }
    const risk = $('#riskInput');
    if (risk) {
      risk.value = S.riskPct;
      risk.addEventListener('change', () => {
        S.riskPct = Math.min(20, Math.max(0.1, parseFloat(risk.value) || S.riskPct));
        saveSettings(); if (S.analysis) runAnalysis('settings');
      });
    }
    $$('#riskChips button').forEach((b) => b.addEventListener('click', () => {
      S.riskPct = parseFloat(b.dataset.r);
      if (risk) risk.value = S.riskPct;
      saveSettings(); runAnalysis('settings');
    }));

    $('#runBtn')?.addEventListener('click', () => runAnalysis('manual'));

    const autoBtn = $('#autoBtn');
    if (autoBtn) {
      autoBtn.classList.toggle('active', S.auto);
      autoBtn.addEventListener('click', () => {
        S.auto = !S.auto;
        autoBtn.classList.toggle('active', S.auto);
        S.nextAt = Date.now() + S.autoEvery * 1000;
        saveSettings(); updateCountdown();
        toast(S.auto ? `Auto-refresh on — every ${S.autoEvery}s` : 'Auto-refresh off', 'info');
      });
    }
    const autoSel = $('#autoEvery');
    if (autoSel) {
      autoSel.value = String(S.autoEvery);
      autoSel.addEventListener('change', () => { S.autoEvery = parseInt(autoSel.value, 10) || 60; S.nextAt = Date.now() + S.autoEvery * 1000; saveSettings(); });
    }

    const win = $('#windowSelect');
    if (win) {
      win.value = String(S.windowSize);
      win.addEventListener('change', () => { S.windowSize = parseInt(win.value, 10) || 130; saveSettings(); renderChart(); });
    }

    const prov = $('#providerSelect');
    if (prov) {
      prov.innerHTML = `<option value="">auto (fastest that answers)</option>${Data.PROVIDER_ORDER.map((id) => `<option value="${id}">${esc(Data.PROVIDERS[id].label)}</option>`).join('')}`;
      prov.value = Data.status.preferred || '';
      prov.addEventListener('change', () => { Data.setPreferred(prov.value); saveSettings(); runAnalysis('settings'); });
    }
    const custom = $('#customUrlInput');
    if (custom) {
      custom.value = Data.status.customUrl || '';
      $('#saveAdvanced')?.addEventListener('click', () => {
        Data.setCustomUrl(custom.value);
        saveSettings();
        toast(custom.value ? 'Custom feed saved — it will be tried first.' : 'Custom feed cleared.', 'success');
        runAnalysis('settings');
      });
    }

    // chart toggles
    const toggles = [['tEma', 'ema'], ['tLevels', 'levels'], ['tTrade', 'trade'], ['tTrend', 'trend'], ['tVol', 'volume']];
    toggles.forEach(([id, key]) => {
      const b = document.getElementById(id);
      if (!b) return;
      b.classList.toggle('active', true);
      b.addEventListener('click', () => {
        const on = S.chart ? S.chart.toggle(key) : false;
        b.classList.toggle('active', on);
      });
    });
    $('#zoomIn')?.addEventListener('click', () => S.chart?.zoom(0.8));
    $('#zoomOut')?.addEventListener('click', () => S.chart?.zoom(1.25));
    $('#zoomReset')?.addEventListener('click', () => S.chart?.reset());

    $('#scanBtn')?.addEventListener('click', scanWatchlist);

    // alerts
    const alertBtn = $('#alertToggle');
    if (alertBtn) {
      alertBtn.classList.toggle('active', S.alertsEnabled);
      alertBtn.addEventListener('click', async () => {
        S.alertsEnabled = !S.alertsEnabled;
        alertBtn.classList.toggle('active', S.alertsEnabled);
        saveSettings();
        if (S.alertsEnabled) {
          toast('Alerts on: entry, stop, targets and journal trades are watched every cycle.', 'success');
          try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* ignore */ }
          checkAlerts();
        } else toast('Alerts off.', 'info');
      });
    }
    $('#checkAlertsBtn')?.addEventListener('click', async () => { S.alerted = {}; await checkAlerts(); toast('Alert check complete.', 'info'); });

    // chat
    $('#chatSend')?.addEventListener('click', () => sendChat());
    $('#chatInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    $$('#chatChips button').forEach((b) => b.addEventListener('click', () => sendChat(b.textContent.trim())));
    $('#chatClear')?.addEventListener('click', () => { const log = $('#chatLog'); if (log) log.innerHTML = ''; greet(); });

    // keyboard shortcut
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAnalysis('manual');
    });
  }

  function greet() {
    pushMsg('bot', `👋 I am the Doro Trade AI assistant. I read the live ${esc(S.symbol)} ${esc(S.interval)} chart and give you the entry, stop loss, take profits and trade lines — with the maths shown.\n\nTry: "analyze", "where is my entry", "risk 1% of 2000", "best trade", or "analyse ETH on 4h".`);
  }

  /* =========================================================
     Boot
     ========================================================= */
  let lastAlertCheck = Date.now();

  function boot() {
    loadSettings();
    loadJournal();
    if (!Data.SYMBOLS.some((s) => s.id === S.symbol)) S.symbol = 'BTCUSDT';
    S.symbolName = Data.symbolById(S.symbol).name;

    if (!Engine || !Data || !Bot) {
      console.error('Trade modules missing');
      return;
    }

    const canvas = $('#chart');
    if (canvas) S.chart = window.TradeChart.create(canvas);

    bindControls();
    syncIntervalButtons();
    renderWatchlist();
    renderJournal();
    greet();
    updateCountdown();
    setInterval(() => {
      updateCountdown();
      if (S.auto && !document.hidden && Date.now() >= S.nextAt) {
        S.nextAt = Date.now() + S.autoEvery * 1000;
        runAnalysis('auto');
      }
      if (S.alertsEnabled && Date.now() - lastAlertCheck > 60000) { lastAlertCheck = Date.now(); checkAlerts(); }
    }, 1000);

    runAnalysis();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.TradeApp = {
    state: S,
    run: runAnalysis,
    scan: scanWatchlist,
    ask: sendChat,
    get analysis() { return S.analysis; },
  };
})();
