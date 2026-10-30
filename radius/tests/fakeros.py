#!/usr/bin/env python3
"""A small RouterOS API server for tests (api-ssl like a MikroTik): login, address-list add / print / remove, identity.
  fakeros.py PORT USER PASSWORD STATE.json [--plain]
The address list is written to STATE.json after every change (with the time each entry was added)."""
import json, os, socket, ssl, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from rosapi import dec_len, sentence  # noqa: E402

port, user, pw, state = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
plain = "--plain" in sys.argv
items, lock, nid = [], threading.Lock(), [1]


def dump():
    json.dump(items, open(state + ".tmp", "w"))
    os.replace(state + ".tmp", state)


def serve(conn):
    buf = [b""]

    def read(n):
        while len(buf[0]) < n:
            c = conn.recv(65536)
            if not c:
                raise EOFError
            buf[0] += c
        out, buf[0] = buf[0][:n], buf[0][n:]
        return out

    logged = False
    try:
        while True:
            words = []
            while True:
                n = dec_len(read)
                if n == 0:
                    break
                words.append(read(n).decode())
            if not words:
                continue
            cmd, attrs, query = words[0], {}, {}
            for w in words[1:]:
                if w.startswith("="):
                    k, _, v = w[1:].partition("=")
                    attrs[k] = v
                elif w.startswith("?"):
                    k, _, v = w[1:].partition("=")
                    query[k] = v
            out = []
            if cmd == "/login":
                if attrs.get("name") == user and attrs.get("password") == pw:
                    logged = True
                    out.append(["!done"])
                else:
                    out += [["!trap", "=message=invalid user name or password (6)"], ["!done"]]
            elif not logged:
                out += [["!fatal", "not logged in"]]
            elif cmd == "/system/identity/print":
                out += [["!re", "=name=FakeRouter"], ["!done"]]
            elif cmd == "/ip/firewall/address-list/add":
                with lock:
                    if any(i["list"] == attrs.get("list") and i["address"] == attrs.get("address") for i in items):
                        out += [["!trap", "=message=failure: already have such entry"], ["!done"]]
                    else:
                        items.append({".id": f"*{nid[0]:X}", "list": attrs.get("list"), "address": attrs.get("address"),
                                      "timeout": attrs.get("timeout", ""), "comment": attrs.get("comment", ""), "at": time.time()})
                        nid[0] += 1
                        dump()
                        out += [["!done", f"=ret={items[-1]['.id']}"]]
            elif cmd == "/ip/firewall/address-list/print":
                with lock:
                    for i in items:
                        if all(i.get(k) == v for k, v in query.items()):
                            out.append(["!re", f"=.id={i['.id']}", f"=list={i['list']}", f"=address={i['address']}"])
                out.append(["!done"])
            elif cmd == "/ip/firewall/address-list/remove":
                with lock:
                    items[:] = [i for i in items if i[".id"] != attrs.get(".id")]
                    dump()
                out.append(["!done"])
            else:
                out += [["!trap", "=message=no such command"], ["!done"]]
            conn.sendall(b"".join(sentence(s) for s in out))
            if out and out[0][0] == "!fatal":
                break
    except (EOFError, OSError):
        pass
    finally:
        conn.close()


d = tempfile.mkdtemp()
ctx = None
if not plain:
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{d}/k", "-out", f"{d}/c", "-days", "3", "-subj", "/CN=ml-api"],
                   capture_output=True, check=True)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(f"{d}/c", f"{d}/k")
dump()
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(16)
print("ready", flush=True)
while True:
    c, _ = srv.accept()
    try:
        c = ctx.wrap_socket(c, server_side=True) if ctx else c
    except (ssl.SSLError, OSError):
        c.close()
        continue
    threading.Thread(target=serve, args=(c,), daemon=True).start()
