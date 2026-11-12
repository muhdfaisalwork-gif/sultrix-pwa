/* Sultrix PWA v2.2.38 — main app
 *
 *  - Connect: first-run wizard asks for desktop bot's tunnel URL
 *    (or detects `?api_base=...` from a scanned QR), then validates
 *    the connection by calling /api/pwa/status before letting the user in.
 *  - Login: license key → /api/pwa/auth → session token in localStorage (sentinel)
 *  - Tab router: bottom-nav + deep-link via ?route=
 *  - Live data: periodic polling with offline fallback
 *  - Push: /api/pwa/notifications/subscribe (handled by SW after grant)
 */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────
  const STORAGE = {
    TOKEN: 'sx.session',          // server-issued session token (or sentinel)
    LICENSE_HASH: 'sx.licHash',   // short fingerprint of last-used license (NOT the key)
    ALERT_SEEN: 'sx.alertsSeen',  // last seen alert id
    CHART: 'sx.chart',            // {market,symbol,tf}
    NOTIF_PREFS: 'sx.notifPrefs', // {category:bool}
    PUSH_SUBS: 'sx.pushSubs',     // last push subscription endpoint
    API_BASE: 'sx.apiBase',       // desktop bot tunnel URL (saved after wizard)
    API_ENDPOINTS: 'sx.apiBases', // array of saved endpoints (history)
  };
  const POLL_MS = 12_000;        // home refresh
  const SLOW_POLL_MS = 45_000;   // agents / alerts
  const BUILD = '2.2.54';

  // ── State ────────────────────────────────────────
  const state = {
    session: null,
    plan: 'unknown',
    isTrial: false,
    isDeveloper: false,
    trialDaysLeft: null,
    lastFetch: 0,
    conn: 'live',                  // live | updating | offline
    offlineSince: null,            // timestamp when connection was lost
    botStatus: null,               // last known bot_status (e.g. 'RUNNING', 'ERROR')
    pos: [],
    posFilter: 'all',
    alertFilter: 'all',
    agentFilter: 'all',
    chart: { market: 'crypto', symbol: 'BTCUSDT', tf: '60' },
    pushSubscribed: false,
  };

  // ── Tiny utils ──────────────────────────────────
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const fmt = {
    money: (n) => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + '$' + Number(n).toFixed(2)),
    pct:   (n) => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'),
    num:  (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString()),
    rel:  (ts) => {
      if (!ts) return '—';
      const s = Math.max(1, Math.round((Date.now() / 1000) - ts));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    },
    side: (s) => s === 'long' || s === 'buy' ? 'L' : s === 'short' || s === 'sell' ? 'S' : '·',
    severity: (s) => (s || 'low').toLowerCase(),
  };
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ── Capacitor Native Bridge ───────────────────────
  const isCapacitorNative = () => {
    try {
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    } catch (_) {
      return false;
    }
  };
  const isNative = isCapacitorNative();
  const CapPlugins = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins : {};

  function triggerHaptic(type = 'light') {
    if (!isNative || !CapPlugins.Haptics) return;
    try {
      if (type === 'warning' || type === 'error') {
        CapPlugins.Haptics.notification({ type: 'WARNING' });
      } else if (type === 'success') {
        CapPlugins.Haptics.notification({ type: 'SUCCESS' });
      } else {
        CapPlugins.Haptics.impact({ style: 'LIGHT' });
      }
    } catch (_) {}
  }

  function initNativeBridge() {
    if (!isNative) return;
    // Dark status bar matching Sultrix theme
    if (CapPlugins.StatusBar) {
      try {
        CapPlugins.StatusBar.setStyle({ style: 'DARK' });
        CapPlugins.StatusBar.setBackgroundColor({ color: '#0B0E14' });
      } catch (_) {}
    }
    // Android hardware back button handler
    if (CapPlugins.App) {
      try {
        CapPlugins.App.addListener('backButton', () => {
          if (state.tab && state.tab !== 'home') {
            setActiveTab('home');
          } else {
            CapPlugins.App.exitApp();
          }
        });
      } catch (_) {}
    }
    // Native network state listener (WiFi <-> Cellular changes)
    if (CapPlugins.Network) {
      try {
        CapPlugins.Network.addListener('networkStatusChange', (status) => {
          if (status && status.connected) {
            handleResumeOrNetworkChange('capacitor-network-connected');
          } else {
            setConn('offline');
          }
        });
      } catch (_) {}
    }
    // Capacitor App lifecycle events: phone comes back from sleep or background
    if (CapPlugins.App) {
      try {
        CapPlugins.App.addListener('appStateChange', (appState) => {
          if (appState && appState.isActive) {
            handleResumeOrNetworkChange('capacitor-appState-active');
          }
        });
        CapPlugins.App.addListener('resume', () => {
          handleResumeOrNetworkChange('capacitor-app-resume');
        });
      } catch (_) {}
    }
  }

  let lastResumeOrNetworkChangeAt = 0;
  function handleResumeOrNetworkChange(reason) {
    const now = Date.now();
    // Debounce: ignore repeated events within 2 seconds to prevent flapping stampedes
    if (now - lastResumeOrNetworkChangeAt < 2000) {
      return;
    }
    lastResumeOrNetworkChangeAt = now;
    setConn('updating', 'Reconnecting…');
    refreshAll();
  }

  // ── Pure connection & retry helpers (loaded via conn_helpers.js) ──
  const computeRetryDelay = (typeof window !== 'undefined' && window.computeRetryDelay) || function (attempt, baseMs = 1500, maxMs = 30000, randomFn = Math.random) {
    const n = Math.max(0, Math.floor(Number(attempt) || 0));
    const base = Math.max(500, Number(baseMs) || 1500);
    const max = Math.max(base, Number(maxMs) || 30000);
    const exp = Math.min(max, base * Math.pow(2, Math.min(n, 10)));
    const rnd = typeof randomFn === 'function' ? randomFn() : Math.random();
    const jitterFactor = 0.2;
    const jitter = (rnd * 2 - 1) * jitterFactor * exp;
    return Math.max(500, Math.min(max, Math.round(exp + jitter)));
  };

  const formatConnectionStatus = (typeof window !== 'undefined' && window.formatConnectionStatus) || function (kind, offlineSinceTs, nowTs = Date.now()) {
    if (kind === 'live' || kind === 'connected') return { kind: 'live', text: '', isLive: true };
    if (kind === 'updating' || kind === 'reconnecting') return { kind: 'updating', text: 'Reconnecting to bot…', isLive: false };
    const s = offlineSinceTs ? Math.max(1, Math.round(((Number(nowTs) || Date.now()) - Number(offlineSinceTs)) / 1000)) : null;
    let relText = '';
    if (s != null) {
      if (s < 60) relText = s + 's ago';
      else if (s < 3600) relText = Math.round(s / 60) + 'm ago';
      else if (s < 86400) relText = Math.round(s / 3600) + 'h ago';
      else relText = Math.round(s / 86400) + 'd ago';
    }
    const text = relText ? `Offline since ${relText} — showing cached data` : 'Offline — showing cached data';
    return { kind: 'offline', text, isLive: false };
  };

  const isRetryableError = (typeof window !== 'undefined' && window.isRetryableError) || function (status, message) {
    const s = Number(status) || 0;
    const msg = String(message || '').toLowerCase();
    if (s === 0) return true;
    if (s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530) || s >= 500) return true;
    if (msg.includes('network_unreachable') || msg.includes('timeout') || msg.includes('failed to fetch')) return true;
    return false;
  };

  const shouldCheckRelay = (typeof window !== 'undefined' && window.shouldCheckRelay) || function (errorStatus, currentUrl, hasSavedKey, message) {
    return Boolean(hasSavedKey && isRetryableError(errorStatus, message) && (!currentUrl || isTrustedTunnel(currentUrl)));
  };

  // Abortable fetch with configurable timeout (default 10s).
  function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
    const ms = Math.max(1000, Number(timeoutMs) || 10000);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(new Error('timeout')); } catch (_) {}
    }, ms);

    const merged = Object.assign({}, opts);
    if (merged.signal) {
      const parentSignal = merged.signal;
      if (parentSignal.aborted) {
        clearTimeout(timer);
        try { controller.abort(parentSignal.reason); } catch (_) {}
      } else {
        parentSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          try { controller.abort(parentSignal.reason); } catch (_) {}
        }, { once: true });
      }
    }
    merged.signal = controller.signal;

    return fetch(url, merged).catch((err) => {
      if (timedOut || (err && (err.name === 'AbortError' || err.message === 'timeout'))) {
        const timeoutErr = new Error('request_timeout');
        timeoutErr.status = 0;
        timeoutErr.cause = err;
        throw timeoutErr;
      }
      throw err;
    }).finally(() => {
      clearTimeout(timer);
    });
  }

  // Storage persistence helpers (mirrors to Capacitor Preferences when in native container)
  function getSavedLicenseKey() {
    try {
      const k = localStorage.getItem('sx.savedLicenseKey');
      if (k) return k.trim();
    } catch (_) {}
    return '';
  }

  function persistSavedLicenseKey(key) {
    if (!key || typeof key !== 'string') return;
    const clean = key.trim();
    if (clean.length < 6) return;
    try { localStorage.setItem('sx.savedLicenseKey', clean); } catch (_) {}
    if (isNative && CapPlugins.Preferences) {
      try { CapPlugins.Preferences.set({ key: 'sx.savedLicenseKey', value: clean }); } catch (_) {}
    }
  }

  function persistSessionToken(token) {
    if (!token) {
      try { localStorage.removeItem(STORAGE.TOKEN); } catch (_) {}
      if (isNative && CapPlugins.Preferences) {
        try { CapPlugins.Preferences.remove({ key: STORAGE.TOKEN }); } catch (_) {}
      }
      return;
    }
    try { localStorage.setItem(STORAGE.TOKEN, token); } catch (_) {}
    if (isNative && CapPlugins.Preferences) {
      try { CapPlugins.Preferences.set({ key: STORAGE.TOKEN, value: token }); } catch (_) {}
    }
  }

  let offlineTicker = null;
  function startOfflineTicker() {
    if (offlineTicker) return;
    offlineTicker = setInterval(() => {
      if (state.conn === 'offline' && state.offlineSince) {
        const formatted = formatConnectionStatus('offline', state.offlineSince);
        const b = $('#banner');
        if (b && !b.hidden) b.textContent = formatted.text;
      } else {
        stopOfflineTicker();
      }
    }, 5000);
  }
  function stopOfflineTicker() {
    if (offlineTicker) clearInterval(offlineTicker);
    offlineTicker = null;
  }

  function setConn(kind, msg) {
    state.conn = kind;
    if (kind === 'live') {
      state.offlineSince = null;
      stopOfflineTicker();
    } else {
      if (!state.offlineSince) state.offlineSince = Date.now();
      if (kind === 'offline') startOfflineTicker();
      else stopOfflineTicker();
    }

    const formatted = formatConnectionStatus(kind, state.offlineSince);
    const displayText = msg || formatted.text;

    // Banner update
    const b = $('#banner');
    if (b) {
      if (formatted.isLive || !displayText) {
        b.hidden = true;
      } else {
        b.hidden = false;
        b.className = 'banner ' + formatted.kind;
        b.textContent = displayText;
      }
    }

    // Status dot update: ensure stale data is never shown as live
    const dot = $('#statusDot');
    if (dot) {
      dot.classList.remove('idle', 'error', 'updating', 'warn');
      if (formatted.isLive) {
        if (state.botStatus && state.botStatus !== 'RUNNING') {
          dot.classList.add(state.botStatus === 'ERROR' ? 'error' : 'idle');
        }
      } else if (formatted.kind === 'updating') {
        dot.classList.add('updating');
      } else {
        dot.classList.add('error');
      }
    }
  }

  // ── API client ───────────────────────────────────
  // API_BASE is the desktop bot's tunnel origin. Resolution order:
  //   1. window.SULTRIX_API_BASE (set by host page before app.js loads)
  //   2. <meta name="sultrix-api-base" content="...">
  //   3. ?api_base=...  query param (set by QR-code scan from the desktop launcher)
  //   4. localStorage.sx.apiBase (saved by the connect wizard)
  //   5. empty string (then api() uses path-as-relative — works when PWA is
  //      served from the dashboard itself, e.g. http://localhost:5000/pwa/).
  function _resolveApiBase() {
    if (typeof window === 'undefined') return '';
    if (window.SULTRIX_API_BASE) return String(window.SULTRIX_API_BASE).replace(/\/$/, '');
    try {
      const m = document.querySelector('meta[name="sultrix-api-base"]');
      if (m && m.content) return String(m.content).replace(/\/$/, '');
    } catch (_) {}
    // 3. URL query param (QR-scan flow)
    try {
      const qp = new URLSearchParams(location.search).get('api_base');
      if (qp) {
        const cleaned = String(qp).replace(/\/$/, '');
        try { localStorage.setItem(STORAGE.API_BASE, cleaned); } catch (_) {}
        return cleaned;
      }
    } catch (_) {}
    // 4. localStorage (saved from a prior wizard)
    try {
      const saved = localStorage.getItem(STORAGE.API_BASE);
      if (saved) return saved.replace(/\/$/, '');
    } catch (_) {}
    return '';
  }
  let API_BASE = _resolveApiBase();
  function getApiBase() {
    return API_BASE || '';
  }

  async function api(path, opts) {
    opts = opts || {};
    const base = getApiBase();
    // If path is absolute (http://... or https://...) use as-is.
    // Otherwise prepend API_BASE if set, else use path as relative URL.
    const url = /^https?:/i.test(path)
      ? path
      : (base ? base + (path.startsWith('/') ? path : '/' + path) : path);
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.session) headers['Authorization'] = 'Bearer ' + state.session;
    const timeoutMs = opts.timeout || 10000;
    let res;
    try {
      res = await fetchWithTimeout(url, Object.assign({ method: opts.method || 'GET', headers }, opts), timeoutMs);
    } catch (e) {
      // Network failure or timeout (DNS, CORS, timeout, server down) — surface a
      // clear error so reconnect/fallback mechanisms trigger immediately.
      const isTimeout = e.message === 'request_timeout';
      const err = new Error(isTimeout ? 'request_timeout' : 'network_unreachable');
      err.status = 0;
      err.cause = e;
      throw err;
    }
    if (!res.ok) {
      const err = new Error('api ' + res.status);
      err.status = res.status;
      try { err.body = await res.json(); } catch (_) {}
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ── Connect wizard ─────────────────────────────────
  // Shown when the PWA is served from a public host (app.sultrixtrade.com)
  // and there's no desktop bot URL configured. The PRIMARY path is now the
  // license-key relay lookup — the user types their license key, the PWA
  // calls https://sultrix-relay.muhd-faisal-work.workers.dev/api/bot/lookup
  // to find the bot's current tunnel URL, and connects automatically. No
  // more copy-pasting random trycloudflare URLs on every bot restart.
  // The manual URL paste is still available as a fallback (for testnet
  // setups, debugging, etc.).
  // `force` shows the wizard even when a saved address exists: that address
  // is stale (the bot's quick-tunnel address changes at every desktop restart)
  // and the customer must not be left with no way to reconnect.
  function showConnectWizard(force) {
    const isPublic = isNative || /sultrixtrade\.com|github\.io/.test(location.host);
    const wiz = document.getElementById('connectWizard');
    if (!wiz) return;
    if (!isPublic) { wiz.hidden = true; return; }
    if (API_BASE && !force) { wiz.hidden = true; return; }
    wiz.hidden = false;
    // On a public host with no bot connected, the login form is useless
    // (it always returns 405). Hide it so the user is forced through
    // the connect wizard. Once they enter a working tunnel URL, the
    // wizard reloads the page and the login form returns.
    if (isPublic) {
      const loginForm = document.getElementById('loginFormFields');
      if (loginForm) loginForm.style.display = 'none';
      const loginFormHeader = document.getElementById('loginFormHeader');
      if (loginFormHeader) loginFormHeader.style.display = 'none';
    }
    renderSavedEndpoints();
    // Autofocus the URL input so the user can just paste/type.
    setTimeout(() => {
      const input = document.getElementById('apiBaseInput');
      if (input) input.focus();
    }, 100);
  }
  function renderSavedEndpoints() {
    const list = document.getElementById('savedEndpointsList');
    const row  = document.getElementById('savedEndpointsRow');
    if (!list || !row) return;
    let endpoints = [];
    try { endpoints = JSON.parse(localStorage.getItem(STORAGE.API_ENDPOINTS) || '[]'); } catch (_) {}
    endpoints = (endpoints || []).filter(e => e && e.url);
    if (!endpoints.length) { row.style.display = 'none'; list.innerHTML = ''; return; }
    row.style.display = '';
    list.innerHTML = endpoints.map((e, i) => `
      <div style="display:flex;align-items:center;gap:8px;background:#0b0f17;border:1px solid #2a3142;border-radius:6px;padding:8px 10px">
        <span style="color:#00E5C3;font-family:var(--mono);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</span>
        <span style="color:#6b7280;font-size:10px">${e.lastSeen ? new Date(e.lastSeen).toLocaleDateString() : ''}</span>
        <button data-i="${i}" data-action="use"   class="btn" style="padding:4px 10px;font-size:11px">Use</button>
        <button data-i="${i}" data-action="remove" class="btn" style="padding:4px 10px;font-size:11px;background:transparent;color:#ff6b81;border:1px solid rgba(255,107,129,0.4)">×</button>
      </div>
    `).join('');
    list.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        const i = +b.dataset.i;
        const a = b.dataset.action;
        if (a === 'use') {
          document.getElementById('apiBaseInput').value = endpoints[i].url;
          tryConnect(endpoints[i].url);
        } else if (a === 'remove') {
          endpoints.splice(i, 1);
          try { localStorage.setItem(STORAGE.API_ENDPOINTS, JSON.stringify(endpoints)); } catch (_) {}
          renderSavedEndpoints();
        }
      });
    });
  }
  function rememberEndpoint(url) {
    if (!url) return;
    let endpoints = [];
    try { endpoints = JSON.parse(localStorage.getItem(STORAGE.API_ENDPOINTS) || '[]'); } catch (_) {}
    endpoints = (endpoints || []).filter(e => e && e.url !== url);
    endpoints.unshift({ url, lastSeen: Date.now() });
    if (endpoints.length > 5) endpoints = endpoints.slice(0, 5);
    try { localStorage.setItem(STORAGE.API_ENDPOINTS, JSON.stringify(endpoints)); } catch (_) {}
  }
  function setConnectStatus(msg, kind) {
    const el = document.getElementById('connectStatus');
    if (!el) return;
    el.style.display = msg ? '' : 'none';
    if (!msg) return;
    el.textContent = msg;
    el.style.background = kind === 'err' ? 'rgba(255,68,102,0.10)' : kind === 'ok' ? 'rgba(0,229,160,0.10)' : 'rgba(255,197,61,0.08)';
    el.style.border = '1px solid ' + (kind === 'err' ? 'rgba(255,68,102,0.4)' : kind === 'ok' ? 'rgba(0,229,160,0.4)' : 'rgba(255,197,61,0.3)');
    el.style.color = kind === 'err' ? '#ff6b81' : kind === 'ok' ? '#00e5a0' : '#F59E0B';
  }
  async function tryConnect(rawUrl) {
    const url = String(rawUrl || '').trim().replace(/\/$/, '');
    if (!url) { setConnectStatus('Enter a tunnel URL first', 'err'); return; }
    if (!/^https?:\/\//i.test(url)) { setConnectStatus('URL must start with http:// or https://', 'err'); return; }
    setConnectStatus('Testing connection to ' + url + ' …', 'info');
    try {
      // Probe the bot with a known endpoint. Any 2xx/3xx/4xx response proves
      // the tunnel is reachable; only network failures abort.
      const probe = await fetchWithTimeout(url.replace(/\/$/, '') + '/api/pwa/status', { method: 'GET', mode: 'cors' }, 8000);
      if (probe.status === 0) throw new Error('No response');
      // Persist
      try { localStorage.setItem(STORAGE.API_BASE, url); } catch (_) {}
      rememberEndpoint(url);
      API_BASE = url;
      if (isNative && CapPlugins.Preferences) {
        try { CapPlugins.Preferences.set({ key: STORAGE.API_BASE, value: url }); } catch (_) {}
      }
      setConnectStatus('Connected! Loading app…', 'ok');
      // Force re-eval of API_BASE by reloading — cleanest, no half-state
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      setConnectStatus('Could not reach ' + url + ' — is the desktop bot running with 📡 Remote enabled?', 'err');
    }
  }
  function wireConnectWizard() {
    const input = document.getElementById('apiBaseInput');
    const btn   = document.getElementById('apiBaseConnect');
    if (input && btn) {
      btn.addEventListener('click', () => tryConnect(input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryConnect(input.value); });
    }
    // Primary path: license-key relay lookup. This is the new "permanent
    // link" flow — the PWA asks the central relay where the bot is, instead
    // of making the user copy-paste a trycloudflare URL.
    const relayInput = document.getElementById('relayLicenseKey');
    const relayBtn   = document.getElementById('relayLookupBtn');
    if (relayInput && relayBtn) {
      // Pre-fill in priority order:
      //   1. Login form field (user just typed a key there)
      //   2. Previously-saved key in localStorage (auto-restore on next visit)
      try {
        const loginField = document.getElementById('licenseKey');
        if (loginField && loginField.value && !relayInput.value) {
          relayInput.value = loginField.value;
        }
        if (!relayInput.value) {
          const saved = localStorage.getItem('sx.savedLicenseKey');
          if (saved) {
            relayInput.value = saved;
            // Also pre-fill the login field so subsequent auth works
            if (loginField) loginField.value = saved;
          }
        }
      } catch (_) {}
      // Keep the login field in sync if the user types here first
      relayInput.addEventListener('input', () => {
        try {
          const loginField = document.getElementById('licenseKey');
          if (loginField) loginField.value = relayInput.value;
        } catch (_) {}
      });
      relayBtn.addEventListener('click', () => lookupByLicenseKey(relayInput.value));
      relayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupByLicenseKey(relayInput.value); });
      // Auto-attempt: if we have a saved key and the PWA is on a public host
      // with no API base, automatically try the relay lookup. This is the
      // "permanent link" promise — the user reopens the PWA and it just
      // works, no button click needed.
      try {
        const saved = localStorage.getItem('sx.savedLicenseKey');
        const isPublic = isNative || /sultrixtrade\.com|github\.io/.test(location.host);
        if (saved && isPublic && !API_BASE) {
          setTimeout(() => lookupByLicenseKey(saved), 600);
        }
      } catch (_) {}
    }
  }

  // ── Relay lookup — primary connect path ───────────
  // The desktop bot pushes its current trycloudflare URL to the central
  // relay Worker every 60 seconds (KV TTL 1h, stale check 5min). The PWA
  // asks the relay "where is license key X right now?" and gets back a
  // live tunnel URL. The user only ever needs to remember their license
  // key — never a URL.
  const RELAY_URL = 'https://sultrix-relay.muhd-faisal-work.workers.dev';

  // An address that comes from the relay (not typed by the user) is only
  // trusted when it is https and on a Cloudflare quick-tunnel / Sultrix host.
  // The app later sends the licence key to this address, so a wrong relay
  // answer must never point it somewhere else.
  function isTrustedTunnel(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:' || u.username || u.password) return false;
      const h = u.hostname.toLowerCase();
      return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(trycloudflare\.com|sultrixtrade\.com)$/.test(h);
    } catch (_) { return false; }
  }

  // Save a new bot address and optionally reload. Does nothing if the address is not
  // trusted. Returns true when the address was saved.
  function saveApiBase(url, shouldReload = false) {
    if (!isTrustedTunnel(String(url || '').trim())) return false;
    // origin only: drops any path, query, fragment or port from the relay answer
    const clean = new URL(String(url).trim()).origin;
    try { localStorage.setItem(STORAGE.API_BASE, clean); } catch (_) { return false; }
    rememberEndpoint(clean);
    API_BASE = clean;
    if (isNative && CapPlugins.Preferences) {
      try { CapPlugins.Preferences.set({ key: STORAGE.API_BASE, value: clean }); } catch (_) {}
    }
    const baseEl = document.getElementById('apiBase');
    if (baseEl) baseEl.textContent = clean || '(same-origin)';
    if (shouldReload) {
      setTimeout(() => location.reload(), 300);
    }
    return true;
  }

  // Reload-loop guard: at most one automatic address switch per 60 seconds
  // per browser tab.
  function mayAutoReconnect() {
    try {
      const last = +(sessionStorage.getItem('sx.autoReconnectAt') || 0);
      if (Date.now() - last < 60000) return false;
      sessionStorage.setItem('sx.autoReconnectAt', String(Date.now()));
    } catch (_) { return false; }
    return true;
  }

  // Ask the relay for the current bot address; returns the address or ''.
  async function relayAddressFor(key) {
    try {
      const rr = await fetchWithTimeout(RELAY_URL + '/api/bot/lookup?license_key=' + encodeURIComponent(key), {
        method: 'GET', mode: 'cors', headers: { 'Accept': 'application/json' },
      }, 8000);
      const rd = await rr.json().catch(() => ({}));
      if (rr.ok && rd.ok && rd.tunnel_url) return String(rd.tunnel_url).replace(/\/$/, '');
    } catch (_) { /* relay unreachable or timed out */ }
    return '';
  }

  async function lookupByLicenseKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) { setConnectStatus('Enter your license key first', 'err'); return; }
    if (key.length < 6) { setConnectStatus('License key looks too short', 'err'); return; }
    setConnectStatus('Asking central relay where your bot is…', 'info');
    try {
      const r = await fetchWithTimeout(RELAY_URL + '/api/bot/lookup?license_key=' + encodeURIComponent(key), {
        method: 'GET',
        mode: 'cors',
        headers: { 'Accept': 'application/json' },
      }, 8000);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        if (r.status === 404) {
          setConnectStatus('No bot found for that key. Is the desktop app running with 📡 Remote enabled?', 'err');
        } else {
          setConnectStatus('Relay lookup failed: ' + (data.error || r.status), 'err');
        }
        return;
      }
      const tunnelUrl = (data.tunnel_url || '').replace(/\/$/, '');
      if (!tunnelUrl) { setConnectStatus('Relay returned no URL', 'err'); return; }
      if (!isTrustedTunnel(tunnelUrl)) { setConnectStatus('Relay returned an address that is not a Sultrix tunnel — not connecting.', 'err'); return; }
      // Also save the key so the PWA can re-lookup next time without the
      // user re-entering it across app restarts.
      persistSavedLicenseKey(key);
      const origin = new URL(tunnelUrl).origin;
      setConnectStatus('Found your bot at ' + origin + ' — connecting…', 'ok');
      // Now treat the discovered URL as the api_base and run the normal
      // connect probe (validates /api/pwa/status before persisting).
      tryConnect(origin);
    } catch (e) {
      setConnectStatus('Could not reach the relay. Check your network and try again.', 'err');
    }
  }

  // ── Login / auth ─────────────────────────────────
  async function login(licenseKey) {
    $('#loginBtn').disabled = true; $('#loginErr').textContent = '';
    const isPublic = isNative || /sultrixtrade\.com|github\.io/.test(location.host);
    // ── Public host with no bot URL + license key provided: do the
    //    central-relay lookup FIRST so the user never sees "No bot
    //    connected" when they hit "Sign in with license". ─────────
    if (isPublic && !API_BASE && licenseKey && licenseKey.length >= 6) {
      try {
        setConnectStatus('Looking up your bot via central relay…', 'info');
        const rr = await fetchWithTimeout(RELAY_URL + '/api/bot/lookup?license_key=' + encodeURIComponent(licenseKey), {
          method: 'GET', mode: 'cors',
          headers: { 'Accept': 'application/json' },
        }, 8000);
        const rd = await rr.json().catch(() => ({}));
        if (rr.ok && rd.ok && rd.tunnel_url) {
          const tunnelUrl = String(rd.tunnel_url).replace(/\/$/, '');
          persistSavedLicenseKey(licenseKey);
          // saveApiBase reloads, so the rest of login() won't run on
          // this path — the page will reload and the user will be
          // authenticated against the discovered bot. An address that is
          // not a trusted tunnel is ignored and falls through to the wizard.
          if (saveApiBase(tunnelUrl, true)) {
            setConnectStatus('Found your bot at ' + tunnelUrl + ' — connecting…', 'ok');
            return;
          }
        }
        // Relay said no — fall through to the wizard so the user can
        // see the "No bot found" hint + paste a URL manually.
      } catch (_) { /* network blip — fall through */ }
    }
    // On a public host with no bot connected, show the connect wizard
    // (instead of the old "this is a preview" hint) so the user can paste
    // their tunnel URL right here. The wizard persists the URL in
    // localStorage and reloads, so subsequent logins don't re-show it.
    showConnectWizard();
    try {
      const r = await api('/api/pwa/auth', { method: 'POST', body: JSON.stringify({ license_key: licenseKey || '' }) });
      state.session = r.session_token;
      state.plan = r.plan || r.tier || 'free';
      state.isTrial = !!r.is_trial;
      state.isDeveloper = !!r.is_developer;
      state.trialDaysLeft = r.trial_days_left;
      state.readOnly = !!r.read_only;
      // Persist the license key and token so they survive app restarts
      if (licenseKey && licenseKey.length >= 6) {
        persistSavedLicenseKey(licenseKey);
        const fingerprint = await fingerprintLicense(licenseKey);
        try { localStorage.setItem(STORAGE.LICENSE_HASH, fingerprint); } catch (_) {}
      } else {
        try { localStorage.removeItem(STORAGE.LICENSE_HASH); } catch (_) {}
      }
      persistSessionToken(r.session_token);
      // Schedule push subscription (only for paid tiers)
      if (!state.readOnly) {
        await ensurePushSubscription();
      }
      triggerHaptic('success');
      onLogin();
    } catch (e) {
      triggerHaptic('error');
      let msg;
      // Public host with no backend: the PWA can't reach a dashboard. Show
      // the connect wizard for ANY non-success status — all of those mean
      // "no live bot reachable" when the PWA is hosted on a static-only host.
      const isNoBackend = e.message === 'network_unreachable' || e.message === 'request_timeout' || e.status === 0;
      const isMethodNotAllowed = e.status === 405;
      const isAuthMissing = e.status === 401 || e.status === 403;
      const isServerError = e.status >= 500;
      // Saved address is stale (tunnel address changes at every desktop
      // restart): ask the relay for the current one once, then switch.
      if (isPublic && API_BASE && (isNoBackend || isServerError) && licenseKey && licenseKey.length >= 6) {
        const fresh = await relayAddressFor(licenseKey);
        if (fresh && fresh !== API_BASE && isTrustedTunnel(fresh) && mayAutoReconnect()) {
          persistSavedLicenseKey(licenseKey);
          if (saveApiBase(fresh, true)) {
            $('#loginErr').textContent = 'Your bot moved to a new address — reconnecting…';
            return;
          }
        }
      }
      if (isPublic && (isNoBackend || isMethodNotAllowed || isAuthMissing || isServerError)) {
        // Force only when the saved address does not answer; a reachable bot
        // with a wrong key keeps its normal login form.
        showConnectWizard(isNoBackend || isServerError);
        // Scroll the connect wizard into view so the user immediately
        // sees it instead of just a small error text.
        setTimeout(() => {
          const wiz = document.getElementById('connectWizard');
          if (wiz) wiz.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
        if (isNoBackend) {
          msg = '👇 No bot connected. Paste your desktop bot URL below to get started.';
        } else if (isMethodNotAllowed || isAuthMissing) {
          msg = '👇 Bot reached but login failed — check that the desktop bot is running the latest version, then enter its URL below.';
        } else {
          msg = '👇 Bot is unreachable. Check that the desktop bot is running and 📡 Remote is enabled, then enter its URL below.';
        }
        const errEl = document.getElementById('loginErr');
        if (errEl) {
          errEl.style.color = '#00E5C3';
          errEl.style.background = 'rgba(0,229,195,0.08)';
          errEl.style.padding = '10px 12px';
          errEl.style.borderRadius = '6px';
          errEl.style.border = '1px solid #00E5C3';
        }
      } else {
        msg = (e.body && (e.body.error || e.body.detail)) || e.message || 'Login failed';
      }
      $('#loginErr').textContent = msg;
    } finally {
      $('#loginBtn').disabled = false;
    }
  }
  async function fingerprintLicense(key) {
    const enc = new TextEncoder().encode(key);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function logout() {
    try { api('/api/pwa/session/logout', { method: 'POST', timeout: 5000 }); } catch (_) {}
    state.session = null;
    persistSessionToken(null);
    try { localStorage.removeItem('sx.savedLicenseKey'); } catch (_) {}
    if (isNative && CapPlugins.Preferences) {
      try { CapPlugins.Preferences.remove({ key: 'sx.savedLicenseKey' }); } catch (_) {}
    }
    try { navigator.serviceWorker && navigator.serviceWorker.ready.then((r) => r.getSubscription()).then((s) => s && s.unsubscribe()); } catch (_) {}
  
    // Drop stored credentials
    try { STORAGE.LICENSE_HASH && localStorage.removeItem(STORAGE.LICENSE_HASH); } catch (_) {}
    try { 
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({type: 'logout'});
      }
    } catch (_) {}
    try {
      if (typeof caches !== 'undefined') {
        caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
      }
    } catch (_) {}
  
    showLogin();
  }

  // Re-authenticate against a newly discovered tunnel using the saved key without full reload
  async function reauthWithSavedKey(savedKey) {
    if (!savedKey) throw new Error('no_saved_key');
    const r = await api('/api/pwa/auth', {
      method: 'POST',
      body: JSON.stringify({ license_key: savedKey }),
      timeout: 10000,
    });
    state.session = r.session_token;
    state.plan = r.plan || r.tier || 'free';
    state.isTrial = !!r.is_trial;
    state.isDeveloper = !!r.is_developer;
    state.trialDaysLeft = r.trial_days_left;
    state.readOnly = !!r.read_only;
    persistSessionToken(r.session_token);
    persistSavedLicenseKey(savedKey);
    return r;
  }

  function onLogin() {
    $('#login').hidden = true; $('#app').hidden = false;
    setActiveTab(getRouteFromURL() || 'home');
    refreshAll();
    startPolling();
  }
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false;
    setActiveTab(null);
    stopPolling();
  }

  // ── Tabs / routing ───────────────────────────────
  function getRouteFromURL() {
    const r = new URLSearchParams(location.search).get('route');
    return r;
  }
  function setActiveTab(tab) {
    state.tab = tab;
    $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
    $$('.tab-content').forEach(s => s.classList.toggle('active', s.dataset.tab === tab));
    if (tab) {
      const url = new URL(location.href); url.searchParams.set('route', tab);
      history.replaceState(null, '', url);
    }
    triggerHaptic('light');
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (a) { e.preventDefault(); setActiveTab(a.dataset.tab); return; }
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); setActiveTab(j.dataset.jump); return; }
    const c = e.target.closest('[data-cmd]');
    if (c) {
      // "refresh" is a client-side data reload, not a bot command -- it was
      // being sent to /api/pwa/commands like every other data-cmd button,
      // which only recognizes status/pnl/positions/health/version/help and
      // returned a confusing "unknown_command" instead of refreshing anything.
      if (c.dataset.cmd === 'refresh') { refreshAll(); refreshSlow(); toast('Refreshed', 'ok'); return; }
      runCommand(c.dataset.cmd);
      return;
    }
    const f = e.target.closest('[data-filter]');
    if (f) { state.posFilter = f.dataset.filter;
      $$('[data-filter]').forEach(b => b.classList.toggle('active', b === f));
      renderPositions(); renderPositions2(); return; }
    const a2 = e.target.closest('[data-asev]');
    if (a2) { state.alertFilter = a2.dataset.asev;
      $$('[data-asev]').forEach(b => b.classList.toggle('active', b === a2));
      renderAlerts(); return; }
  });

  // ── Fetchers ────────────────────────────────────
  async function fetchStatus()      { return api('/api/pwa/status'); }
  async function fetchPnl()         { return api('/api/pwa/pnl'); }
  async function fetchPositions()  { return api('/api/pwa/positions'); }
  async function fetchAgents()     { return api('/api/pwa/agents'); }
  async function fetchAlerts()     { return api('/api/pwa/alerts'); }
  async function fetchRisk()       { return api('/api/pwa/risk'); }
  async function fetchMarkets()    { return api('/api/pwa/markets'); }
  async function fetchAccount()    { return api('/api/pwa/account'); }

  // ── Chat (OpenRouter) ─────────────────────
  const _chatHistory = [];   // local conversation history for the chat tab
  function _appendChat(role, text) {
    const log = $('#chatLog');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'chat-msg chat-' + role;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  async function sendChat() {
    const input = $('#chatInput');
    const send = $('#chatSend');
    if (!input || !send) return;
    const msg = (input.value || '').trim();
    if (!msg) return;
    input.value = '';
    send.disabled = true;
    const status = $('#chatStatus');
    if (status) status.textContent = '…';
    _appendChat('user', msg);
    _chatHistory.push({ role: 'user', content: msg });
    if (_chatHistory.length > 12) _chatHistory.splice(0, _chatHistory.length - 12);
    try {
      const r = await api('/api/pwa/chat', { method: 'POST', body: JSON.stringify({ message: msg, history: _chatHistory }) });
      _appendChat('assistant', r.reply || '(no reply)');
      _chatHistory.push({ role: 'assistant', content: r.reply || '' });
      if (r.usage) {
        const meta = $('#chatMeta');
        if (meta) meta.textContent = 'Model: ' + (r.model || '?') + ' · tokens: ' + (r.usage.total_tokens || 0) + ' · tier: ' + (r.tier || '?');
      }
      if (status) status.textContent = '●';
    } catch (e) {
      const errMsg = (e.body && (e.body.message || e.body.error)) || e.message || 'Chat failed';
      _appendChat('assistant', '[error: ' + errMsg + ']');
      if (status) status.textContent = '✕';
    } finally {
      send.disabled = false;
      input.focus();
    }
  }
  async function fetchNotifPrefs() { return api('/api/pwa/notifications/prefs'); }
  async function postNotifPrefs(p) { return api('/api/pwa/notifications/prefs', { method: 'POST', body: JSON.stringify(p) }); }

  // ── Render ─────────────────────────────────────
  function renderAll(d) {
    if (!d) return;
    renderKpis(d.pnl);
    renderMarkets(d.markets);
    renderPositions();
    renderPositions2();
    renderAgents(d.agents);
    renderBotState(d.status);
    renderRisk(d.risk);
    renderAlerts();
    renderAccount();
  }

  function renderKpis(p) {
    if (!p) return;
    const c = (v) => v == null ? '' : (v >= 0 ? 'green' : 'red');
    const k = (id, v, cls) => { const el = $(id); if (el) { el.textContent = fmt.money(v); el.className = 'val ' + (cls || c(v)); } };
    k('#kpiTotalPnl', p.total_pnl);
    k('#kpiDailyPnl', p.daily_pnl);
    k('#kpiUnrealized', p.unrealized_pnl);
    k('#kpiRealized', p.realized_pnl);
  }

  function renderMarkets(m) {
    if (!m) return;
    [['crypto','#m-crypto'], ['forex','#m-forex'], ['stocks','#m-stocks']].forEach(([k, sel]) => {
      const el = $(sel); if (!el) return;
      const data = m[k] || {};
      el.classList.toggle('on', data.active);
      el.classList.toggle('off', !data.active);
      el.querySelector('.status').textContent = data.active ? 'LIVE' : 'OFF';
      el.querySelector('.pnl').textContent = data.pnl == null ? '—' : fmt.money(data.pnl);
      el.title = 'Realized today' + (data.unrealized != null ? ' · open ' + fmt.money(data.unrealized) : '');
      el.querySelector('.pnl').className = 'pnl ' + (data.pnl >= 0 ? 'green' : 'red');
    });
  }

  function filterPositions(all) {
    if (state.posFilter === 'all') return all;
    return all.filter(p => (p.market || '').toLowerCase() === state.posFilter);
  }
  function renderPositions() {
    const list = filterPositions(state.pos || []);
    const c = $('#posCount'); if (c) c.textContent = list.length;
    const target = $('#posList');
    if (!target) return;
    if (!list.length) { target.innerHTML = '<div class="empty">No open positions</div>'; return; }
    target.innerHTML = list.map(p => posRow(p)).join('');
  }
  function renderPositions2() {
    const list = filterPositions(state.pos || []);
    const c = $('#posCount2'); if (c) c.textContent = list.length;
    const target = $('#posList2');
    if (!target) return;
    if (!list.length) { target.innerHTML = '<div class="empty">No open positions in this category</div>'; return; }
    target.innerHTML = list.map(p => posRow(p)).join('');
  }
  function posRow(p) {
    const side = (p.side || '').toLowerCase();
    return `<div class="pos">
      <div class="left">
        <span class="side-tag ${side}">${fmt.side(side)}</span>
        <div><div class="sym">${escapeHtml(p.symbol)}</div><div class="meta">${escapeHtml(p.market || '')} · qty ${fmt.num(p.quantity)}</div></div>
      </div>
      <div class="right">
        <div class="pnl ${p.unrealized_pnl >= 0 ? 'green' : 'red'}">${fmt.money(p.unrealized_pnl)}</div>
        <div class="meta">${fmt.pct(p.unrealized_pct)}</div>
      </div>
    </div>`;
  }

  function renderAgents(agents) {
    if (!agents) return;
    const list = Object.entries(agents).map(([name, a]) => ({ name, ...a }));
    const c = $('#agentCount'); if (c) c.textContent = list.length;
    const status = $('#agentStatus');
    if (status) {
      const ok = list.filter(a => (a.state || '').toUpperCase() === 'RUNNING').length;
      status.textContent = ok + ' / ' + list.length + ' running';
    }
    const full = $('#agentListFull');
    const preview = $('#agentList');
    const html = list.map(agentRow).join('');
    if (full) full.innerHTML = html;
    if (preview) preview.innerHTML = html;
  }
  function agentRow(a) {
    const s = (a.state || 'UNKNOWN').toUpperCase();
    const klass = s === 'RUNNING' ? 'ok' : (s === 'STARTING' ? 'warn' : 'bad');
    const age = a.last_heartbeat ? fmt.rel(a.last_heartbeat) : '—';
    return `<div class="agent">
      <div class="info"><span class="dot ${klass}"></span><div><div class="name">${escapeHtml(a.name)}</div><div class="hb">${age}</div></div></div>
      <span class="tag ${klass}">${escapeHtml(s)}</span>
    </div>`;
  }

  function renderBotState(s) {
    if (!s) return;
    const st = $('#botState'); if (st) st.textContent = s.bot_status || '—';
    setConn(s.bot_status === 'RUNNING' ? 'live' : 'updating',
            s.bot_status === 'RUNNING' ? null : 'Bot is ' + (s.bot_status || 'updating'));
    const dot = $('#statusDot');
    if (dot) {
      dot.classList.remove('idle', 'error');
      if (s.bot_status !== 'RUNNING') dot.classList.add(s.bot_status === 'ERROR' ? 'error' : 'idle');
    }
    const u = $('#botUptime'); if (u) u.textContent = s.uptime_h != null ? s.uptime_h.toFixed(1) + 'h' : '—';
    const f = $('#botFills'); if (f) f.textContent = fmt.num(s.total_fills);
    const c = $('#botCycles'); if (c) c.textContent = fmt.num(s.total_cycles);
    const r = $('#botRegime'); if (r) r.textContent = s.regime || '—';
    const v = $('#verTag'); if (v) v.textContent = 'v' + (s.version || BUILD);
    const tb = $('#tierBadge');
    if (tb) {
      tb.hidden = false;
      // /api/pwa/auth + /api/pwa/account report `plan` as only
      // 'basic'|'pro'|'ultra' (license_manager.Plan) -- trial/developer
      // status comes back as separate boolean fields (is_trial/is_developer),
      // never as a `plan` value. state.plan could therefore never equal
      // 'developer' or 'trial' here, so those branches (and the matching
      // .tier-developer/.tier-trial CSS classes, both defined in
      // styles.css) never fired. Check the booleans instead.
      const tier = state.isDeveloper ? 'developer' : state.isTrial ? 'trial' : (state.plan || 'free');
      tb.className = 'tier-badge tier-' + tier;
      tb.textContent = state.isDeveloper ? 'DEV'
                     : state.isTrial ? 'TRIAL'
                     : state.plan === 'ultra' ? 'ULTRA'
                     : state.plan === 'free' ? 'FREE'
                     : (state.plan || '?').toUpperCase();
    }
  }

  function renderRisk(r) {
    if (!r) return;
    const t = $('#riskThreat'); if (t) t.textContent = r.threat_level || '—';
    const tv = $('#riskThreatVal'); if (tv) { tv.textContent = r.threat_level || '—'; tv.className = 'val ' + (r.threat_level === 'CLEAR' ? 'green' : (r.threat_level === 'HIGH' ? 'red' : '')); }
    const h = $('#riskHealth'); if (h) h.textContent = (r.health_score != null ? r.health_score + '%' : '—');
    const i = $('#riskIntegrity'); if (i) i.textContent = r.integrity_status || '—';
    const ru = $('#riskRules'); if (ru) ru.textContent = fmt.num(r.active_rules);
    const exp = $('#exposures');
    if (exp && r.exposures) {
      exp.innerHTML = Object.entries(r.exposures).map(([k, v]) =>
        `<div class="row" style="justify-content:space-between;padding:6px 0"><span>${escapeHtml(k)}</span><span class="${v >= 0 ? '' : 'red'}" style="font-variant-numeric:tabular-nums">${fmt.money(v)}</span></div>`
      ).join('') || '<div class="empty muted">No exposure data</div>';
    }
  }

  function renderAlerts() {
    const list = (state.alerts || []).filter(a => state.alertFilter === 'all' || (a.severity || '').toUpperCase() === state.alertFilter);
    const c = $('#alertCount'); if (c) c.textContent = list.length;
    const target = $('#alertList');
    if (target) target.innerHTML = list.length ? list.map(alertRow).join('') : '<div class="empty">No alerts</div>';
    const preview = $('#alertsPreview');
    if (preview) preview.innerHTML = (state.alerts || []).slice(0, 5).map(alertRow).join('') || '<div class="empty">No alerts</div>';
    const badge = $('#alertsBadge');
    const unseen = (state.alerts || []).filter(a => !a.read).length;
    if (badge) badge.hidden = unseen === 0;
  }
  function alertRow(a) {
    const sev = fmt.severity(a.severity);
    return `<div class="alert ${a.read ? '' : 'unread'}" data-aid="${a.id}">
      <div class="sev ${sev}"></div>
      <div class="body">
        <div class="title">${escapeHtml(a.title || a.event_type || a.type || 'Alert')}</div>
        ${a.detail ? `<div class="meta">${escapeHtml(String(a.detail).slice(0, 160))}</div>` : ''}
        <div class="meta">${escapeHtml(a.market || '')} ${a.symbol ? '· ' + escapeHtml(a.symbol) : ''} · ${fmt.rel(a.ts)} · ${escapeHtml(a.severity || '')}</div>
      </div>
    </div>`;
  }
  async function markAlertRead(id) {
    try { await api('/api/pwa/alerts/' + id + '/read', { method: 'POST' }); } catch (_) {}
    const a = (state.alerts || []).find(x => x.id === id);
    if (a) a.read = true;
    renderAlerts();
  }
  async function markAllRead() {
    try { await api('/api/pwa/alerts/read-all', { method: 'POST' }); } catch (_) {}
    (state.alerts || []).forEach(a => a.read = true);
    renderAlerts();
    toast('All alerts marked read', 'ok');
  }

  // ── Notification preferences ───────────────────
  const DEFAULT_NOTIF_PREFS = {
    trade_opened: true, trade_closed: true,
    take_profit: true, stop_loss: true,
    risk_warning: true, critical_risk: true,
    agent_failure: true, system_failure: true,
    market_alert: false, pnl_alert: true,
    license_warning: true, system_notification: false,
    push_enabled: true,
  };
  const NOTIF_CATEGORIES = [
    { k: 'trade_opened',       label: 'Trade opened' },
    { k: 'trade_closed',       label: 'Trade closed' },
    { k: 'take_profit',        label: 'Take-profit' },
    { k: 'stop_loss',          label: 'Stop-loss' },
    { k: 'risk_warning',       label: 'Risk warning' },
    { k: 'critical_risk',      label: 'Critical risk' },
    { k: 'agent_failure',      label: 'Agent failure' },
    { k: 'system_failure',     label: 'System failure' },
    { k: 'market_alert',       label: 'Market alert' },
    { k: 'pnl_alert',          label: 'PnL alert' },
    { k: 'license_warning',    label: 'License / trial warning' },
    { k: 'system_notification',label: 'System notification' },
  ];
  function renderNotifPrefs() {
    const target = $('#notifPrefs');
    const status = $('#notifStatus');
    if (!target) return;
    const p = state.notifPrefs || DEFAULT_NOTIF_PREFS;
    if (status) status.textContent = (p.push_enabled !== false ? 'On' : 'Off') + (state.pushSubscribed ? ' · subscribed' : ' · browser not subscribed');
    const rows = NOTIF_CATEGORIES.map(c =>
      `<div class="row" style="justify-content:space-between;padding:6px 0">
        <span>${escapeHtml(c.label)}</span>
        <button class="cmd-btn ${p[c.k] ? 'primary' : ''}" data-pref="${c.k}" style="width:auto;padding:6px 12px">${p[c.k] ? 'On' : 'Off'}</button>
      </div>`
    ).join('');
    target.innerHTML = rows +
      `<button class="cmd-btn" id="pushEnBtn" style="margin-top:10px">${state.pushSubscribed ? 'Push notifications enabled ✓' : 'Enable push notifications'}</button>`;
  }
  async function togglePref(k) {
    const p = state.notifPrefs || { ...DEFAULT_NOTIF_PREFS };
    p[k] = !p[k];
    state.notifPrefs = p;
    try { await postNotifPrefs(p); } catch (_) {}
    renderNotifPrefs();
  }
  async function enablePush() {
    if (state.pushSubscribed) { toast('Already subscribed', 'ok'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const pk = await api('/api/pwa/notifications/public-key');
      if (!pk || !pk.key) { toast('Server has no VAPID key', 'error'); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pk.key });
      await api('/api/pwa/notifications/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
      state.pushSubscribed = true;
      toast('Push notifications enabled', 'ok');
      renderNotifPrefs();
    } catch (e) {
      toast('Push failed: ' + (e.message || 'permission denied'), 'error');
    }
  }

  function renderAccount() {
    const plan = $('#acctPlan'); if (plan) plan.textContent = state.plan || 'unknown';
    const trial = $('#acctTrial'); if (trial) trial.textContent = state.trialDaysLeft == null ? '—' : (state.trialDaysLeft + ' days left');
    const sess = $('#acctSession'); if (sess) sess.textContent = state.session ? state.session.slice(0, 12) + '…' : '—';
  }

  // ── Charts (TradingView embed) ───────────────────
  const TV_SYMBOLS = {
    crypto: ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'],
    forex:  ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','XAUUSD'],
    stocks: ['SPY','QQQ','AAPL','MSFT','NVDA','TSLA','AMZN','META','AMD'],
  };
  // The fixed list plus every instrument the bot holds right now (crypto coins, forex pairs, stocks, tokenized stocks shown under their ticker).
  function chartSymbols(m) {
    const list = (TV_SYMBOLS[m] || []).slice();
    (state.pos || []).forEach(p => {
      if ((p.market || '').toLowerCase() !== m) return;
      const raw = String(p.symbol || '');
      const tok = /^([A-Z]{1,5})B\/USDT$/.exec(raw);
      const s = m === 'stocks' && tok ? tok[1] : raw.replace('/', '');
      if (/^[A-Z0-9]{2,12}$/.test(s) && !list.includes(s) && list.length < 40) list.push(s);
    });
    return list;
  }
  function updateChartSymbolSelect() {
    const m = state.chart.market;
    const sel = $('#chartSymbol');
    if (!sel) return;
    sel.innerHTML = chartSymbols(m).map(s => `<option value="${s}">${s}</option>`).join('');
    sel.value = state.chart.symbol;
  }
  function updateChart() {
    const { market, symbol, tf } = state.chart;
    updateChartSymbolSelect();
    const tfMap = { '1':'1','5':'5','15':'15','60':'60','240':'240','D':'D','W':'W' };
    const tvInterval = tfMap[tf] || '60';
    const tvSymbol = market === 'crypto' ? 'BINANCE:' + symbol : market === 'forex' ? 'OANDA:' + symbol : symbol;
    const url = `https://s.tradingview.com/widgetembed/?frameElementId=tvFrame&symbol=${encodeURIComponent(tvSymbol)}&interval=${tvInterval}&hidesidetoolbar=1&symboledit=1&saveimage=0&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC`;
    const f = $('#tvFrame'); if (f) f.src = url;
    const info = $('#chartInfo'); if (info) info.textContent = symbol + ' · ' + tf;
  }

  // ── Commands ────────────────────────────────────
  async function runCommand(name) {
    if (/halt|stop|emergency/i.test(name)) triggerHaptic('warning');
    else triggerHaptic('light');
    const out = $('#cmdOutput');
    if (out) out.textContent = '> ' + name + '\n...';
    try {
      const r = await api('/api/pwa/commands', { method: 'POST', body: JSON.stringify({ command: name }) });
      if (out) out.textContent = (r && r.text) || JSON.stringify(r, null, 2);
      toast('Command executed', 'ok');
      triggerHaptic('success');
      refreshAll();
    } catch (e) {
      if (out) out.textContent = '> ' + name + '\nERROR: ' + ((e.body && e.body.error) || e.message);
      toast('Command failed', 'error');
      triggerHaptic('error');
    }
  }

  // ── Polling & Retry ─────────────────────────────
  let pollTimer = null, slowTimer = null;
  let retryAttempt = 0;
  let refreshInFlight = false;

  function clearPollTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNextRefresh(delayMs) {
    clearPollTimer();
    pollTimer = setTimeout(refreshAll, delayMs);
  }

  function startPolling() {
    stopPolling();
    scheduleNextRefresh(POLL_MS);
    slowTimer = setInterval(refreshSlow, SLOW_POLL_MS);
  }

  function stopPolling() {
    clearPollTimer();
    if (slowTimer) clearInterval(slowTimer);
    slowTimer = null;
    retryAttempt = 0;
  }

  async function refreshAll() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    clearPollTimer();
    try {
      setConn('updating', 'Updating…');
      const [status, pnl, positions, markets] = await Promise.all([fetchStatus(), fetchPnl(), fetchPositions(), fetchMarkets()]);
      state.pos = positions || [];
      state.markets = markets || {};
      renderKpis(pnl);
      renderMarkets(markets);
      renderPositions(); renderPositions2();
      renderBotState(status);
      setConn('live', null);
      state.lastFetch = Date.now();
      // Successful refresh: reset backoff and schedule next regular poll
      retryAttempt = 0;
      scheduleNextRefresh(POLL_MS);
    } catch (e) {
      if (e.status === 401) { logout(); return; }
      try {
        const savedKey = localStorage.getItem('sx.savedLicenseKey') || '';
        const hasSavedKey = Boolean(savedKey && savedKey.length >= 6);
        const errStatus = (e && typeof e.status !== 'undefined') ? e.status : 0;
        const errMsg = (e && e.message) ? e.message : '';

        // Query central relay when error is retryable and relay check is approved
        if (isRetryableError(errStatus, errMsg) && shouldCheckRelay(errStatus, API_BASE, hasSavedKey, errMsg)) {
          const fresh = await relayAddressFor(savedKey);
          if (fresh && fresh !== API_BASE && isTrustedTunnel(fresh) && mayAutoReconnect()) {
            try { localStorage.removeItem(STORAGE.TOKEN); } catch (_) {}
            if (saveApiBase(fresh)) {
              setConn('updating', 'Bot tunnel updated — reconnecting…');
              retryAttempt = 0;
              scheduleNextRefresh(500);
              return;
            }
          }
        }
      } catch (_) {}
      setConn('offline', 'Offline — showing cached data');
      // Failed refresh: exponential backoff with jitter and cap, never stops retrying
      retryAttempt++;
      const nextDelay = computeRetryDelay(retryAttempt);
      scheduleNextRefresh(nextDelay);
    } finally {
      refreshInFlight = false;
    }
  }
  async function refreshSlow() {
    try {
      const [agents, alerts, risk, account, prefs] = await Promise.all([fetchAgents(), fetchAlerts(), fetchRisk(), fetchAccount(), fetchNotifPrefs().catch(() => null)]);
      state.alerts = (alerts || []).map(a => ({ ...a, read: /READ_BY_PWA/.test(a.payload || '') }));
      state.risk = risk;
      state.plan = (account && account.plan) || state.plan;
      if (account) { state.isTrial = !!account.is_trial; state.isDeveloper = !!account.is_developer; }
      state.trialDaysLeft = (account && account.trial_days_left) || state.trialDaysLeft;
      if (prefs) state.notifPrefs = prefs;
      renderAgents(agents);
      renderRisk(risk);
      renderAlerts();
      renderAccount();
      renderNotifPrefs();
    } catch (e) {
      // Soft fail — slow poll is best-effort.
    }
  }

  // ── Push notifications ──────────────────────────
  async function ensurePushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub) { state.pushSubscribed = true; return; }
      const publicKey = await api('/api/pwa/notifications/public-key');
      if (!publicKey || !publicKey.key) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey.key });
      await api('/api/pwa/notifications/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
      state.pushSubscribed = true;
    } catch (e) { /* permission denied or not supported */ }
  }

  // ── Bootstrap ───────────────────────────────────
  function tryRestore() {
    try {
      const tok = localStorage.getItem(STORAGE.TOKEN);
      if (tok) { state.session = tok; onLogin(); return true; }
    } catch (_) {}
    return false;
  }

  function init() {
    initNativeBridge();
    document.getElementById('verTag').textContent = 'v' + BUILD;
    try {      // the page just reloaded itself because a new version arrived: say so
      if (Date.now() - Number(sessionStorage.getItem('sx.updReload') || 0) < 15000) setTimeout(() => toast('Updated to v' + BUILD, 'ok'), 600);
    } catch (_) {}
    document.getElementById('acctVer').textContent = 'v' + BUILD;
    // Show the public-host banner when the PWA is being served from
    // app.sultrixtrade.com or a github.io URL. Hidden on native mobile & localhost / tunnel.
    try {
      const isPublic = !isNative && /sultrixtrade\.com|github\.io/.test(location.host);
      const banner = document.getElementById('publicHostBanner');
      if (banner && isPublic && !API_BASE) banner.hidden = false;
    } catch (_) {}
    const baseEl = document.getElementById('apiBase');
    if (baseEl) baseEl.textContent = API_BASE || '(same-origin)';
    updateChartSymbolSelect();
    updateChart();

    // Wire the connect wizard (paste tunnel URL or pick a saved one)
    wireConnectWizard();
    showConnectWizard();

    // Restore session (or complete pending license login after tunnel discovery reload)
    if (!tryRestore()) {
      showLogin();
      try {
        const savedKey = localStorage.getItem('sx.savedLicenseKey');
        if (API_BASE && savedKey && savedKey.length >= 6) {
          const lf = document.getElementById('licenseKey');
          if (lf && !lf.value) lf.value = savedKey;
          setTimeout(() => login(savedKey), 150);
        }
      } catch (_) {}
    }

    // Events
    $('#loginBtn').addEventListener('click', () => login($('#licenseKey').value.trim()));
    $('#freeBtn').addEventListener('click', () => login(''));
    $('#licenseKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') login($('#licenseKey').value.trim()); });
    $('#logoutBtn').addEventListener('click', logout);
    const ci = $('#chatInput'), cs = $('#chatSend');
    if (ci && cs) {
      cs.addEventListener('click', sendChat);
      ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
    }
    $('#refreshBtn').addEventListener('click', refreshAll);
    $('#alertsBtn').addEventListener('click', () => setActiveTab('alerts'));
    $('#settingsBtn').addEventListener('click', () => setActiveTab('settings'));
    $('#clearCmd').addEventListener('click', () => { $('#cmdOutput').textContent = ''; });
    $('#markAllReadBtn') && $('#markAllReadBtn').addEventListener('click', markAllRead);
    $('#pushEnBtn') && $('#pushEnBtn').addEventListener('click', enablePush);
    document.addEventListener('click', (e) => {
      const m = e.target.closest('[data-pref]');
      if (m) togglePref(m.dataset.pref);
      const aid = e.target.closest('[data-aid]');
      if (aid && !e.target.closest('[data-asev]')) markAlertRead(parseInt(aid.dataset.aid, 10));
    });
    $('#chartMarket').addEventListener('change', (e) => { state.chart.market = e.target.value; state.chart.symbol = (TV_SYMBOLS[e.target.value] || [])[0]; updateChart(); });
    $('#chartSymbol').addEventListener('change', (e) => { state.chart.symbol = e.target.value; updateChart(); });
    $('#chartTf').addEventListener('change', (e) => { state.chart.tf = e.target.value; updateChart(); });

    // Online/offline banner
    window.addEventListener('online', () => { handleResumeOrNetworkChange('window-online'); });
    window.addEventListener('offline', () => setConn('offline', 'Offline — showing cached data'));

    // Hide native splash screen once UI is initialized
    if (isNative && CapPlugins.SplashScreen) {
      try { CapPlugins.SplashScreen.hide(); } catch (_) {}
    }

    // Service worker (browsers only, bypassed in native container)
    if (!isNative && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  // ---- Install helper -------------------------------------------------------
  // Chrome/Edge/Android fire beforeinstallprompt once, early; it must be captured at load time, not inside init().
  // iOS Safari never fires it, so it gets the manual Share-sheet steps. Other cases get the browser-menu hint.
  const INSTALL_HIDE_DAYS = 7;
  let deferredInstall = null;
  let installHandled = false;   // set once the browser prompt fired, was used, or the app got installed: the manual-steps hint must not appear after that
  const isStandalone = () => isNative || (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installDismissed = () => { try { return Date.now() - Number(localStorage.getItem('sultrix_install_hidden') || 0) < INSTALL_HIDE_DAYS * 864e5; } catch (_) { return false; } };
  function showInstallBar(text, withButton) {
    const bar = document.getElementById('installBar');
    if (!bar || isStandalone() || installDismissed()) return;
    document.getElementById('installText').textContent = text;
    document.getElementById('installBtn').hidden = !withButton;
    bar.hidden = false;
  }
  function hideInstallBar(remember) {
    const bar = document.getElementById('installBar');
    if (bar) bar.hidden = true;
    if (remember) { try { localStorage.setItem('sultrix_install_hidden', String(Date.now())); } catch (_) {} }
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    installHandled = true;
    showInstallBar('Install Sultrix on your phone for one-tap access.', true);
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; installHandled = true; hideInstallBar(false); });
  function initInstallBar() {
    const btn = document.getElementById('installBtn'), close = document.getElementById('installClose');
    if (btn) btn.addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (_) {}
      deferredInstall = null;
      hideInstallBar(false);
    });
    if (close) close.addEventListener('click', () => hideInstallBar(true));
    if (isStandalone()) return;
    if (deferredInstall) { showInstallBar('Install Sultrix on your phone for one-tap access.', true); return; }   // the event fired before this ran
    if (isIos()) {
      showInstallBar('To install: tap the Share button, then "Add to Home Screen".', false);
    } else {
      // No prompt event after a few seconds (already dismissed, unsupported browser, or private mode): tell the user where the option lives.
      setTimeout(() => { if (!installHandled) showInstallBar('To install: open the browser menu (⋮) and tap "Install app" or "Add to Home screen".', false); }, 4000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInstallBar); else initInstallBar();
  // ---- Auto-update ----------------------------------------------------------------------------------------------
  // A new release = a new sw.js (its VERSION changes every time). The browser fetches it, the worker installs, takes over at once (skipWaiting +
  // clients.claim in sw.js) and the page then reloads itself ONCE, when that cannot interrupt the user: the page is hidden, or nothing is being
  // typed. Updates are looked for at launch, whenever the app comes back to the front, when the phone gets its connection back, and every 30
  // minutes, plus a direct check of manifest.json for browsers that are slow to refresh a worker (iOS home-screen apps).
  const UPDATE_CHECK_MS = 30 * 60 * 1000;
  let hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);   // false on the very first visit: nothing to replace
  let swReg = null;
  let updatePending = false;
  let lastReloadAt = 0;                                      // in-memory twin of the sessionStorage lock, for browsers where storage throws
  let inflight = 0;                                          // user actions (not GET) still travelling to the server
  let deferTimer = null;
  let deferSince = 0;
  const DEFER_MAX_MS = 30000;                                // a hung request must not block updates for ever
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') return _fetch(input, init);
    inflight++;
    return _fetch(input, init).finally(() => { inflight = Math.max(0, inflight - 1); });
  };
  const typingNow = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && String(a.value || '') !== ''; };
  function reloadForUpdate() {
    const now = Date.now();
    try {
      const last = Math.max(lastReloadAt, Number(sessionStorage.getItem('sx.updReload') || 0));
      if (now - last < 60000) { updatePending = false; return; }   // never a reload loop
      sessionStorage.setItem('sx.updReload', String(now));
    } catch (_) {
      if (now - lastReloadAt < 60000) { updatePending = false; return; }
    }
    lastReloadAt = now;
    updatePending = false;
    location.reload();
  }
  function applyUpdateWhenSafe() {
    if (inflight > 0) {                                      // a chat message or bot action is still being sent: wait for it (at most 30 s)
      deferSince = deferSince || Date.now();
      if (Date.now() - deferSince < DEFER_MAX_MS) {
        updatePending = true;
        if (!deferTimer) deferTimer = setTimeout(() => { deferTimer = null; if (updatePending) applyUpdateWhenSafe(); }, 2000);
        return;
      }
    }
    deferSince = 0;
    if (!typingNow()) reloadForUpdate();                     // never over a half-typed message, also not while the app is in the background
    else updatePending = true;                               // retried as soon as the user leaves the field
  }
  async function versionCheck() {
    try {
      const r = await fetch('/manifest.json?v=' + Date.now(), { cache: 'no-store' });
      const m = await r.json();
      if (m && m.version && m.version !== BUILD && swReg) swReg.update();
    } catch (_) {}
  }
  function checkForUpdate() {
    try { if (swReg) swReg.update(); } catch (_) {}
    versionCheck();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) applyUpdateWhenSafe();
      else hadController = true;                             // the first worker taking over a first visit is not an update; every later change is
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (updatePending) applyUpdateWhenSafe(); } else checkForUpdate();
    });
    document.addEventListener('focusout', () => {
      if (updatePending) setTimeout(() => { if (updatePending) applyUpdateWhenSafe(); }, 500);
    });
    window.addEventListener('online', checkForUpdate);
    setInterval(checkForUpdate, UPDATE_CHECK_MS);
  }
  window.__sxUpdate = { applyUpdateWhenSafe, reloadForUpdate, checkForUpdate };       // used by the self-test and by support to force a check

  // The worker must register even if init() stops early; registering twice is harmless.
  const registerWorker = () => {
    if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((r) => { swReg = r; checkForUpdate(); }).catch(() => {});
  };
  if (document.readyState === 'complete') registerWorker(); else window.addEventListener('load', registerWorker);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
