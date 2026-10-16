#!/usr/bin/env python3
"""MikrotikLover traffic collector: data download/upload per client IP, per user, per website.

* Receives MikroTik Traffic Flow (NetFlow v9 or IPFIX) on UDP 2055.
* Finds the LAN client in every flow record from ALL its IPv4 fields (pre- and post-NAT),
  so it works whether the router reports the private or the NATed address.
* Names the remote side with the DNS logger's answers (dnsmasq log-queries=extra):
  the IP that client X got for www.youtube.com is counted as youtube.com for client X.
* Adds hourly totals to MariaDB table traffic_site (bucket, client_ip, username, site, down, up)
  and writes the last minute to /run/mikrotiklover/traffic-now.json ("radius-admin traffic now").

Run by systemd (mikrotiklover-traffic.service); config from /etc/mikrotiklover-radius/radius.conf.
"""
import ipaddress, json, os, re, socket, struct, sys, time
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mlreport import base_domain  # noqa: E402  (same directory)

CONF = "/etc/mikrotiklover-radius/radius.conf"
DNS_LOG = os.environ.get("MLREPORT_LOGDIR", "/var/log/mikrotik") + "/dns.log"
NOW_FILE = "/run/mikrotiklover/traffic-now.json"
FLUSH_EVERY = int(os.environ.get("MLR_FLUSH", 60))

# IPFIX / NetFlow v9 information elements we use
IE_BYTES, IE_BYTES_TOTAL, IE_PKTS, IE_PROTO = 1, 85, 2, 4
IE_SRC4, IE_DST4, IE_SPORT, IE_DPORT = 8, 12, 7, 11
IE_NAT_SRC4, IE_NAT_DST4, IE_NAT_SPORT, IE_NAT_DPORT = 225, 226, 227, 228
IE_TIMES = (21, 22, 150, 151, 152, 153)


def read_conf(path=CONF):
    conf = {}
    try:
        for line in open(path):
            m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
            if m:
                conf[m.group(1)] = m.group(2).strip('"')
    except OSError:
        pass
    return conf


# ------------------------------------------------------------------ flow decoding
class Decoder:
    """NetFlow v9 + IPFIX decoder with per-exporter template cache."""

    def __init__(self):
        self.templates = {}

    def decode(self, data, exporter):
        if len(data) < 4:
            return []
        version = struct.unpack("!H", data[:2])[0]
        if version == 9:
            return self._v9(data, exporter)
        if version == 10:
            return self._ipfix(data, exporter)
        return []

    def _v9(self, data, exporter):
        if len(data) < 20:
            return []
        _, _, _, _, _, source_id = struct.unpack("!HHIIII", data[:20])
        return self._sets(data[20:], (exporter, 9, source_id), tmpl_ids=(0,), opt_ids=(1,))

    def _ipfix(self, data, exporter):
        if len(data) < 16:
            return []
        _, length, _, _, domain = struct.unpack("!HHIII", data[:16])
        return self._sets(data[16:length], (exporter, 10, domain), tmpl_ids=(2,), opt_ids=(3,), ipfix=True)

    def _sets(self, body, key, tmpl_ids, opt_ids, ipfix=False):
        out, off = [], 0
        while off + 4 <= len(body):
            set_id, set_len = struct.unpack("!HH", body[off:off + 4])
            if set_len < 4:
                break
            content = body[off + 4:off + set_len]
            off += set_len
            if set_id in tmpl_ids:
                self._templates(content, key, ipfix)
            elif set_id in opt_ids:
                continue
            elif set_id >= 256:
                tmpl = self.templates.get(key + (set_id,))
                if tmpl:
                    out.extend(self._records(content, tmpl))
        return out

    def _templates(self, content, key, ipfix):
        off = 0
        while off + 4 <= len(content):
            tid, count = struct.unpack("!HH", content[off:off + 4])
            off += 4
            fields = []
            for _ in range(count):
                if off + 4 > len(content):
                    return
                ftype, flen = struct.unpack("!HH", content[off:off + 4])
                off += 4
                enterprise = False
                if ipfix and ftype & 0x8000:
                    ftype &= 0x7FFF
                    enterprise = True
                    off += 4
                fields.append((ftype, flen, enterprise))
            self.templates[key + (tid,)] = fields

    @staticmethod
    def _records(content, tmpl):
        recs, off = [], 0
        fixed = all(l != 65535 for _, l, _ in tmpl)
        size = sum(l for _, l, _ in tmpl) if fixed else 0
        while off < len(content):
            if fixed and off + size > len(content):
                break
            rec, ok = {}, True
            for ftype, flen, ent in tmpl:
                if flen == 65535:
                    if off >= len(content):
                        ok = False
                        break
                    flen = content[off]
                    off += 1
                    if flen == 255:
                        flen = struct.unpack("!H", content[off:off + 2])[0]
                        off += 2
                raw = content[off:off + flen]
                off += flen
                if len(raw) < flen:
                    ok = False
                    break
                if ent:
                    continue
                if ftype in (IE_SRC4, IE_DST4, IE_NAT_SRC4, IE_NAT_DST4) and flen == 4:
                    rec[ftype] = socket.inet_ntoa(raw)
                elif flen <= 8:
                    rec[ftype] = int.from_bytes(raw, "big")
            if not ok:
                break
            if rec:
                recs.append(rec)
        return recs


