# shellcheck shell=bash
# Several server tests give users the policy "kids". It is not one of the shipped policies (README examples make it),
# so a test sources this file: "kids" is made when the server has none, and removed again at the end (kids_cleanup).
KIDS_MADE=0
if [ ! -f /var/lib/mikrotiklover/policies/kids.txt ]; then
    printf '# Kids: social media, games, VPN and adult words blocked (made by a test)\nblock social\nblock gaming\nblock-vpn\nblock keywords\n' \
        | radius-admin policy set kids >/dev/null 2>&1 && KIDS_MADE=1
fi
kids_cleanup() { [ "$KIDS_MADE" = 1 ] && radius-admin policy del kids >/dev/null 2>&1; KIDS_MADE=0; }
