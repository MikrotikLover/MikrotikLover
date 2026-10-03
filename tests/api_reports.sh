#!/usr/bin/env bash
# API test for Batch 6: reports + dashboard. Uses its own parties/items (RUN suffix)
# and filters on them, so it can run against a database that already has data.
#   BASE=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASS=Admin12345 tests/api_reports.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/index.php?r="
JAR=$(mktemp); PASS=0; FAIL=0; CSRF=""
RUN=$(date +%s | tail -c 6)
TODAY=$(TZ=Asia/Karachi date +%F)
MONTH="${TODAY:0:8}01"

json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode("|",$argv[1]) as $k){ $v=is_array($v)&&array_key_exists($k,$v)?$v[$k]:null; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v,JSON_UNESCAPED_UNICODE):(string)$v);' "$1"; }
req() { local out; out=$(curl -s -o - -w '\n%{http_code}' -X "$1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" ${3:+--data "$3"} "$API$2"); echo "$(tail -n1 <<<"$out")|$(sed '$d' <<<"$out")"; }
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi; }
code() { echo "${1%%|*}"; }
body() { echo "${1#*|}"; }
id() { body "$1" | json "data|id"; }
num() { php -r 'echo rtrim(rtrim(number_format((float)$argv[1], 3, ".", ""), "0"), ".");' "$1"; }
# rep <route+query> → body; col <body> <row> <key>; tot <body> <key>; rows <body>
rep() { body "$(req GET "reports/$1&date_from=$MONTH&date_to=$TODAY")"; }
col() { num "$(json "data|rows|$2|$3" <<<"$1")"; }
txt() { json "data|rows|$2|$3" <<<"$1"; }
tot() { num "$(json "data|totals|$2" <<<"$1")"; }
rows() { php -r 'echo count(json_decode(stream_get_contents(STDIN),true)["data"]["rows"] ?? []);' <<<"$1"; }

R=$(req GET auth/bootstrap); CSRF=$(body "$R" | json "data|csrf")
R=$(req POST auth/login "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"${ADMIN_PASS:-Admin12345}\"}"); CSRF=$(body "$R" | json "data|csrf")
check "login" 200 "$(code "$R")"

