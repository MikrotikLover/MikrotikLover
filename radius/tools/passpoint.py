#!/usr/bin/env python3
"""Passpoint (Hotspot 2.0): the router script and the phone profiles.

A phone with the profile joins every office Wi-Fi that announces the same Passpoint domain by itself
(no network to pick, no password to type). The login is EAP-TTLS with MSCHAPv2 inside (the only
username/password method Android's Passpoint has) against this RADIUS server; the outer name is
anonymous@DOMAIN, so the real name only travels inside the encrypted tunnel.

  passpoint.py check     --settings JSON                         settings OK? (exit 1 + message if not)
  passpoint.py router    --settings JSON --template FILE [--secret S --server IP]
  passpoint.py ios       --settings JSON --user U [--ca CA.der] [--server-name NAME] < password
  passpoint.py android   --settings JSON --user U [--ca CA.der] [--server-name NAME] < password

Settings (ml_setting pp_*): domain (FQDN: profile <-> Wi-Fi match, and the realm), name (operator /
profile name), ssid, venue, venue_name, network (network-type), roaming_oi (optional, hex).
"""
import argparse, base64, json, plistlib, re, sys, uuid

DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
NAME_RE = re.compile(r"^[A-Za-z0-9 ._&()+-]{1,64}$")          # shown on phones; no quotes / colons (RouterOS name:lang)
SSID_RE = re.compile(r"^[A-Za-z0-9 ._@#+()-]{1,32}$")
OI_RE = re.compile(r"^([0-9a-f]{6}|[0-9a-f]{10})$")              # 3- or 5-octet roaming consortium OI
USER_RE = re.compile(r"^[A-Za-z0-9._@+-]{1,64}$")
NETWORKS = ("private", "private-with-guest", "public-chargeable", "public-free", "personal-device")
VENUES = ("business-professional-office", "business-unspecified", "industrial-factory", "industrial-unspecified",
          "educational-university-or-college", "educational-secondary-school", "educational-primary-school",
          "institutional-hospital", "mercantile-retail-store", "mercantile-shopping-mall", "residential-hotel",
          "residential-dormitory", "assembly-restaurant", "assembly-coffee-shop", "unspecified")
DEFAULTS = {"name": "Office Wi-Fi", "ssid": "Office-Passpoint", "venue": "business-professional-office",
            "venue_name": "Office", "network": "private", "roaming_oi": ""}
PPS_DDF = "urn:wfa:mo:hotspot2dot0-perprovidersubscription:1.0"


def settings(raw):
    """raw dict (missing keys -> defaults) -> checked settings; ValueError with a plain message"""
    st = dict(DEFAULTS)
    st.update({k: (str(v).strip() if v is not None else "") for k, v in (raw or {}).items() if k in DEFAULTS or k == "domain"})
    for k in DEFAULTS:
        if not st[k] and k != "roaming_oi":
            st[k] = DEFAULTS[k]
    st["domain"] = st.get("domain", "").lower().rstrip(".")
    st["roaming_oi"] = st["roaming_oi"].lower().replace("-", "").replace(":", "")
    if not DOMAIN_RE.match(st["domain"]):
        raise ValueError("Passpoint domain: a name like wifi.yourcompany.com (best: the RADIUS certificate's name)")
    if not NAME_RE.match(st["name"]):
        raise ValueError("name: letters, digits, space . _ & ( ) + - (64 at most)")
    if not NAME_RE.match(st["venue_name"]):
        raise ValueError("venue name: letters, digits, space . _ & ( ) + - (64 at most)")
    if not SSID_RE.match(st["ssid"]):
        raise ValueError("Wi-Fi name: letters, digits, space . _ - (32 at most)")
    if st["venue"] not in VENUES:
        raise ValueError("venue: one of " + ", ".join(VENUES))
    if st["network"] not in NETWORKS:
        raise ValueError("network type: one of " + ", ".join(NETWORKS))
    if st["roaming_oi"] and not OI_RE.match(st["roaming_oi"]):
        raise ValueError("roaming OI: 6 or 10 hex digits (like 5a03ba0000), or empty")
    return st


