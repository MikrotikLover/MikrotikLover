#!/usr/bin/env python3
"""Why blocked? — for a website name and a user: which category / app / keyword / VPN list it is in, which
rule of the user's policy blocks it, and whether that rule is active now (time=). Same matching as the
router rules made by webfilter/build.sh: a listed domain also covers its subdomains, * patterns as in
tls-host, keywords anywhere in the name (^word only at the start of a name part).

  whyblocked.py SITE [--policy NAME] [--at 'YYYY-MM-DD HH:MM'] [--wf DIR] [--policies DIR]
"""
import fnmatch, os, re, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

WF_DIR = "/usr/local/lib/mikrotiklover/webfilter"
POLICY_DIR = "/var/lib/mikrotiklover/policies"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
HOST_RE = re.compile(r"^[a-z0-9*]([a-z0-9*.-]{0,251}[a-z0-9*])?$")


def clean_host(s):
    """URL or name -> lowercase host name, or '' when it is not one."""
    s = str(s or "").strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = s.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    s = s.rsplit("@", 1)[-1]
    if s.startswith("["):
        return ""
    s = s.split(":", 1)[0].strip(".")
    return s if HOST_RE.match(s) and "*" not in s and "." in s else ""


_LISTS = {}


def read_list(path):
    """Entries of a list file (comments dropped); cached until the file changes."""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return []
    hit = _LISTS.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    out = []
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            d = line.split("#", 1)[0].strip().lower()
            if d:
                out.append(d)
    except OSError:
        pass
    _LISTS[path] = (mt, out)
    return out


def domain_hit(host, entry):
    """A list entry covers the host? Plain domain = itself + subdomains; * = pattern (tls-host / DNS regexp)."""
    if "*" in entry:
        return fnmatch.fnmatchcase(host, entry)
    return host == entry or host.endswith("." + entry)


def keyword_hit(host, kw):
    if kw.startswith("^"):
        k = kw[1:]
        return host.startswith(k) or ("." + k) in host or ("-" + k) in host
    return kw in host


def categories(wf_dir):
    d = os.path.join(wf_dir, "categories")
    try:
        return sorted(f[:-4] for f in os.listdir(d) if f.endswith(".txt"))
    except OSError:
        return []


def lists_for(host, wf_dir=WF_DIR, catalog=None, vpn_extra=()):
    """Every block list the host is on: [{kind, name, match}]."""
    hits = []
    for c in categories(wf_dir):
        for e in read_list(os.path.join(wf_dir, "categories", c + ".txt")):
            if domain_hit(host, e):
                hits.append({"kind": "category", "name": c, "match": e})
                break
    for k in read_list(os.path.join(wf_dir, "keywords.txt")):
        if re.match(r"^\^?[a-z0-9]{2,32}$", k) and keyword_hit(host, k):
            hits.append({"kind": "keywords", "name": "adult words", "match": k})
            break
    if catalog is not None:
        try:
            e = catalog.name(host)
        except Exception:                      # noqa: BLE001 — the catalog is optional
            e = None
        if e and not e.get("generic"):
            hits.append({"kind": "app", "name": e["app"], "match": e.get("matched", ""), "category": e.get("category", "")})
    vpn = [e for e in read_list(os.path.join(wf_dir, "categories", "vpn-proxy.txt")) + list(vpn_extra) if domain_hit(host, e)]
    if vpn or "vpn" in host or any(h["kind"] == "app" and h.get("category") == "vpn" for h in hits):
        hits.append({"kind": "vpn", "name": "VPN / proxy", "match": vpn[0] if vpn else ("vpn" if "vpn" in host else host)})
    return hits


def _clock(s):
    """'9h', '8h30m', '0s', '17:30', '17:30:15' -> seconds after midnight."""
    s = s.strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", s)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3) or 0)
    m = re.match(r"^(?:(\d{1,2})h)?(?:(\d{1,2})m)?(?:(\d{1,2})s)?$", s)
    if m and s:
        return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
    raise ValueError(f"time '{s}'")


def time_active(spec, at):
    """RouterOS time= ('9h-17h,mon,tue') active at datetime `at`? Empty spec = always."""
    if not spec:
        return True
    parts = [p.strip().lower() for p in spec.split(",") if p.strip()]
    days = [p for p in parts if p in DAYS]
    if days and DAYS[at.weekday()] not in days:
        return False
    ranges = [p for p in parts if p not in DAYS]
    if not ranges:
        return True
    a, _, b = ranges[0].partition("-")
    start, end, now = _clock(a), _clock(b or "24h"), at.hour * 3600 + at.minute * 60 + at.second
    return start <= now < end if start <= end else (now >= start or now < end)


def parse_policy(text):
    rules = []
    for line in str(text).splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.search(r"\s+time=(\S+)", line)
        t = m.group(1) if m else ""
        line = re.sub(r"\s+time=\S+", "", line)
        key, _, val = line.partition(" ")
        rules.append({"kind": key, "value": val.strip(), "time": t, "line": line + (f" time={t}" if t else "")})
    return rules


AO_DIR = "/var/lib/mikrotiklover/allowonly"


def ao_file(profile, wf_dir, ao_dir=None):
    for d in (ao_dir or AO_DIR, os.path.join(wf_dir, "allowonly")):
        f = os.path.join(d, profile + ".txt")
        if os.path.isfile(f):
            return f
    return ""


def allow_only_ok(host, profile, wf_dir, ao_dir=None):
    """Does an allow-only profile let this name through (host / domain lines; networks need the IP)?"""
    for line in read_list(ao_file(profile, wf_dir, ao_dir)):
        key, _, val = line.partition(" ")
        val = val.strip()
        if key == "host" and (host == val or (val.startswith("www.") and host == val[4:])):
            return True
        if key == "domain" and domain_hit(host, val):
            return True
    return False


