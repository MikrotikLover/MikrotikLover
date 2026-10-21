#!/usr/bin/env python3
"""Allowed websites, automatically: for "allow-web SITE" in a policy, find what the site needs from other
places (fonts, CSS / JS libraries, image CDNs …) so the admin only types the site's name.

  webscan.py scan SITE [--url URL] [--dir DIR] [--allow-private]   read the site's pages now
  webscan.py auto [--cnf FILE] [--db NAME] [--dir DIR]             rescan old ones, learn from the DNS log
  webscan.py allow|ignore SITE NAME [--dir DIR]                    the admin's answer to a suggestion
  webscan.py show SITE [--dir DIR]                                 what is known (JSON)

Files: DIR/SITE.json (everything) and DIR/SITE.txt (the names to allow, read by webfilter/build.sh).
1. Scan: the home page and up to 4 of its own pages, their CSS files; every other host they load from.
   Trackers / ads are left out, embedded pages (iframes: maps, videos) only suggested.
2. Learning: a device in a policy with allow-web asks the site's name, and within 20 seconds other names
   the policy blocks — well-known helpers (fonts, CDNs) are allowed by themselves, the rest suggested.
"""
import html.parser, ipaddress, json, os, re, socket, ssl, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = "/var/lib/mikrotiklover/webscan"
POLICY_DIR = "/var/lib/mikrotiklover/policies"
MAX_BYTES, TIMEOUT, MAX_PAGES, MAX_CSS = 3_000_000, 15, 5, 12
SITE_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
# hosting shared by many companies: allow that host only, never the whole domain
SHARED = ("googleapis.com", "gstatic.com", "google.com", "googleusercontent.com", "amazonaws.com", "cloudfront.net",
          "akamaihd.net", "akamaized.net", "azureedge.net", "windows.net", "fastly.net", "cloudflare.com", "github.io",
          "herokuapp.com", "appspot.com", "firebaseapp.com", "fbcdn.net", "facebook.com", "facebook.net", "wp.com",
          "jsdelivr.net", "shopify.com", "myshopify.com", "wixstatic.com", "squarespace.com", "b-cdn.net", "bunnycdn.com")
# not needed for a page to work
TRACKERS = ("google-analytics.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com",
            "adservice.google.com", "connect.facebook.net", "facebook.net", "hotjar.com", "clarity.ms", "analytics.tiktok.com",
            "bat.bing.com", "scorecardresearch.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
            "amazon-adsystem.com", "adnxs.com", "yandex.ru", "mc.yandex.ru", "quantserve.com", "newrelic.com", "nr-data.net")
# well-known helpers: allowed by themselves when learned from the DNS log
HELPERS = ("fonts.googleapis.com", "fonts.gstatic.com", "ajax.googleapis.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net",
           "unpkg.com", "code.jquery.com", "maxcdn.bootstrapcdn.com", "stackpath.bootstrapcdn.com", "use.fontawesome.com",
           "kit.fontawesome.com", "ka-f.fontawesome.com", "cdninstagram.com", "cdn.shopify.com", "i0.wp.com", "i1.wp.com",
           "i2.wp.com", "s0.wp.com", "secure.gravatar.com", "fonts.bunny.net", "use.typekit.net", "p.typekit.net")


def registrable(host):
    try:
        import cdnmap
        return cdnmap.registrable(host)
    except Exception:                                     # noqa: BLE001
        p = host.split(".")
        return ".".join(p[-3:]) if len(p) > 2 and len(p[-1]) == 2 and p[-2] in ("com", "net", "org", "co", "gov", "edu") else ".".join(p[-2:])


def under(host, names):
    return any(host == n or host.endswith("." + n) for n in names)


def allow_name(host):
    """The name to allow for a host the site loads from: the whole domain, unless it is shared hosting."""
    reg = registrable(host)
    return host if under(reg, SHARED) else reg


def clean_site(s):
    s = str(s or "").strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s).split("/", 1)[0].split("?", 1)[0].split(":", 1)[0].strip(".")
    s = s[4:] if s.startswith("www.") else s
    return s if SITE_RE.match(s) else ""


# ---------------------------------------------------------------- fetching (public addresses only)
class Refused(Exception):
    pass


