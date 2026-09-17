/* ============================================================================
   Hotel Serving System — shared core
   API client, formatting, toasts, live updates, small DOM helpers.
   ========================================================================== */
'use strict';

const HSS = (() => {
  const TOKEN_KEY = 'hss.token';
  const STAFF_KEY = 'hss.staff';
  const TABLE_KEY = 'hss.table';

  let settings = {
    currency: { code: 'USD', symbol: '$', decimals: 2, position: 'before' },
    hotelName: 'Hotel',
    restaurantName: 'Restaurant'
  };

  /* ---------------------------------------------------------------- session */
  const session = {
    get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
    get staff() {
      try { return JSON.parse(localStorage.getItem(STAFF_KEY) || 'null'); } catch { return null; }
    },
    save(token, staff) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(STAFF_KEY);
    }
  };

  /* ------------------------------------------------------------------ api */
  async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && session.token) headers.Authorization = 'Bearer ' + session.token;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && auth) session.clear();
      throw err;
    }
    return data;
  }

  /* ---------------------------------------------------------- formatting */
  function money(minor, opts = {}) {
    const c = Object.assign({}, settings.currency, opts.currency || {});
    const decimals = opts.decimals !== undefined ? opts.decimals : (c.decimals ?? 2);
    const value = (Number(minor) || 0) / Math.pow(10, decimals);
    const fixed = value.toFixed(decimals);
    const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sym = opts.hideSymbol ? '' : (c.symbol || '');
    if (opts.hideSymbol) return grouped;
    return c.position === 'after' ? `${grouped}\u00a0${sym}` : `${sym}${grouped}`;
  }

  /** "1,25" typed by a human → 125 minor units */
  function toMinor(input, decimals) {
    const d = decimals ?? (settings.currency.decimals ?? 2);
    const n = parseFloat(String(input).replace(/[^0-9.\-]/g, ''));
    if (Number.isNaN(n)) return 0;
    return Math.round(n * Math.pow(10, d));
  }

  function clockTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + clockTime(iso);
  }

  /** Minutes since an ISO timestamp, as "4m" / "1h 12m". */
  function elapsed(iso, from) {
    if (!iso) return '—';
    const ms = (from ? new Date(from).getTime() : Date.now()) - new Date(iso).getTime();
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    return h + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }

  function secondsSince(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------------------------------------------------------------- toasts */
  let toastHost = null;
  function toast(message, kind = 'ok', ms = 3200) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = `<span class="t-dot"></span><span>${esc(message)}</span>`;
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => {
      t.classList.remove('in');
      setTimeout(() => t.remove(), 250);
    }, ms);
  }

  /* --------------------------------------------------------------- status */
  const STATUS = {
    awaiting_cashier: { label: 'Awaiting cashier', short: 'To approve', step: 1, tone: 'warn', icon: '🧾' },
    in_kitchen: { label: 'Sent to kitchen', short: 'In kitchen', step: 2, tone: 'info', icon: '📨' },
    preparing: { label: 'Cooking', short: 'Cooking', step: 3, tone: 'accent', icon: '🔥' },
    ready: { label: 'Ready to serve', short: 'Ready', step: 4, tone: 'good', icon: '🔔' },
    served: { label: 'Served', short: 'Served', step: 5, tone: 'good', icon: '✅' },
    completed: { label: 'Completed & paid', short: 'Paid', step: 6, tone: 'muted', icon: '💰' },
    rejected: { label: 'Rejected by cashier', short: 'Rejected', step: 0, tone: 'bad', icon: '⛔' },
    cancelled: { label: 'Cancelled', short: 'Cancelled', step: 0, tone: 'bad', icon: '✖' }
  };
  const ITEM_STATUS = {
    queued: { label: 'Queued', tone: 'muted' },
    cooking: { label: 'Cooking', tone: 'accent' },
    ready: { label: 'Ready', tone: 'good' },
    served: { label: 'Served', tone: 'good' }
  };
  const PAY = {
    unpaid: { label: 'Unpaid', tone: 'warn' },
    paid: { label: 'Paid', tone: 'good' },
    refunded: { label: 'Refunded', tone: 'muted' }
  };
  const status = (s) => STATUS[s] || { label: s || '—', short: s || '—', tone: 'muted', step: 0, icon: '•' };

  /* ------------------------------------------------------------- live feed */
  function live(onChange, onState) {
    // Environments without Server-Sent Events (old tablets, some webviews) keep
    // working — the screens also poll, so we just report the degraded state.
    if (typeof EventSource === 'undefined') {
      if (onState) onState('poll');
      return () => {};
    }
    let es = null;
    let closed = false;
    function connect() {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onopen = () => onState && onState('live');
      es.onerror = () => { onState && onState('offline'); };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'change') onChange(data);
          if (data.type === 'hello') onState && onState('live');
        } catch { /* ignore malformed frames */ }
      };
    }
    connect();
    return () => { closed = true; if (es) es.close(); };
  }

  /* ----------------------------------------------------------------- sound */
  let audioCtx = null;
  function ping(kind = 'order') {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === 'ready' ? [880, 1180] : kind === 'bill' ? [660, 520] : [520, 780];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.value = 0.0001;
        osc.connect(gain).connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + i * 0.14;
        gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.start(t0);
        osc.stop(t0 + 0.18);
      });
    } catch { /* audio is a nicety, never fatal */ }
  }

  /* ------------------------------------------------------------------- dom */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Delegated events: on(root, 'click', '[data-act="x"]', (el, ev) => ...) */
  function on(root, type, selector, handler) {
    root.addEventListener(type, (ev) => {
      const target = ev.target.closest(selector);
      if (target && root.contains(target)) handler(target, ev);
    });
  }

  let modalHost = null;
  function modal(html, { onMount, className = '' } = {}) {
    if (!modalHost) {
      modalHost = document.createElement('div');
      modalHost.className = 'modal-host';
      modalHost.setAttribute('hidden', '');
      document.body.appendChild(modalHost);
      modalHost.addEventListener('click', (ev) => {
        if (ev.target === modalHost || ev.target.closest('[data-modal-close]')) closeModal();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeModal();
      });
    }
    modalHost.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true"><div class="modal-inner">${html}</div></div>`;
    modalHost.removeAttribute('hidden');
    document.body.classList.add('modal-open');
    if (onMount) onMount(modalHost);
    return modalHost;
  }
  function closeModal() {
    if (!modalHost) return;
    modalHost.setAttribute('hidden', '');
    modalHost.innerHTML = '';
    document.body.classList.remove('modal-open');
  }

  function badge(text, tone = 'muted', extra = '') {
    return `<span class="badge ${tone} ${extra}">${esc(text)}</span>`;
  }

  function setSettings(s) {
    if (s && s.currency) settings = Object.assign({}, settings, s);
  }

  return {
    session, api, money, toMinor, clockTime, dateTime, elapsed, secondsSince, esc,
    toast, STATUS, ITEM_STATUS, PAY, status, live, ping, $, $$, on, modal, closeModal,
    badge, setSettings, get settings() { return settings; },
    TABLE_KEY
  };
})();
