/* ============================================================
   Doro Trade AI — trade assistant (rule-based, runs offline)
   Turns the engine output into plain answers: entries, stops,
   targets, trade lines, sizing, risk and trade management.
   No external model — deterministic and auditable, so the numbers
   it quotes are always the numbers on screen.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trade-engine.js'));
  else root.TradeBot = factory(root.TradeEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const fmt = (v) => Engine.fmtPrice(v);
  const pct = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
  const num = (v, d = 2) => (isFinite(v) ? Number(v).toFixed(d) : '—');

  /* ---------------------------------------------------------
     Entity extraction so "analyse ETH on 4h" works
     --------------------------------------------------------- */
  const NAME_HINTS = {
    BTCUSDT: ['btc', 'bitcoin', 'xbt'],
    ETHUSDT: ['eth', 'ethereum', 'ether'],
    BNBUSDT: ['bnb', 'binance coin', 'binancecoin'],
    SOLUSDT: ['sol', 'solana'],
    XRPUSDT: ['xrp', 'ripple'],
    ADAUSDT: ['ada', 'cardano'],
    DOGEUSDT: ['doge', 'dogecoin'],
    AVAXUSDT: ['avax', 'avalanche'],
    LINKUSDT: ['link', 'chainlink'],
    TONUSDT: ['ton', 'toncoin'],
    EURUSDT: ['eur', 'euro'],
    XAUUSDT: ['gold', 'xau', 'paxg'],
    WBTCUSDT: ['wbtc', 'wrapped bitcoin'],
  };

  function extractSymbol(text, catalog) {
    const t = ` ${text.toLowerCase()} `;
    for (const s of catalog || []) {
      const hints = [s.id.toLowerCase(), s.name.toLowerCase(), ...(NAME_HINTS[s.id] || [])];
      if (hints.some((h) => t.includes(` ${h} `) || t.includes(`${h}/`) || t.includes(`${h}usdt`))) return s.id;
    }
    return null;
  }

  function extractInterval(text) {
    const t = text.toLowerCase();
    const pairs = [
      [/\b(5\s*m|5\s*min|m5|5minute)/, '5m'],
      [/\b(15\s*m|15\s*min|m15)/, '15m'],
      [/\b(1\s*h|1\s*hour|hourly|h1|60\s*min)/, '1h'],
      [/\b(4\s*h|4\s*hour|h4|240)/, '4h'],
      [/\b(1\s*d|daily|day|d1|1\s*day)/, '1d'],
    ];
    for (const [re, iv] of pairs) if (re.test(t)) return iv;
    return null;
  }

  function extractRisk(text) {
    const m = text.match(/risk\s*(?:of\s*)?\$?\s*([\d.]+)\s*(%|usd|dollars|usdt|birr|etb)?/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    const unit = (m[2] || '').toLowerCase();
    if (unit === '%') return { riskPct: v };
    if (unit) return { riskPct: null, riskAmountOverride: v };
    return v <= 20 ? { riskPct: v } : { riskPct: null, riskAmountOverride: v };
  }

  function extractBalance(text, opts = {}) {
    // "balance 5000", "account of 2500", "risk 1% of 5000", "risking 1% of $500"
    const patterns = [
      /(?:balance|account|capital|equity)\s*(?:of|is|:)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
      /\bof\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
      /\$\s*([\d,]+(?:\.\d+)?)/,
    ];
    const use = opts.skipDollarOnly ? patterns.slice(0, 2) : patterns;
    for (const re of use) {
      const m = text.match(re);
      if (!m) continue;
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (isFinite(v) && v > 0) return v;
    }
    return null;
  }

  /* ---------------------------------------------------------
     Answer builders
     --------------------------------------------------------- */
  function header(a) {
    return `**${a.symbol} · ${a.interval}** — ${a.direction}${a.direction !== 'NEUTRAL' ? ` · ${a.grade} grade · ${a.confidence}% confidence` : ''} · ${a.regime.replace('-', ' ')}`;
  }

  function fullPlan(a) {
    if (a.direction === 'NEUTRAL') {
      return [
        header(a),
        '',
        `No trade right now. ${a.riskFlags[0] || 'Signals are balanced.'}`,
        '',
        '**What to watch**',
        `- Range: ${fmt(a.levels.rangeLow)} → ${fmt(a.levels.rangeHigh)} (price is at ${a.levels.rangePosPct}% of it)`,
        `- Wait for a candle close outside the range with volume above 1.2× average, then re-run the analysis`,
        `- Risk is 0 until a setup appears — that is a position too`,
      ].join('\n');
    }
    const L = [header(a), ''];
    L.push(`**Entry** — ${a.entry.type}`);
    L.push(`- Zone: ${fmt(a.entry.low)} – ${fmt(a.entry.high)} (mid ${fmt(a.entry.price)})`);
    L.push(`- Trigger: ${a.entry.trigger}`);
    L.push('');
    L.push('**Stop loss**');
    L.push(`- ${fmt(a.stop.price)} · ${a.stop.pct}% away · ${a.stop.atrMultiple}× ATR`);
    L.push(`- Why here: ${a.stop.reason}`);
    L.push('');
    L.push('**Take profit**');
    a.targets.forEach((t) => L.push(`- ${t.label}: ${fmt(t.price)} → ${t.r}R (${pct(t.pct)}) · ${t.basis} · exit ${t.sizeHint}`));
    L.push('');
    L.push(`**Reward:risk** ${a.rr.tp1}R / ${a.rr.tp2}R / ${a.rr.tp3}R · blended ${a.rr.blended}R`);
    L.push(`Breakeven win-rate at this R:R is ${a.breakevenWinRate}% — you only need to win slightly more than that to be profitable.`);
    L.push('');
    L.push('**Size**');
    L.push(`- Risking ${a.sizing.riskPct}% of ${a.sizing.balance} = ${num(a.sizing.riskAmount)}`);
    L.push(`- Position: ${num(a.sizing.qty, 6)} units (${num(a.sizing.notional)} notional)`);
    if (a.sizing.leverageNote) L.push(`- ${a.sizing.leverageNote}`);
    if (a.tradeLines.trend) {
      L.push('');
      L.push(`**Trade line** — ${a.tradeLines.trend.note}`);
    }
    return L.join('\n');
  }

  function entryAnswer(a) {
    if (a.direction === 'NEUTRAL') return fullPlan(a);
    const dist = ((a.price - a.entry.price) / a.entry.price) * 100;
    const L = [`**Entry for ${a.symbol} ${a.interval}**`, ''];
    L.push(`- Type: ${a.entry.type}`);
    L.push(`- Zone: ${fmt(a.entry.low)} – ${fmt(a.entry.high)}`);
    L.push(`- Live price: ${fmt(a.price)} — ${Math.abs(dist) < 0.15 ? 'you are *inside* the zone right now' : dist > 0 ? `${num(dist)}% above the zone, wait for a pullback` : `${num(Math.abs(dist))}% below the zone, let it reclaim the zone first`}`);
    L.push(`- Trigger: ${a.entry.trigger}`);
    L.push('');
    const best = a.planStyle === 'range' ? 'fade the edges with limit orders, do not chase the middle of the range'
      : a.planStyle === 'breakout' ? 'wait for the close beyond the level — breakout stop orders, never market orders before the close'
        : 'scale in: half at market/limit inside the zone, half on the retest';
    L.push(`Bot advice: ${best}.`);
    return L.join('\n');
  }

  function stopAnswer(a) {
    if (a.direction === 'NEUTRAL') return fullPlan(a);
    const riskPerUnit = a.stop.distance;
    return [
      `**Stop loss — ${a.symbol} ${a.interval}**`,
      '',
      `- Price: ${fmt(a.stop.price)} (${a.stop.pct}% from entry)`,
      `- Distance: ${num(riskPerUnit, 6)} per unit = ${a.stop.atrMultiple}× ATR(14)`,
      `- Logic: ${a.stop.reason}`,
      '',
      'Rules I would enforce:',
      `1. Set the stop the moment the entry fills — never trade a position without one`,
      `2. After TP1 fills, move it to break-even (${fmt(a.entry.price)}) so the trade can no longer lose`,
      `3. Trail it under each new ${a.interval} swing ${a.direction === 'LONG' ? 'low' : 'high'} after that`,
      `4. Hard exit if a candle *closes* ${a.direction === 'LONG' ? 'below' : 'above'} ${fmt(a.stop.price)} — do not "give it room"`,
      `5. With ${a.sizing.riskPct}% risk this stop costs at most ${num(a.sizing.riskAmount)}`,
    ].join('\n');
  }

  function targetAnswer(a) {
    if (a.direction === 'NEUTRAL') return fullPlan(a);
    const L = [`**Targets — ${a.symbol} ${a.interval}**`, ''];
    a.targets.forEach((t) => L.push(`- ${t.label} ${fmt(t.price)} · ${t.r}R · ${pct(t.pct)} · ${t.basis} · take ${t.sizeHint} of the position`));
    L.push('');
    L.push(`Blended expectation ${a.rr.blended}R. At ${a.sizing.balance} balance and ${a.sizing.riskPct}% risk that is roughly ${num(a.sizing.riskAmount * a.rr.blended)} if the whole plan works out.`);
    L.push(`Best target to chase: TP2 — it balances hit-rate with payoff. TP3 only on a trend day with expanding volume.`);
    return L.join('\n');
  }

  function riskAnswer(a, overrides) {
    let balance = (overrides && overrides.balance) || a.sizing.balance;
    let riskPct = (overrides && overrides.riskPct) || a.sizing.riskPct;
    let riskAmount = (overrides && overrides.riskAmountOverride) || (balance * riskPct) / 100;
    if (a.direction === 'NEUTRAL' || !a.stop.distance) {
      return [`**Risk**`, '', `No active setup on ${a.symbol} ${a.interval}, so risk is 0 right now.`, `Give me a symbol and a timeframe and I will size the trade for you.`].join('\n');
    }
    const qty = riskAmount / a.stop.distance;
    const notional = qty * a.entry.price;
    const shownPct = balance ? (riskAmount / balance) * 100 : riskPct;
    const L = [`**Position sizing — ${a.symbol} ${a.interval}**`, ''];
    L.push(`- Account ${num(balance)} · risking ${num(riskAmount)} (${num(shownPct, 2)}% of the account)`);
    L.push(`- Stop distance ${num(a.stop.distance, 6)} → position ${num(qty, 6)} units`);
    L.push(`- Notional value ${num(notional)} (${num(notional / balance, 2)}× account)`);
    L.push(`- Max loss if the stop is hit: ${num(riskAmount)}`);
    a.targets.forEach((t) => L.push(`- Profit if ${t.label} fills on the full size: ${num(qty * Math.abs(t.price - a.entry.price))} (${t.r}R)`));
    L.push('');
    if (notional > balance) L.push(`⚠ That notional needs ${num(notional / balance, 2)}× leverage. On a leveraged account remember: a ${num((100 / (notional / balance)) * 1, 1)}% adverse move wipes the account. Prefer smaller size over bigger leverage.`);
    else L.push('✅ The position fits inside the account with no leverage.');
    L.push(`Suggested maximum: 1–2% risk per idea and never more than 6% total across open trades.`);
    return L.join('\n');
  }

  function tradeLineAnswer(a) {
    if (!a.tradeLines.trend) return `No clean trend line fits the last swings on ${a.symbol} ${a.interval} — the market is ranging, so I am using entry/stop/target lines instead.`;
    const t = a.tradeLines.trend;
    return [
      `**Trade lines — ${a.symbol} ${a.interval}**`,
      '',
      `- Trend line: ${t.kind} at ${fmt(t.valueNow)} now, moving ${num(t.slopePctPerBar, 3)}% per ${a.interval} bar (${t.note})`,
      `- Entry line: ${fmt(a.entry.price)} — ${a.entry.trigger}`,
      `- Stop line: ${fmt(a.stop.price)} (${a.stop.atrMultiple}× ATR)`,
      a.targets.map((x) => `- ${x.label} line: ${fmt(x.price)} (${x.r}R)`).join('\n'),
      '',
      'How to read it on the chart: while price holds above the entry line and the trend line keeps rising, the plan is valid. A close through the stop line invalidates it — no averaging down.',
    ].join('\n');
  }

  function whyAnswer(a) {
    const L = [`**Why ${a.direction} on ${a.symbol} ${a.interval}**`, ''];
    if (a.confluences.length) {
      L.push('Working for the trade:');
      a.confluences.forEach((c) => L.push(`- ${c.label}: ${c.note}`));
    }
    if (a.against.length) {
      L.push('');
      L.push('Working against it:');
      a.against.forEach((c) => L.push(`- ${c.label}: ${c.note}`));
    }
    L.push('');
    L.push(`Net weighted score ${a.score} → ${a.confidence}% confidence. Regime: ${a.regime.replace('-', ' ')}.`);
    return L.join('\n');
  }

  function riskFlagsAnswer(a) {
    if (!a.riskFlags.length) return `Nothing serious on ${a.symbol} ${a.interval} right now — clean-ish setup, but still use the stop.`;
    return [`**What could go wrong — ${a.symbol} ${a.interval}**`, '', ...a.riskFlags.map((f) => `- ${f}`), '', 'If two or more of these stack up, cut your size in half or skip the trade.'].join('\n');
  }

  function regimeAnswer(a) {
    const i = a.indicators;
    return [
      `**Market read — ${a.symbol} ${a.interval}**`,
      '',
      `- Regime: ${a.regime.replace('-', ' ')} (ATR ${num(i.atrPct)}% of price, ADX ${num(i.adx, 1)})`,
      `- Trend: price ${fmt(a.price)} vs EMA20 ${fmt(i.ema20)} / EMA50 ${fmt(i.ema50)}${i.ema200 ? ` / EMA200 ${fmt(i.ema200)}` : ''}`,
      `- Momentum: RSI ${num(i.rsi, 1)} · MACD hist ${num(i.macd.hist, 4)} · Stochastic ${num(i.stoch.k, 1)}`,
      `- Bands: ${fmt(i.bb.lower)} – ${fmt(i.bb.upper)} (width ${num(i.bb.widthPct)}%) · VWAP ${fmt(i.vwap)}`,
      `- Volume: ${num(i.volRatio)}× the 20-bar average`,
      `- Range position: ${a.levels.rangePosPct}% of ${fmt(a.levels.rangeLow)} → ${fmt(a.levels.rangeHigh)}`,
      '',
      a.regime.startsWith('trending')
        ? 'Trend regimes reward pullback entries and wider targets — trail the stop instead of taking profit too early.'
        : a.regime === 'compression'
          ? 'Compression precedes expansion: place breakout stop orders on both sides and let the market choose.'
          : a.regime === 'ranging'
            ? 'Ranges reward fading the edges and punish mid-range entries — set alerts and wait.'
            : 'Volatile regimes are dangerous: smaller size, wider stop, faster profit taking.',
    ].join('\n');
  }

  function managementAnswer(a) {
    if (a.direction === 'NEUTRAL') return fullPlan(a);
    return [
      `**How to manage it — ${a.symbol} ${a.interval}**`,
      '',
      `1. Enter: ${a.entry.trigger}`,
      `2. Stop goes in at ${fmt(a.stop.price)} immediately (${a.stop.atrMultiple}× ATR — normal noise will not reach it)`,
      `3. TP1 ${fmt(a.targets[0].price)} (${a.targets[0].r}R): take ${a.targets[0].sizeHint} off, move the stop to break-even`,
      `4. TP2 ${fmt(a.targets[1].price)} (${a.targets[1].r}R): take ${a.targets[1].sizeHint} off, trail the rest`,
      `5. TP3 ${fmt(a.targets[2].price)} (${a.targets[2].r}R): leave 20% as a runner with a trailing stop under the ${a.interval} swings`,
      '',
      `Time stop: if price has not moved 1× ATR in your favour after ~10 bars, close it at break-even and move on. Invalidation: a close ${a.direction === 'LONG' ? 'below' : 'above'} ${fmt(a.stop.price)}.`,
    ].join('\n');
  }

  const GLOSSARY = {
    rsi: 'RSI(14) measures the speed of price changes on a 0–100 scale. Above 70 = overbought, below 30 = oversold, and 50 is the momentum line. I use it with divergence detection, not on its own.',
    macd: 'MACD is the difference between the 12 and 26 EMA with a 9-period signal line. When the histogram crosses zero the momentum is turning — that is the trigger I weight most after trend.',
    adx: 'ADX measures trend *strength*, not direction. Under 15 = chop, 15–25 = developing, above 25 = real trend. It decides whether I trust trend signals or cut size.',
    atr: 'ATR(14) is the average true range — the average size of a bar including gaps. I use it to place stops wide enough that normal noise will not hit them, and to project targets.',
    bollinger: 'Bollinger bands are a 20-period average ±2 standard deviations. Price outside a band is stretched; compressed bands (low width) usually precede an expansion move.',
    vwap: 'VWAP is volume-weighted average price over the window. Price above VWAP means buyers are paying above the average price — an institutional-style bias filter.',
    ema: 'EMAs are exponentially weighted averages. EMA20 = short-term pullback zone, EMA50/200 = trend definition. When they stack in order a trend is healthy.',
    divergence: 'Divergence is when price makes a new extreme but momentum (RSI) does not. It warns the move is tiring and often precedes a reversal.',
    "stop loss": 'A stop loss is an order that closes the trade at a set price to cap the loss. I place it beyond the last swing plus an ATR buffer, then size the position so the loss equals your chosen risk %.',
    "take profit": 'A take profit closes the trade in profit. I project them from real swing levels first, then ATR extensions, and I scale out 50/30/20%.',
    "risk reward": 'Reward:risk compares the pips/points you can win to what you risk. 2R means you win twice what you risk; it means you can be profitable with a 34% win-rate.',
    "position sizing": 'Position size = (account × risk%) ÷ stop distance. That single formula is what keeps a losing streak survivable.',
    "trade line": 'Trade lines are the chart lines for the plan: entry line, stop line and target lines, plus the fitted trend line. If price closes through the stop line, the idea is dead.',
  };

  function glossaryAnswer(question) {
    const q = question.toLowerCase();
    const hit = Object.keys(GLOSSARY).find((k) => q.includes(k));
    if (hit) return `**${hit.toUpperCase()}**\n\n${GLOSSARY[hit]}`;
    return null;
  }

  function helpAnswer(a) {
    return [
      '**I can help with**',
      '- "analyze" / "setup" — full plan: entry, stop, targets, size',
      '- "where is my entry", "stop loss", "targets", "trade line"',
      '- "risk 2% of 5000" — size any amount for you',
      '- "why long", "what could go wrong", "market read"',
      '- "analyse ETH on 4h" — switch asset and timeframe',
      '- "explain RSI / ATR / VWAP / divergence ..." — plain-English definitions',
      '',
      `Right now I am tracking **${a.symbol} · ${a.interval}** — ${a.direction}${a.direction !== 'NEUTRAL' ? ` at ${a.confidence}% confidence` : ''}.`,
    ].join('\n');
  }

  function bestTradeAnswer(watchlist) {
    if (!watchlist || !watchlist.length) return 'Run the scanner first and I will rank the cleanest setups across the watchlist.';
    const ranked = watchlist
      .filter((w) => w.a && w.a.ok && w.a.direction !== 'NEUTRAL')
      .sort((x, y) => y.a.confidence - x.a.confidence);
    if (!ranked.length) return 'Nothing on the watchlist is worth trading right now — every market is mid-range or conflicting. Sitting out is the correct trade.';
    const L = ['**Best setups right now**', ''];
    ranked.slice(0, 5).forEach((w, i) => {
      const a = w.a;
      L.push(`${i + 1}. **${a.symbol} ${a.interval}** — ${a.direction} ${a.confidence}% (${a.grade}) · entry ${fmt(a.entry.price)} · stop ${fmt(a.stop.price)} · TP1 ${fmt(a.targets[0].price)} (${a.targets[0].r}R) · ${a.regime.replace('-', ' ')}`);
    });
    L.push('', 'Pick the top one, or the one whose structure you understand best — confidence scores are not a promise.');
    return L.join('\n');
  }

  /* ---------------------------------------------------------
     Main entry point
     --------------------------------------------------------- */
  function reply(question, ctx) {
    const q = (question || '').toLowerCase().trim();
    const a = ctx && ctx.analysis;
    const catalog = (ctx && ctx.catalog) || [];

    const action = {};
    const currentId = (ctx && ctx.marketId) || (a && a.symbol);
    const wantedSymbol = extractSymbol(q, catalog);
    if (wantedSymbol && wantedSymbol !== currentId) action.symbol = wantedSymbol;
    const wantedInterval = extractInterval(q);
    if (wantedInterval && (!a || wantedInterval !== a.interval)) action.interval = wantedInterval;

    if (!a || !a.ok) {
      return { text: 'I need data before I can answer. Hit **Analyse** and ask me again.', action: Object.keys(action).length ? action : null };
    }

    // sizing overrides
    const risk = extractRisk(q);
    const balance = extractBalance(q, { skipDollarOnly: !!(risk && risk.riskAmountOverride) });
    const overrides = {
      balance: balance || a.sizing.balance,
      riskPct: (risk && risk.riskPct) || a.sizing.riskPct,
      riskAmountOverride: risk && risk.riskAmountOverride,
    };

    const has = (...words) => words.some((w) => q.includes(w));
    let text = null;

    if (!q || has('hi', 'hello', 'hey', 'salam', 'selam')) {
      text = `👋 Ready. ${header(a)}\n\nAsk me "analyze" for the full plan, or "risk 1% of 500" to size it.`;
    } else if (/^(help|what can you do|commands|how do you work)$/.test(q) || has('what can you')) {
      text = helpAnswer(a);
    } else if (has('best trade', 'best setup', 'what should i trade', 'scan', 'top pick')) {
      text = bestTradeAnswer(ctx.watchlist);
    } else if (has('entry', 'enter', 'buy', 'long at', 'short at', 'where do i get in')) {
      text = entryAnswer(a);
    } else if (has('stop', 'sl', 'invalidation', 'where do i exit if wrong')) {
      text = stopAnswer(a);
    } else if (has('target', 'tp', 'take profit', 'profit level', 'exit')) {
      text = targetAnswer(a);
    } else if (has('risk', 'size', 'position', 'how much', 'lot', 'quantity', 'capital', 'balance')) {
      text = riskAnswer(a, overrides);
    } else if (has('trend line', 'trade line', 'trendline', 'line')) {
      text = tradeLineAnswer(a);
    } else if (has('why', 'reason', 'confluence', 'justify')) {
      text = whyAnswer(a);
    } else if (has('what could go wrong', 'risk of', 'danger', 'warning', 'against')) {
      text = riskFlagsAnswer(a);
    } else if (has('market read', 'regime', 'trend', 'structure', 'read the market', 'how is the market')) {
      text = regimeAnswer(a);
    } else if (has('manage', 'hold', 'trail', 'move my stop', 'after entry', 'plan of action')) {
      text = managementAnswer(a);
    } else if (has('analyze', 'analyse', 'setup', 'signal', 'plan', 'trade now', 'should i trade')) {
      text = fullPlan(a);
    } else {
      text = glossaryAnswer(q);
      if (!text) {
        text = has('what if', 'think')
          ? whyAnswer(a)
          : [`Not sure I parsed that — here is the current read:`, '', fullPlan(a), '', 'Try: "where is my entry", "stop loss", "targets", "risk 2% of 5000", "analyse ETH on 4h".'].join('\n');
      }
    }

    return { text, action: Object.keys(action).length ? action : null };
  }

  return { reply, extractSymbol, extractInterval, extractRisk, extractBalance, fullPlan, GLOSSARY };
});
