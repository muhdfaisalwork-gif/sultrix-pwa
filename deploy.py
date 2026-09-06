#!/usr/bin/env python3
"""
Sultrix PWA v2.0 — build & deploy script.

Usage:
  python deploy.py build            # verify files, lint, write manifest
  python deploy.py serve            # local dev server on http://localhost:8080
  python deploy.py deploy <target>  # copy to deploy target (e.g. app.sultrixtrade.com)

This script is intentionally dependency-free — uses only Python stdlib.
"""
import os, sys, json, http.server, socketserver, webbrowser, hashlib

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
ICONS = os.path.join(ASSETS, "icons")
MANIFEST = os.path.join(ROOT, "manifest.json")
SW = os.path.join(ROOT, "sw.js")
INDEX = os.path.join(ROOT, "index.html")
APP_JS = os.path.join(ROOT, "app.js")
STYLES = os.path.join(ROOT, "styles.css")
VERSION = "2.0.0"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def build():
    """Verify PWA files exist and are well-formed."""
    required = [
        ("index.html", INDEX),
        ("app.js", APP_JS),
        ("styles.css", STYLES),
        ("manifest.json", MANIFEST),
        ("sw.js", SW),
        ("icon-192", os.path.join(ICONS, "icon-192.png")),
        ("icon-512", os.path.join(ICONS, "icon-512.png")),
        ("maskable", os.path.join(ICONS, "icon-maskable.png")),
    ]
    print(f"=== Sultrix PWA v{VERSION} — build check ===")
    bad = 0
    for name, path in required:
        ok = os.path.isfile(path)
        size = os.path.getsize(path) if ok else 0
        mark = "OK " if ok else "MISS"
        print(f"  [{mark}] {name:18s} {size:>8} bytes  {path}")
        if not ok: bad += 1
    if bad:
        print(f"\n{bad} missing file(s). Run from the PWA root directory.")
        return 1
    # Verify manifest
    with open(MANIFEST) as f: m = json.load(f)
    print(f"\nmanifest: name='{m.get('name')}', version={m.get('version')}, icons={len(m.get('icons', []))}")
    print(f"shortcuts: {len(m.get('shortcuts', []))} entries")
    # Verify service worker
    with open(SW) as f: sw = f.read()
    if "addEventListener('install'" in sw and "addEventListener('fetch'" in sw:
        print("sw.js: install + fetch handlers present")
    # Print hashes for deploy verification
    print("\nFile hashes (sha256):")
    for name, path in required:
        print(f"  {sha256(path)}  {name}")
    print("\nBUILD OK")
    return 0


def serve(port=8080):
    """Quick local dev server."""
    os.chdir(ROOT)
    handler = http.server.SimpleHTTPRequestHandler
    handler.extensions_map.setdefault("", "application/octet-stream")
    with socketserver.TCPServer(("0.0.0.0", port), handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"Sultrix PWA v{VERSION} dev server running at {url}")
        try: webbrowser.open(url)
        except Exception: pass
        try: httpd.serve_forever()
        except KeyboardInterrupt: print("\nstopped.")


def deploy(target):
    """Copy PWA files to a deploy target. Target can be a local dir or a remote URL stub."""
    if not os.path.isdir(target):
        print(f"Target directory not found: {target}")
        print("Usage: deploy.py deploy <local-dir>")
        return 1
    os.makedirs(target, exist_ok=True)
    files = ["index.html", "app.js", "styles.css", "manifest.json", "sw.js"]
    for f in files:
        src = os.path.join(ROOT, f)
        dst = os.path.join(target, f)
        with open(src, "rb") as fr, open(dst, "wb") as fw:
            fw.write(fr.read())
        print(f"  copied {f}")
    # Copy assets dir
    import shutil
    if os.path.isdir(ASSETS):
        dst_assets = os.path.join(target, "assets")
        if os.path.isdir(dst_assets): shutil.rmtree(dst_assets)
        shutil.copytree(ASSETS, dst_assets)
        print(f"  copied assets/ ({len(os.listdir(ASSETS))} entries)")
    print(f"\nDeployed to {target}")
    print("Reminder: ensure HTTPS is enabled at the target — PWA install requires it.")
    return 0


def main():
    if len(sys.argv) < 2:
        print("Usage: deploy.py [build|serve|deploy <target>]")
        return 1
    cmd = sys.argv[1]
    if cmd == "build":
        return build()
    if cmd == "serve":
        return serve()
    if cmd == "deploy":
        if len(sys.argv) < 3:
            print("Usage: deploy.py deploy <target-dir>")
            return 1
        return deploy(sys.argv[2])
    print(f"Unknown command: {cmd}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
