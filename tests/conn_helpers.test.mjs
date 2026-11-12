import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeRetryDelay,
  isRetryableError,
  shouldCheckRelay,
  isTrustedTunnel,
  formatConnectionStatus,
} = require('../conn_helpers.js');

test('computeRetryDelay: exponential growth without jitter', () => {
  // randomFn returning 0.5 produces zero jitter because (0.5 * 2 - 1) * 0.2 = 0
  const noJitter = () => 0.5;
  const base = 1500;
  const max = 30000;

  const d0 = computeRetryDelay(0, base, max, noJitter);
  const d1 = computeRetryDelay(1, base, max, noJitter);
  const d2 = computeRetryDelay(2, base, max, noJitter);
  const d3 = computeRetryDelay(3, base, max, noJitter);
  const d4 = computeRetryDelay(4, base, max, noJitter);

  assert.equal(d0, 1500, 'attempt 0 delay should equal baseMs');
  assert.equal(d1, 3000, 'attempt 1 delay should equal baseMs * 2^1');
  assert.equal(d2, 6000, 'attempt 2 delay should equal baseMs * 2^2');
  assert.equal(d3, 12000, 'attempt 3 delay should equal baseMs * 2^3');
  assert.equal(d4, 24000, 'attempt 4 delay should equal baseMs * 2^4');

  // Verify strict monotonic increase across attempts
  assert.ok(d0 < d1 && d1 < d2 && d2 < d3 && d3 < d4, 'delays should grow exponentially');
});

test('computeRetryDelay: caps at maxMs regardless of attempt count', () => {
  const noJitter = () => 0.5;
  const maxJitter = () => 1.0;
  const base = 1500;
  const max = 30000;

  // With no jitter
  assert.equal(computeRetryDelay(5, base, max, noJitter), 30000, 'attempt 5 caps at maxMs');
  assert.equal(computeRetryDelay(10, base, max, noJitter), 30000, 'attempt 10 caps at maxMs');
  assert.equal(computeRetryDelay(100, base, max, noJitter), 30000, 'attempt 100 caps at maxMs');

  // With positive jitter, cap must still be strictly respected
  assert.equal(computeRetryDelay(5, base, max, maxJitter), 30000, 'capped even with positive jitter');
  assert.equal(computeRetryDelay(20, base, max, maxJitter), 30000, 'capped at attempt 20 with positive jitter');

  // Custom cap
  const customMax = 8000;
  assert.equal(computeRetryDelay(10, base, customMax, noJitter), 8000, 'custom cap is respected');
});

test('computeRetryDelay: jitter bounds (±20% of exponential value)', () => {
  const base = 1500;
  const max = 30000;
  const attempt = 2; // exp = 1500 * 4 = 6000
  const exp = 6000;

  const minJitterFn = () => 0; // jitter = -0.2 * 6000 = -1200 -> 4800
  const maxJitterFn = () => 1; // jitter = +0.2 * 6000 = +1200 -> 7200
  const midJitterFn = () => 0.5; // jitter = 0 -> 6000

  const dMin = computeRetryDelay(attempt, base, max, minJitterFn);
  const dMax = computeRetryDelay(attempt, base, max, maxJitterFn);
  const dMid = computeRetryDelay(attempt, base, max, midJitterFn);

  assert.equal(dMin, 4800, 'min jitter bound is 80% of exponential delay');
  assert.equal(dMax, 7200, 'max jitter bound is 120% of exponential delay');
  assert.equal(dMid, 6000, 'zero jitter matches exponential delay');

  // Verify multiple random iterations stay strictly within [4800, 7200] and >= 500
  for (let i = 0; i < 50; i++) {
    const dRand = computeRetryDelay(attempt, base, max);
    assert.ok(dRand >= 4800 && dRand <= 7200, `random delay ${dRand} must be within [4800, 7200]`);
    assert.ok(dRand >= 500, 'delay must never drop below 500ms lower bound');
  }
});

