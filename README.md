# Doro Smart Poultry System

Website: [dorosmart.com](http://dorosmart.com)

Smart poultry farm manager for Ethiopian farms:

- Email + password login and sign up
- Farm profile (name, region, birds, house, type)
- Feeding, water, temperature and healthcare tools
- Free plan vs Paid (1,499 ETB / month)
- Pay in ETB to **CBE 1000707418757** or **Telebirr +251904743453**
- House PLC dashboard paired with a QR code

Open `index.html` or serve the folder with any static web server.

---

## Doro Trade AI — trading analysis bot

Open **`trade.html`** (linked from the main navigation and the hero). It is a
self-contained trading terminal that turns live market data into one complete
trade plan:

- **Entry** — market/pullback/range/breakout style, price zone and the trigger
  that confirms it
- **Stop loss** — beyond the last swing plus an ATR buffer, floored at 0.8 ATR
  and capped at 2.6 ATR so normal noise cannot clip it
- **Take profit 1/2/3** — real swing levels and pivots first (≥1R / ≥1.8R / ≥2.6R),
  ATR extensions when structure is thin, with 50/30/20% exit sizes
- **Trade lines** — entry line, stop line, target lines and a fitted trend line,
  all drawn on the live candlestick chart
- **Reward:risk** — per target, blended R and the breakeven win-rate
- **Position sizing** — `(balance × risk%) ÷ stop distance`, with a leverage warning
- **Refusal to trade** — mid-range chop, dead volatility or a balanced score
  returns “no trade” plus the reason

Plus a bot that answers questions about the plan, a multi-market scanner, a
trade journal with win rate / average R / profit factor, and alerts when price
reaches your entry, stop or targets.

### Files

| File | Purpose |
| --- | --- |
| `trade.html` | The terminal page (charts, plan, bot, journal) |
| `css/trade.css` | Dark trading-desk styling |
| `js/trade-engine.js` | Indicators, market structure, weighted signals, trade plan |
| `js/trade-data.js` | Market data from public exchange APIs + demo fallback |
| `js/trade-chart.js` | Canvas chart with candles, EMAs, volume and trade lines |
| `js/trade-bot.js` | Rule-based assistant (entry, stop, targets, sizing, glossary) |
| `js/trade-ai.js` | Page wiring: controls, rendering, journal, alerts, exports |

### Data sources

Candles come from public endpoints, tried in order until one answers:
**Binance → Bybit → OKX → Coinbase → Kraken → Bitstamp**. No API key, no
backend — everything runs in the browser, so the static site works as-is.
Gold is tracked through PAXG (a gold-backed token) as a proxy for XAU/USD.
For stocks, forex or any other broker feed, set a **custom JSON feed** URL in
the console's advanced panel: it is called with `?symbol=…&interval=…` and must
return `[{t,o,h,l,c,v}]`. If no feed is reachable the page labels the chart
**DEMO DATA** and keeps working so the workflow can still be demonstrated.

### Tests

No dependencies required (Node 18+):

```bash
npm test              # engine + feed adapters + page smoke test + UI checks
node tools/test-engine.mjs    # 58 checks: indicator maths, trade plans, bot replies
node tools/test-feed.mjs      # 32 checks: exchange adapters, fallback order, demo mode
node tools/test-browser.mjs   # 32 checks: the page logic runs end-to-end in a fake DOM
node tools/check-ui.mjs       # static cross-check of HTML ids, CSS classes, script order
```

> **Risk warning:** Doro Trade AI is an educational analysis tool, not financial
> advice. Signals can be wrong. Never trade without a stop and never risk money
> you cannot afford to lose.