def router(st, template, server=None, secret=None):
    """passpoint-*.rsc with this server's settings filled in"""
    pairs = [('ssid="Office-Passpoint"', f'ssid="{st["ssid"]}"'),
             ("domain-names=wifi.example.com realms=wifi.example.com:not-specified",
              f"domain-names={st['domain']} realms={st['domain']}:not-specified"
              + (f" roaming-ois={st['roaming_oi']}" if st["roaming_oi"] else "")),
             ('venue-names="Office:eng"', f'venue-names="{st["venue_name"]}:eng"'),
             ('operator-names="Your Company:eng"', f'operator-names="{st["name"]}:eng"'),
             ("venue=business-professional-office", f"venue={st['venue']}"),
             ("network-type=private", f"network-type={st['network']}")]
    t = template
    for old, new in pairs:
        if old not in t:
            raise ValueError(f"template: '{old}' not found (template changed?)")
        t = t.replace(old, new)
    if server:
        t = t.replace("RADIUS_SERVER_IP", server)
    if secret:
        t = t.replace("RADIUS_SECRET", secret)
    return t


def _ids(st, user):
    base = f"mikrotiklover.passpoint.{st['domain']}.{user}"
    return base, (lambda part: str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{part}.{base}")).upper())


def ios(st, user, password, ca_der=None, server_name=None):
    """Apple configuration profile (.mobileconfig, iOS / iPadOS / macOS): Passpoint Wi-Fi + the CA"""
    if not USER_RE.match(user or "") or not password:
        raise ValueError("user name and password needed")
    ident, uid = _ids(st, user)
    eap = {"AcceptEAPTypes": [21], "TTLSInnerAuthentication": "MSCHAPv2", "UserName": user,
           "UserPassword": password, "OuterIdentity": f"anonymous@{st['domain']}",
           "TLSTrustedServerNames": [server_name or st["domain"]]}
    content = []
    if ca_der:
        content.append({"PayloadType": "com.apple.security.root", "PayloadVersion": 1,
                        "PayloadIdentifier": ident + ".ca", "PayloadUUID": uid("ca"),
                        "PayloadDisplayName": f"{st['name']} Wi-Fi certificate", "PayloadContent": ca_der})
        eap["PayloadCertificateAnchorUUID"] = [uid("ca")]
    wifi = {"PayloadType": "com.apple.wifi.managed", "PayloadVersion": 1,
            "PayloadIdentifier": ident + ".wifi", "PayloadUUID": uid("wifi"),
            "PayloadDisplayName": f"{st['name']} (Passpoint)",
            "IsHotspot": True, "DomainName": st["domain"], "DisplayedOperatorName": st["name"],
            "NAIRealmNames": [st["domain"]], "ServiceProviderRoamingEnabled": False,
            "AutoJoin": True, "EncryptionType": "WPA2", "EAPClientConfiguration": eap}
    if st["roaming_oi"]:
        wifi["RoamingConsortiumOIs"] = [st["roaming_oi"].upper()]
    content.append(wifi)
    prof = {"PayloadType": "Configuration", "PayloadVersion": 1, "PayloadIdentifier": ident,
            "PayloadUUID": uid("profile"), "PayloadDisplayName": f"{st['name']} Wi-Fi ({user})",
            "PayloadDescription": f"Joins the {st['name']} Wi-Fi by itself (Passpoint) as {user}.",
            "PayloadOrganization": st["name"], "PayloadRemovalDisallowed": False, "PayloadContent": content}
    return plistlib.dumps(prof, fmt=plistlib.FMT_XML)


def _node(name, *children, value=None):
    from xml.sax.saxutils import escape
    if value is not None:
        return f"<Node><NodeName>{name}</NodeName><Value>{escape(str(value))}</Value></Node>"
    return f"<Node><NodeName>{name}</NodeName>{''.join(children)}</Node>"


def pps_mo(st, user, password, server_name=None):
    """PerProviderSubscription management object (XML) — Android's Passpoint profile"""
    if not USER_RE.match(user or "") or not password:
        raise ValueError("user name and password needed")
    home = [_node("FriendlyName", value=st["name"]), _node("FQDN", value=st["domain"])]
    if st["roaming_oi"]:
        home.append(_node("RoamingConsortiumOI", value=st["roaming_oi"]))
    cred = _node("Credential",
                 _node("Realm", value=st["domain"]),
                 _node("UsernamePassword",
                       _node("Username", value=user),
                       _node("Password", value=base64.b64encode(password.encode()).decode()),
                       _node("EAPMethod", _node("EAPType", value=21), _node("InnerMethod", value="MS-CHAP-V2"))))
    parts = [_node("HomeSP", *home), cred]
    if server_name and server_name != st["domain"]:
        # Android 12+: the RADIUS certificate's name when it is not under the domain (older ones check the domain)
        parts.append(_node("Extension", _node("Android", _node("AAAServerTrustedNames", _node("FQDN", value=server_name)))))
    return ('<MgmtTree xmlns="syncml:dmddf1.2"><VerDTD>1.2</VerDTD>'
            "<Node><NodeName>PerProviderSubscription</NodeName>"
            f"<RTProperties><Type><DDFName>{PPS_DDF}</DDFName></Type></RTProperties>"
            + _node("i001", *parts) + "</Node></MgmtTree>")


def android(st, user, password, ca_der=None, server_name=None):
    """application/x-wifi-config file: base64 of a MIME multipart (profile + CA), as Android installs it
    when a browser downloads it with that Content-Type (Android 8+)"""
    b = "mikrotiklover-" + uuid.uuid5(uuid.NAMESPACE_DNS, user + st["domain"]).hex[:16]

    def wrap(data):
        s = base64.b64encode(data).decode()
        return "\r\n".join(s[i:i + 76] for i in range(0, len(s), 76))
    out = [f"Content-Type: multipart/mixed; boundary={b}", "Content-Transfer-Encoding: base64", "",
           f"--{b}", "Content-Type: application/x-passpoint-profile", "Content-Transfer-Encoding: base64", "",
           wrap(pps_mo(st, user, password, server_name).encode())]
    if ca_der:
        out += [f"--{b}", "Content-Type: application/x-x509-ca-cert", "Content-Transfer-Encoding: base64", "", wrap(ca_der)]
    out += [f"--{b}--", ""]
    return base64.b64encode("\r\n".join(out).encode()).decode() + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Passpoint router script and phone profiles")
    ap.add_argument("what", choices=("check", "router", "ios", "android"))
    ap.add_argument("--settings", default="{}", help="JSON object of the pp_* settings (without pp_)")
    ap.add_argument("--template"); ap.add_argument("--server"); ap.add_argument("--secret")
    ap.add_argument("--user"); ap.add_argument("--ca"); ap.add_argument("--server-name")
    a = ap.parse_args(argv)
    try:
        st = settings(json.loads(a.settings))
        if a.what == "check":
            print(json.dumps(st))
        elif a.what == "router":
            sys.stdout.write(router(st, open(a.template, encoding="utf-8").read(), a.server, a.secret))
        else:
            pw = sys.stdin.readline().rstrip("\r\n")
            ca = open(a.ca, "rb").read() if a.ca else None
            if ca and ca.startswith(b"-----BEGIN"):
                ca = base64.b64decode("".join(l for l in ca.decode().splitlines() if l and not l.startswith("-----")))
            if a.what == "ios":
                sys.stdout.buffer.write(ios(st, a.user, pw, ca, a.server_name))
            else:
                sys.stdout.write(android(st, a.user, pw, ca, a.server_name))
    except (ValueError, json.JSONDecodeError, OSError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
