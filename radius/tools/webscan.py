#!/usr/bin/env python3
"""Allowed websites, automatically: for "allow-web SITE" in a policy, find what the site needs from other
places (fonts, CSS / JS libraries, image CDNs …) so the admin only types the site's name.

  webscan.py scan SITE [--deep] [--background] [--url URL] [--dir DIR] [--allow-private]
                  quick: the home page + 4 pages; --deep: the sitemap, up to 150 pages and the JS files
  webscan.py auto [--cnf FILE] [--db NAME] [--dir DIR]   read old sites deeply again, learn from the DNS log
  webscan.py allow|ignore KEY NAME [--dir DIR]           the admin's answer (KEY: a site, app-NAME or ao-PROFILE;
                                                         NAME: a name, or 'NET/24 udp PORT' for a direct connection)
  webscan.py show KEY [--dir DIR]                        what is known (JSON)
  webscan.py list [--dir DIR]                            one line each

Files: DIR/SITE.json (everything) and DIR/SITE.txt (the names to allow, read by webfilter/build.sh).
1. Scan: the home page and up to 4 of its own pages, their CSS files; every other host they load from.
   Trackers / ads are left out, embedded pages (iframes: maps, videos) only suggested.
   Deep: robots.txt / sitemap.xml, up to 150 pages (4 at a time, 4 minutes at most) and the site's JS files,
   whose web addresses count when they look like files (cdn, static, img, media, fonts …), else are asked.
2. Learning, also for apps (allow-app) and app profiles (allow-only): a device of the policy asks one of
   its names and within 20 seconds others the policy blocks — well-known helpers are allowed by themselves,
   the rest is suggested (Allow / Ignore). An app profile's "host" lines name its company: other names
   under that domain (not denied by deny-sni) are allowed by themselves.
3. Ports: the ports each one's names use (traffic collector, ml_app_port), and connections to bare addresses
   (P2P, relays, cameras) the policy blocked right after it was used — suggested as 'NET/24 proto PORT';
   allowed ones go to DIR/KEY.nets, opened by the router only for that network and port.
"""
import html.parser, ipaddress, json, os, re, socket, ssl, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DIR = "/var/lib/mikrotiklover/webscan"
POLICY_DIR = "/var/lib/mikrotiklover/policies"
MAX_BYTES, TIMEOUT, MAX_PAGES, MAX_CSS = 3_000_000, 15, 5, 12
DEEP_PAGES, DEEP_SECONDS, DEEP_JS, WORKERS = 150, 240, 40, 4
AO_DIR = "/var/lib/mikrotiklover/allowonly"
KEY_RE = re.compile(r"^(app|ao)-[a-z0-9][a-z0-9-]{0,40}$")
# names in JS that look like file hosts (allowed); other names found in JS are only suggested
ASSET_HINT = re.compile(r"(^|[.-])(cdn|static|img|imgs|image|images|media|assets?|fonts?|files?|content|s3|storage|uploads?|photos?|pics?|videos?|thumbs?)([.\d-]|$)")
# names in code that are never what a page loads
NOISE = ("w3.org", "schema.org", "github.com", "reactjs.org", "mozilla.org", "example.com", "example.org", "localhost",
         "jquery.com", "npmjs.com", "apache.org", "opensource.org", "ietf.org", "whatwg.org", "wikipedia.org")
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
    """Collects resource URLs (kind, url), links to other pages, inline styles and inline scripts."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.res, self.links, self.styles, self.scripts, self._in_script = [], [], [], [], False

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower()
        if tag == "script":
            if a.get("src"):
                self.res.append(("script", a["src"]))
            else:
                self._in_script = True
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

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False

    def handle_data(self, data):
        if self._in_script:
            self.scripts.append(data[:500_000])
        elif "url(" in data or "@import" in data:
            self.styles.append(data)


CSS_URL = re.compile(r"""url\(\s*['"]?([^'")\s]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]""", re.I)
JS_HOST = re.compile(r"""(?:https?:)?\\?/\\?/([a-z0-9][a-z0-9.-]{0,200}\.[a-z]{2,24})(?=[/"'\\?#:)\s`])""", re.I)
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)


