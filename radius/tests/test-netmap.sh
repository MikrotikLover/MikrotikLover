#!/usr/bin/env bash
# Network map: per department its people (users + users of its groups + MAC devices) with address, online, device kind,
# policy, fixed address; SNMP devices put in a department; online people in no department; routers and core devices.
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-netmap.sh
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
[ -n "${URL:-}" ] || { echo "skip: needs URL USER PASS (dashboard)"; exit 0; }
MAC=AA:BB:CC:16:00:01
# the policy "kids" these checks use (made when the server has none)
. "$(dirname "$0")/lib-kids.sh"
cleanup() {
    kids_cleanup
    for u in nm-a nm-b nm-c; do radius-admin user del "$u" >/dev/null 2>&1; done
    radius-admin mac del $MAC >/dev/null 2>&1
    for id in $(db "SELECT id FROM ml_snmp_device WHERE name LIKE 'nm-%'"); do radius-admin snmp del "$id" >/dev/null 2>&1; done
    db "DELETE FROM radacct WHERE acctsessionid LIKE 'nm-%'; DELETE FROM ml_dept_member WHERE dept='nm-office'; DELETE FROM ml_department WHERE name='nm-office';
        DELETE FROM radgroupreply WHERE groupname='nm-grp'; DELETE FROM radusergroup WHERE groupname='nm-grp'; DELETE FROM radgroup_meta WHERE groupname='nm-grp';
        DELETE FROM ml_device WHERE client_ip LIKE '192.168.160.%'; DELETE FROM ml_ip_bind WHERE username LIKE 'nm-%'"
}
trap cleanup EXIT
cleanup
sess() { db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, callingstationid, acctstarttime, acctupdatetime)
             VALUES ('nm-$RANDOM', 'nm-$1-$RANDOM$RANDOM', '$1', '127.0.0.1', '$2', '$3', NOW(), NOW())"; }

radius-admin group add nm-grp --policy kids >/dev/null
radius-admin user add nm-a -p Pass1234 >/dev/null; radius-admin user policy nm-a staff >/dev/null
radius-admin user add nm-b -p Pass1234 -g nm-grp >/dev/null
radius-admin user add nm-c -p Pass1234 >/dev/null
radius-admin mac add $MAC -g nm-grp -d "nm reception printer" >/dev/null
radius-admin dept add nm-office 10M 5M >/dev/null 2>&1 || db "INSERT INTO ml_department (name, down_kbps, up_kbps) VALUES ('nm-office', 10000, 5000)"
radius-admin dept member nm-office user nm-a >/dev/null 2>&1 || db "INSERT INTO ml_dept_member VALUES ('nm-office','user','nm-a')"
radius-admin dept member nm-office group nm-grp >/dev/null 2>&1 || db "INSERT INTO ml_dept_member VALUES ('nm-office','group','nm-grp')"
sess nm-a 192.168.160.11 AA-BB-CC-16-00-11
sess AA-BB-CC-16-00-01 192.168.160.12 AA-BB-CC-16-00-01
sess nm-c 192.168.160.13 AA-BB-CC-16-00-13
db "INSERT INTO ml_device (client_ip, os, username, first_seen, last_seen) VALUES ('192.168.160.11','windows','nm-a',NOW(),NOW())"
radius-admin ipbind set nm-b 192.168.160.50 >/dev/null
radius-admin snmp add 127.0.0.250 port 11999 name nm-ap1 kind ap --no-check >/dev/null
radius-admin snmp add 127.0.0.251 port 11998 name nm-core kind switch --no-check >/dev/null
radius-admin snmp add 127.0.0.1 port 11997 name nm-rtr kind mikrotik --no-check >/dev/null
AP=$(db "SELECT id FROM ml_snmp_device WHERE name='nm-ap1'")
t "device put in a department (CLI); unknown department refused" "$(radius-admin snmp dept "$AP" nm-office | grep -c 'dept nm-office')$(radius-admin snmp dept "$AP" nosuch 2>&1 | grep -c 'no department')" "11"

