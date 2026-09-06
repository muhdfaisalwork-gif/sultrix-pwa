# Sultrix PWA v2.0

Mobile companion for the Sultrix trading bot. Installable on phones, tablets and desktop. Connects to the existing Sultrix backend via secure HTTPS API.

## Status

- v2.0.0 build OK
- All 8 static files present
- 11 backend API routes wired
- Service worker with offline cache + push handlers
- Mobile-first dark trading UI

## Architecture

```
Customer phone
   │  (PWA install, push, login)
   ▼
Sultrix PWA
   │  (HTTPS, Bearer session token)
   ▼
Sultrix Backend (dashboard.py)
   │  (session validation, plan/license check)
   ▼
Existing Sultrix trading engine (shadow.py)
   │
   ▼
Crypto / Forex / Stocks / Risk / Agents / Brokers
```

The PWA is a presentation, monitoring and command surface. It does **not** execute broker operations, does not duplicate trading logic, and does not store broker credentials.

## File map

```
sultrix-pwa/
├── manifest.json        # PWA install manifest, icons, shortcuts
├── sw.js                # Service worker (cache + push)
├── index.html           # Single-page entry
├── app.js               # Routing, API client, polling, push subscribe
├── styles.css           # Mobile-first dark trading aesthetic
├── deploy.py            # build / serve / deploy
├── assets/
│   └── icons/           # PWA icons (placeholders, replace with branded)
└── README.md
```

## Backend integration

All PWA routes are mounted under `/api/pwa/*` on the existing Flask dashboard.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/pwa/auth` | License key → 12h session token (raw key never persisted) |
| POST | `/api/pwa/session/logout` | Revoke session |
| GET  | `/api/pwa/session` | Session info |
| GET  | `/api/pwa/status` | Bot status, uptime, fills, regime, version |
| GET  | `/api/pwa/pnl` | Total / daily / realized / unrealized |
| GET  | `/api/pwa/positions` | Open positions (crypto/forex/stocks) |
| GET  | `/api/pwa/agents` | Agent states + last heartbeat |
| GET  | `/api/pwa/alerts` | Alert history |
| POST | `/api/pwa/alerts/{id}/read` | Mark alert read |
| POST | `/api/pwa/alerts/read-all` | Mark all alerts read |
| GET  | `/api/pwa/risk` | Threat level, health, integrity, exposures |
| GET  | `/api/pwa/markets` | Crypto/forex/stocks availability |
| GET  | `/api/pwa/account` | Plan, trial, version |
| GET  | `/api/pwa/analytics` | Win rate, market breakdown, history |
| GET  | `/api/pwa/charts/symbols` | TradingView symbol list |
| POST | `/api/pwa/commands` | Execute authorized bot command |
| GET  | `/api/pwa/notifications/prefs` | Notification preferences |
| POST | `/api/pwa/notifications/prefs` | Update preferences |
| GET  | `/api/pwa/notifications/public-key` | VAPID public key |
| POST | `/api/pwa/notifications/subscribe` | Register push subscription |
| GET  | `/api/pwa/health` | Public liveness (no auth) |

## License flow

1. Customer opens PWA, sees login screen.
2. Enters Sultrix license key.
3. PWA POSTs to `/api/pwa/auth` with the key.
4. Backend validates via `license_validator.validate_license` (or fallback).
5. On success, backend creates a 12h session token in memory.
6. PWA stores the token in localStorage. **The raw key is never stored on the client.**
7. All subsequent API calls use `Authorization: Bearer <token>`.
8. Session expires after 12h idle. License changes require re-login.

## Notifications

- Backend AlertManager emits events
- Notification layer fans out to WhatsApp and PWA push
- PWA push uses the Web Push API (VAPID)
- Customer can configure per-category preferences

To enable real push:
```
pip install py-vapid
vapid --gen
```
Set `pwa_vapid_public_key` and `pwa_vapid_private_key` in `bot_state.db` settings.

## Local development

```
cd "G:\crypto super bot Back up\sultrix-pwa"
python deploy.py build    # verify files
python deploy.py serve    # http://localhost:8080
```

For the full PWA + backend integration, run `dashboard.py` and visit:
- PWA:   http://localhost:5000/
- API:    http://localhost:5000/api/pwa/health

## Deployment

```
python deploy.py deploy C:\inetpub\wwwroot\sultrix-pwa
```

Then sync the target directory to `app.sultrixtrade.com` via your existing deploy mechanism.

**HTTPS is required** for PWA install. Ensure a valid cert is on the production domain.

## Branding

Replace the placeholder icons in `assets/icons/` with proper branded assets:
- 192×192 and 512×512 PNGs (with maskable variant for adaptive icons)
- Splash screen background color in `manifest.json` (`theme_color`)

## Known follow-ups

- `_think()` cycle is taking 130-170s — investigate `shadow.py` for the long cycle (causes heartbeat staleness, not a functional break)
- MT5 broker login still user-side action; `forex_*` settings are wired in `dashboard.py` and the new `/api/pwa/markets` endpoint will surface this
- VAPID keys not yet generated; push is wired but won't deliver until keys exist
- Real licensed icons (placeholders only)
- Analytics `history_chart` field is empty; needs a background aggregator that rolls up daily PnL into time-bucketed history

## Testing checklist (per v2.0 spec)

- [x] Build check passes
- [x] Manifest valid (name, icons, shortcuts)
- [x] Service worker handlers (install, fetch, push, notificationclick)
- [x] App shell + assets present
- [ ] HTTPS in production
- [ ] License flow tested with real key
- [ ] PWA install on Android Chrome
- [ ] PWA install on iOS Safari
- [ ] Push delivery tested
- [ ] Offline mode tested
- [ ] Mobile portrait tested
- [ ] Tablet + desktop layout tested