# ------------------------------------------------------------------ classification
class Classifier:
    def __init__(self, lan_nets):
        self.lan = [ipaddress.ip_network(n) for n in lan_nets]

    def is_lan(self, ip):
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in n for n in self.lan)

    def classify(self, rec):
        """-> (client_ip, remote_ip, 'up'|'down', bytes, dedupe_key) or None."""
        nbytes = rec.get(IE_BYTES, rec.get(IE_BYTES_TOTAL, 0))
        if not nbytes:
            return None
        srcs = [rec.get(IE_SRC4), rec.get(IE_NAT_SRC4)]
        dsts = [rec.get(IE_DST4), rec.get(IE_NAT_DST4)]
        src_client = next((ip for ip in srcs if ip and self.is_lan(ip)), None)
        dst_client = next((ip for ip in dsts if ip and self.is_lan(ip)), None)
        src_remote = next((ip for ip in srcs if ip and not self.is_lan(ip)), None)
        dst_remote = next((ip for ip in dsts if ip and not self.is_lan(ip)), None)
        if src_client and dst_remote and not dst_client:
            client, remote, direction = src_client, dst_remote, "up"
            cport, rport = rec.get(IE_SPORT, 0), rec.get(IE_DPORT, 0)
        elif dst_client and src_remote and not src_client:
            client, remote, direction = dst_client, src_remote, "down"
            cport, rport = rec.get(IE_DPORT, 0), rec.get(IE_SPORT, 0)
        else:
            return None  # LAN<->LAN, router itself, or the client is not visible in this record
        # The same packets can be reported on the LAN and the WAN interface: identical
        # (client, remote, ports, proto, times, bytes) means a duplicate.
        times = tuple(rec.get(t, 0) for t in IE_TIMES)
        key = (client, cport, remote, rport, rec.get(IE_PROTO, 0), direction, nbytes, times)
        return client, remote, direction, nbytes, key


class Dedupe:
    def __init__(self, ttl=600):
        self.seen, self.ttl = OrderedDict(), ttl

    def first(self, key, now):
        while self.seen and next(iter(self.seen.values())) < now - self.ttl:
            self.seen.popitem(last=False)
        if key in self.seen:
            return False
        self.seen[key] = now
        return True


# ------------------------------------------------------------------ DNS answers -> site names
EXTRA_RE = re.compile(r"\b(\d+) (\d+\.\d+\.\d+\.\d+)/\d+ (query\[\w+\]|reply|cached|config) (\S+)(?: is (\S+))?")


class DnsNames:
    """(client_ip, answer_ip) -> queried name, from dnsmasq 'log-queries=extra' lines."""

    def __init__(self, ttl=7200):
        self.serial, self.by_client, self.by_ip, self.ttl = {}, {}, {}, ttl

    def feed(self, line, now):
        m = EXTRA_RE.search(line)
        if not m:
            return
        serial, client, action, name, answer = m.groups()
        if action.startswith("query"):
            self.serial[serial] = (client, name.rstrip(".").lower(), now)
            if len(self.serial) > 50000:
                for k in list(self.serial)[:10000]:
                    del self.serial[k]
            return
        q = self.serial.get(serial)
        if not q or not answer or not re.match(r"^\d+\.\d+\.\d+\.\d+$", answer):
            return
        qclient, qname, _ = q
        self.by_client[(qclient, answer)] = (qname, now)
        self.by_ip[answer] = (qname, now)

    def prune(self, now):
        for d in (self.by_client, self.by_ip):
            for k in [k for k, (_, ts) in d.items() if ts < now - self.ttl]:
                del d[k]

    def site(self, client, remote):
        hit = self.by_client.get((client, remote)) or self.by_ip.get(remote)
        return base_domain(hit[0]) if hit else remote


class Tail:
    def __init__(self, path, prime_bytes=4_000_000):
        self.path, self.fh, self.ino, self.prime = path, None, None, prime_bytes

    def lines(self):
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        if self.fh is None or st.st_ino != self.ino:
            self.fh = open(self.path, encoding="utf-8", errors="replace")
            self.ino = st.st_ino
            if self.prime:  # start with the recent past so existing connections get names
                self.fh.seek(max(0, st.st_size - self.prime))
                self.fh.readline()
                self.prime = 0
        return self.fh.readlines()