test('isRetryableError: retryable status classes and network errors', () => {
  // Status 0: network failure, CORS block, aborted, or client timeout
  assert.equal(isRetryableError(0), true, 'status 0 is retryable');
  assert.equal(isRetryableError('0'), true, 'string "0" is retryable');
  assert.equal(isRetryableError(null), true, 'null status is retryable (treated as 0)');
  assert.equal(isRetryableError(undefined), true, 'undefined status is retryable');

  // 5xx Server errors
  assert.equal(isRetryableError(500), true, '500 Internal Server Error is retryable');
  assert.equal(isRetryableError(502), true, '502 Bad Gateway is retryable');
  assert.equal(isRetryableError(503), true, '503 Service Unavailable is retryable');
  assert.equal(isRetryableError(504), true, '504 Gateway Timeout is retryable');

  // Cloudflare error range (520-530)
  assert.equal(isRetryableError(520), true, '520 Web Server Returned an Unknown Error is retryable');
  assert.equal(isRetryableError(521), true, '521 Web Server Is Down is retryable');
  assert.equal(isRetryableError(522), true, '522 Connection Timed Out is retryable');
  assert.equal(isRetryableError(524), true, '524 A Timeout Occurred is retryable');
  assert.equal(isRetryableError(525), true, '525 SSL Handshake Failed is retryable');

  // Error message heuristics
  assert.equal(isRetryableError(0, 'network_unreachable'), true, 'network_unreachable is retryable');
  assert.equal(isRetryableError(0, 'request_timeout'), true, 'request_timeout is retryable');
  assert.equal(isRetryableError(0, 'Failed to fetch'), true, 'Failed to fetch is retryable');
});

test('isRetryableError: non-retryable status classes', () => {
  // 2xx Success (not an error to retry)
  assert.equal(isRetryableError(200), false, '200 OK is not retryable');
  assert.equal(isRetryableError(204), false, '204 No Content is not retryable');

  // 4xx Client errors (bad request, auth errors, missing endpoints)
  assert.equal(isRetryableError(400), false, '400 Bad Request is not retryable');
  assert.equal(isRetryableError(401), false, '401 Unauthorized is not retryable');
  assert.equal(isRetryableError(403), false, '403 Forbidden is not retryable');
  assert.equal(isRetryableError(404), false, '404 Not Found is not retryable');
  assert.equal(isRetryableError(405), false, '405 Method Not Allowed is not retryable');
  assert.equal(isRetryableError(422), false, '422 Unprocessable Entity is not retryable');
});

test('shouldCheckRelay: queries relay only when retryable, key exists, and tunnel is trusted', () => {
  const validKey = true;
  const trustedUrl = 'https://abc-123.trycloudflare.com';
  const untrustedUrl = 'http://insecure-host.com';

  // Successful retryable scenarios
  assert.equal(shouldCheckRelay(503, trustedUrl, validKey), true, '503 on trusted tunnel with key checks relay');
  assert.equal(shouldCheckRelay(0, trustedUrl, validKey), true, 'network drop on trusted tunnel with key checks relay');
  assert.equal(shouldCheckRelay(502, '', validKey), true, 'empty URL with key and 502 checks relay');

  // Should NOT check relay if no saved key
  assert.equal(shouldCheckRelay(503, trustedUrl, false), false, 'no saved key does not check relay');

  // Should NOT check relay if status is not retryable (e.g., 401 or 404)
  assert.equal(shouldCheckRelay(401, trustedUrl, validKey), false, '401 auth failure does not check relay');
  assert.equal(shouldCheckRelay(404, trustedUrl, validKey), false, '404 not found does not check relay');

  // Should NOT check relay if existing URL is untrusted
  assert.equal(shouldCheckRelay(503, untrustedUrl, validKey), false, 'untrusted URL does not check relay');
});

test('isTrustedTunnel: validation rules', () => {
  assert.equal(isTrustedTunnel('https://foo.trycloudflare.com'), true);
  assert.equal(isTrustedTunnel('https://bar.sultrixtrade.com'), true);
  assert.equal(isTrustedTunnel('https://sub.sub2.trycloudflare.com'), true);

  // Insecure / invalid
  assert.equal(isTrustedTunnel('http://foo.trycloudflare.com'), false, 'http rejected');
  assert.equal(isTrustedTunnel('https://user:pass@foo.trycloudflare.com'), false, 'user credentials rejected');
  assert.equal(isTrustedTunnel('https://evilcloudflare.com'), false, 'spoofed domain rejected');
  assert.equal(isTrustedTunnel('https://trycloudflare.com.attacker.com'), false, 'suffix spoof rejected');
  assert.equal(isTrustedTunnel(''), false, 'empty string rejected');
  assert.equal(isTrustedTunnel(null), false, 'null rejected');
});

test('formatConnectionStatus: status formatting and offline duration text', () => {
  assert.deepEqual(formatConnectionStatus('live', null), { kind: 'live', text: '', isLive: true });
  assert.deepEqual(formatConnectionStatus('connected', null), { kind: 'live', text: '', isLive: true });
  assert.deepEqual(formatConnectionStatus('updating', null), { kind: 'updating', text: 'Reconnecting to bot…', isLive: false });

  const now = 1000000;
  const thirtySecAgo = now - 30000;
  const res30 = formatConnectionStatus('offline', thirtySecAgo, now);
  assert.equal(res30.kind, 'offline');
  assert.equal(res30.isLive, false);
  assert.equal(res30.text, 'Offline since 30s ago — showing cached data');
});
