#!/usr/bin/env python3
"""A fake browser push service for the tests: checks the VAPID signature like FCM / Mozilla / Apple do, decrypts the
message with the device's key and writes what came to a file. /gone/* answers 410 (the device unsubscribed).
  fakepush.py PORT KEYFILE(device private key PEM) AUTH OUTFILE"""
import base64, json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import webpush  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: E402
from cryptography.exceptions import InvalidSignature  # noqa: E402

PORT, KEYF, AUTH, OUT = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
UA = serialization.load_pem_private_key(open(KEYF, "rb").read(), None)


def vapid_ok(h, aud):
    try:
        t = dict(x.strip().split("=", 1) for x in h[len("vapid "):].split(","))
        head, claims, sig = t["t"].split(".")
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(t["k"]))
        raw = webpush.unb64u(sig)
        pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                   f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
        c = json.loads(webpush.unb64u(claims))
        return c["aud"] == aud and c["sub"].startswith("mailto:")
    except (KeyError, ValueError, InvalidSignature):
        return False


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.startswith("/gone/"):
            self.send_response(410); self.end_headers(); return
        ok = vapid_ok(self.headers.get("Authorization", ""), f"http://127.0.0.1:{PORT}") and self.headers.get("Content-Encoding") == "aes128gcm"
        try:
            msg = json.loads(webpush.decrypt(body, UA, AUTH)) if ok else None
        except Exception:  # noqa: BLE001
            msg = None
        with open(OUT, "a") as f:
            f.write(json.dumps({"path": self.path, "vapid": ok, "ttl": self.headers.get("TTL"), "msg": msg}) + "\n")
        self.send_response(201 if msg else 400); self.end_headers()


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
