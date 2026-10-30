#!/usr/bin/env python3
"""Web Push for the dashboard app (PWA): alerts straight to the admins' phones and laptops, no app store, no third
party account. Standard Web Push: the payload is encrypted for each device (RFC 8291, aes128gcm) and the server signs
every request with its own VAPID key (RFC 8292). Messages go only to the browsers' own push services.

  webpush.py keys                                   make the server's VAPID key once; prints the public key
  webpush.py add ADMIN [UA] < subscription.json      a device turned notifications on (from the dashboard)
  webpush.py del ID | list [--json]
  webpush.py send TITLE [TEXT] [--url /#/health]     to every device (the alerts' 'push' channel uses this)
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEY = "/etc/mikrotiklover-radius/vapid.pem"
CNF, DBNAME = "/etc/mikrotiklover-radius/my.cnf", "radius"
# the browsers' push services (Chrome / Edge / Android: FCM, Firefox: Mozilla, Safari / iPhone: Apple, Windows: WNS)
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
              "web.push.apple.com", "api.push.apple.com", "notify.windows.com")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ------------------------------------------------------------------ keys
def load_key(path=KEY, create=False):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    if not os.path.exists(path):
        if not create:
            raise RuntimeError("no VAPID key yet (webpush.py keys)")
        k = ec.generate_private_key(ec.SECP256R1())
        pem = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), None)


def public_raw(key):
    from cryptography.hazmat.primitives import serialization
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


# ------------------------------------------------------------------ RFC 8291 (aes128gcm) + RFC 8292 (VAPID)
def _hkdf(salt, ikm, info, n):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]


def encrypt(payload, p256dh, auth, salt=None, as_key=None):
    """payload bytes for one device (its p256dh public key + auth secret, base64url) -> request body"""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ua_pub = unb64u(p256dh)
    auth_secret = unb64u(auth)
    if len(ua_pub) != 65 or ua_pub[0] != 4 or len(auth_secret) < 16:
        raise ValueError("bad subscription keys")
    as_key = as_key or ec.generate_private_key(ec.SECP256R1())
    as_pub = public_raw(as_key)
    shared = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = salt or os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)          # one record, last-record padding delimiter
    return salt + struct.pack("!IB", 4096, len(as_pub)) + as_pub + body


def decrypt(body, ua_key, auth):
    """the device side (used by the tests' fake push service)"""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, (rs, idlen) = body[:16], struct.unpack("!IB", body[16:21])
    as_pub = body[21:21 + idlen]
    ua_pub = public_raw(ua_key)
    shared = ua_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ikm = _hkdf(unb64u(auth), shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, body[21 + idlen:], None)
    return plain.rstrip(b"\x00")[:-1]


def vapid_header(endpoint, key, sub="mailto:admin@localhost", now=None):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    u = urllib.parse.urlsplit(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int(now or time.time()) + 12 * 3600, "sub": sub},
                             separators=(",", ":")).encode())
    r, s = decode_dss_signature(key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    jwt = f"{head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return f"vapid t={jwt}, k={b64u(public_raw(key))}"


def endpoint_ok(url, extra=()):
    """only the browsers' push services (https), so a stored address cannot make the server call anything else;
    `extra` = host:port allowed in addition (setting push_allow_hosts; http only for 127.0.0.1, for tests)"""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if len(url) > 1024 or not u.hostname:
        return False
    host = u.hostname.lower()
    if u.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS):
        return True
    if u.netloc in extra:
        try:
            return u.scheme == "https" or ipaddress.ip_address(host).is_loopback
        except ValueError:
            return u.scheme == "https"
    return False