def own_page(url, site):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname or registrable(u.hostname.lower()) != registrable(site):
        return None
    if re.search(r"\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|xml|ico|woff2?)$", u.path, re.I):
        return None
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path or "/", u.query if len(u.query) < 60 else "", ""))


def sitemap_pages(base, site, allow_private, limit):
    """Pages listed in robots.txt / sitemap.xml (sitemap indexes followed a little), spread over the list."""
    maps, pages = [], []
    try:
        _, robots = fetch(urllib.parse.urljoin(base, "/robots.txt"), allow_private, "text/plain,*/*")
        maps += re.findall(r"(?im)^\s*sitemap:\s*(\S+)", robots)
    except Refused:
        pass
    maps.append(urllib.parse.urljoin(base, "/sitemap.xml"))
    done = 0
    while maps and done < 8:
        m = maps.pop(0)
        done += 1
        try:
            _, xml = fetch(m, allow_private, "application/xml,text/xml,*/*")
        except Refused:
            continue
        locs = LOC.findall(xml)
        if "<sitemapindex" in xml.lower():
            maps += locs[:6]
        else:
            pages += [p for p in (own_page(x, site) for x in locs) if p]
    pages = list(dict.fromkeys(pages))
    if len(pages) > limit:                                # spread: one of every N, so all kinds of pages are seen
        step = len(pages) / limit
        pages = [pages[int(i * step)] for i in range(limit)]
    return pages


def scan(site, url=None, allow_private=False, deep=False, max_pages=None, budget=None, progress=None):
    """-> {hosts: {name: why}, skipped: {name: why}, embeds: {name: why}, suggest: {name: why}, pages, error}"""
    from concurrent.futures import ThreadPoolExecutor
    base = url or f"https://{site}/"
    max_pages = max_pages or (DEEP_PAGES if deep else MAX_PAGES)
    budget = budget or (DEEP_SECONDS if deep else 60)
    start = time.time()
    found, pages, errors = {}, [], []
    css_done, js_done, js_hosts = set(), set(), {}
    todo, seen = [base], set()
    if deep:
        todo += sitemap_pages(base, site, allow_private, max_pages)

    def add(kind, ref, page_url):
        u = urllib.parse.urlsplit(urllib.parse.urljoin(page_url, ref.strip()))
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        found.setdefault(u.hostname.lower().rstrip("."), set()).add(kind)
        return u.geturl()

    def js_names(text, src):
        for m in JS_HOST.finditer(text):
            h = m.group(1).lower().rstrip(".")
            if SITE_RE.match(h) and not under(h, NOISE) and "." in h and not h[-1].isdigit():
                js_hosts.setdefault(h, src)

    def read(page_url):
        try:
            return page_url, fetch(page_url, allow_private), None
        except Refused as e:
            return page_url, None, str(e)

    with ThreadPoolExecutor(WORKERS if deep else 1) as pool:
        while todo and len(pages) < max_pages and time.time() - start < budget:
            batch = []
            while todo and len(batch) < (WORKERS if deep else 1) and len(pages) + len(batch) < max_pages:
                u = todo.pop(0)
                if u not in seen:
                    seen.add(u)
                    batch.append(u)
            for page_url, got, err in pool.map(read, batch):
                if err:
                    errors.append(err)
                    continue
                final, text = got
                pages.append(final)
                p = Page()
                try:
                    p.feed(text)
                except Exception:                         # noqa: BLE001 — broken HTML: use what was read
                    pass
                for kind, ref in p.res:
                    full = add(kind, ref, final)
                    if kind == "css" and full and full not in css_done and len(css_done) < MAX_CSS * (3 if deep else 1):
                        css_done.add(full)
                        try:
                            cfinal, css = fetch(full, allow_private, "text/css,*/*")
                            for m in CSS_URL.finditer(css):
                                add("css-file", m.group(1) or m.group(2), cfinal)
                        except Refused as e:
                            errors.append(str(e))
                    if deep and kind == "script" and full and full not in js_done and len(js_done) < DEEP_JS:
                        js_done.add(full)
                        try:
                            jfinal, js = fetch(full, allow_private, "application/javascript,*/*")
                            js_names(js, jfinal)
                        except Refused as e:
                            errors.append(str(e))
                for s in p.styles:
                    for m in CSS_URL.finditer(s):
                        add("style", m.group(1) or m.group(2), final)
                if deep:
                    for s in p.scripts:
                        js_names(s, final)
                if deep or len(pages) == 1:               # the site's own pages (products, contact …)
                    for l in p.links:
                        o = own_page(urllib.parse.urljoin(final, l), site)
                        if o and o not in seen and o not in todo:
                            todo.append(o)
                if progress:
                    progress(len(pages))
    hosts, skipped, embeds, suggest = {}, {}, {}, {}
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
    for h, src in sorted(js_hosts.items()):
        name = allow_name(h)
        if registrable(h) == mine or name in hosts or under(h, TRACKERS):
            if under(h, TRACKERS) and name not in hosts:
                skipped.setdefault(name, "tracker / ads (in JS)")
            continue
        if ASSET_HINT.search(h) or under(h, HELPERS):
            hosts.setdefault(name, "in JS: file host")
        else:
            suggest.setdefault(name, f"named in the site's JS ({h})")
    return {"hosts": hosts, "skipped": skipped, "embeds": embeds, "suggest": suggest, "pages": pages,
            "seconds": int(time.time() - start), "deep": deep,
            "error": "" if pages else (errors[0] if errors else "nothing read"), "errors": errors[:5]}


