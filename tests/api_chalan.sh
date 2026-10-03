#!/usr/bin/env bash
# API test for Batch 5: Outward Gate Pass / Delivery Chalan.
#   BASE=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASS=Admin12345 tests/api_chalan.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/index.php?r="
JAR=$(mktemp); PASS=0; FAIL=0; CSRF=""
RUN=$(date +%s | tail -c 6)
TODAY=$(TZ=Asia/Karachi date +%F)

json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode("|",$argv[1]) as $k){ $v=is_array($v)&&array_key_exists($k,$v)?$v[$k]:null; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v,JSON_UNESCAPED_UNICODE):(string)$v);' "$1"; }
req() { local out; out=$(curl -s -o - -w '\n%{http_code}' -X "$1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" ${3:+--data "$3"} "$API$2"); echo "$(tail -n1 <<<"$out")|$(sed '$d' <<<"$out")"; }
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi; }
code() { echo "${1%%|*}"; }
body() { echo "${1#*|}"; }
id() { body "$1" | json "data|id"; }
num() { php -r 'echo rtrim(rtrim(number_format((float)$argv[1], 3, ".", ""), "0"), ".");' "$1"; }
bal() { req GET "stock/balance&warehouse_id=$1&item_id=$2" | sed 's/^[0-9]*|//' | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]; $q=0; foreach($d as $r) if($r["lot_no"]===$argv[1]) $q=$r["qty"]; echo round($q,3);' "$3"; }

R=$(req GET auth/bootstrap); CSRF=$(body "$R" | json "data|csrf")
R=$(req POST auth/login "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"${ADMIN_PASS:-Admin12345}\"}"); CSRF=$(body "$R" | json "data|csrf")
check "login" 200 "$(code "$R")"

