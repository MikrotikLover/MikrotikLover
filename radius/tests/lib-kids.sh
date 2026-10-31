# shellcheck shell=bash
# Several server tests give users the policy "kids". It is not one of the shipped policies (README examples make it),
# so a test sources this file and calls kids_ensure AFTER its own first clean-up: "kids" is made when the server has
# none, and kids_cleanup (in the test's clean-up) removes it again — only when this test made it.
KIDS_MADE=0
kids_ensure() {
    [ -f /var/lib/mikrotiklover/policies/kids.txt ] && return 0
    printf '# Kids: social media, games, VPN and adult words blocked (made by a test)\nblock social\nblock gaming\nblock-vpn\nblock keywords\n' \
        | radius-admin policy set kids >/dev/null 2>&1 && KIDS_MADE=1
}
kids_cleanup() { [ "$KIDS_MADE" = 1 ] && radius-admin policy del kids >/dev/null 2>&1; KIDS_MADE=0; }
