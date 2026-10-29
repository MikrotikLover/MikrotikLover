#!/usr/bin/env python3
"""tools/webpush.py: RFC 8291 test vector, VAPID signature, which addresses may be called.  python3 tests/test-webpush.py"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import webpush as w  # noqa: E402
from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: E402

fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {info}"))
    fails += 0 if cond else 1


def priv(d):
    return ec.derive_private_key(int.from_bytes(w.unb64u(d), "big"), ec.SECP256R1())


# RFC 8291 Appendix A
AS, UA = priv("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), priv("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
ua_pub, auth = w.b64u(w.public_raw(UA)), "BTBZMqHH6r4Tts7J_aSIgg"
body = w.encrypt(w.unb64u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"), ua_pub, auth, salt=w.unb64u("DGv6ra1nlYgDCS1FRnbzlw"), as_key=AS)
t("RFC 8291 test vector: the same bytes as the standard", w.b64u(body) == "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
t("the device decrypts it", w.decrypt(body, UA, auth) == b"When I grow up, I want to be a watermelon")
dev = ec.generate_private_key(ec.SECP256R1())
msg = json.dumps({"title": "Router down", "body": "ü ✓ 漢"}).encode()
t("round trip with a fresh device key (fresh salt / key each time)", w.decrypt(w.encrypt(msg, w.b64u(w.public_raw(dev)), "AAAAAAAAAAAAAAAAAAAAAA"), dev, "AAAAAAAAAAAAAAAAAAAAAA") == msg)
t("two sends of the same message differ (no replay pattern)", w.encrypt(msg, w.b64u(w.public_raw(dev)), "AAAAAAAAAAAAAAAAAAAAAA") != w.encrypt(msg, w.b64u(w.public_raw(dev)), "AAAAAAAAAAAAAAAAAAAAAA"))
try:
    w.encrypt(msg, "AAAA", "AAAAAAAAAAAAAAAAAAAAAA"); t("bad device key refused", False)
except ValueError:
    t("bad device key refused", True)
# VAPID
k = ec.generate_private_key(ec.SECP256R1())
hdr = w.vapid_header("https://fcm.googleapis.com/fcm/send/abc", k, "mailto:it@x.org", now=1700000000)
tok = dict(x.strip().split("=", 1) for x in hdr[6:].split(","))
head, claims, sig = tok["t"].split(".")
raw = w.unb64u(sig)
try:
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), w.unb64u(tok["k"])).verify(
        encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")), f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    good = True
except Exception:  # noqa: BLE001
    good = False
c = json.loads(w.unb64u(claims))
t("VAPID: ES256 signature checks with the public key k", good and json.loads(w.unb64u(head)) == {"typ": "JWT", "alg": "ES256"})
t("VAPID: audience = the push service, 12 h, contact", c == {"aud": "https://fcm.googleapis.com", "exp": 1700000000 + 43200, "sub": "mailto:it@x.org"})
# where the server may send
ok = [w.endpoint_ok(u) for u in ("https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
                                 "https://web.push.apple.com/QAbc", "https://db5p.notify.windows.com/w/?token=x")]
bad = [w.endpoint_ok(u) for u in ("http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.net/x", "https://evil.net/fcm.googleapis.com",
                                  "https://192.168.1.1/x", "http://127.0.0.1:8099/api/users", "file:///etc/passwd", "https://" + "a" * 1100)]
t("the browsers' push services allowed", all(ok), ok)
t("anything else refused (no requests to the LAN or this server)", not any(bad), bad)
t("an extra test address: only when named, http only on loopback", w.endpoint_ok("http://127.0.0.1:9911/x", ("127.0.0.1:9911",))
  and not w.endpoint_ok("http://10.0.0.5:9911/x", ("10.0.0.5:9911",)) and not w.endpoint_ok("http://127.0.0.1:9912/x", ("127.0.0.1:9911",)))
print("all webpush tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