echo "== fixtures"
L=$(body "$(req GET 'lookups&sets=units,warehouses')")
pick() { php -r '$d=json_decode($argv[1],true)["data"][$argv[2]]; foreach($d as $o) if($o[$argv[3]]===$argv[4]) { echo $o["value"]; break; }' "$L" "$@"; }
U_M=$(pick units code m); FLOOR=$(pick warehouses code FLOOR); FIN=$(pick warehouses code FIN)
A=$(id "$(req POST parties "{\"name\":\"Owner A $RUN\",\"is_customer\":true,\"is_fabric_owner\":true,\"address\":\"Plot 12, Sundar Estate, Lahore\",\"is_active\":true}")")
B=$(id "$(req POST parties "{\"name\":\"Buyer B $RUN\",\"is_customer\":true,\"is_active\":true}")")
S=$(id "$(req POST parties "{\"name\":\"Mill S $RUN\",\"is_supplier\":true,\"is_active\":true}")")
GF=$(id "$(req POST items "{\"name\":\"Grey C$RUN\",\"item_type\":\"grey_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")")
FF=$(id "$(req POST items "{\"name\":\"Printed C$RUN\",\"item_type\":\"finished_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")")
PAPER=$(id "$(req POST items "{\"name\":\"Paper C$RUN\",\"item_type\":\"paper\",\"unit_id\":$U_M,\"is_active\":true}")")
MACH=$(id "$(req POST machines "{\"name\":\"M C$RUN\",\"machine_type\":\"sublimation\",\"speed_m_per_hr\":\"50\",\"is_active\":true}")")
D=$(id "$(req POST designs "{\"name\":\"Bandhani $RUN\",\"party_id\":$A,\"process_type\":\"sublimation\",\"is_active\":true}")")
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$A,\"warehouse_id\":$FLOOR,\"ownership\":\"job_work\",\"lines\":[{\"item_id\":$GF,\"lot_no\":\"JA-$RUN\",\"qty\":\"200\"}]}")
check "job-work grey in (A, 200 m)" 201 "$(code "$R")"
R=$(req POST productions-manual "{\"voucher_date\":\"$TODAY\",\"manual_reason\":\"job\",\"party_id\":$A,\"design_id\":$D,\"machine_id\":$MACH,\"fabric_item_id\":$GF,\"fabric_warehouse_id\":$FLOOR,\"fabric_lot_no\":\"JA-$RUN\",\"finished_item_id\":$FF,\"finished_warehouse_id\":$FIN,\"produced_qty\":\"150\",\"produced_rolls\":\"6\",\"wastage_qty\":\"5\",\"material_warehouse_id\":$FLOOR,\"lines\":[]}")
check "printed 150 m for A" 201 "$(code "$R")"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$S,\"warehouse_id\":$FIN,\"ownership\":\"own\",\"lines\":[{\"item_id\":$FF,\"lot_no\":\"OWN-$RUN\",\"qty\":\"100\",\"rolls\":\"4\"}]}")
check "own finished stock 100 m" 201 "$(code "$R")"

echo "== party summary + lots"
R=$(req GET "chalans/party-summary&party_id=$A")
check "received / produced / delivered" "200|150|0" "$(num "$(body "$R" | json "data|received")")|$(num "$(body "$R" | json "data|produced")")|$(num "$(body "$R" | json "data|delivered")")"
check "A's fabric in stock: 150 finished + 45 grey" 195 "$(body "$R" | php -r '$s=0; foreach(json_decode(stream_get_contents(STDIN),true)["data"]["stock"] as $r) $s+=$r["qty"]; echo $s;')"
R=$(req GET "chalans/party-lots&party_id=$A&warehouse_id=$FIN")
check "A's lots in finished store: JA 150 m, 6 rolls, design" "JA-$RUN|150|6|$D" "$(body "$R" | php -r '$r=json_decode(stream_get_contents(STDIN),true)["data"][0]; echo $r["lot_no"]."|".$r["qty"]."|".$r["rolls"]."|".$r["design_id"];')"
R=$(req GET "chalans/party-lots&party_id=$B&warehouse_id=$FIN"); check "B owns no lots" "[]" "$(body "$R" | json "data")"

echo "== delivery chalan rules"
H="\"voucher_date\":\"$TODAY\",\"warehouse_id\":$FIN,\"vehicle_no\":\"LEB-889\",\"driver_name\":\"Rashid\",\"receiver_name\":\"Store in-charge\""
R=$(req POST chalans "{$H,\"party_id\":$B,\"lines\":[{\"_row\":0,\"item_id\":$FF,\"lot_no\":\"JA-$RUN\",\"qty\":\"10\"}]}")
check "job-work lot cannot go to another party" 1 "$([[ $(body "$R" | json "errors|lines.0.lot_no") == *"Owner A $RUN"* ]] && echo 1 || echo 0)"
R=$(req POST chalans "{$H,\"party_id\":$A,\"lines\":[{\"_row\":0,\"item_id\":$PAPER,\"qty\":\"10\"}]}")
check "non-fabric refused" 1 "$([[ -n $(body "$R" | json "errors|lines.0.item_id") ]] && echo 1 || echo 0)"
R=$(req POST chalans "{$H,\"party_id\":$A,\"lines\":[{\"_row\":0,\"item_id\":$FF,\"lot_no\":\"JA-$RUN\",\"qty\":\"160\"}]}")
check "more than in stock refused on qty" 1 "$([[ $(body "$R" | json "errors|lines.0.qty") == *"Only 150 m"* ]] && echo 1 || echo 0)"
R=$(req POST chalans "{$H,\"party_id\":$A,\"party_ref\":\"PO-991\",\"delivery_address\":\"Plot 12, Sundar Estate, Lahore\",\"lines\":[{\"_row\":0,\"item_id\":$FF,\"lot_no\":\"JA-$RUN\",\"rolls\":\"4\",\"qty\":\"100\"}]}")
check "deliver 100 m to owner" 201 "$(code "$R")"; DCV=$(id "$R"); B1=$(body "$R")
check "DCV number" 1 "$([[ $(json "data|voucher_no" <<<"$B1") =~ ^DCV-[0-9]{4}-[0-9]{5}$ ]] && echo 1 || echo 0)"
check "design filled from production" "$D" "$(json "data|lines|0|design_id" <<<"$B1")"
check "party address / ref on chalan" "PO-991" "$(json "data|party_ref" <<<"$B1")"
check "finished lot 150 − 100" 50 "$(bal $FIN $FF "JA-$RUN")"
R=$(req POST chalans "{$H,\"party_id\":$B,\"lines\":[{\"item_id\":$FF,\"lot_no\":\"OWN-$RUN\",\"rolls\":\"1\",\"qty\":\"30\"}]}")
check "own stock may go to any party" 201 "$(code "$R")"
R=$(req GET "chalans/party-summary&party_id=$A")
check "A: delivered 100, pending 100" "100|100" "$(num "$(body "$R" | json "data|delivered")")|$(num "$(body "$R" | json "data|pending")")"

echo "== edit / cancel / list"
R=$(req PUT "chalans/$DCV" "{$H,\"party_id\":$A,\"lines\":[{\"item_id\":$FF,\"lot_no\":\"JA-$RUN\",\"rolls\":\"5\",\"qty\":\"120\"}]}")
check "edit chalan to 120 m" 200 "$(code "$R")"; check "finished lot now 30" 30 "$(bal $FIN $FF "JA-$RUN")"
R=$(req GET "chalans&party_id=$A&q=LEB-889"); check "chalan list by party + vehicle" 1 "$(body "$R" | json "data|total")"
R=$(req POST "chalans/$DCV/cancel" '{"reason":"returned at gate"}')
check "cancel chalan" 200 "$(code "$R")"; check "stock restored to 150" 150 "$(bal $FIN $FF "JA-$RUN")"

echo "== print settings"
R=$(req GET settings); SET=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]; $d["chalan_copies"]="3"; $d["chalan_terms"]="Check rolls before signing."; echo json_encode($d);')
R=$(req PUT settings "$SET"); check "save chalan copies / terms" 200 "$(code "$R")"
R=$(req GET auth/bootstrap); check "copies exposed to the app" 3 "$(body "$R" | json "data|app|chalan_copies")"
SET=$(php -r '$d=json_decode($argv[1],true); $d["chalan_copies"]="5"; echo json_encode($d);' "$SET")
R=$(req PUT settings "$SET"); check "copies limited to 1–3" 422 "$(code "$R")"
SET=$(php -r '$d=json_decode($argv[1],true); $d["chalan_copies"]="2"; echo json_encode($d);' "$SET"); req PUT settings "$SET" >/dev/null

rm -f "$JAR"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
