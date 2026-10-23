#!/usr/bin/env python3
"""Hotspot login page designer: makes login.html, status.html and alogin.html from the templates
(mikrotik/hotspot-login/) with your name, colours, logo, notice / advert and footer.

  hotspotgen.py build [--cnf FILE] [--db NAME] [--templates DIR] [--out DIR] [--logo FILE]
  hotspotgen.py preview PAGE [...same]      the page with sample values instead of the router's $(...)

Settings (ml_setting): hs_title, hs_sub, hs_color1, hs_color2, hs_notice, hs_footer; the logo is a
data: URI in /var/lib/mikrotiklover/hotspot-logo.txt. The routers download the pages by auto-sync.
"""
import hashlib, html, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TEMPLATES = "/usr/local/lib/mikrotiklover/hotspot-login"
OUT = "/var/lib/mikrotiklover/router/hotspot"
LOGO = "/var/lib/mikrotiklover/hotspot-logo.txt"
PAGES = ("login.html", "status.html", "alogin.html")
DEFAULTS = {"hs_title": "", "hs_sub": "Card par likha username aur password likhein", "hs_color1": "#1d4ed8",
            "hs_color2": "#0ea5e9", "hs_notice": "", "hs_footer": ""}
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
LOGO_RE = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$")
SAMPLE = {"username": "ali123", "ip": "10.5.0.23", "uptime": "1h12m", "session-time-left": "19h47m", "remain-bytes-total-nice": "820.0 MiB",
          "remain-bytes-total": "1", "bytes-out-nice": "312.4 MiB", "bytes-in-nice": "30.1 MiB", "link-redirect": "#", "link-logout": "#",
          "link-login-only": "#", "link-orig": "#", "link-orig-esc": "#", "mac-esc": "", "radius18": "", "error": "", "chap-id": "",
          "trial": "", "refresh-timeout": ""}


def settings(rows):
    st = dict(DEFAULTS)
    for k, v in rows("SELECT k, v FROM ml_setting WHERE k LIKE 'hs\\_%%' OR k IN ('brand', 'contact', 'social_on', 'server_ip')"):
        st[k] = v
    if not st["hs_title"]:
        st["hs_title"] = st.get("brand") or "WiFi"
    if not st["hs_footer"]:
        st["hs_footer"] = f"Masla? Rabta: {st['contact']}" if st.get("contact") else "Masla? Staff se rabta karein."
    for k in ("hs_color1", "hs_color2"):
        if not COLOR_RE.match(st[k] or ""):
            st[k] = DEFAULTS[k]
    return st


def render(name, tpl, st, logo=""):
    e = lambda s: html.escape(str(s), quote=True)  # noqa: E731
    s = tpl.replace("linear-gradient(135deg,#1d4ed8,#0ea5e9)", f"linear-gradient(135deg,{st['hs_color1']},{st['hs_color2']})")
    s = s.replace("#2563eb", st["hs_color1"])
    s = s.replace('<h1 id="brand">MikrotikLover WiFi</h1>', f'<h1 id="brand">{e(st["hs_title"])}</h1>')
    s = s.replace('<p class="sub">Card par likha username aur password likhein</p>', f'<p class="sub">{e(st["hs_sub"])}</p>')
    s = s.replace("Masla? Staff se rabta karein.", e(st["hs_footer"]))
    s = s.replace("<title>Wi-Fi Login</title>", f"<title>{e(st['hs_title'])}</title>")
    s = s.replace("<!--ML-LOGO-->", f'<img class="logo" src="{logo}" alt="">' if logo and LOGO_RE.match(logo) else "")
    notice = "<br>".join(e(x) for x in str(st["hs_notice"]).split("|") if x.strip())
    s = s.replace("<!--ML-NOTICE-->", f'<div class="ad">{notice}</div>' if notice else "")
    ip = st.get("server_ip", "")
    if st.get("social_on") == "1" and re.match(r"^\d+\.\d+\.\d+\.\d+$", ip or ""):
        # social WiFi: free internet with the phone number (portal on this server, port 8081)
        s = s.replace("<!--ML-SOCIAL-->", f"""<form class="social" action="http://{ip}:8081/social/start" method="post">
    <input type="hidden" name="mac" value="$(mac)"><input type="hidden" name="ip" value="$(ip)">
    <input type="hidden" name="login" value="$(link-login-only)"><input type="hidden" name="dst" value="$(link-orig)">
    <input type="hidden" name="chap_id" value="$(chap-id)"><input type="hidden" name="chap_challenge" value="$(chap-challenge)">
    <small>Card nahi hai?</small>
    <button type="submit">📱 Phone number se free WiFi</button>
  </form>""")
    s = s.replace("<!--ML-SOCIAL-->", "")
    return s


def build(rows, templates=TEMPLATES, out=OUT, logo_file=LOGO):
    st = settings(rows)
    logo = ""
    try:
        logo = open(logo_file, encoding="ascii").read().strip()
    except OSError:
        pass
    os.makedirs(out, exist_ok=True)
    h = hashlib.sha256()
    for name in PAGES:
        page = render(name, open(os.path.join(templates, name), encoding="utf-8").read(), st, logo)
        with open(os.path.join(out, name) + ".tmp", "w", encoding="utf-8") as f:
            f.write(page)
        os.replace(os.path.join(out, name) + ".tmp", os.path.join(out, name))
        h.update(page.encode())
    ver = h.hexdigest()[:12]
    with open(os.path.join(out, "version"), "w") as f:
        f.write(ver + "\n")
    return ver


def preview(page_html, notice=""):
    """Router variables -> sample values, so the page can be looked at in a browser."""
    v = dict(SAMPLE, radius18=notice)

    def cond(m):
        return m.group(2) if v.get(m.group(1)) else (m.group(3) or "")
    s = re.sub(r"\$\(if ([\w-]+)(?: == '[^']*')?\)(.*?)(?:\$\(else\)(.*?))?\$\(endif\)", cond, page_html, flags=re.S)
    s = re.sub(r"\$\(([\w-]+)\)", lambda m: html.escape(v.get(m.group(1), "")), s)
    s = re.sub(r"<script\b.*?</script>", "", s, flags=re.S | re.I)          # the preview shows the look only
    s = re.sub(r'\son[a-z]+="[^"]*"', "", s)
    return re.sub(r'<meta http-equiv="refresh"[^>]*>', "", s)


def main():
    import insights
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    rows = insights.mysql_rows(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"))
    if a[:1] == ["build"]:
        print(build(rows, opt("--templates", TEMPLATES), opt("--out", OUT), opt("--logo", LOGO)))
    elif a[:1] == ["preview"] and len(a) > 1 and a[1] in PAGES:
        st = settings(rows)
        try:
            logo = open(opt("--logo", LOGO), encoding="ascii").read().strip()
        except OSError:
            logo = ""
        tpl = open(os.path.join(opt("--templates", TEMPLATES), a[1]), encoding="utf-8").read()
        print(preview(render(a[1], tpl, st, logo), "Aap ka package 2 din mein khatam ho ga." if a[1] != "login.html" else ""))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