# ---------------------------------------------------------------- state (KEY: a site, app-NAME, ao-PROFILE)
def path(d, key, ext):
    return os.path.join(d, f"{key}.{ext}")


def load(d, key):
    try:
        return json.load(open(path(d, key, "json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {"site": key, "allowed": {}, "skipped": {}, "suggest": {}, "ignored": [], "scanned": 0, "error": ""}


def save(d, st):
    os.makedirs(d, exist_ok=True)
    names = sorted(st["allowed"])
    nets = sorted(st.get("nets", {}))
    for ext, data in (("json", json.dumps(st, indent=1, sort_keys=True)), ("txt", "".join(n + "\n" for n in names)),
                      ("nets", "".join(n + "\n" for n in nets))):
        tmp = path(d, st["site"], ext) + f".tmp{os.getpid()}"
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
    for n, why in list(r["embeds"].items()) + list(r.get("suggest", {}).items()):
        if n not in st["allowed"] and n not in st["ignored"]:
            st["suggest"].setdefault(n, {"count": 0, "why": why})
    st.update(scanned=int(time.time()), error=r["error"], pages=r["pages"][:300], pages_read=len(r["pages"]),
              deep=r.get("deep", False), seconds=r.get("seconds", 0))
    st.pop("scanning", None)
    return set(st["allowed"]) != before


def cmd_scan(site, d, url=None, allow_private=False, deep=False):
    st = load(d, site)
    if deep:
        st["scanning"] = {"since": int(time.time()), "pages": 0}
        save(d, st)

    def progress(n):
        if deep and n % 5 == 0:
            cur = load(d, site)
            cur["scanning"] = {"since": st["scanning"]["since"], "pages": n}
            save(d, cur)
    r = scan(site, url, allow_private, deep=deep, progress=progress)
    st = load(d, site)
    changed = apply_scan(st, r)
    save(d, st)
    return st, r, changed


# ---------------------------------------------------------------- what the policies allow by name
def app_slug(name):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]", "-", name.lower())).strip("-")


def targets(policy_dir=POLICY_DIR, ao_dir=AO_DIR, catalog=None):
    """{key: {kind: site|app|ao, name, policies: [..], base: [names that mean "this one is used"]}}"""
    out = {}
    for f in sorted(os.listdir(policy_dir)) if os.path.isdir(policy_dir) else []:
        if not f.endswith(".txt") or f == "README.txt":
            continue
        for line in open(os.path.join(policy_dir, f), encoding="utf-8", errors="replace"):
            line = line.split("#", 1)[0].strip()
            m = re.match(r"^allow-web\s+(\S+)", line)
            if m and clean_site(m.group(1)):
                site = clean_site(m.group(1))
                out.setdefault(site, {"kind": "site", "name": site, "policies": [], "base": [site]})["policies"].append(f[:-4])
                continue
            m = re.match(r"^allow-app\s+(.+)$", line)
            if m:
                name = re.sub(r"\s+time=\S+", "", m.group(1)).strip()
                key = "app-" + app_slug(name)
                if key not in out:
                    base = []
                    try:
                        import cdnmap
                        cat = catalog or cdnmap.catalog()
                        a = next((v for k, v in cat.apps().items() if k.lower() == name.lower()), None)
                        base = [d["domain"] for d in a["domains"]] if a else []
                    except Exception:                     # noqa: BLE001
                        base = []
                    out[key] = {"kind": "app", "name": name, "policies": [], "base": base}
                out[key]["policies"].append(f[:-4])
                continue
            m = re.match(r"^allow-only\s+([a-z0-9-]+)$", line)
            if m:
                key = "ao-" + m.group(1)
                if key not in out:
                    base, company, deny = [], set(), []
                    try:
                        for l in open(os.path.join(ao_dir, m.group(1) + ".txt"), encoding="utf-8", errors="replace"):
                            k, _, v = l.split("#", 1)[0].strip().partition(" ")
                            v = v.strip().lower()
                            if k in ("domain", "host") and SITE_RE.match(v):
                                base.append(v)
                            if k == "host" and SITE_RE.match(v) and not under(v, SHARED):
                                company.add(registrable(v))   # host g.whatsapp.net: other *.whatsapp.net too
                            if k == "deny-sni" and v:
                                deny.append(v)
                    except OSError:
                        pass
                    out[key] = {"kind": "ao", "name": m.group(1), "policies": [], "base": base,
                                "company": sorted(company), "deny": deny}
                out[key]["policies"].append(f[:-4])
    return out


def web_sites(policy_dir=POLICY_DIR):
    """{site: [policies]} from the allow-web lines (older callers)."""
    return {k: v["policies"] for k, v in targets(policy_dir).items() if v["kind"] == "site"}


# ---------------------------------------------------------------- learning from the DNS log
def learn(lines, clients, tg, states, window=20):
    """lines: DNS log; clients: {ip: policy}; tg: targets(); states: {key: state}. Adds learned names /
    suggestions. -> set of keys whose allowed names changed."""
    import mlreport
    changed, last = set(), {}
    for l in lines:
        m = mlreport.DNS_RE.match(l)
        if not m or m.group(4) not in clients:
            continue
        ts, name, ip = mlreport.ts_of(m.group(1)) or 0, m.group(3).lower().rstrip("."), m.group(4)
        pol = clients[ip]
        mine = [k for k, t in tg.items() if pol in t["policies"]]
        hit = next((k for k in mine if under(name, tg[k]["base"]) or under(name, list(states[k]["allowed"]))), None)
        if hit:
            last[ip] = (hit, ts)
            continue
        if not SITE_RE.match(name) or under(name, TRACKERS):
            continue
        n = allow_name(name)
        # an app profile's "host" lines name its company (g.whatsapp.net): other names under that domain are
        # allowed by themselves, no matter when — unless the profile denies them (deny-sni facebook …)
        same = next((k for k in mine if registrable(name) in tg[k].get("company", ())
                     and not any(w in name for w in tg[k].get("deny", ()))), None)
        if same:
            st = states[same]
            if n not in st["ignored"]:
                st["allowed"][n] = {"from": "learned", "why": f"same company as {tg[same]['name']} ({name})"}
                st["suggest"].pop(n, None)
                changed.add(same)
            last[ip] = (same, ts)
            continue
        if ip not in last or ts - last[ip][1] > window:
            continue
        key = last[ip][0]
        t, st = tg[key], states[key]
        if n in st["allowed"] or n in st["ignored"] or under(name, list(st["allowed"])):
            continue
        what = t["name"] if t["kind"] != "ao" else f"{t['name']} (app profile)"
        helper = next((h for h in HELPERS if name == h or name.endswith("." + h)), None)
        if helper:                                        # a well-known helper (fonts, JS libraries …)
            st["allowed"][helper] = {"from": "learned", "why": f"asked right after {what} ({name})"}
            st["suggest"].pop(helper, None)
            changed.add(key)
        else:
            s = st["suggest"].setdefault(n, {"count": 0, "why": ""})
            s["count"] += 1
            s["why"] = f"asked right after {what} ({name})"
    return changed


# ---------------------------------------------------------------- ports
PROTO = {6: "tcp", 17: "udp"}
NET_RE = re.compile(r"^(\d{1,3}(?:\.\d{1,3}){3})/(2[4-9]|3[0-2]) (tcp|udp) (\d{1,5})$")
WF_PORT_RE = re.compile(r"^(\S+) \S+ .*?WF-(allowonly|noinet)\b.*?proto (TCP|UDP)\b.*?"
                        r"(\d+\.\d+\.\d+\.\d+):\d+->(\d+\.\d+\.\d+\.\d+):(\d+)")
REPLY_RE = re.compile(r"\breply \S+ is (\d+\.\d+\.\d+\.\d+)$")


def good_net(key):
    """'47.91.12.0/24 udp 6000' -> the same text when valid (a public network, a real port), else ''."""
    m = NET_RE.match(key or "")
    if not m or not 0 < int(m.group(4)) < 65536:
        return ""
    try:
        net = ipaddress.ip_network(f"{m.group(1)}/{m.group(2)}", strict=True)
    except ValueError:
        return ""
    return key if net.is_global else ""


def ports_used(rows, tg, states, top=12):
    """rows: (site, proto, port, direction, bytes, last_seen) from ml_app_port (what the traffic collector
    saw). Each website / app / profile gets the ports its names use: state["ports"]."""
    for k, t in tg.items():
        names = list(t["base"]) + list(states[k]["allowed"]) + list(t.get("company", ()))
        agg = {}
        for site, proto, port, direction, nbytes, last in rows:
            if direction != "out" or not names or not under(str(site), names):
                continue
            pr = PROTO.get(int(proto), str(proto))
            a = agg.setdefault((pr, int(port)), {"proto": pr, "port": int(port), "bytes": 0, "last": 0})
            a["bytes"] += int(nbytes or 0)
            a["last"] = max(a["last"], int(last or 0))
        states[k]["ports"] = sorted(agg.values(), key=lambda a: -a["bytes"])[:top]


def learn_ports(dns_lines, wf_lines, clients, tg, states, window=20):
    """Connections to bare addresses (no name asked: P2P, relays, cameras …) that the policy blocked right
    after a device used an allowed website / app / profile: suggested as 'NETWORK/24 proto port'."""
    import mlreport
    hits, named = {}, set()
    for l in dns_lines:
        r = REPLY_RE.search(l.rstrip())
        if r:
            named.add(r.group(1))                     # this address has a name: name learning covers it
            continue
        m = mlreport.DNS_RE.match(l)
        if not m or m.group(4) not in clients:
            continue
        name, ip = m.group(3).lower().rstrip("."), m.group(4)
        k = next((k for k, t in tg.items() if clients[ip] in t["policies"]
                  and (under(name, t["base"]) or under(name, list(states[k]["allowed"])))), None)
        if k:
            hits.setdefault(ip, []).append((mlreport.ts_of(m.group(1)) or 0, k))
    for l in wf_lines:
        m = WF_PORT_RE.match(l)
        if not m or m.group(4) not in clients:
            continue
        ts, proto, src, dst, port = mlreport.ts_of(m.group(1)) or 0, m.group(3).lower(), m.group(4), m.group(5), m.group(6)
        if dst in named:
            continue
        try:
            if not ipaddress.ip_address(dst).is_global:
                continue
        except ValueError:
            continue
        before = [h for h in hits.get(src, []) if 0 <= ts - h[0] <= window]
        if not before:
            continue
        key = max(before)[1]
        net = f"{ipaddress.ip_network(dst + '/24', strict=False).network_address}/24 {proto} {port}"
        st, t = states[key], tg[key]
        if net in st.get("nets", {}) or net in st["ignored"]:
            continue
        s = st.setdefault("suggest_net", {}).setdefault(net, {"count": 0, "ips": [], "why": ""})
        s["count"] += 1
        if dst not in s["ips"]:
            s["ips"] = (s["ips"] + [dst])[-5:]
        s["why"] = f"blocked right after {t['name']}{' (app profile)' if t['kind'] == 'ao' else ''} was used"


def cmd_auto(d, cnf, db, policy_dir=POLICY_DIR, ao_dir=AO_DIR, max_age=86400, deep_per_run=3):
    import insights, mlreport
    tg = targets(policy_dir, ao_dir)
    states = {k: load(d, k) for k in tg}
    changed = set()
    stale = sorted((st.get("scanned", 0), k) for k, st in states.items() if tg[k]["kind"] == "site"
                   and time.time() - st.get("scanned", 0) > max_age and not st.get("scanning"))
    for _, k in stale[:deep_per_run]:                     # a few each hour: deep reads take minutes
        _, _, ch = cmd_scan(k, d, deep=True)
        states[k] = load(d, k)
        if ch:
            changed.add(k)
    if tg:
        rows = insights.mysql_rows(cnf, db)
        pols = {u: v[7:] for u, v in rows(mlreport.POLICY_SQL) if v.startswith("policy-")}
        since = min([st.get("learned_until", 0) for st in states.values()] + [time.time() - 3600])
        clients = {}
        for u, ip in rows(f"SELECT username, framedipaddress FROM radacct WHERE framedipaddress <> '' "
                          f"AND (acctstoptime IS NULL OR acctstoptime >= FROM_UNIXTIME({int(since)}))"):
            if u in pols:
                clients[ip] = pols[u]
        lines = [l for l in mlreport.read_lines(mlreport.DNS_LOG, since) if (mlreport.ts_of(l.split(" ", 1)[0]) or 0) >= since]
        changed |= learn(lines, clients, tg, states)
        wf = [l for l in mlreport.read_lines(mlreport.WF_LOG, since) if (mlreport.ts_of(l.split(" ", 1)[0]) or 0) >= since]
        learn_ports(lines, wf, clients, tg, states)
        try:
            ports_used(rows("SELECT site, proto, port, direction, bytes, UNIX_TIMESTAMP(last_seen) FROM ml_app_port "
                            "WHERE direction = 'out'"), tg, states)
        except Exception:                                 # noqa: BLE001 — no traffic collector: no ports
            pass
        for st in states.values():
            st["learned_until"] = int(time.time())
    for st in states.values():
        cur = load(d, st["site"])                         # a deep read may be running: keep its progress
        if cur.get("scanning"):
            st["scanning"] = cur["scanning"]
        save(d, st)
    # names no policy uses any more: forget them after 30 days
    for f in os.listdir(d) if os.path.isdir(d) else []:
        key, _, ext = f.rpartition(".")
        if ext in ("json", "txt", "nets") and key not in tg and time.time() - os.path.getmtime(os.path.join(d, f)) > 30 * 86400:
            os.unlink(os.path.join(d, f))
    return changed


def main():
    a = sys.argv[1:]
    opt = lambda k, dflt=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else dflt  # noqa: E731
    d = opt("--dir", DIR)
    cmd = a[0] if a else ""
    key = (a[1] if len(a) > 1 else "").lower()
    if cmd == "scan":
        key = clean_site(key)
        if not key:
            sys.exit("give a website name, e.g. example.com")
    elif cmd in ("show", "allow", "ignore"):
        key = clean_site(key) or (key if KEY_RE.match(key) else "")
        if not key:
            sys.exit("give a website name (example.com), app-NAME or ao-PROFILE")
    if cmd == "scan" and "--background" in a:
        st = load(d, key)
        if st.get("scanning") and time.time() - st["scanning"].get("since", 0) < 600:
            print(f"{key}: already being read ({st['scanning'].get('pages', 0)} pages so far)")
            return
        st["scanning"] = {"since": int(time.time()), "pages": 0}
        save(d, st)
        import subprocess
        args = [sys.executable, "-I", os.path.abspath(__file__), "scan", key, "--deep", "--dir", d] + \
               (["--rebuild"] if "--rebuild" in a else []) + \
               (["--url", opt("--url")] if opt("--url") else []) + (["--allow-private"] if "--allow-private" in a else [])
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        print(f"{key}: reading the whole site in the background (up to {DEEP_PAGES} pages, {DEEP_SECONDS // 60} minutes)")
    elif cmd == "scan":
        st, r, changed = cmd_scan(key, d, opt("--url"), "--allow-private" in a, deep="--deep" in a)
        if r["error"]:
            print(f"could not read {key}: {r['error']}")
            sys.exit(2)
        print(f"{key}: {len(r['pages'])} page(s) read in {r['seconds']} s{' (deep)' if r['deep'] else ''}")
        for n, v in sorted(st["allowed"].items()):
            print(f"  allow  {n:<34} {v['from']}: {v['why']}")
        for n, why in sorted(r["skipped"].items()):
            print(f"  skip   {n:<34} {why}")
        for n, v in sorted(st["suggest"].items()):
            print(f"  ask?   {n:<34} {v['why']}")
        print("changed" if changed else "no change")
        if changed and "--rebuild" in a:                  # a background read: give the routers the new names
            import shutil, subprocess
            ra = shutil.which("radius-admin") or "/usr/local/sbin/radius-admin"
            subprocess.run([ra, "policy", "build"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif cmd == "list":
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not f.endswith(".json"):
                continue
            st = load(d, f[:-5])
            sc, t = st.get("scanning"), st.get("scanned", 0)
            if sc:
                state = f"reading now ({sc.get('pages', 0)} pages)"
            elif t:
                state = f"read {time.strftime('%Y-%m-%d %H:%M', time.localtime(t))}, " \
                        f"{st.get('pages_read', len(st.get('pages', [])))} pages{' (whole site)' if st.get('deep') else ''}"
            else:
                state = "learning only"
            print(f"{st['site']:<28} {len(st['allowed']):>3} allowed  {len(st['suggest']):>3} to answer  {state}  {st.get('error', '')}")
    elif cmd == "show":
        print(json.dumps(load(d, key), indent=1, sort_keys=True))
    elif cmd in ("allow", "ignore") and (good_net(" ".join(a[2:3]).lower()) or good_net(" ".join(a[2:5]).lower())):
        net = good_net(" ".join(a[2:3]).lower()) or good_net(" ".join(a[2:5]).lower())
        st = load(d, key)
        st.setdefault("suggest_net", {}).pop(net, None)
        st.setdefault("nets", {})
        if cmd == "allow":
            st["nets"][net] = {"from": "admin", "why": "allowed by the admin"}
            if net in st["ignored"]:
                st["ignored"].remove(net)
        else:
            st["nets"].pop(net, None)
            if net not in st["ignored"]:
                st["ignored"].append(net)
        save(d, st)
        print(f"{key}: {net} {'allowed' if cmd == 'allow' else 'ignored'}")
    elif cmd in ("allow", "ignore"):
        name = (a[2] if len(a) > 2 else "").lower()
        if not SITE_RE.match(name):
            sys.exit("give a name (cdn.example.com) or a network with a port ('47.91.12.0/24 udp 6000')")
        st = load(d, key)
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
        print(f"{key}: {name} {'allowed' if cmd == 'allow' else 'ignored'}")
    elif cmd == "auto":
        changed = cmd_auto(d, opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"),
                           opt("--policies", POLICY_DIR), opt("--allowonly", AO_DIR))
        print(f"changed: {' '.join(sorted(changed)) or '-'}")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
