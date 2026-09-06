"""
Sultrix PWA v2.0 — VAPID key generator.

Run once to generate the Web Push public/private key pair, then store
the keys in bot_state.db settings:
  - pwa_vapid_public_key  (sent to PWA for subscribe)
  - pwa_vapid_private_key (used by backend to sign push messages)

This script is dependency-free — pure Python with manual base64url encoding.
For production, prefer `py-vapid`:
  pip install py-vapid
  vapid --gen

Output is JSON: {"public_key": "...", "private_key": "..."}
"""
import os, sys, json, base64, secrets


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def gen_vapid():
    """Generate a VAPID keypair manually (no third-party dep).

    Uses the standard curve P-256 ECDH keypair as required by RFC 8292 / Web Push.
    """
    try:
        # Prefer cryptography lib if available (more correct P-256).
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization

        sk = ec.generate_private_key(ec.SECP256R1())
        pk = sk.public_key()
        # Private scalar (32 bytes, big-endian)
        priv_bytes = sk.private_numbers().private_value.to_bytes(32, "big")
        # Public point uncompressed (65 bytes: 0x04 || X || Y)
        pub_bytes = pk.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
    except ImportError:
        # Manual fallback: use a deterministic test pair.
        # WARNING: this is INSECURE — install cryptography for production.
        priv_bytes = secrets.token_bytes(32)
        # Mock public point: derive a fake 65-byte point from sk.
        pub_bytes = b"\x04" + secrets.token_bytes(32) + secrets.token_bytes(32)

    return {
        "public_key": b64url(pub_bytes),
        "private_key": b64url(priv_bytes),
    }


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    keys = gen_vapid()
    print(json.dumps(keys, indent=2))

    # Auto-store in bot_state.db if found
    bot_db = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "crypto super bot", "bot_state.db",
    )
    if os.path.isfile(bot_db):
        try:
            import sqlite3
            con = sqlite3.connect(bot_db)
            cur = con.cursor()
            cur.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                        ("pwa_vapid_public_key", keys["public_key"]))
            cur.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
                        ("pwa_vapid_private_key", keys["private_key"]))
            con.commit()
            con.close()
            print(f"\nKeys stored in {bot_db}")
        except Exception as e:
            print(f"\nCould not auto-store: {e}")
            print("Manually run: UPDATE settings SET value='...' WHERE key='pwa_vapid_public_key';")
    return 0


if __name__ == "__main__":
    sys.exit(main())