# ------------------------------------------------------------------ storage
class Store:
    def __init__(self, conf):
        import pymysql
        self.pymysql, self.conf, self.db = pymysql, conf, None

    def conn(self):
        if self.db is None:
            self.db = self.pymysql.connect(unix_socket="/run/mysqld/mysqld.sock", user=self.conf.get("DB_USER", "radius"),
                                           password=self.conf.get("DB_PASS", ""), database=self.conf.get("DB_NAME", "radius"),
                                           autocommit=True, connect_timeout=10)
        return self.db

    def users(self):
        """client IP -> username of the RADIUS session active now."""
        with self.conn().cursor() as c:
            c.execute("SELECT framedipaddress, username FROM radacct WHERE acctstoptime IS NULL "
                      "AND framedipaddress <> '' ORDER BY acctstarttime")
            return {ip: u for ip, u in c.fetchall()}

    def exporters(self):
        with self.conn().cursor() as c:
            c.execute("SELECT nasname FROM nas")
            return [r[0] for r in c.fetchall()]

    def write(self, rows, keep_days):
        sql = ("INSERT INTO traffic_site (bucket, client_ip, username, site, bytes_down, bytes_up, flows) "
               "VALUES (%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE username=VALUES(username), "
               "bytes_down=bytes_down+VALUES(bytes_down), bytes_up=bytes_up+VALUES(bytes_up), flows=flows+VALUES(flows)")
        try:
            with self.conn().cursor() as c:
                c.executemany(sql, rows)
                if int(time.time()) % 3600 < FLUSH_EVERY:
                    c.execute("DELETE FROM traffic_site WHERE bucket < NOW() - INTERVAL %s DAY", (keep_days,))
        except self.pymysql.MySQLError:
            self.db = None
            raise


def main():
    conf = read_conf()
    port = int(conf.get("TRAFFIC_PORT", 2055))
    lan = conf.get("LAN_NETS", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10").split(",")
    keep_days = int(conf.get("TRAFFIC_DAYS", 90))
    store = Store(conf)
    decoder, cls, dedupe, names = Decoder(), Classifier(lan), Dedupe(), DnsNames()
    tail = Tail(DNS_LOG)
    allowed = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]
    try:
        allowed += [n for n in store.exporters()]
    except Exception as e:  # DB down at boot: private networks only until the next restart
        print(f"warning: cannot read NAS list: {e}", file=sys.stderr)
    allowed_nets = []
    for n in allowed:
        try:
            allowed_nets.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            pass

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    sock.bind(("0.0.0.0", port))
    sock.settimeout(1.0)
    os.makedirs(os.path.dirname(NOW_FILE), exist_ok=True)
    print(f"traffic collector listening on udp/{port}, LAN {','.join(lan)}", flush=True)

    agg, last_flush, rejected = {}, time.time(), 0
    while True:
        now = time.time()
        try:
            data, (addr, _) = sock.recvfrom(65535)
            if any(ipaddress.ip_address(addr) in n for n in allowed_nets):
                for line in tail.lines():
                    names.feed(line, now)
                for rec in decoder.decode(data, addr):
                    r = cls.classify(rec)
                    if not r or not dedupe.first(r[4], now):
                        continue
                    client, remote, direction, nbytes, _ = r
                    a = agg.setdefault((client, names.site(client, remote)), [0, 0, 0])
                    a[0 if direction == "down" else 1] += nbytes
                    a[2] += 1
            else:
                rejected += 1
        except socket.timeout:
            pass
        if now - last_flush >= FLUSH_EVERY:
            for line in tail.lines():
                names.feed(line, now)
            names.prune(now)
            interval, last_flush = now - last_flush, now
            try:
                users = store.users()
            except Exception as e:
                print(f"warning: sessions: {e}", file=sys.stderr, flush=True)
                users = {}
            bucket = time.strftime("%Y-%m-%d %H:00:00", time.localtime(now))
            rows = [(bucket, c, users.get(c, ""), s, v[0], v[1], v[2]) for (c, s), v in agg.items()]
            snapshot = {"time": int(now), "interval": round(interval, 1),
                        "rows": [{"ip": c, "user": users.get(c, ""), "site": s, "down": v[0], "up": v[1]}
                                 for (c, s), v in agg.items()]}
            try:
                if rows:
                    store.write(rows, keep_days)
                agg = {}
            except Exception as e:  # keep the counters and retry on the next flush
                print(f"warning: database write failed, retrying: {e}", file=sys.stderr, flush=True)
            tmp = NOW_FILE + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(snapshot, fh)
            os.replace(tmp, NOW_FILE)
            if rejected:
                print(f"warning: ignored {rejected} packets from unknown exporters", file=sys.stderr, flush=True)
                rejected = 0


if __name__ == "__main__":
    main()
