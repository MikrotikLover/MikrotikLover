#!/usr/bin/env bash
# Speed schedule tests on an installed server (needs root + the database): the SQL rules and the CLI checks.
#   sudo bash tests/test-speed.sh
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
rate() { db "SELECT ml_sched_rate('$1', '$2')"; }
# other rules on this server are switched off during the test and back on at the end
others=$(db "SELECT GROUP_CONCAT(id) FROM ml_speed_schedule WHERE enabled=1 AND name NOT LIKE 'zt-%'")
[ "$others" = NULL ] && others=""
restore() { [ -z "$others" ] || db "UPDATE ml_speed_schedule SET enabled=1 WHERE id IN ($others)"; }
trap restore EXIT
[ -z "$others" ] || db "UPDATE ml_speed_schedule SET enabled=0 WHERE id IN ($others)"
db "DELETE FROM ml_speed_schedule WHERE name LIKE 'zt-%'; DELETE FROM radusergroup WHERE username='zt-user';
    INSERT INTO radusergroup (username, groupname, priority) VALUES ('zt-user', 'zt-grp', 1);
    INSERT INTO ml_speed_schedule (name, target_type, target, days, start_min, end_min, rate) VALUES
      ('zt-night', 'all', '', 'all', 1320, 360, '20M/20M'),
      ('zt-peak', 'group', 'zt-grp', 'mon,tue,wed,thu,fri', 1080, 1380, '2M/2M'),
      ('zt-fri', 'all', '', 'fri', 1380, 120, '30M/30M'),
      ('zt-user1', 'user', 'zt-vip', 'all', 0, 0, '50M/50M');"
# 2026-10-19 is a Monday
t "night 23:00 (everyone)" "$(rate nobody '2026-10-19 23:30:00')" "20M/20M"
t "night continues after midnight 05:59" "$(rate nobody '2026-10-20 05:59:00')" "20M/20M"
t "night ends 06:00" "$(rate nobody '2026-10-20 06:00:00')" ""
t "day 12:00: no schedule" "$(rate nobody '2026-10-19 12:00:00')" ""
t "group rule beats everyone (Mon 22:30)" "$(rate zt-user '2026-10-19 22:30:00')" "2M/2M"
t "group rule only on weekdays (Sat 19:00)" "$(rate zt-user '2026-10-24 19:00:00')" ""
t "end time is not included (Mon 23:00 -> night)" "$(rate zt-user '2026-10-19 23:00:00')" "20M/20M"
t "Friday-only window, Fri 23:30 (newest everyone rule wins)" "$(rate nobody '2026-10-23 23:30:00')" "30M/30M"
t "Friday window continues Sat 01:00" "$(rate nobody '2026-10-24 01:00:00')" "30M/30M"
t "Friday window not on Sun 01:00 (night instead)" "$(rate nobody '2026-10-25 01:00:00')" "20M/20M"
t "user rule all day beats everything" "$(rate zt-vip '2026-10-19 23:30:00')" "50M/50M"
db "UPDATE ml_speed_schedule SET enabled=0 WHERE name='zt-user1'"
t "rule turned off is ignored" "$(rate zt-vip '2026-10-19 12:00:00')" ""
# CLI input checks
chk() { if out=$(radius-admin speed "$@" 2>&1); then echo "FAIL refused: speed $*"; fails=$((fails+1)); else echo "ok   refused: speed $* ($(tail -1 <<<"$out" | cut -c1-50))"; fi; }
chk add zt-bad --rate fast --time 1-2
chk add zt-bad --rate 1M/1M --time 25:00-02:00
chk add zt-bad --rate 1M/1M --time 1-2 --days someday
chk add zt-bad --rate 1M/1M --time 1-2 --group no-such-group
chk add 'zt bad' --rate 1M/1M --time 1-2
chk del zt-none
out=$(radius-admin speed add zt-cli --rate 3M/3M --time 0-0 --days sat,sun 2>&1) && t "CLI add all-day weekend" "$(db "SELECT CONCAT(start_min,'-',end_min,' ',days) FROM ml_speed_schedule WHERE name='zt-cli'")" "0-0 sat,sun"
radius-admin speed add zt-cli --rate 4M/4M --time 22h-6h >/dev/null 2>&1
t "CLI add same name updates it" "$(db "SELECT CONCAT(rate,' ',start_min,'-',end_min,' ',days) FROM ml_speed_schedule WHERE name='zt-cli'")" "4M/4M 1320-360 all"
db "DELETE FROM ml_speed_schedule WHERE name LIKE 'zt-%'; DELETE FROM radusergroup WHERE username='zt-user';"
[ "$fails" = 0 ] && echo "all speed tests passed" || { echo "$fails FAILED"; exit 1; }