def check_host(host, allow_private=False):
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)}
    except OSError as e:
        raise Refused(f"{host}: name not found ({e.strerror or e})")
    for a in addrs:
        ip = ipaddress.ip_address(a)
        if not allow_private and not ip.is_global:
            raise Refused(f"{host}: {a} is not a public address")


def fetch(url, allow_private=False, accept="text/html,text/css,*/*"):
    """-> (final_url, text) — follows redirects, each hop checked."""
    ctx = ssl.create_default_context()
    for _ in range(6):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise Refused(f"not a web address: {url}")
        check_host(u.hostname, allow_private)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
                                                                 "Chrome/126.0 Mobile Safari/537.36", "Accept": accept,
                                                   "Accept-Encoding": "identity"})
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), NoRedirect)
        try:
            with opener.open(req, timeout=TIMEOUT) as r:
                body = r.read(MAX_BYTES)
                cs = r.headers.get_content_charset() or "utf-8"
                return r.geturl(), body.decode(cs, "replace")
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise Refused(f"{url}: HTTP {e.code}")
        except (urllib.error.URLError, OSError) as e:
            raise Refused(f"{url}: {getattr(e, 'reason', e)}")
    raise Refused(f"{url}: too many redirects")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Page(html.parser.HTMLParser):
    """Collects resource URLs (kind, url) and links to other pages."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.res, self.links, self.styles = [], [], []

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower()
        if tag == "script" and a.get("src"):
            self.res.append(("script", a["src"]))
        elif tag == "link" and a.get("href"):
            if "stylesheet" in rel:
                self.res.append(("css", a["href"]))
            elif any(x in rel for x in ("preconnect", "dns-prefetch", "preload", "icon", "modulepreload", "manifest")):
                self.res.append(("link", a["href"]))
        elif tag in ("img", "source", "video", "audio", "embed", "input") and (a.get("src") or a.get("srcset") or a.get("data-src")):
            for v in [a.get("src", ""), a.get("data-src", "")] + [x.strip().split(" ")[0] for x in (a.get("srcset") or a.get("data-srcset", "")).split(",")]:
                if v:
                    self.res.append(("image", v))
        elif tag == "iframe" and a.get("src"):
            self.res.append(("embed", a["src"]))
        elif tag == "meta" and a.get("property", "").lower() in ("og:image",) and a.get("content"):
            self.res.append(("image", a["content"]))
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if a.get("style") and "url(" in a["style"]:
            self.styles.append(a["style"])

    def handle_data(self, data):
        if "url(" in data or "@import" in data:
            self.styles.append(data)


CSS_URL = re.compile(r"""url\(\s*['"]?([^'")\s]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]""", re.I)


def scan(site, url=None, allow_private=False):
    """-> {hosts: {name: why}, skipped: {name: why}, embeds: {name: why}, pages, error}"""
    base = url or f"https://{site}/"
    found, pages, css_done, errors = {}, [], set(), []
    todo, seen = [base], set()

    def add(kind, ref, page_url):
        u = urllib.parse.urlsplit(urllib.parse.urljoin(page_url, ref.strip()))
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        h = u.hostname.lower().rstrip(".")
        found.setdefault(h, set()).add(kind)
        return u.geturl()

    while todo and len(pages) < MAX_PAGES:
        page_url = todo.pop(0)
        if page_url in seen:
            continue
        seen.add(page_url)
        try:
            final, text = fetch(page_url, allow_private)
        except Refused as e:
            errors.append(str(e))
            continue
        pages.append(final)
        p = Page()
        try:
            p.feed(text)
        except Exception:                                 # noqa: BLE001 — broken HTML: use what was read
            pass
        for kind, ref in p.res:
            full = add(kind, ref, final)
            if kind == "css" and full and full not in css_done and len(css_done) < MAX_CSS:
                css_done.add(full)
                try:
                    cfinal, css = fetch(full, allow_private, "text/css,*/*")
                    for m in CSS_URL.finditer(css):
                        add("css-file", m.group(1) or m.group(2), cfinal)
                except Refused as e:
                    errors.append(str(e))
        for s in p.styles:
            for m in CSS_URL.finditer(s):
                add("style", m.group(1) or m.group(2), final)
        if len(pages) == 1:                               # a few of the site's own pages (products, contact …)
            own = []
            for l in p.links:
                u = urllib.parse.urlsplit(urllib.parse.urljoin(final, l))
                if u.scheme in ("http", "https") and u.hostname and registrable(u.hostname.lower()) == registrable(site):
                    clean = urllib.parse.urlunsplit((u.scheme, u.netloc, u.path or "/", "", ""))
                    if clean not in own and clean != final:
                        own.append(clean)
            todo += own[:MAX_PAGES - 1]
    hosts, skipped, embeds = {}, {}, {}
    mine = registrable(site)
    for h, kinds in sorted(found.items()):
        if registrable(h) == mine:
            continue
        why = ", ".join(sorted(kinds))
        name = allow_name(h)
        if under(h, TRACKERS):
            skipped[name] = f"tracker / ads ({why})"
        elif kinds == {"embed"}:
            embeds[name] = f"embedded page ({h})"
        else:
            hosts.setdefault(name, why)
    return {"hosts": hosts, "skipped": skipped, "embeds": embeds, "pages": pages,
            "error": "" if pages else (errors[0] if errors else "nothing read"), "errors": errors[:5]}


# ---------------------------------------------------------------- state
def path(d, site, ext):
    return os.path.join(d, f"{site}.{ext}")


def load(d, site):
    try:
        return json.load(open(path(d, site, "json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {"site": site, "allowed": {}, "skipped": {}, "suggest": {}, "ignored": [], "scanned": 0, "error": ""}


def save(d, st):
    os.makedirs(d, exist_ok=True)
    names = sorted(st["allowed"])
    for ext, data in (("json", json.dumps(st, indent=1, sort_keys=True)), ("txt", "".join(n + "\n" for n in names))):
        tmp = path(d, st["site"], ext) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path(d, st["site"], ext))


def apply_scan(st, r):
    """Merge a scan into the state; -> True when the allowed names changed."""
    before = set(st["allowed"])
    st["allowed"] = {n: v for n, v in st["allowed"].items() if v.get("from") != "scan"}
    for n, why in r["hosts"].items():
        if n not in st["ignored"]:
            st["allowed"].setdefault(n, {"from": "scan", "why": why})
    st["skipped"] = r["skipped"]
    for n, why in r["embeds"].items():
        if n not in st["allowed"] and n not in st["ignored"]:
            st["suggest"].setdefault(n, {"count": 0, "why": why})
    st.update(scanned=int(time.time()), error=r["error"], pages=r["pages"])
    return set(st["allowed"]) != before


def cmd_scan(site, d, url=None, allow_private=False):
    st = load(d, site)
    r = scan(site, url, allow_private)
    changed = apply_scan(st, r)
    save(d, st)
    return st, r, changed


# ---------------------------------------------------------------- learning from the DNS log
def web_sites(policy_dir=POLICY_DIR):
    """{site: [policies]} from the allow-web lines."""
    out = {}
    for f in sorted(os.listdir(policy_dir)) if os.path.isdir(policy_dir) else []:
        if f.endswith(".txt") and f != "README.txt":
            for line in open(os.path.join(policy_dir, f), encoding="utf-8", errors="replace"):
                m = re.match(r"^\s*allow-web\s+(\S+)", line.split("#", 1)[0])
                if m and clean_site(m.group(1)):
                    out.setdefault(clean_site(m.group(1)), []).append(f[:-4])
    return out


def learn(lines, clients, sites, states, window=20):
    """lines: DNS log; clients: {ip: policy}; sites: {site: [policies]}. Adds suggestions / learned helpers.
    -> set of sites whose allowed names changed."""
    import mlreport
    changed, last = set(), {}
    for l in lines:
        m = mlreport.DNS_RE.match(l)
        if not m or m.group(4) not in clients:
            continue
        ts, name, ip = mlreport.ts_of(m.group(1)) or 0, m.group(3).lower().rstrip("."), m.group(4)
        pol = clients[ip]
        hit = next((s for s, pols in sites.items() if pol in pols and (under(name, [s]) or under(name, list(states[s]["allowed"])))), None)
        if hit:
            last[ip] = (hit, ts)
            continue
        if ip not in last or ts - last[ip][1] > window or not SITE_RE.match(name) or under(name, TRACKERS):
            continue
        site = last[ip][0]
        st = states[site]
        n = allow_name(name)
        if n in st["allowed"] or n in st["ignored"] or under(name, [site]) or under(name, list(st["allowed"])):
            continue
        helper = next((h for h in HELPERS if name == h or name.endswith("." + h)), None)
        if helper:                                        # open just that helper, not its whole domain
            st["allowed"][helper] = {"from": "learned", "why": f"asked right after {site} ({name})"}
            st["suggest"].pop(helper, None)
            changed.add(site)
        else:
            s = st["suggest"].setdefault(n, {"count": 0, "why": ""})
            s["count"] += 1
            s["why"] = f"asked right after {site} ({name})"
    return changed


def cmd_auto(d, cnf, db, policy_dir=POLICY_DIR, max_age=86400):
    import insights, mlreport
    sites = web_sites(policy_dir)
    states = {s: load(d, s) for s in sites}
    changed = set()
    for s, st in states.items():
        if time.time() - st.get("scanned", 0) > max_age:
            r = scan(s)
            if apply_scan(st, r):
                changed.add(s)
    if sites:
        rows = insights.mysql_rows(cnf, db)
        pols = {u: v[7:] for u, v in rows(mlreport.POLICY_SQL) if v.startswith("policy-")}
        since = min([st.get("learned_until", 0) for st in states.values()] + [time.time() - 3600])
        clients = {}
        for u, ip in rows(f"SELECT username, framedipaddress FROM radacct WHERE framedipaddress <> '' "
                          f"AND (acctstoptime IS NULL OR acctstoptime >= FROM_UNIXTIME({int(since)}))"):
            if u in pols:
                clients[ip] = pols[u]
        lines = [l for l in mlreport.read_lines(mlreport.DNS_LOG, since) if (mlreport.ts_of(l.split(" ", 1)[0]) or 0) >= since]
        changed |= learn(lines, clients, sites, states)
        for st in states.values():
            st["learned_until"] = int(time.time())
    for st in states.values():
        save(d, st)
    # sites no policy uses any more: forget them after 30 days
    for f in os.listdir(d) if os.path.isdir(d) else []:
        site, _, ext = f.rpartition(".")
        if ext in ("json", "txt") and site not in sites and time.time() - os.path.getmtime(os.path.join(d, f)) > 30 * 86400:
            os.unlink(os.path.join(d, f))
    return changed


def main():
    a = sys.argv[1:]
    opt = lambda k, dflt=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else dflt  # noqa: E731
    d = opt("--dir", DIR)
    cmd = a[0] if a else ""
    if cmd in ("scan", "show", "allow", "ignore"):
        site = clean_site(a[1] if len(a) > 1 else "")
        if not site:
            sys.exit("give a website name, e.g. example.com")
    if cmd == "scan":
        st, r, changed = cmd_scan(site, d, opt("--url"), "--allow-private" in a)
        if r["error"]:
            print(f"could not read {site}: {r['error']}")
            sys.exit(2)
        print(f"{site}: {len(r['pages'])} page(s) read")
        for n, v in sorted(st["allowed"].items()):
            print(f"  allow  {n:<34} {v['from']}: {v['why']}")
        for n, why in sorted(r["skipped"].items()):
            print(f"  skip   {n:<34} {why}")
        for n, v in sorted(st["suggest"].items()):
            print(f"  ask?   {n:<34} {v['why']}")
        print("changed" if changed else "no change")
    elif cmd == "show":
        print(json.dumps(load(d, site), indent=1, sort_keys=True))
    elif cmd in ("allow", "ignore"):
        name = (a[2] if len(a) > 2 else "").lower()
        if not SITE_RE.match(name):
            sys.exit("give a name, e.g. cdn.example.com")
        st = load(d, site)
        st["suggest"].pop(name, None)
        if cmd == "allow":
            st["allowed"][name] = {"from": "admin", "why": "allowed by the admin"}
            if name in st["ignored"]:
                st["ignored"].remove(name)
        else:
            st["allowed"].pop(name, None)
            if name not in st["ignored"]:
                st["ignored"].append(name)
        save(d, st)
        print(f"{site}: {name} {'allowed' if cmd == 'allow' else 'ignored'}")
    elif cmd == "auto":
        changed = cmd_auto(d, opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"), opt("--policies", POLICY_DIR))
        print(f"changed: {' '.join(sorted(changed)) or '-'}")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
