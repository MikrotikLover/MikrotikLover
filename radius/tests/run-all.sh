#!/usr/bin/env bash
# Every test of this project in one run, with a summary at the end.
#
#   sudo tests/run-all.sh [--quick] [--only PATTERN] [--log DIR]
#     --quick         no server needed: only the tests that run without an installed server
#     --only PAT      only tests whose file name contains PAT
#     --log DIR       each test's output in DIR/<name>.log (default: a temp dir, printed at the end)
#   URL=https://127.0.0.1:8443 USER=admin PASS=...  also runs the browser tests (ui-*.mjs)
#
# Left out (long, own command): test-vm-image.sh (builds / boots a VM image), test-chr.sh (RouterOS in QEMU:
# run tests/test-chr.sh --ros 7 and --ros 6). A Python test with a --live part is run with --live on a server.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
QUICK=0 ONLY="" LOG=""
while [ $# -gt 0 ]; do
    case $1 in --quick) QUICK=1 ;; --only) ONLY=${2:-}; shift ;; --log) LOG=${2:-}; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; shift
done
LOG=${LOG:-$(mktemp -d /tmp/ml-tests.XXXXXX)}; mkdir -p "$LOG"
SERVER=0; [ "$QUICK" = 0 ] && command -v radius-admin >/dev/null && [ -r /etc/mikrotiklover-radius/radius.conf ] && SERVER=1
# needs a server (radius-admin, database, FreeRADIUS, dashboard) — skipped with --quick or when none is installed
NEEDS_SERVER=" test-ai.sh test-allowonly.sh test-apps-health.sh test-blockpage.sh test-captive.sh test-firewall.sh test-golive.sh test-ha.sh
 test-inbound-winupdate.sh test-inline.sh test-ipbind.sh test-ips.sh test-lan-logins.sh test-letsencrypt.sh test-login-policies.sh
 test-mail.sh test-netip.sh test-netmap.sh test-notice.sh test-policy-give.sh test-policy-onoff.sh test-push.sh test-ransomware.sh
 test-remember.sh test-ros6.sh test-snmp.sh test-social.sh test-speed.sh test-traffic.sh test-unblock.sh test-webscan.sh test-wifipolicy.sh "
SKIP=" test-vm-image.sh test-chr.sh "
# a server test against a stopped database only gives "can't connect" everywhere: say it once and stop
if [ $SERVER = 1 ] && ! mysql -N -e "SELECT 1" radius >/dev/null 2>&1; then
    echo "The database (MariaDB) is not running — start the server first (sudo service mariadb start; sudo radius-admin doctor)," >&2
    echo "or run the tests that need no server: tests/run-all.sh --quick" >&2
    exit 2
fi
pass=() fail=() skipped=()
run() { # NAME CMD...
    local name=$1; shift
    local t0=$SECONDS rc
    timeout 1800 "$@" > "$LOG/$name.log" 2>&1; rc=$?
    if [ $rc = 0 ]; then pass+=("$name"); printf '  \033[32mok  \033[0m %-34s %4ss\n' "$name" $((SECONDS - t0))
    else fail+=("$name"); printf '  \033[31mFAIL\033[0m %-34s %4ss  (%s)\n' "$name" $((SECONDS - t0)) "$(grep -m1 -E '^FAIL|ERROR|Error|Traceback' "$LOG/$name.log" | cut -c1-90)"; fi
}
echo "== MikrotikLover tests ($([ $SERVER = 1 ] && echo "with the installed server" || echo "no server: quick tests only")) — logs: $LOG"
for f in "$HERE"/lint-rsc.py "$HERE"/simulate-*.py "$HERE"/test-*.py "$HERE"/test-*.sh; do
    n=$(basename "$f")
    [ -n "$ONLY" ] && [[ $n != *"$ONLY"* ]] && continue
    [[ $SKIP == *" $n "* ]] && continue
    if [[ $NEEDS_SERVER == *" $n "* ]] && [ $SERVER = 0 ]; then skipped+=("$n"); continue; fi
    case $n in
        *.py) if [ $SERVER = 1 ] && grep -q -- '"--live"' "$f"; then run "$n --live" python3 "$f" --live; else run "$n" python3 "$f"; fi ;;
        *.sh) run "$n" bash "$f" ;;
    esac
done
if [ -n "${URL:-}" ] && [ -n "${PASS:-}" ] && command -v node >/dev/null; then
    for f in "$HERE"/ui-*.mjs; do n=$(basename "$f"); [ -n "$ONLY" ] && [[ $n != *"$ONLY"* ]] && continue; run "$n" node "$f"; done
else
    skipped+=("ui-*.mjs (set URL, USER, PASS)")
fi
echo
echo "passed ${#pass[@]}, failed ${#fail[@]}, skipped ${#skipped[@]}"
[ ${#fail[@]} = 0 ] || { echo "failed:"; printf '  %s\n' "${fail[@]}"; }
[ ${#skipped[@]} = 0 ] || echo "skipped: ${skipped[*]}"
echo "logs: $LOG"
[ ${#fail[@]} = 0 ]
