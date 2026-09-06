# Sultrix PWA v2.0.2 — Deployment Guide

## Build artifacts

- `sultrix-pwa-v2.0.2.zip` (79 KB) — static site bundle, ready to upload to any HTTPS host
- `sultrix-pwa-dist/` — extracted contents + `BUILD-MANIFEST.json` (sha256 hashes)
- `sultrix-pwa/` — source directory

## Files in the bundle (8 static + 1 manifest)

```
BUILD-MANIFEST.json   sha256 manifest
index.html            11.6 KB   PWA shell, login, 9 tabs
app.js                26.6 KB   UI logic, fetchers, render, SW registration
styles.css            14.5 KB   dark mobile-first design
sw.js                  3.8 KB   service worker (network-first API, swr assets, push)
manifest.json          1.5 KB   PWA manifest, 3 icons, 3 shortcuts
assets/icons/icon-192.png     8.5 KB
assets/icons/icon-512.png    27.4 KB
assets/icons/icon-maskable.png  27.4 KB
```

## Backend requirements (NOT in the static bundle)

The static PWA talks to `/api/pwa/*` routes served by **dashboard.py**. For production:

1. **Backend host** — dashboard.py must run on a publicly reachable HTTPS endpoint.
   Default binding: `0.0.0.0:5000` (change in `dashboard.py` if needed).
2. **Reverse proxy** — Nginx/Caddy in front of dashboard.py for TLS termination + caching.
3. **CORS** — if the static PWA is on a different origin than the API, add CORS headers to dashboard.py. Recommended: serve everything from the same origin.
4. **VAPID** — keys are already in `bot_state.db` (`pwa_vapid_public_key`, `pwa_vapid_private_key`). The private key is used by the backend when sending web-push notifications via `pywebpush` / `py_vapid`.

## Three deployment options

### Option A — Same-origin (recommended)

1. Point `app.sultrixtrade.com` DNS to the host running dashboard.py.
2. Run dashboard.py behind a reverse proxy that:
   - Serves `/api/pwa/*` from dashboard.py
   - Serves `/` and other PWA paths from `sultrix-pwa-dist/`
   - Forces HTTPS
   - Adds security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: push=()`, `Content-Security-Policy` allowing `https://slt.tradingview.com` for the chart iframe)
3. Open `https://app.sultrixtrade.com/` in Chrome on Android or iOS Safari → tap install prompt.

### Option B — Static on CDN + API on a separate host

1. Upload the contents of `sultrix-pwa-dist/` to a CDN (Cloudflare Pages, Netlify, S3+CloudFront, Vercel).
2. Add CORS to dashboard.py:
   ```python
   from flask_cors import CORS
   CORS(app, resources={r"/api/pwa/*": {"origins": "https://app.sultrixtrade.com"}})
   ```
3. Set the `SultrixAPI` base in `app.js` if the API is on a different origin (currently same-origin; add an env var if needed).

### Option C — Served entirely by dashboard.py (no static host)

Already running at `http://127.0.0.1:5000/`. The dashboard auto-mounts the PWA from `../sultrix-pwa/` when present. Just put a reverse proxy in front of dashboard.py and you're done.

## Environment variables

Already set in `.env`:
- Telegram bot token, Neon database URL, SMTP creds
- Binance Testnet API keys (pre-configured; user must re-enter in Settings UI)
- VAPID keys (auto-generated; stored in `bot_state.db`)

## Security checklist (production)

- [ ] HTTPS enforced (HSTS header)
- [ ] VAPID keys not exposed in client code
- [ ] License key never stored client-side
- [ ] Session token expires in 12h (`_PWA_SESSIONS` in-memory)
- [ ] Push subscription endpoint validated on subscribe
- [ ] Bot commands require Bearer token + backend authorization
- [ ] `Content-Security-Policy` header set to allow only necessary origins
- [ ] Service worker registered at root scope `/`
- [ ] PWA installed and launchable from a phone home screen

## Quick sanity-check (after deploy)

```bash
# Replace with your real host
HOST=https://app.sultrixtrade.com

curl -sS $HOST/api/pwa/health | jq .
# → {"service":"sultrix-pwa","status":"ok",...}

curl -sS $HOST/manifest.json | jq .name
# → "Sultrix Trading"

curl -sS $HOST/sw.js | head -3
# → service worker JS

# End-to-end auth
curl -sS -X POST $HOST/api/pwa/auth \
  -H 'Content-Type: application/json' \
  -d '{"license_key":"dev-bypass"}' | jq .session_token
# → 12h Bearer token
```

## Known gaps (deferred)

- Real-device VAPID delivery test (server flow verified end-to-end; only phone-side unverified)
- MT5 broker login (forex module configured but broker auth is user-side)
- Branded app icons (current icons are placeholders)
- Screenshots for the install dialog (removed from manifest to avoid 404; re-add when you have marketing screenshots)

## Versioning

- `manifest.json` version = `2.0.2`
- `dashboard.py` reads `version.py` → must be `2.0.2` (already done)
- `bot_state.db settings.version` should also be `2.0.2` (already synced)
