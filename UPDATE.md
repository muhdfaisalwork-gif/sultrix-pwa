# Sultrix Auto-Update Flow

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    SULTRIX AUTO-UPDATE                            │
│                                                                  │
│   ┌─────────────────┐         ┌──────────────────┐               │
│   │  Sultrix.app    │         │  GitHub Releases │               │
│   │  (running)      │         │  sultrix-releases │               │
│   │                 │         │  /releases/latest │               │
│   │  - VERSION      │         │                   │               │
│   │  - launcher.py  │         └────────┬──────────┘               │
│   │    _check_      │                  │                          │
│   │    update()     │                  │ tag_name + assets         │
│   └────────┬────────┘                  │                          │
│            │                            │                          │
│            │ GET latest release         │                          │
│            └───────────────────────────→                          │
│            │                                                      │
│            │  If newer: show banner                               │
│            │  User clicks → download asset                        │
│            │  Verify sha256 → run installer                        │
│            ▼                                                      │
│   ┌─────────────────┐         ┌──────────────────┐               │
│   │  Restart app    │         │  Cloudflare R2   │               │
│   │  New version    │         │  sultrix-releases │               │
│   │  running        │         │  Sultrix-Setup.exe│               │
│   └─────────────────┘         └──────────────────┘               │
│                                                                  │
│   Build pipeline (build.py):                                    │
│   ┌──────────┐   Inno Setup   ┌──────────┐   wrangler r2   ┌────┐│
│   │ Nuitka / │──────────────→ │ Setup.exe │──────────────→ │ R2 ││
│   │PyInst.   │                │ + sha256  │                └────┘│
│   └──────────┘                └──────────┘                        │
│                                       │                          │
│                                       │ POST /api/publish-version│
│                                       ▼                          │
│                              ┌─────────────────┐                  │
│                              │ Worker KV       │                  │
│                              │ sultrix-api.    │                  │
│                              │ muhd-faisal-work│                  │
│                              │ .workers.dev    │                  │
│                              └─────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

## Three update sources (redundant)

1. **GitHub Releases** — `https://api.github.com/repos/muhdfaisalwork-gif/sultrix-releases/releases/latest`
   - Primary source, public CDN
   - Rate-limited but fine for occasional checks
2. **Cloudflare R2** — `sultrix-releases` bucket
   - Fast CDN, direct downloads
   - Used as GitHub asset mirror
3. **Worker KV** — `https://sultrix-api.muhd-faisal-work.workers.dev/api/desktop/latest`
   - Authoritative version metadata
   - No rate limits, served from Cloudflare edge

## File locations

- `version.py` — source of truth, single string VERSION = "2.1.0"
- `launcher.py:_RELEASES_API` — GitHub Releases URL
- `launcher.py:_check_update_bg()` — background update check at startup
- `build.py:507-536` — R2 upload step
- `build.py:541-579` — Worker publish-version POST
- `dashboard.py` — /api/pwa/* routes (separate from desktop updater)

## Update payload format (from Worker)

```json
{
  "ok": true,
  "version": "2.1.1",
  "sha256": "abc123...",
  "url": "https://github.com/muhdfaisalwork-gif/sultrix-releases/releases/latest/download/Sultrix-Setup.exe",
  "mandatory": false,
  "release_notes": "Bug fixes + new Free trial"
}
```

## Update decision flow (in launcher.py)

1. App starts → read VERSION from `version.py` (compiled-in)
2. `launcher.py:_check_update_bg()` runs in background thread
3. Hits Worker API for `/api/desktop/latest`
4. If `response.version > VERSION`:
   - Show update notification banner with "Download & Install" button
   - If `mandatory: true` → block app until user updates
5. User clicks → download installer + verify sha256 + run + restart

## Manual update trigger

`launcher.py` has a "↻ Updates" button that calls `_check_for_update_manual()`. Also accessible via the "Updates" tab in the launcher UI.

## What changes per release

- `version.py` VERSION string (single source of truth)
- `app.js` BUILD constant (PWA build version, also surfaces in Settings)
- `manifest.json` `version` field
- `dashboard.py` reads `version.py` via `from version import VERSION`

## Verification commands

```powershell
# Verify Worker API is reachable and returns current version
curl https://sultrix-api.muhd-faisal-work.workers.dev/api/desktop/latest

# Verify GitHub release exists
curl https://api.github.com/repos/muhdfaisalwork-gif/sultrix-releases/releases/latest | jq .tag_name

# Verify R2 object exists
wrangler r2 object get sultrix-releases/Sultrix-Setup.exe --remote

# Check PWA version served by dashboard
curl http://127.0.0.1:5000/api/pwa/status | jq .version
```

## Trust + security

- **sha256 verification** — every download is verified against the published digest before running
- **HTTPS** — all update endpoints are HTTPS-only
- **No silent updates** — mandatory updates require user consent (unless `mandatory: true`)
- **R2 + GitHub + Worker triple-source** — if any one is down, the other two serve the manifest
- **Code-signed installer** — placeholder for future code-signing cert (Phase 7 hard spec)