echo "== fixtures"
L=$(body "$(req GET 'lookups&sets=units,warehouses,ink_colours')")
pick() { php -r '$d=json_decode($argv[1],true)["data"][$argv[2]]; foreach($d as $o) if($o[$argv[3]]===$argv[4]) { echo $o["value"]; break; }' "$L" "$@"; }
U_M=$(pick units code m); U_L=$(pick units code l)
GREY=$(pick warehouses code GREY); FLOOR=$(pick warehouses code FLOOR); FIN=$(pick warehouses code FIN)
C=$(pick ink_colours code C)
A=$(id "$(req POST parties "{\"name\":\"Rpt Owner $RUN\",\"is_customer\":true,\"is_fabric_owner\":true,\"is_active\":true}")")
SUP=$(id "$(req POST parties "{\"name\":\"Rpt Supplier $RUN\",\"is_supplier\":true,\"is_active\":true}")")
GF=$(id "$(req POST items "{\"name\":\"Rpt Grey $RUN\",\"item_type\":\"grey_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")")
FF=$(id "$(req POST items "{\"name\":\"Rpt Printed $RUN\",\"item_type\":\"finished_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")")
INK=$(id "$(req POST items "{\"name\":\"Rpt Cyan $RUN\",\"item_type\":\"ink\",\"unit_id\":$U_L,\"ink_colour_id\":$C,\"process_type\":\"sublimation\",\"rate_per_liter\":\"4000\",\"reorder_level\":\"10\",\"is_active\":true}")")
PAPER=$(id "$(req POST items "{\"name\":\"Rpt Paper $RUN\",\"item_type\":\"paper\",\"unit_id\":$U_M,\"rate\":\"25\",\"reorder_level\":\"5000\",\"is_active\":true}")")
MACH=$(id "$(req POST machines "{\"name\":\"Rpt Machine $RUN\",\"machine_type\":\"sublimation\",\"speed_m_per_hr\":\"50\",\"hourly_cost\":\"1000\",\"warehouse_id\":$FLOOR,\"is_active\":true}")")
D=$(id "$(req POST designs "{\"name\":\"Rpt Design $RUN\",\"party_id\":$A,\"process_type\":\"sublimation\",\"is_active\":true}")")
check "masters" 1 "$([[ -n "$A$SUP$GF$FF$INK$PAPER$MACH$D" && -n "$FIN" ]] && echo 1 || echo 0)"
LOT="RJ-$RUN"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$A,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"vehicle_no\":\"LES-$RUN\",\"lines\":[{\"item_id\":$GF,\"lot_no\":\"$LOT\",\"rolls\":\"3\",\"qty\":\"300\"}]}"); check "IGP job work 300 m" 201 "$(code "$R")"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$SUP,\"warehouse_id\":$FLOOR,\"ownership\":\"own\",\"lines\":[{\"item_id\":$PAPER,\"qty\":\"1000\"},{\"item_id\":$INK,\"qty\":\"2\"}]}"); check "IGP paper + ink" 201 "$(code "$R")"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"item_id\":$GF,\"lot_no\":\"$LOT\",\"rolls\":\"3\",\"qty\":\"300\"}]}"); check "transfer to floor" 201 "$(code "$R")"
R=$(req POST consumptions "{\"voucher_date\":\"$TODAY\",\"warehouse_id\":$FLOOR,\"machine_id\":$MACH,\"party_id\":$A,\"design_id\":$D,\"purpose\":\"sampling\",\"lines\":[{\"item_id\":$PAPER,\"qty\":\"100\"}]}"); check "consumption 100 m paper" 201 "$(code "$R")"
R=$(req POST ink-loads "{\"voucher_date\":\"$TODAY\",\"machine_id\":$MACH,\"warehouse_id\":$FLOOR,\"lines\":[{\"item_id\":$INK,\"ml_filled\":\"750\"}]}"); check "ink load 750 ml" 201 "$(code "$R")"
R=$(req POST productions-manual "{\"voucher_date\":\"$TODAY\",\"manual_reason\":\"job\",\"party_id\":$A,\"design_id\":$D,\"machine_id\":$MACH,\"fabric_item_id\":$GF,\"fabric_warehouse_id\":$FLOOR,\"fabric_lot_no\":\"$LOT\",\"finished_item_id\":$FF,\"finished_warehouse_id\":$FIN,\"produced_qty\":\"280\",\"produced_rolls\":\"7\",\"wastage_qty\":\"14\",\"material_warehouse_id\":$FLOOR,\"lines\":[]}")
check "manual production 280 m (+14 waste)" 201 "$(code "$R")"
R=$(req POST chalans "{\"voucher_date\":\"$TODAY\",\"party_id\":$A,\"warehouse_id\":$FIN,\"vehicle_no\":\"LEC-$RUN\",\"lines\":[{\"item_id\":$FF,\"lot_no\":\"$LOT\",\"rolls\":\"5\",\"qty\":\"200\"}]}")
check "chalan 200 m" 201 "$(code "$R")"; DCV=$(id "$R")

echo "== filters + validation"
R=$(req GET "reports/inward&date_from=$TODAY&date_to=$MONTH")
[[ "$TODAY" == "$MONTH" ]] && R=$(req GET "reports/inward&date_from=2099-01-02&date_to=2099-01-01")
check "from after to → 422 on date_to" "422|1" "$(code "$R")|$([[ -n $(body "$R" | json "errors|date_to") ]] && echo 1 || echo 0)"
R=$(req GET "reports/stock&view=ledger&date_from=$MONTH&date_to=$TODAY"); check "stock ledger needs an item" "422" "$(code "$R")"
check "ledger error on item_id" 1 "$([[ -n $(body "$R" | json "errors|item_id") ]] && echo 1 || echo 0)"
R=$(req GET "reports/consumption&view=bogus&date_from=$MONTH&date_to=$TODAY"); check "unknown view refused" 422 "$(code "$R")"
R=$(req GET "reports/inward"); check "dates default to this month" "$MONTH|$TODAY" "$(body "$R" | json "data|filters|date_from")|$(body "$R" | json "data|filters|date_to")"

echo "== inward / transfer / consumption"
B=$(rep "inward&party_id=$A"); check "inward: 1 line for party, 300 m, 3 rolls" "1|300|3" "$(rows "$B")|$(tot "$B" qty)|$(tot "$B" rolls)"
check "inward row: ownership + vehicle" "job_work|LES-$RUN" "$(txt "$B" 0 ownership)|$(txt "$B" 0 vehicle_no)"
B=$(rep "inward&party_id=$A&type=own"); check "inward own-only excludes job work" 0 "$(rows "$B")"
B=$(rep "inward&item_id=$PAPER&warehouse_id=$FLOOR"); check "inward by item + warehouse" "1|1000" "$(rows "$B")|$(tot "$B" qty)"
B=$(rep "transfer&item_id=$GF"); check "transfer GREY → FLOOR 300 m" "1|300" "$(rows "$B")|$(tot "$B" qty)"
B=$(rep "transfer&item_id=$GF&warehouse_id=$FIN"); check "transfer warehouse filter (either side)" 0 "$(rows "$B")"
B=$(rep "consumption&item_id=$PAPER"); check "consumption detail: 100 m × 25 = 2500" "1|100|2500" "$(rows "$B")|$(col "$B" 0 qty)|$(tot "$B" amount)"
check "consumption purpose / machine" "sampling|Rpt Machine $RUN" "$(txt "$B" 0 purpose)|$(txt "$B" 0 machine)"
B=$(rep "consumption&view=item&item_id=$PAPER"); check "by item" "100|2500|1" "$(col "$B" 0 qty)|$(col "$B" 0 amount)|$(col "$B" 0 vouchers)"
B=$(rep "consumption&view=machine&machine_id=$MACH"); check "by machine" "2500" "$(tot "$B" amount)"
B=$(rep "consumption&view=job&design_id=$D"); check "by job (design / party)" "Rpt Owner $RUN|2500" "$(txt "$B" 0 party)|$(col "$B" 0 amount)"

echo "== production"
B=$(rep "production&machine_id=$MACH"); check "production: 1 voucher, 280 produced, 14 waste" "1|280|14" "$(rows "$B")|$(tot "$B" produced_qty)|$(tot "$B" wastage_qty)"
check "type manual" manual "$(txt "$B" 0 production_type)"
PR=$(col "$B" 0 printed_qty)
check "wastage % = waste / printed" "$(num "$(php -r "echo round(14/$PR*100,2);")")" "$(col "$B" 0 wastage_pct)"
B=$(rep "production&machine_id=$MACH&type=bom"); check "BOM-only filter" 0 "$(rows "$B")"
B=$(rep "production&view=machine&machine_id=$MACH"); check "by machine: 280 m" "1|280" "$(rows "$B")|$(col "$B" 0 produced_qty)"
B=$(rep "production&view=materials&machine_id=$MACH"); check "materials view (manual, no lines)" 0 "$(rows "$B")"

echo "== delivery + job work"
B=$(rep "delivery&party_id=$A"); check "delivery lines: 200 m, 5 rolls, lot" "1|200|5|$LOT" "$(rows "$B")|$(tot "$B" qty)|$(tot "$B" rolls)|$(txt "$B" 0 lot_no)"
B=$(rep "delivery&view=party&party_id=$A")
check "party-wise: received 300 / delivered 200 / ready 80" "300|200|80" "$(col "$B" 0 received_total)|$(col "$B" 0 delivered_total)|$(col "$B" 0 ready_qty)"
check "pending = received − delivered (as on the chalan screen)" 100 "$(col "$B" 0 pending_qty)"
B=$(rep "jobwork&party_id=$A")
check "job work: opening 0, received 300, delivered 200" "0|300|200" "$(col "$B" 0 opening_qty)|$(col "$B" 0 received_qty)|$(col "$B" 0 delivered_qty)"
check "job work: loss 14 (waste), balance 86 = 6 grey + 80 printed (diff 0)" "14|86|86|0" "$(col "$B" 0 loss_qty)|$(col "$B" 0 closing_qty)|$(num "$(php -r "echo $(col "$B" 0 grey_stock)+$(col "$B" 0 finished_stock);")")|$(col "$B" 0 difference_qty)"
B=$(body "$(req GET "reports/jobwork&party_id=$A&date_from=2099-01-01&date_to=2099-01-31")")
check "later period: all of it is opening balance" "86|0|86" "$(col "$B" 0 opening_qty)|$(col "$B" 0 received_qty)|$(col "$B" 0 closing_qty)"

echo "== ink"
B=$(rep "ink&view=colour&machine_id=$MACH"); check "ink by colour: 750 ml loaded, Rs 3000" "750|3000" "$(tot "$B" loaded_ml)|$(tot "$B" loaded_cost)"
B=$(rep "ink&view=machine&machine_id=$MACH"); check "ink by machine: 750 ml over 294 m printed" "750|$PR" "$(col "$B" 0 loaded_ml)|$(col "$B" 0 printed_qty)"
check "loaded ml per meter" "$(num "$(php -r "echo round(750/$PR,3);")")" "$(col "$B" 0 ml_per_meter)"
B=$(rep "ink&view=ledger&item_id=$INK"); check "ink ledger: in 2 l, out 0.75 l, balance 1.25" "2|0.75|1.25" "$(tot "$B" qty_in)|$(tot "$B" qty_out)|$(col "$B" "$(( $(rows "$B") - 1 ))" balance)"
B=$(rep "ink&view=reorder&item_id=$INK"); check "ink below reorder: 1.25 of 10, short 8.75" "1|1.25|8.75" "$(rows "$B")|$(col "$B" 0 stock_qty)|$(col "$B" 0 shortfall_qty)"
B=$(rep "ink&view=cost&machine_id=$MACH"); check "ink cost per meter view answers" 200 "$(code "$(req GET "reports/ink&view=cost&machine_id=$MACH")")"

echo "== stock"
B=$(rep "stock&item_id=$FF"); check "current stock: printed lot 80 m in FIN, owner A" "1|80|$LOT|Rpt Owner $RUN" "$(rows "$B")|$(col "$B" 0 qty)|$(txt "$B" 0 lot_no)|$(txt "$B" 0 owner)"
B=$(rep "stock&item_id=$PAPER"); check "paper 1000 − 100 = 900, value 22500" "900|22500" "$(col "$B" 0 qty)|$(tot "$B" value)"
B=$(rep "stock&view=ledger&item_id=$FF"); check "ledger: opening, MPV in 280, DCV out 200, balance 80" "OPENING|MPV|DCV|280|200|80" "$(txt "$B" 0 voucher_type)|$(txt "$B" 1 voucher_type)|$(txt "$B" 2 voucher_type)|$(tot "$B" qty_in)|$(tot "$B" qty_out)|$(col "$B" 2 balance)"
B=$(rep "stock&view=ledger&item_id=$GF&warehouse_id=$GREY"); check "ledger by warehouse: in 300, out 300, nil" "300|300|0" "$(tot "$B" qty_in)|$(tot "$B" qty_out)|$(col "$B" "$(( $(rows "$B") - 1 ))" balance)"
B=$(rep "stock&view=reorder&item_type=paper&item_id=$PAPER"); check "paper below reorder (900 < 5000)" "1|4100" "$(rows "$B")|$(col "$B" 0 shortfall_qty)"
B=$(rep "stock&lot_no=$LOT&item_type=finished_fabric"); check "stock by lot number + type" "1|80" "$(rows "$B")|$(col "$B" 0 qty)"
B=$(body "$(req GET "reports/stock&item_id=$FF&date_from=$MONTH&date_to=2000-01-01")"); check "stock as at a date (bad order refused)" "" "$(json "data|rows" <<<"$B")"

echo "== dashboard"
R=$(req GET dashboard); B=$(body "$R")
check "dashboard 200" 200 "$(code "$R")"
check "today's inward includes 300 m fabric" 1 "$(php -r 'echo json_decode($argv[1],true)["data"]["today"]["inward_qty"] >= 300 ? 1 : 0;' "$B")"
check "machine row with 280 m today" 280 "$(php -r 'foreach(json_decode($argv[1],true)["data"]["production_by_machine"] as $r) if($r["machine"]===$argv[2]) echo $r["today_qty"];' "$B" "Rpt Machine $RUN")"
check "ink + paper low stock listed" 2 "$(php -r '$n=0; foreach(json_decode($argv[1],true)["data"]["low_stock"] as $r) if(str_ends_with($r["item"],$argv[2])) $n++; echo $n;' "$B" "$RUN")"
check "pending delivery for owner (80 ready)" 80 "$(php -r 'foreach(json_decode($argv[1],true)["data"]["pending_deliveries"] as $r) if($r["party"]===$argv[2]) echo $r["ready_qty"];' "$B" "Rpt Owner $RUN")"
check "top customers include owner (200 m)" 200 "$(php -r 'foreach(json_decode($argv[1],true)["data"]["top_customers"] as $r) if($r["party"]===$argv[2]) echo $r["delivered_qty"];' "$B" "Rpt Owner $RUN")"

echo "== cancel flows into reports"
R=$(req POST "chalans/$DCV/cancel" '{"reason":"wrong party"}'); check "cancel chalan" 200 "$(code "$R")"
B=$(rep "delivery&party_id=$A"); check "cancelled chalan leaves the report" 0 "$(rows "$B")"
B=$(rep "jobwork&party_id=$A"); check "job work balance back to 286" "0|286" "$(col "$B" 0 delivered_qty)|$(col "$B" 0 closing_qty)"

echo "== permissions (seeded Gate role: inward + delivery reports, dashboard)"
R=$(req GET roles); ROLE=$(body "$R" | php -r 'foreach(json_decode(stream_get_contents(STDIN),true)["data"] as $r) if($r["code"]==="gate") echo $r["id"];')
R=$(req POST users "{\"username\":\"gate$RUN\",\"full_name\":\"Gate $RUN\",\"role_id\":$ROLE,\"lang\":\"en\",\"password\":\"Gate12345\",\"is_active\":true,\"must_change_password\":false}")
check "gate user created" 201 "$(code "$R")"
J2=$(mktemp)
C2=$(curl -s -c "$J2" -b "$J2" "${API}auth/bootstrap" | json "data|csrf")
curl -s -c "$J2" -b "$J2" -H 'Content-Type: application/json' -H "X-CSRF-Token: $C2" --data "{\"username\":\"gate$RUN\",\"password\":\"Gate12345\"}" "${API}auth/login" >/dev/null
check "gate: inward report allowed" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "${API}reports/inward")"
check "gate: stock report forbidden" 403 "$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "${API}reports/stock")"
check "gate: production report forbidden" 403 "$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "${API}reports/production")"
check "gate: dashboard allowed" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b "$J2" "${API}dashboard")"
check "no-cache headers on reports" 1 "$(curl -s -D - -o /dev/null -b "$J2" "${API}reports/inward" | grep -ci 'cache-control: no-store' | tr -d ' ')"
rm -f "$J2"

rm -f "$JAR"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
