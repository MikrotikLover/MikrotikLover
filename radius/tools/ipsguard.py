#!/usr/bin/env python3
"""Inline IPS guard (fail-open): the internet must not stop because Suricata stopped.

In inline mode Suricata itself carries every packet between the two network cards (MikroTik side <-> LAN side).
Every second this checks that Suricata runs and really passes traffic. If it is not running, or packets come in
but nothing goes out for 3 seconds (stuck), the two cards are joined by a plain Linux bridge (br-mlbypass):
traffic flows unchecked until Suricata is back and has started, then the bridge is removed again.
A hang kills Suricata so it starts fresh; after 3 failures in 10 minutes it stays on the bridge (health check says so).

  ipsguard.py            run (systemd: mikrotiklover-ipsguard)
  ipsguard.py bypass on|off|status
"""
import json, os, re, signal, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ips  # noqa: E402

BR = "br-mlbypass"
STATE = os.environ.get("ML_INLINE_STATE", "/run/mikrotiklover/inline.json")
MANUAL = os.environ.get("ML_INLINE_MANUAL", "/run/mikrotiklover/bypass.manual")
LOG = os.path.join(ips.LOG_DIR, "suricata.log")


def sh(*a):
    return subprocess.run(list(a), capture_output=True, text=True)


def counters(i):
    out = []
    for k in ("rx_packets", "tx_packets"):
        try:
            out.append(int(open(f"/sys/class/net/{i}/statistics/{k}").read()))
        except (OSError, ValueError):
            out.append(0)
    return out


def bypass_on(wan, lan):
    if not os.path.exists(f"/sys/class/net/{BR}"):
        sh("ip", "link", "add", BR, "type", "bridge", "stp_state", "0", "forward_delay", "0")
    for i in (wan, lan):
        sh("ip", "link", "set", i, "master", BR)
    sh("ip", "link", "set", BR, "up")


def bypass_off(wan, lan):
    for i in (wan, lan):
        sh("ip", "link", "set", i, "nomaster")
    if os.path.exists(f"/sys/class/net/{BR}"):
        sh("ip", "link", "del", BR)


def bypassed():
    return os.path.exists(f"/sys/class/net/{BR}")


def prepare(wan, lan):
    """Both cards up, no address handling, promiscuous, no offloads (Suricata must see real packets)."""
    for i in (wan, lan):
        sh("ip", "link", "set", i, "up", "promisc", "on")
        sh("ethtool", "-K", i, "gro", "off", "lro", "off", "tso", "off", "gso", "off", "rx", "off", "tx", "off")


def started_ok(pid):
    """Suricata wrote 'Engine started' after this process began (rules loaded, passing packets)."""
    try:
        since = os.stat(f"/proc/{pid}").st_mtime - 2
        for line in reversed(open(LOG, errors="replace").read().splitlines()[-400:]):
            if "Engine started" in line:
                m = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", line)
                return bool(m) and time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")) >= since
    except OSError:
        pass
    return False


def save(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w") as f:
        json.dump(st, f)
    os.replace(STATE + ".tmp", STATE)


def restart_suricata():
    if os.path.isdir("/run/systemd/system"):
        sh("systemctl", "restart", "mikrotiklover-suricata")
        return
    pid = ips.suricata_pid()
    if pid:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        time.sleep(1)
    try:
        os.remove(ips.PIDFILE)
    except OSError:
        pass
    subprocess.Popen(["suricata", "-D"] + ips.suricata_args(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run():
    st = {"bypass": bypassed(), "since": time.time(), "reason": "", "failures": [], "guard": os.getpid()}
    hist = []                                    # (time, packets in, packets out)
    missing_since = None
    last_mode = None
    while True:
        m = ips.mode()
        if m["mode"] != "inline":
            if last_mode == "inline" and bypassed():
                bypass_off(m.get("wan", ""), m.get("lan", ""))
            last_mode = m["mode"]
            save({**st, "bypass": False, "mode": "copy"})
            time.sleep(2)
            continue
        wan, lan = m["wan"], m["lan"]
        if last_mode != "inline":
            prepare(wan, lan)
        last_mode = "inline"
        now = time.time()
        if os.path.exists(MANUAL):               # the admin turned the bypass on by hand: leave it
            if not bypassed():
                bypass_on(wan, lan)
            st.update(bypass=True, reason="turned on by hand", mode="inline", wan=wan, lan=lan, at=now, manual=True)
            save(st)
            time.sleep(1)
            continue
        st["manual"] = False
        pid = ips.suricata_pid()
        (rw, tw), (rl, tl) = counters(wan), counters(lan)
        hist = [h for h in hist if now - h[0] <= 3.2] + [(now, rw + rl, tw + tl)]
        stuck = False
        if pid and not bypassed() and len(hist) >= 3 and now - hist[0][0] >= 2.8:
            got, sent = hist[-1][1] - hist[0][1], hist[-1][2] - hist[0][2]
            stuck = got >= 30 and sent == 0
        st["failures"] = [t for t in st["failures"] if now - t < 600]
        missing_since = (missing_since or now) if not pid else None
        if not bypassed() and (not pid or stuck):
            bypass_on(wan, lan)                  # fail open at once: the internet keeps working
            st.update(bypass=True, since=now, reason="Suricata stopped" if not pid else "Suricata stuck (packets in, none out)")
            print(f"ipsguard: BYPASS ON — {st['reason']}", flush=True)
            if stuck:
                st["failures"].append(now)
                if len(st["failures"]) <= 3:
                    restart_suricata()
            hist = []
        elif bypassed() and not pid and missing_since and now - missing_since > 15 and len(st["failures"]) <= 3 \
                and now - st.get("restarted", 0) > 30:
            st["failures"].append(now)           # gone for 15 s (no one is starting it): start it again
            st["restarted"] = now
            restart_suricata()
        elif bypassed() and pid and started_ok(pid) and len(st["failures"]) <= 3:
            bypass_off(wan, lan)
            st.update(bypass=False, since=now, reason="")
            print("ipsguard: bypass off — Suricata is passing traffic again", flush=True)
            hist = []
        st.update(mode="inline", wan=wan, lan=lan, at=now, held=len(st["failures"]) > 3)
        save(st)
        time.sleep(1)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["bypass"]:
        m = ips.mode()
        if m["mode"] != "inline":
            raise SystemExit("not in inline mode")
        act = argv[1] if len(argv) > 1 else "status"
        if act == "on":
            os.makedirs(os.path.dirname(MANUAL), exist_ok=True)
            open(MANUAL, "w").close()
            bypass_on(m["wan"], m["lan"])
        elif act == "off":
            try:
                os.remove(MANUAL)
            except OSError:
                pass
            if ips.suricata_pid():
                bypass_off(m["wan"], m["lan"])
        print(f"bypass {'ON (traffic not checked)' if bypassed() else 'off'}")
        return 0
    run()


if __name__ == "__main__":
    sys.exit(main())
