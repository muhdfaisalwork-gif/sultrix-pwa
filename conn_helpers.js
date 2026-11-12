/* Sultrix PWA — Connection & Retry Helpers
 *
 * Pure, unit-testable connection and backoff logic.
 * Compatible with Node.js (CommonJS export) and browser (attaches to window/globalThis).
 */
(function (root, factory) {
  'use strict';
  const exports = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = exports;
  }
  if (typeof window !== 'undefined') {
    Object.assign(window, exports);
  } else if (typeof globalThis !== 'undefined') {
    Object.assign(globalThis, exports);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Exponential backoff with ±20% jitter and a cap. Never tight-loops, never gives up.
   * @param {number} attempt Attempt index (0-based or 1-based)
   * @param {number} [baseMs=1500] Base delay in ms
   * @param {number} [maxMs=30000] Maximum delay cap in ms
   * @param {Function} [randomFn=Math.random] RNG returning [0, 1)
   * @returns {number} Delay in ms
   */
  function computeRetryDelay(attempt, baseMs = 1500, maxMs = 30000, randomFn = Math.random) {
    const n = Math.max(0, Math.floor(Number(attempt) || 0));
    const base = Math.max(500, Number(baseMs) || 1500);
    const max = Math.max(base, Number(maxMs) || 30000);
    const exp = Math.min(max, base * Math.pow(2, Math.min(n, 10)));
    const rnd = typeof randomFn === 'function' ? randomFn() : Math.random();
    const jitterFactor = 0.2;
    const jitter = (rnd * 2 - 1) * jitterFactor * exp;
    return Math.max(500, Math.min(max, Math.round(exp + jitter)));
  }

  /**
   * Predicate: does this status or error indicate an unreachable tunnel or temporary outage?
   * @param {number|string} status HTTP status code (or 0 for network drop/timeout)
   * @param {string} [message] Error message
   * @returns {boolean}
   */
  function isRetryableError(status, message) {
    const s = Number(status) || 0;
    const msg = String(message || '').toLowerCase();
    if (s === 0) return true; // network failure, abort or timeout
    if (s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530) || s >= 500) return true;
    if (msg.includes('network_unreachable') || msg.includes('timeout') || msg.includes('failed to fetch')) return true;
    return false;
  }

  /**
   * Predicate: is this URL a trusted Cloudflare quick-tunnel or Sultrix domain?
   * @param {string} raw
   * @returns {boolean}
   */
  function isTrustedTunnel(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:' || u.username || u.password) return false;
      const h = u.hostname.toLowerCase();
      return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(trycloudflare\.com|sultrixtrade\.com)$/.test(h);
    } catch (_) { return false; }
  }

  /**
   * Predicate: should the client query the central relay for a new tunnel?
   * @param {number|string} errorStatus
   * @param {string} currentUrl
   * @param {boolean} hasSavedKey
   * @param {string} [message]
   * @returns {boolean}
   */
  function shouldCheckRelay(errorStatus, currentUrl, hasSavedKey, message) {
    return Boolean(hasSavedKey && isRetryableError(errorStatus, message) && (!currentUrl || isTrustedTunnel(currentUrl)));
  }

  /**
   * Format connection banner text calmly without ever presenting stale data as live.
   * @param {string} kind 'live' | 'connected' | 'updating' | 'reconnecting' | 'offline'
   * @param {number} [offlineSinceTs]
   * @param {number} [nowTs=Date.now()]
   * @returns {{ kind: string, text: string, isLive: boolean }}
   */
  function formatConnectionStatus(kind, offlineSinceTs, nowTs = Date.now()) {
    if (kind === 'live' || kind === 'connected') {
      return { kind: 'live', text: '', isLive: true };
    }
    if (kind === 'updating' || kind === 'reconnecting') {
      return { kind: 'updating', text: 'Reconnecting to bot…', isLive: false };
    }
    const s = offlineSinceTs ? Math.max(1, Math.round(((Number(nowTs) || Date.now()) - Number(offlineSinceTs)) / 1000)) : null;
    let relText = '';
    if (s != null) {
      if (s < 60) relText = s + 's ago';
      else if (s < 3600) relText = Math.round(s / 60) + 'm ago';
      else if (s < 86400) relText = Math.round(s / 3600) + 'h ago';
      else relText = Math.round(s / 86400) + 'd ago';
    }
    const text = relText
      ? `Offline since ${relText} — showing cached data`
      : 'Offline — showing cached data';
    return { kind: 'offline', text, isLive: false };
  }

  return {
    computeRetryDelay,
    isRetryableError,
    isTrustedTunnel,
    shouldCheckRelay,
    formatConnectionStatus,
  };
});