jar=$(mktemp)
csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/nm.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
js() { python3 -c "import json; d=json.load(open('/tmp/nm.json')); D={x['name']:x for x in d['departments']}; P={p['name']:p for x in d['departments'] for p in x['people']}; L={p['name']:p for p in d['loose']}; print($1)"; }
t "map: the department, its shared speed, 2 of 3 online" "$(api GET /api/netmap)$(js "(D['nm-office']['online'], D['nm-office']['total'], D['nm-office']['down_kbps'])")" "200(2, 3, 10000)"
t "  user nm-a: online, its IP, Windows, own policy" "$(js "(P['nm-a']['online'], P['nm-a']['ip'], P['nm-a']['os'], P['nm-a']['policy'], P['nm-a']['kind'])")" "(True, '192.168.160.11', 'windows', 'staff', 'user')"
t "  group user nm-b: offline, shown on its fixed address, the group's policy" "$(js "(P['nm-b']['online'], P['nm-b']['ip'], P['nm-b']['fixed'], P['nm-b']['policy'])")" "(False, '192.168.160.50', True, 'kids')"
t "  MAC device of the group: with its description" "$(js "(P['AA-BB-CC-16-00-01']['kind'], P['AA-BB-CC-16-00-01']['label'], P['AA-BB-CC-16-00-01']['ip'])")" "('mac', 'nm reception printer', '192.168.160.12')"
t "  online ones listed first" "$(js "[p['online'] for p in D['nm-office']['people']]")" "[True, True, False]"
t "  its AP shown in it" "$(js "[x['name'] for x in D['nm-office']['devices']]")" "['nm-ap1']"
t "online but in no department: shown apart" "$(js "('nm-c' in L, 'nm-a' in L)")" "(True, False)"
t "a switch in no department: at the top (core)" "$(js "[x['name'] for x in d['core'] if x['name'].startswith('nm-')]")" "['nm-core']"
t "routers listed with their online count" "$(js "any(r['ip']=='127.0.0.1' and r['online'] >= 3 for r in d['routers'])")" "True"
t "a router that is also an SNMP device: shown once, as the router (not again in core)" "$(js "([r['name'] for r in d['routers'] if r['ip']=='127.0.0.1'], [x['name'] for x in d['core'] if x['name']=='nm-rtr'])")" "(['nm-rtr'], [])"
t "routers given as a subnet are not drawn" "$(js "all('/' not in r['ip'] for r in d['routers'])")" "True"
t "API: move a device to a department and back" "$(api POST "/api/devices/$AP/dept" '{"dept":""}')$(db "SELECT dept FROM ml_snmp_device WHERE id=$AP")-$(api POST "/api/devices/$AP/dept" '{"dept":"nm-office"}')$(db "SELECT dept FROM ml_snmp_device WHERE id=$AP")" "200-200nm-office"
t "API: bad department name 400" "$(api POST "/api/devices/$AP/dept" '{"dept":"x;y"}')" "400"
t "device page offers the departments" "$(api GET "/api/devices/$AP")$(python3 -c "import json; d=json.load(open('/tmp/nm.json')); print('nm-office' in d['depts'], d['device']['dept'])")" "200True nm-office"
# whole network: the core switch sees the AP (and nm-a's phone) on its port 3 -> AP under the core, nm-a under the AP
CORE=$(db "SELECT id FROM ml_snmp_device WHERE name='nm-core'")
db "UPDATE ml_snmp_device SET macs='AA-BB-CC-16-0A-01' WHERE id=$AP; UPDATE ml_snmp_device SET macs='AA-BB-CC-16-0C-01' WHERE id=$CORE;
    INSERT INTO ml_snmp_if (device_id, ifindex, name) VALUES ($CORE, 3, 'Gi0/3');
    INSERT INTO ml_snmp_fdb (device_id, ifindex, mac, seen) VALUES ($CORE, 3, 'AA-BB-CC-16-0A-01', NOW()), ($CORE, 3, 'AA-BB-CC-16-00-11', NOW()), ($CORE, 9, 'AA-BB-CC-16-0F-FF', NOW())"
api GET /api/netmap/topology >/dev/null
t "whole network: AP on the core's port Gi0/3, nm-a's phone under the AP, an unknown MAC counted" \
  "$(python3 -c "import json; N={n['id']:n for n in json.load(open('/tmp/nm.json'))['nodes']}; print(N['d$AP']['parent']=='d$CORE', N['d$AP']['port'], N['pAA-BB-CC-16-00-11']['parent']=='d$AP', N.get('u-d$CORE',{}).get('count'))")" "True Gi0/3 True 1"
t "whole network: a person not seen on any switch hangs under the router" "$(python3 -c "import json; N={n['id']:n for n in json.load(open('/tmp/nm.json'))['nodes']}; print(N['pAA-BB-CC-16-00-13']['parent'])")" "d$(db "SELECT id FROM ml_snmp_device WHERE name='nm-rtr'")"
db "DELETE FROM ml_snmp_if WHERE device_id=$CORE"
rm -f "$jar" /tmp/nm.json
[ "$fails" = 0 ] && echo "all network map tests passed" || { echo "$fails FAILED"; exit 1; }
