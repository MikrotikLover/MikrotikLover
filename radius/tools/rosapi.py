#!/usr/bin/env python3
"""Instant blocks on the MikroTik routers through the RouterOS API (api-ssl, port 8729).

The IPS normally reaches the routers through the 1-minute router script (ml-live). With a router added here, the
server puts a blocked address straight into the router's ml-ips list the moment Suricata sees the attack (~1 s),
and takes it out again on unblock. The 1-minute script stays as the safety net.

Routers and their API passwords live in a root-only file (/etc/mikrotiklover-radius/router-api.json), not in the
database. The router's TLS certificate is remembered on the first connection; a different one later is refused.

  rosapi.py add ROUTER-IP [--port 8729] [--user mlapi] [--plain]   -> new password + the script to paste on the router
  rosapi.py list | test ROUTER-IP | del ROUTER-IP | forget-cert ROUTER-IP
  rosapi.py block IP SECONDS REASON  /  unblock IP                    (what ips.py calls)
"""
import argparse, hashlib, ipaddress, json, os, re, secrets, socket, ssl, sys, time

STORE = os.environ.get("ML_ROUTER_API", "/etc/mikrotiklover-radius/router-api.json")
LIST = "ml-ips"


class ApiError(Exception):
    pass


# ------------------------------------------------------------------ the RouterOS API protocol
def enc_len(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return (n | 0x8000).to_bytes(2, "big")
    if n < 0x200000:
        return (n | 0xC00000).to_bytes(3, "big")
    if n < 0x10000000:
        return (n | 0xE0000000).to_bytes(4, "big")
    return b"\xf0" + n.to_bytes(4, "big")


def dec_len(read):
    b = read(1)[0]
    if b < 0x80:
        return b
    if b < 0xC0:
        return ((b & 0x3F) << 8) | read(1)[0]
    if b < 0xE0:
        return ((b & 0x1F) << 16) | int.from_bytes(read(2), "big")
    if b < 0xF0:
        return ((b & 0x0F) << 24) | int.from_bytes(read(3), "big")
    return int.from_bytes(read(4), "big")


def sentence(words):
    return b"".join(enc_len(len(w.encode())) + w.encode() for w in words) + b"\0"


class Api:
    """One connection. talk(['/ip/firewall/address-list/add', '=list=x', ...]) -> [('!re'|'!done'|'!trap', {k: v})]."""

    def __init__(self, host, port=8729, tls=True, fingerprint="", timeout=5.0):
        self.host = host
        raw = socket.create_connection((host, port), timeout=timeout)
        if tls:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE          # a router's own certificate: pinned by its fingerprint below
            self.sock = ctx.wrap_socket(raw, server_hostname=host)
            der = self.sock.getpeercert(binary_form=True) or b""
            self.fingerprint = hashlib.sha256(der).hexdigest()
            if fingerprint and fingerprint != self.fingerprint:
                self.sock.close()
                raise ApiError(f"{host}: the router's certificate changed (was {fingerprint[:16]}…, now {self.fingerprint[:16]}…) — "
                               "if you changed it yourself: rosapi.py forget-cert " + host)
        else:
            self.sock, self.fingerprint = raw, ""
        self.buf = b""

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ApiError(f"{self.host}: connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _sentence(self):
        words = []
        while True:
            n = dec_len(self._read)
            if n == 0:
                return words
            words.append(self._read(n).decode("utf-8", "replace"))

    def talk(self, words):
        self.sock.sendall(sentence(words))
        out = []
        while True:
            s = self._sentence()
            if not s:
                continue
            attrs = {}
            for w in s[1:]:
                if w.startswith("="):
                    k, _, v = w[1:].partition("=")
                    attrs[k] = v
            out.append((s[0], attrs))
            if s[0] in ("!done", "!fatal"):
                return out

    def login(self, user, password):
        r = self.talk(["/login", f"=name={user}", f"=password={password}"])
        trap = [a for t, a in r if t in ("!trap", "!fatal")]
        if trap:
            raise ApiError(f"{self.host}: login refused ({trap[0].get('message', 'wrong user or password')})")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------------ routers
def load():
    try:
        return json.load(open(STORE))
    except (OSError, ValueError):
        return {}


def save(d):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    tmp = STORE + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, STORE)


def connect(ip, r):
    api = Api(ip, int(r.get("port", 8729)), not r.get("plain"), r.get("fingerprint", ""))
    api.login(r.get("user", "mlapi"), r["password"])
    return api


def remember(ip, api, note):
    d = load()
    if ip in d:
        if api.fingerprint and not d[ip].get("fingerprint"):
            d[ip]["fingerprint"] = api.fingerprint
        d[ip]["last"] = time.strftime("%Y-%m-%d %H:%M:%S")
        d[ip]["status"] = note
        save(d)


def note_fail(ip, msg):
    d = load()
    if ip in d:
        d[ip]["last"] = time.strftime("%Y-%m-%d %H:%M:%S")
        d[ip]["status"] = "failed: " + str(msg)[:160]
        save(d)


def clean(s):
    return re.sub(r"[^\w .,:()/-]", "", str(s))[:60]


def push_block(ip, seconds, reason, routers=None):
    """-> {router: 'ok' | error}. 'already have such entry' counts as ok."""
    out = {}
    for rip, r in (routers or load()).items():
        try:
            api = connect(rip, r)
            try:
                res = api.talk(["/ip/firewall/address-list/add", f"=list={LIST}", f"=address={ip}", f"=timeout={int(seconds)}s",
                                f"=comment=mlips: {clean(reason)}"])
                trap = [a.get("message", "") for t, a in res if t == "!trap"]
                if trap and "already have" not in trap[0]:
                    raise ApiError(trap[0])
                out[rip] = "ok"
                remember(rip, api, "ok")
            finally:
                api.close()
        except (OSError, ApiError, ssl.SSLError) as e:
            out[rip] = str(e)[:160]
            note_fail(rip, e)
    return out


def push_unblock(ip, routers=None):
    out = {}
    for rip, r in (routers or load()).items():
        try:
            api = connect(rip, r)
            try:
                ids = [a.get(".id") for t, a in api.talk(["/ip/firewall/address-list/print", "=.proplist=.id", f"?list={LIST}", f"?address={ip}"])
                       if t == "!re" and a.get(".id")]
                for i in ids:
                    api.talk(["/ip/firewall/address-list/remove", f"=.id={i}"])
                out[rip] = f"ok ({len(ids)} removed)"
                remember(rip, api, "ok")
            finally:
                api.close()
        except (OSError, ApiError, ssl.SSLError) as e:
            out[rip] = str(e)[:160]
            note_fail(rip, e)
    return out


def router_script(server_ip, user, password, port=8729, plain=False):
    """What to paste on the router once (Terminal): a user that can only use the API, from this server only."""
    svc = "api" if plain else "api-ssl"
    lines = ["# MikrotikLover: instant IPS blocks through the API (only from the RADIUS server)",
             "/user group remove [find name=\"mikrotiklover-api\"]",
             "/user group add name=mikrotiklover-api policy=api,read,write comment=\"MikrotikLover IPS: address lists\"",
             f"/user remove [find name=\"{user}\"]",
             f"/user add name={user} group=mikrotiklover-api address={server_ip}/32 password=\"{password}\" comment=\"MikrotikLover IPS\""]
    if not plain:
        lines += [":if ([:len [/certificate find name=\"ml-api\"]] = 0) do={",
                  "  /certificate add name=ml-api common-name=ml-api days-valid=3650 key-size=2048 key-usage=digital-signature,key-encipherment,tls-server",
                  "  /certificate sign ml-api",
                  "  :delay 8s",
                  "}",
                  f"/ip service set api-ssl certificate=ml-api port={port} address={server_ip}/32 disabled=no"]
    else:
        lines.append(f"/ip service set api port={port} address={server_ip}/32 disabled=no")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("ip")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--user", default="mlapi")
    p.add_argument("--plain", action="store_true", help="API without TLS (port 8728): only on a trusted LAN")
    p.add_argument("--server", default="", help="this server's IP as the router sees it")
    p.add_argument("--password", default="", help="use this password instead of a new one")
    sub.add_parser("list")
    for k in ("test", "del", "forget-cert"):
        sub.add_parser(k).add_argument("ip")
    p = sub.add_parser("block")
    p.add_argument("ip")
    p.add_argument("seconds", type=int)
    p.add_argument("reason", nargs="*")
    sub.add_parser("unblock").add_argument("ip")
    a = ap.parse_args(argv)
    if a.cmd in ("add", "test", "del", "forget-cert", "block", "unblock"):
        try:
            ipaddress.IPv4Address(a.ip)
        except ValueError:
            raise SystemExit(f"bad address '{a.ip}'")
    d = load()
    if a.cmd == "add":
        if not re.match(r"^[A-Za-z0-9_-]{1,32}$", a.user):
            raise SystemExit("bad user name")
        if not a.server:
            raise SystemExit("this server's IP is needed (--server)")
        pw = a.password or secrets.token_urlsafe(18).replace("-", "x").replace("_", "y")
        port = a.port or (8728 if a.plain else 8729)
        d[a.ip] = {"port": port, "user": a.user, "password": pw, "plain": a.plain, "fingerprint": "", "added": time.strftime("%Y-%m-%d %H:%M"),
                   "status": "waiting for the router script", "last": ""}
        save(d)
        sys.stdout.write(router_script(a.server, a.user, pw, port, a.plain))
        return 0
    if a.cmd == "list":
        json.dump({ip: {k: v for k, v in r.items() if k != "password"} for ip, r in d.items()}, sys.stdout)
        return 0
    if a.cmd in ("test", "del", "forget-cert") and a.ip not in d:
        raise SystemExit(f"router {a.ip} is not set up for instant blocks")
    if a.cmd == "del":
        del d[a.ip]
        save(d)
        print(f"{a.ip}: instant blocks off (the 1-minute list still works)")
        return 0
    if a.cmd == "forget-cert":
        d[a.ip]["fingerprint"] = ""
        save(d)
        print(f"{a.ip}: certificate forgotten; the next connection is trusted")
        return 0
    if a.cmd == "test":
        t0 = time.time()
        try:
            api = connect(a.ip, d[a.ip])
            ident = [x.get("name") for t, x in api.talk(["/system/identity/print"]) if t == "!re"]
            remember(a.ip, api, "ok")
            api.close()
        except (OSError, ApiError, ssl.SSLError) as e:
            note_fail(a.ip, e)
            raise SystemExit(f"{a.ip}: {e}")
        print(f"{a.ip}: connected as {d[a.ip].get('user')} to '{(ident or ['?'])[0]}' in {int((time.time() - t0) * 1000)} ms")
        return 0
    if a.cmd == "block":
        print(json.dumps(push_block(a.ip, a.seconds, " ".join(a.reason) or "by the admin")))
        return 0
    print(json.dumps(push_unblock(a.ip)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
