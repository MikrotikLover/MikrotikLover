#!/usr/bin/env bash
# API test for Batch 4: Production Estimation, BOM Production, Manual Production.
#   BASE=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASS=Admin12345 tests/api_production.sh
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
num() { php -r 'echo rtrim(rtrim(number_format((float)$argv[1], 4, ".", ""), "0"), ".");' "$1"; }
bal() { req GET "stock/balance&warehouse_id=$1&item_id=$2" | sed 's/^[0-9]*|//' | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]; $q=0; foreach($d as $r) if($r["lot_no"]===$argv[1]) $q=$r["qty"]; echo round($q,3);' "$3"; }
line() { # body itemId field → value of that line
  php -r '$d=json_decode($argv[1],true)["data"]["lines"]; foreach($d as $l) if((string)$l["item_id"]===$argv[2]) { echo $l[$argv[3]]; break; }' "$1" "$2" "$3"; }

R=$(req GET auth/bootstrap); CSRF=$(body "$R" | json "data|csrf")
R=$(req POST auth/login "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"${ADMIN_PASS:-Admin12345}\"}"); CSRF=$(body "$R" | json "data|csrf")
check "login" 200 "$(code "$R")"

echo "== fixtures"
L=$(body "$(req GET 'lookups&sets=units,warehouses,ink_colours')")
pick() { php -r '$d=json_decode($argv[1],true)["data"][$argv[2]]; foreach($d as $o) if($o[$argv[3]]===$argv[4]) { echo $o["value"]; break; }' "$L" "$@"; }
U_M=$(pick units code m); U_L=$(pick units code l); U_KG=$(pick units code kg)
GREY=$(pick warehouses code GREY); FLOOR=$(pick warehouses code FLOOR); FIN=$(pick warehouses code FIN)
C=$(pick ink_colours code C); M=$(pick ink_colours code M)
id() { body "$1" | json "data|id"; }
P=$(id "$(req POST parties "{\"name\":\"Faisal Prints $RUN\",\"is_customer\":true,\"is_fabric_owner\":true,\"is_active\":true}")")
SUP=$(id "$(req POST parties "{\"name\":\"Chem Supplier $RUN\",\"is_supplier\":true,\"is_active\":true}")")
GF=$(id "$(req POST items "{\"name\":\"Poly Micro $RUN\",\"item_type\":\"grey_fabric\",\"unit_id\":$U_M,\"gsm\":\"120\",\"width_inch\":\"58\",\"track_lots\":true,\"is_active\":true}")")
FF=$(id "$(req POST items "{\"name\":\"Printed Micro $RUN\",\"item_type\":\"finished_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")")
INKC=$(id "$(req POST items "{\"name\":\"Cyan P$RUN\",\"item_type\":\"ink\",\"unit_id\":$U_L,\"ink_colour_id\":$C,\"process_type\":\"sublimation\",\"rate_per_liter\":\"4000\",\"is_active\":true}")")
INKM=$(id "$(req POST items "{\"name\":\"Magenta P$RUN\",\"item_type\":\"ink\",\"unit_id\":$U_L,\"ink_colour_id\":$M,\"process_type\":\"sublimation\",\"rate_per_liter\":\"5000\",\"is_active\":true}")")
PAPER=$(id "$(req POST items "{\"name\":\"Paper P$RUN\",\"item_type\":\"paper\",\"unit_id\":$U_M,\"rate\":\"25\",\"is_active\":true}")")
CHEM=$(id "$(req POST items "{\"name\":\"Fixer P$RUN\",\"item_type\":\"chemical\",\"unit_id\":$U_KG,\"rate\":\"900\",\"is_active\":true}")")
MACH=$(id "$(req POST machines "{\"name\":\"Mimaki $RUN\",\"machine_type\":\"sublimation\",\"speed_m_per_hr\":\"50\",\"hourly_cost\":\"1500\",\"warehouse_id\":$FLOOR,\"is_active\":true}")")
D=$(id "$(req POST designs "{\"name\":\"Ajrak $RUN\",\"party_id\":$P,\"process_type\":\"sublimation\",\"basis_gsm\":\"120\",\"basis_width_inch\":\"58\",\"finished_item_id\":$FF,\"default_machine_id\":$MACH,\"is_active\":true,\"inks\":[{\"ink_colour_id\":$C,\"coverage_pct\":\"40\",\"item_id\":$INKC},{\"ink_colour_id\":$M,\"coverage_pct\":\"20\",\"item_id\":$INKM}],\"bom\":[{\"item_id\":$PAPER,\"qty_per_meter\":\"1.05\",\"wastage_pct\":\"2\"},{\"item_id\":$CHEM,\"qty_per_meter\":\"0.005\"}]}")")
check "fixtures" 1 "$([[ -n "$P$GF$FF$INKC$INKM$PAPER$CHEM$MACH$D" && -n "$FIN" ]] && echo 1 || echo 0)"

echo "== estimation"
E="\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"order_ref\":\"PO-77\",\"design_id\":$D,\"machine_id\":$MACH,\"fabric_item_id\":$GF,\"meters\":\"1000\",\"wastage_pct\":\"3\""
R=$(req POST estimations/calc "{$E}")
check "calc preview 200" 200 "$(code "$R")"
# gross 1030 m; cyan ml/m = 12 × 0.40 × 1.4732 × 1.2 = 8.4856 → 8740.168 ml
check "cyan ml for 1030 m" 8740.168 "$(num "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]["lines"]; foreach($d as $l) if($l["line_type"]==="ink" && $l["colour_code"]==="C") echo $l["qty"];')")"
check "gross meters incl. wastage" 1030 "$(num "$(body "$R" | json "data|header|gross_meters")")"
check "machine hours 1030/50" 20.6 "$(num "$(body "$R" | json "data|totals|machine_hours")")"
check "machine cost 20.6 × 1500" 30900 "$(num "$(body "$R" | json "data|totals|machine_cost")")"
check "paper cost 1.05×1.02×1030×25" 27578.25 "$(num "$(body "$R" | json "data|totals|paper_cost")")"
check "chemical cost 0.005×1030×900" 4635 "$(num "$(body "$R" | json "data|totals|chemical_cost")")"
T=$(body "$R" | php -r '$t=json_decode(stream_get_contents(STDIN),true)["data"]["totals"]; echo round($t["ink_cost"]+$t["paper_cost"]+$t["chemical_cost"]+$t["other_cost"]+$t["machine_cost"],2);')
check "total = sum of parts" "$(num "$T")" "$(num "$(body "$R" | json "data|totals|total_cost")")"
check "cost per meter = total / 1000" "$(num "$(php -r "echo round($T/1000,4);")")" "$(num "$(body "$R" | json "data|totals|cost_per_meter")")"
R=$(req POST estimations "{$E,\"lines\":[]}")
check "save estimation (no lines needed)" 201 "$(code "$R")"; EST=$(id "$R")
check "PEV number" 1 "$([[ $(body "$R" | json "data|voucher_no") =~ ^PEV-[0-9]{4}-[0-9]{5}$ ]] && echo 1 || echo 0)"
check "estimation lines stored (2 ink + 2 bom + fabric)" 5 "$(body "$R" | php -r 'echo count(json_decode(stream_get_contents(STDIN),true)["data"]["lines"]);')"
check "resolved GSM saved" 120 "$(num "$(body "$R" | json "data|fabric_gsm")")"
R=$(req POST estimations "{\"voucher_date\":\"$TODAY\",\"design_id\":$D,\"meters\":\"100\",\"fabric_item_id\":$PAPER}")
check "fabric must be a fabric item" 1 "$([[ -n $(body "$R" | json "errors|fabric_item_id") ]] && echo 1 || echo 0)"
R=$(req GET "stock/balance&warehouse_id=$FLOOR&item_id=$PAPER"); check "estimation has no stock effect" "[]" "$(body "$R" | json "data")"

echo "== stock in"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$FLOOR,\"ownership\":\"job_work\",\"lines\":[{\"item_id\":$GF,\"lot_no\":\"FP-$RUN\",\"qty\":\"500\"}]}")
check "job-work fabric 500 m to floor" 201 "$(code "$R")"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$SUP,\"warehouse_id\":$FLOOR,\"ownership\":\"own\",\"lines\":[{\"item_id\":$PAPER,\"qty\":\"2000\"},{\"item_id\":$CHEM,\"qty\":\"10\"},{\"item_id\":$INKC,\"qty\":\"5\"}]}")
check "paper, chemical, ink purchase" 201 "$(code "$R")"

echo "== BOM production"
R=$(req POST production/requirements "{\"design_id\":$D,\"meters\":\"415\"}")
check "requirements endpoint" 4 "$(body "$R" | php -r 'echo count(json_decode(stream_get_contents(STDIN),true)["data"]["lines"]);')"
check "paper est 1.05×1.02×415" 444.465 "$(num "$(php -r '$d=json_decode($argv[1],true)["data"]["lines"]; foreach($d as $l) if($l["line_type"]==="paper") echo $l["est_qty"];' "$(body "$R")")")"
PH="\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"design_id\":$D,\"machine_id\":$MACH,\"estimation_id\":$EST,\"operator_name\":\"Nadeem\",\"fabric_item_id\":$GF,\"fabric_warehouse_id\":$FLOOR,\"fabric_lot_no\":\"FP-$RUN\",\"finished_item_id\":$FF,\"finished_warehouse_id\":$FIN,\"material_warehouse_id\":$FLOOR"
R=$(req POST productions-bom "{$PH,\"produced_qty\":\"400\",\"produced_rolls\":\"8\",\"wastage_qty\":\"10\",\"rejected_qty\":\"5\",\"lines\":[{\"_row\":0,\"item_id\":$PAPER,\"actual_qty\":\"450\"},{\"_row\":1,\"item_id\":$INKC,\"actual_qty\":\"3.8\"},{\"_row\":2,\"item_id\":$GF,\"actual_qty\":\"1\"}]}")
check "fabric as material line rejected" 1 "$([[ -n $(body "$R" | json "errors|lines.2.item_id") ]] && echo 1 || echo 0)"
R=$(req POST productions-bom "{$PH,\"produced_qty\":\"400\",\"produced_rolls\":\"8\",\"wastage_qty\":\"10\",\"rejected_qty\":\"5\",\"lines\":[{\"_row\":0,\"item_id\":$PAPER,\"actual_qty\":\"450\"},{\"_row\":1,\"item_id\":$INKC,\"actual_qty\":\"3.8\"}]}")
check "save BOM production" 201 "$(code "$R")"; B=$(body "$R"); PRD=$(id "$R")
check "BOM number" 1 "$([[ $(json "data|voucher_no" <<<"$B") =~ ^BOM-[0-9]{4}-[0-9]{5}$ ]] && echo 1 || echo 0)"
check "fabric used = 415 printed m" 415 "$(num "$(json "data|fabric_issued_qty" <<<"$B")")"
check "unlisted BOM lines auto-added (paper, chem, 2 inks)" 4 "$(php -r 'echo count(json_decode($argv[1],true)["data"]["lines"]);' "$B")"
check "chemical consumed at estimate 0.005×415" 2.075 "$(num "$(line "$B" "$CHEM" actual_qty)")"
check "paper actual kept, estimate recorded" "450|444.465" "$(num "$(line "$B" "$PAPER" actual_qty)")|$(num "$(line "$B" "$PAPER" est_qty)")"
check "cyan est 8.4856×415 ml → 3.522 l" 3.522 "$(num "$(line "$B" "$INKC" est_qty)")"
check "ink ml actual − estimated = 278" 278 "$(num "$(php -r '$d=json_decode($argv[1],true)["data"]; echo $d["ink_ml_actual"]-$d["ink_ml_estimated"];' "$B")")"
check "ink variance % reported" 1 "$(php -r '$d=json_decode($argv[1],true)["data"]; echo (int)($d["ink_variance_pct"] > 5 && $d["ink_variance_pct"] < 5.5);' "$B")"
check "machine hours 415/50 = 8.3" 8.3 "$(num "$(json "data|machine_hours" <<<"$B")")"
check "job-work fabric not costed" "$(num "$(php -r '$d=json_decode($argv[1],true)["data"]["lines"]; $s=0; foreach($d as $l) if($l["line_type"]!=="ink") $s+=$l["amount"]; echo $s;' "$B")")" "$(num "$(json "data|material_cost" <<<"$B")")"
check "cost per good meter = total / 400" "$(num "$(php -r '$d=json_decode($argv[1],true)["data"]; echo round($d["total_cost"]/400,4);' "$B")")" "$(num "$(json "data|cost_per_meter" <<<"$B")")"
check "fabric lot 500 − 415 = 85" 85 "$(bal $FLOOR $GF "FP-$RUN")"
check "finished store +400 m in same lot" 400 "$(bal $FIN $FF "FP-$RUN")"
check "paper 2000 − 450" 1550 "$(bal $FLOOR $PAPER "")"
check "chemical 10 − 2.075" 7.925 "$(bal $FLOOR $CHEM "")"
check "ink not deducted again (taken at ink loading)" 5 "$(bal $FLOOR $INKC "")"
R=$(req POST productions-bom "{$PH,\"produced_qty\":\"100\",\"lines\":[]}")
check "insufficient fabric lot → error on lot" 1 "$([[ $(body "$R" | json "errors|fabric_lot_no") == *"Only 85 m"* ]] && echo 1 || echo 0)"

echo "== edit / cancel"
R=$(req PUT "productions-bom/$PRD" "{$PH,\"produced_qty\":\"420\",\"produced_rolls\":\"8\",\"wastage_qty\":\"10\",\"rejected_qty\":\"5\",\"lines\":[{\"item_id\":$PAPER,\"actual_qty\":\"460\"}]}")
check "edit production" 200 "$(code "$R")"
check "fabric lot now 500 − 435 = 65" 65 "$(bal $FLOOR $GF "FP-$RUN")"
check "finished now 420" 420 "$(bal $FIN $FF "FP-$RUN")"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$FIN,\"to_warehouse_id\":$GREY,\"lines\":[{\"item_id\":$FF,\"lot_no\":\"FP-$RUN\",\"qty\":\"300\"}]}")
STV=$(id "$R")
R=$(req POST "productions-bom/$PRD/cancel" '{"reason":"test"}')
check "cancel blocked: finished fabric already moved" 422 "$(code "$R")"
req POST "transfers/$STV/cancel" '{"reason":"undo"}' >/dev/null
R=$(req POST "productions-bom/$PRD/cancel" '{"reason":"machine fault"}')
check "cancel production" 200 "$(code "$R")"
check "fabric restored to 500" 500 "$(bal $FLOOR $GF "FP-$RUN")"
check "finished removed" 0 "$(bal $FIN $FF "FP-$RUN")"
check "paper restored" 2000 "$(bal $FLOOR $PAPER "")"

echo "== manual production"
MH="\"voucher_date\":\"$TODAY\",\"machine_id\":$MACH,\"fabric_item_id\":$GF,\"fabric_warehouse_id\":$FLOOR,\"fabric_lot_no\":\"FP-$RUN\",\"finished_item_id\":$FF,\"finished_warehouse_id\":$FIN,\"finished_lot_no\":\"SMP-$RUN\",\"material_warehouse_id\":$FLOOR"
R=$(req POST productions-manual "{$MH,\"produced_qty\":\"5\",\"lines\":[{\"item_id\":$PAPER,\"actual_qty\":\"6\"}]}")
check "manual reason required" 1 "$([[ -n $(body "$R" | json "errors|manual_reason") ]] && echo 1 || echo 0)"
R=$(req POST productions-manual "{$MH,\"manual_reason\":\"sampling\",\"produced_qty\":\"5\",\"rejected_qty\":\"1\",\"start_time\":\"$TODAY 10:00\",\"end_time\":\"$TODAY 10:30\",\"lines\":[{\"item_id\":$PAPER,\"actual_qty\":\"6.5\"},{\"item_id\":$INKC,\"actual_qty\":\"0.05\"}]}")
check "save manual production (no design)" 201 "$(code "$R")"; B=$(body "$R")
check "MPV number" 1 "$([[ $(json "data|voucher_no" <<<"$B") =~ ^MPV-[0-9]{4}-[0-9]{5}$ ]] && echo 1 || echo 0)"
check "only entered lines (no BOM)" 2 "$(php -r 'echo count(json_decode($argv[1],true)["data"]["lines"]);' "$B")"
check "hours from start/end = 0.5" 0.5 "$(num "$(json "data|machine_hours" <<<"$B")")"
check "sample lot in finished store" 5 "$(bal $FIN $FF "SMP-$RUN")"
check "fabric 500 − 6" 494 "$(bal $FLOOR $GF "FP-$RUN")"
R=$(req GET "productions-manual&q=SMP-$RUN"); check "manual list separate from BOM list" 1 "$(body "$R" | json "data|total")"
R=$(req GET "productions-bom&design_id=$D"); check "BOM list by design" 1 "$(body "$R" | json "data|total")"
R=$(req GET "productions-bom/$(body "$(req GET "productions-manual&q=SMP-$RUN")" | json "data|items|0|id")"); check "manual id not reachable via BOM route" 404 "$(code "$R")"

rm -f "$JAR"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