def explain(host, policy=None, policy_text="", at=None, wf_dir=WF_DIR, catalog=None, vpn_extra=(), ao_dir=None):
    """-> {host, lists, policy, rules: [{rule, blocks, active, why, router}], verdict, summary}"""
    at = at or datetime.now()
    lists = lists_for(host, wf_dir, catalog, vpn_extra)
    cats = {h["name"] for h in lists if h["kind"] == "category"}
    apps = {h["name"].lower() for h in lists if h["kind"] == "app"}
    out = []
    # several "allow-only" lines: the site is let through when one of the apps needs it
    aos = [r for r in parse_policy(policy_text) if r["kind"] == "allow-only"] if policy else []
    ao_pass = any(allow_only_ok(host, r["value"], wf_dir, ao_dir) for r in aos)
    ao_done = False
    for r in parse_policy(policy_text) if policy else []:
        k, v = r["kind"], r["value"]
        why, router = None, ""
        if k == "block" and (v in cats or (v == "keywords" and any(h["kind"] == "keywords" for h in lists))):
            hit = next(h for h in lists if (h["kind"] == "category" and h["name"] == v) or (v == "keywords" and h["kind"] == "keywords"))
            why, router = f"'{hit['match']}' is in the {v} list", f"WF-{v}"
        elif k == "block-app" and v.lower() in apps:
            why, router = f"{host} belongs to the app {v}", "WF-app-" + re.sub(r"[^a-z0-9]+", "-", v.lower()).strip("-")
        elif k == "block-vpn" and any(h["kind"] == "vpn" for h in lists):
            why, router = "VPN / proxy website or app", "WF-vpn"
        elif k == "block-site" and domain_hit(host, v.lower()):
            why, router = f"{v} is blocked by name in this policy", "WF-site"
        elif k == "block-all":
            why, router = "no internet for this policy", "WF-noinet"
        elif k == "allow-only" and not ao_pass and not ao_done:
            ao_done = True
            names = " + ".join(x["value"] for x in aos)
            why, router = f"only {names} {'is' if len(aos) == 1 else 'are'} allowed", "WF-allowonly"
            r = dict(r, line=" + ".join(x["line"] for x in aos))
        if why:
            try:
                active = time_active(r["time"], at)
            except ValueError:
                active = True
            out.append({"rule": r["line"], "why": why, "active": active, "time": r["time"], "router": router})
    allow = next((r for r in parse_policy(policy_text) if r["kind"] == "allow-site" and domain_hit(host, r["value"].lower())), None) if policy else None
    if allow:
        for x in out:
            x["active"] = False
            x["why"] += f" — but '{allow['line']}' comes first"
    if allow:
        verdict = "allowed"
    elif any(x["active"] for x in out):
        verdict = "blocked"
    elif out:
        verdict = "blocked-other-times"
    elif policy:
        verdict = "allowed"
    else:
        verdict = "no-policy"
    if verdict == "blocked":
        first = next(x for x in out if x["active"])
        summary = f"Blocked by policy '{policy}': {first['rule']} — {first['why']}."
    elif verdict == "blocked-other-times":
        summary = f"Policy '{policy}' blocks it only at: " + "; ".join(x["time"] for x in out) + " (not now)."
    elif verdict == "allowed" and allow:
        summary = f"Policy '{policy}' allows it: {allow['line']} (an exception, before every block)."
    elif verdict == "allowed":
        summary = f"Policy '{policy}' does not block {host}."
    else:
        summary = "This user has no policy."
    dns = next((r["value"] for r in parse_policy(policy_text) if r["kind"] == "dns" and r["value"] != "router"), "") if policy else ""
    if dns and verdict != "blocked":
        summary += f" Note: this policy uses the '{dns}' DNS, which may refuse adult / malware sites by itself."
    if lists and verdict in ("allowed", "no-policy"):
        summary += " It is on: " + ", ".join(f"{h['kind']} {h['name']}" for h in lists) + \
                   " — blocked for everyone only if that list's webfilter-*.rsc is imported on the router."
    return {"host": host, "lists": lists, "policy": policy or "", "rules": out, "verdict": verdict, "summary": summary, "dns": dns,
            "allow": allow["line"] if allow else "",
            "at": at.strftime("%Y-%m-%d %H:%M")}


def main():
    a = sys.argv[1:]
    opt = lambda k, d="": a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    if not a or a[0].startswith("-"):
        print(__doc__)
        sys.exit(1)
    host = clean_host(a[0])
    if not host:
        sys.exit(f"not a website name: {a[0]}")
    pol = opt("--policy")
    if pol and not re.match(r"^[a-z0-9-]{1,40}$", pol):
        sys.exit("invalid policy name")
    text = ""
    if pol:
        try:
            text = open(os.path.join(opt("--policies", POLICY_DIR), pol + ".txt"), encoding="utf-8").read()
        except OSError:
            sys.exit(f"no policy '{pol}'")
    at = datetime.strptime(opt("--at"), "%Y-%m-%d %H:%M") if opt("--at") else None
    try:
        import cdnmap
        cat = cdnmap.catalog()
    except Exception:                          # noqa: BLE001
        cat = None
    r = explain(host, pol, text, at, opt("--wf", WF_DIR), cat)
    print(f"Site    : {r['host']}")
    print("Lists   : " + (", ".join(f"{h['kind']} {h['name']} ({h['match']})" for h in r["lists"]) or "none"))
    for x in r["rules"]:
        print(f"Rule    : {x['rule']}  -> {'ACTIVE now' if x['active'] else 'not now'} — {x['why']} (router log {x['router']})")
    print(f"Answer  : {r['summary']}")


if __name__ == "__main__":
    main()
