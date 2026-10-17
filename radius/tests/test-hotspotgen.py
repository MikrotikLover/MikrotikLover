#!/usr/bin/env python3
"""Offline tests for the hotspot page designer (tools/hotspotgen.py) and router reports (tools/routerstat.py)."""
import os, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import hotspotgen, routerstat  # noqa: E402

fails = 0


def check(name, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))
    fails += 0 if cond else 1


TPL = os.path.join(here, "..", "mikrotik", "hotspot-login")
rows = lambda q: [("hs_title", "Cafe <b>X</b>"), ("hs_color1", "#7e22ce"), ("hs_color2", "javascript:x"), ("hs_notice", "A|B & C"),  # noqa: E731
                  ("brand", "Brand"), ("contact", "0300-1")]
st = hotspotgen.settings(rows)
check("bad colour falls back to the default", st["hs_color2"] == "#0ea5e9")
check("footer from the contact", st["hs_footer"] == "Masla? Rabta: 0300-1")
login = hotspotgen.render("login.html", open(os.path.join(TPL, "login.html")).read(), st, "data:image/png;base64,iVBORw0KGgo=")
check("title escaped", '<h1 id="brand">Cafe &lt;b&gt;X&lt;/b&gt;</h1>' in login)
check("colours in the gradient", "linear-gradient(135deg,#7e22ce,#0ea5e9)" in login)
check("notice box, | = new line, escaped", '<div class="ad">A<br>B &amp; C</div>' in login)
check("logo shown", '<img class="logo" src="data:image/png;base64,iVBORw0KGgo="' in login)
check("router variables kept", "$(link-login-only)" in login and "$(if chap-id)" in login)
bad = hotspotgen.render("login.html", open(os.path.join(TPL, "login.html")).read(), st, 'data:image/svg+xml;base64,PHN2Zz4=')
check("SVG logo refused (could carry script)", 'class="logo"' not in bad)
pv = hotspotgen.preview(login)
check("preview: no router variables, no scripts, no handlers", "$(" not in pv and "<script" not in pv.lower() and "onsubmit=" not in pv)
d = tempfile.mkdtemp()
v1 = hotspotgen.build(rows, TPL, d, os.path.join(d, "nologo"))
check("build: 3 pages + version", sorted(os.listdir(d)) == ["alogin.html", "login.html", "status.html", "version"] and len(v1) == 12)
rows2 = lambda q: rows(q) + [("hs_sub", "new")]  # noqa: E731
check("version changes with the design", hotspotgen.build(rows2, TPL, d, os.path.join(d, "nologo")) != v1)
# router reports
rep = routerstat.parse("id=Office hAP\ncpu=250\nmem=100/400\nif=ether1|true|false|1000|500|ether\nif=bad;name|true|false|1|1\n"
                       "nw=8.8.8.8|down|ml-link: ISP\nhs=3\nppp=x")
check("report parsed; cpu capped; bad interface name skipped", rep["identity"] == "Office hAP" and rep["cpu"] == 100 and len(rep["interfaces"]) == 1
      and rep["links"][0]["status"] == "down" and rep["hotspot"] == 3 and rep["ppp"] == 0, rep)
try:
    routerstat.parse("cpu=1")
    check("report without identity refused", False)
except ValueError:
    check("report without identity refused", True)
cur = [{"name": "ether1", "running": True, "rx": 1000 + 60 * 125000, "tx": 500}]
routerstat.rates(cur, [{"name": "ether1", "rx": 1000, "tx": 900}], 60)
check("rates: 1 Mbit/s; counter reset -> 0", cur[0]["rx_bps"] == 1000000 and cur[0]["tx_bps"] == 0, cur)
check("busiest interface", routerstat.busiest(cur) == (1000000, 0))
print("all hotspot / router tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