def send(sub, payload, key, ttl=86400, contact="mailto:admin@localhost", timeout=15):
    """-> HTTP status (201 / 200 ok, 404 / 410 = the device unsubscribed)"""
    body = encrypt(json.dumps(payload).encode(), sub["p256dh"], sub["auth"])
    req = urllib.request.Request(sub["endpoint"], data=body, method="POST", headers={
        "Authorization": vapid_header(sub["endpoint"], key, contact), "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream", "TTL": str(ttl), "Urgency": "high"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


# ------------------------------------------------------------------ devices (ml_push_sub)
def _db(cnf=CNF, db=DBNAME):
    import pymysql
    c = pymysql.connect(read_default_file=cnf, database=db, charset="utf8mb4", autocommit=True,
                        cursorclass=pymysql.cursors.DictCursor)

    def ex(sql, args=None):
        with c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()
    return ex


def _extra(ex):
    r = ex("SELECT v FROM ml_setting WHERE k='push_allow_hosts'")
    return tuple(x for x in (r[0]["v"] if r else "").split() if x)


def add(ex, admin, sub, ua=""):
    ep = str(sub.get("endpoint", ""))
    keys = sub.get("keys") or {}
    p256dh, auth = str(keys.get("p256dh", "")), str(keys.get("auth", ""))
    if not endpoint_ok(ep, _extra(ex)):
        raise ValueError("not a browser push service address")
    if not re.match(r"^[A-Za-z0-9_-]{80,100}$", p256dh) or not re.match(r"^[A-Za-z0-9_-]{16,32}$", auth):
        raise ValueError("bad subscription keys")
    if not re.match(r"^[A-Za-z0-9._@+-]{1,64}$", admin):
        raise ValueError("bad admin name")
    h = hashlib.sha256(ep.encode()).hexdigest()
    ex("""REPLACE INTO ml_push_sub (ep_hash, admin, endpoint, p256dh, auth, ua, created)
          VALUES (%s, %s, %s, %s, %s, %s, NOW())""", (h, admin, ep, p256dh, auth, re.sub(r"[^\x20-\x7e]", "", ua)[:160]))
    return h


def send_all(ex, title, text="", url="/", key=None):
    """-> {'sent': n, 'removed': n, 'failed': n}; devices that unsubscribed (404 / 410) are removed"""
    key = key or load_key()
    extra = _extra(ex)
    contact = ex("SELECT v FROM ml_setting WHERE k='push_contact'")
    contact = contact[0]["v"] if contact and contact[0]["v"].startswith("mailto:") else "mailto:admin@localhost"
    out = {"sent": 0, "removed": 0, "failed": 0}
    for s in ex("SELECT id, endpoint, p256dh, auth FROM ml_push_sub"):
        if not endpoint_ok(s["endpoint"], extra):
            out["failed"] += 1
            continue
        try:
            st = send(s, {"title": title[:120], "body": text[:400], "url": url if url.startswith("/") else "/"}, key, contact=contact)
        except (OSError, ValueError) as e:
            ex("UPDATE ml_push_sub SET last_error=%s WHERE id=%s", (str(e)[:200], s["id"]))
            out["failed"] += 1
            continue
        if st in (404, 410):
            ex("DELETE FROM ml_push_sub WHERE id=%s", (s["id"],))
            out["removed"] += 1
        elif 200 <= st < 300:
            ex("UPDATE ml_push_sub SET last_ok=NOW(), last_error='' WHERE id=%s", (s["id"],))
            out["sent"] += 1
        else:
            ex("UPDATE ml_push_sub SET last_error=%s WHERE id=%s", (f"HTTP {st}", s["id"]))
            out["failed"] += 1
    return out


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 1
    cmd = a[0]
    if cmd == "keys":
        k = load_key(create=True)
        print(b64u(public_raw(k)))
        return 0
    ex = _db()
    if cmd == "add":
        if len(a) < 2:
            print("usage: webpush.py add ADMIN [UA] < subscription.json", file=sys.stderr)
            return 1
        try:
            print(add(ex, a[1], json.loads(sys.stdin.read(8192)), a[2] if len(a) > 2 else ""))
        except (ValueError, KeyError, TypeError) as e:
            print(f"refused: {e}", file=sys.stderr)
            return 1
        return 0
    if cmd == "del":
        ex("DELETE FROM ml_push_sub WHERE id=%s", (int(a[1]),))
        return 0
    if cmd == "list":
        rows = ex("SELECT id, admin, ua, SUBSTRING_INDEX(SUBSTRING_INDEX(endpoint, '/', 3), '/', -1) AS service, created, last_ok, last_error "
                  "FROM ml_push_sub ORDER BY created DESC")
        if "--json" in a:
            print(json.dumps([{k: (str(v) if v is not None else "") for k, v in r.items()} for r in rows]))
        else:
            for r in rows:
                print(f'{r["id"]:4} {r["admin"]:12} {r["service"]:32} {r["ua"][:40]:40} ok {r["last_ok"] or "-"} {r["last_error"] or ""}')
        return 0
    if cmd == "send":
        url = a[a.index("--url") + 1] if "--url" in a and a.index("--url") + 1 < len(a) else "/"
        pos = [x for i, x in enumerate(a) if i > 0 and x != "--url" and a[i - 1] != "--url"]
        print(json.dumps(send_all(ex, pos[0] if pos else "Test", pos[1] if len(pos) > 1 else "", url)))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
