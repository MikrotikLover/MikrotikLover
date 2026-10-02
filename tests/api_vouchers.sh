#!/usr/bin/env bash
# API test for Batch 3 vouchers: Inward Gate Pass, Stock Transfer, Stock Consumption, Ink Loading.
#   BASE=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASS=Admin12345 tests/api_vouchers.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/index.php?r="
JAR=$(mktemp); PASS=0; FAIL=0; CSRF=""
RUN=$(date +%s | tail -c 6)
TODAY=$(TZ=Asia/Karachi date +%F)
TOMORROW=$(TZ=Asia/Karachi date -d tomorrow +%F)

json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode("|",$argv[1]) as $k){ $v=is_array($v)&&array_key_exists($k,$v)?$v[$k]:null; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v,JSON_UNESCAPED_UNICODE):(string)$v);' "$1"; }
req() { local out; out=$(curl -s -o - -w '\n%{http_code}' -X "$1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" ${3:+--data "$3"} "$API$2"); echo "$(tail -n1 <<<"$out")|$(sed '$d' <<<"$out")"; }
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi; }
code() { echo "${1%%|*}"; }
body() { echo "${1#*|}"; }
bal() { # warehouse item lot → qty
  req GET "stock/balance&warehouse_id=$1&item_id=$2" | sed 's/^[0-9]*|//' | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]; $q=0; foreach($d as $r) if($r["lot_no"]===$argv[1]) $q=$r["qty"]; echo $q;' "$3"
}

R=$(req GET auth/bootstrap); CSRF=$(body "$R" | json "data|csrf")
R=$(req POST auth/login "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"${ADMIN_PASS:-Admin12345}\"}"); CSRF=$(body "$R" | json "data|csrf")
check "login" 200 "$(code "$R")"

echo "== fixtures"
L=$(body "$(req GET 'lookups&sets=units,warehouses,ink_colours')")
pick() { php -r '$d=json_decode($argv[1],true)["data"][$argv[2]]; foreach($d as $o) if($o[$argv[3]]===$argv[4]) { echo $o["value"]; break; }' "$L" "$@"; }
U_M=$(pick units code m); U_L=$(pick units code l); U_ML=$(pick units code ml)
GREY=$(pick warehouses code GREY); FLOOR=$(pick warehouses code FLOOR)
C=$(pick ink_colours code C)
P=$(body "$(req POST parties "{\"name\":\"Job Client $RUN\",\"is_customer\":true,\"is_fabric_owner\":true,\"is_active\":true}")" | json "data|id")
S=$(body "$(req POST parties "{\"name\":\"Ink Supplier $RUN\",\"is_supplier\":true,\"is_active\":true}")" | json "data|id")
FAB=$(body "$(req POST items "{\"name\":\"Lawn 60x60 $RUN\",\"item_type\":\"grey_fabric\",\"unit_id\":$U_M,\"track_lots\":true,\"is_active\":true}")" | json "data|id")
INK=$(body "$(req POST items "{\"name\":\"Cyan $RUN\",\"item_type\":\"ink\",\"unit_id\":$U_L,\"ink_colour_id\":$C,\"process_type\":\"sublimation\",\"rate_per_liter\":\"4000\",\"is_active\":true}")" | json "data|id")
INKML=$(body "$(req POST items "{\"name\":\"Cyan ml $RUN\",\"item_type\":\"ink\",\"unit_id\":$U_ML,\"ink_colour_id\":$C,\"process_type\":\"sublimation\",\"rate_per_liter\":\"3000\",\"is_active\":true}")" | json "data|id")
PAPER=$(body "$(req POST items "{\"name\":\"Paper $RUN\",\"item_type\":\"paper\",\"unit_id\":$U_M,\"rate\":\"25\",\"is_active\":true}")" | json "data|id")
MACH=$(body "$(req POST machines "{\"name\":\"Printer $RUN\",\"machine_type\":\"sublimation\",\"speed_m_per_hr\":\"50\",\"warehouse_id\":$FLOOR,\"is_active\":true}")" | json "data|id")
check "fixtures created" 1 "$([[ -n "$P$FAB$INK$PAPER$MACH" && -n "$GREY" && -n "$FLOOR" ]] && echo 1 || echo 0)"

echo "== inward gate pass"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"lines\":[]}")
check "no lines 422" 422 "$(code "$R")"
R=$(req POST igp "{\"voucher_date\":\"$TOMORROW\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"A\",\"qty\":\"1\"}]}")
check "future date 422" 1 "$([[ -n $(body "$R" | json "errors|voucher_date") ]] && echo 1 || echo 0)"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"lines\":[{\"_row\":3,\"item_id\":$FAB,\"qty\":\"10\"}]}")
check "lot required, keyed by grid row" 1 "$([[ -n $(body "$R" | json "errors|lines.3.lot_no") ]] && echo 1 || echo 0)"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"vehicle_no\":\"LES-1234\",\"driver_name\":\"Aslam\",\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"rolls\":\"5\",\"qty\":\"100\"},{\"_row\":1,\"item_id\":$FAB,\"lot_no\":\"L$RUN-2\",\"rolls\":\"2\",\"qty\":\"50.5\"},{\"_row\":2,\"item_id\":\"\"}]}")
check "create IGP 201" 201 "$(code "$R")"
IGP=$(body "$R" | json "data|id"); IGP_NO=$(body "$R" | json "data|voucher_no")
check "voucher number IGP-yyyy-nnnnn" 1 "$([[ "$IGP_NO" =~ ^IGP-[0-9]{4}-[0-9]{5}$ ]] && echo 1 || echo 0)"
check "totals" "150.500|7" "$(body "$R" | json "data|total_qty")|$(body "$R" | json "data|total_rolls")"
check "empty grid row ignored" 2 "$(body "$R" | php -r 'echo count(json_decode(stream_get_contents(STDIN),true)["data"]["lines"]);')"
check "grey stock lot 1 = 100" 100 "$(bal $GREY $FAB "L$RUN-1")"
R=$(req POST igp "{\"voucher_date\":\"$TODAY\",\"party_id\":$S,\"warehouse_id\":$FLOOR,\"ownership\":\"own\",\"lines\":[{\"item_id\":$INK,\"qty\":\"5\"},{\"item_id\":$INKML,\"qty\":\"2000\"},{\"item_id\":$PAPER,\"qty\":\"300\",\"lot_no\":\"ignored-not-tracked\"}]}")
check "purchase inward (ink, paper) to floor" 201 "$(code "$R")"
IGP2_NO=$(body "$R" | json "data|voucher_no")
check "numbers are sequential" "$((10#${IGP_NO##*-} + 1))" "$((10#${IGP2_NO##*-}))"
check "untracked item: ledger lot blank" 300 "$(bal $FLOOR $PAPER "")"

echo "== stock transfer"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$GREY,\"lines\":[{\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"1\"}]}")
check "same warehouse 422" 1 "$([[ -n $(body "$R" | json "errors|to_warehouse_id") ]] && echo 1 || echo 0)"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"120\"}]}")
MSG=$(body "$R" | json "errors|lines.0.qty")
check "insufficient stock 422 on the line" 1 "$([[ "$MSG" == *"Only 100 m"* ]] && echo 1 || echo 0)"
check "nothing posted after failure" 100 "$(bal $GREY $FAB "L$RUN-1")"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"rolls\":\"4\",\"qty\":\"60\"},{\"_row\":1,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"50\"}]}")
check "two lines of same lot exceeding together 422" 1 "$([[ -n $(body "$R" | json "errors|lines.1.qty") ]] && echo 1 || echo 0)"
R=$(req POST transfers "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"rolls\":\"4\",\"qty\":\"80\"}]}")
check "transfer 80 m" 201 "$(code "$R")"; STV=$(body "$R" | json "data|id")
check "lot owner carried on transfer" "$P" "$(body "$R" | json "data|lines|0|owner_party_id")"
check "grey lot 1 = 20" 20 "$(bal $GREY $FAB "L$RUN-1")"
check "floor lot 1 = 80" 80 "$(bal $FLOOR $FAB "L$RUN-1")"

echo "== edit / cancel rules"
R=$(req POST "igp/$IGP/cancel" '{"reason":"wrong party"}')
check "cancel IGP blocked: stock already transferred" 422 "$(code "$R")"
check "explains negative stock" 1 "$([[ $(body "$R" | json "message") == *"negative"* ]] && echo 1 || echo 0)"
R=$(req PUT "igp/$IGP" "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"lines\":[{\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"70\"},{\"item_id\":$FAB,\"lot_no\":\"L$RUN-2\",\"qty\":\"50.5\"}]}")
check "edit IGP below transferred qty blocked" 422 "$(code "$R")"
R=$(req POST "transfers/$STV/cancel" '{"reason":"moved back"}')
check "cancel transfer" 200 "$(code "$R")"; check "status cancelled" cancelled "$(body "$R" | json "data|status")"
check "floor lot 1 back to 0" 0 "$(bal $FLOOR $FAB "L$RUN-1")"
R=$(req PUT "transfers/$STV" "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"1\"}]}")
check "cancelled voucher not editable 409" 409 "$(code "$R")"
R=$(req PUT "igp/$IGP" "{\"voucher_date\":\"$TODAY\",\"party_id\":$P,\"warehouse_id\":$GREY,\"ownership\":\"job_work\",\"vehicle_no\":\"LES-1234\",\"lines\":[{\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"rolls\":\"4\",\"qty\":\"90\"},{\"item_id\":$FAB,\"lot_no\":\"L$RUN-2\",\"qty\":\"50.5\"}]}")
check "edit IGP qty 100→90" 200 "$(code "$R")"; check "number unchanged on edit" "$IGP_NO" "$(body "$R" | json "data|voucher_no")"
check "grey lot 1 = 90 after edit" 90 "$(bal $GREY $FAB "L$RUN-1")"

echo "== stock consumption"
R=$(req POST consumptions "{\"voucher_date\":\"$TODAY\",\"warehouse_id\":$GREY,\"purpose\":\"production\",\"lines\":[{\"_row\":0,\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"1\"}]}")
check "fabric cannot be consumed here" 1 "$([[ -n $(body "$R" | json "errors|lines.0.item_id") ]] && echo 1 || echo 0)"
R=$(req POST consumptions "{\"voucher_date\":\"$TODAY\",\"warehouse_id\":$FLOOR,\"machine_id\":$MACH,\"party_id\":$P,\"purpose\":\"production\",\"lines\":[{\"item_id\":$PAPER,\"qty\":\"120\"},{\"item_id\":$INK,\"qty\":\"0.5\",\"rate\":\"4200\"}]}")
check "issue paper + ink" 201 "$(code "$R")"; SCV=$(body "$R" | json "data|id")
check "default rate from item (25 × 120 = 3000)" "3000.00" "$(body "$R" | json "data|lines|0|amount")"
check "total amount 3000 + 2100" "5100.00" "$(body "$R" | json "data|total_amount")"
check "paper floor = 180" 180 "$(bal $FLOOR $PAPER "")"

echo "== ink loading"
R=$(req POST ink-loads "{\"voucher_date\":\"$TODAY\",\"machine_id\":$MACH,\"warehouse_id\":$FLOOR,\"lines\":[{\"_row\":0,\"item_id\":$PAPER,\"ml_filled\":\"10\"}]}")
check "non-ink rejected" 1 "$([[ -n $(body "$R" | json "errors|lines.0.item_id") ]] && echo 1 || echo 0)"
R=$(req POST ink-loads "{\"voucher_date\":\"$TODAY\",\"machine_id\":$MACH,\"warehouse_id\":$FLOOR,\"lines\":[{\"item_id\":$INK,\"ml_filled\":\"750\"},{\"item_id\":$INKML,\"ml_filled\":\"400\"}]}")
check "load 750 ml (L) + 400 ml (ml)" 201 "$(code "$R")"
check "750 ml → 0.75 L" "0.750" "$(body "$R" | json "data|lines|0|qty")"
check "400 ml → 400 ml" "400.000" "$(body "$R" | json "data|lines|1|qty")"
check "colour stored on line" "C" "$(body "$R" | json "data|lines|0|colour_code")"
# 0.75 × 4000 + 400 × 3 (3000/L = 3/ml) = 3000 + 1200
check "ink amount" "4200.00" "$(body "$R" | json "data|total_amount")"
check "total ml" "1150.000" "$(body "$R" | json "data|total_ml")"
check "cyan L floor 5 − 0.5 − 0.75 = 3.75" 3.75 "$(bal $FLOOR $INK "")"
R=$(req POST ink-loads "{\"voucher_date\":\"$TODAY\",\"machine_id\":$MACH,\"warehouse_id\":$FLOOR,\"lines\":[{\"_row\":0,\"item_id\":$INK,\"ml_filled\":\"5000\"}]}")
check "overfill blocked on ml field" 1 "$([[ $(body "$R" | json "errors|lines.0.ml_filled") == *"Only 3.75 l"* ]] && echo 1 || echo 0)"

echo "== concurrency: 6 parallel transfers of 20 m from a 90 m lot"
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -b "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
    --data "{\"voucher_date\":\"$TODAY\",\"from_warehouse_id\":$GREY,\"to_warehouse_id\":$FLOOR,\"lines\":[{\"item_id\":$FAB,\"lot_no\":\"L$RUN-1\",\"qty\":\"20\"}]}" \
    "${API}transfers" > "$JAR.c$i" &
done
wait
OKS=$(cat "$JAR".c* | grep -c 201); rm -f "$JAR".c*
check "exactly 4 succeed (80 m), rest refused" 4 "$OKS"
check "grey lot never negative" 10 "$(bal $GREY $FAB "L$RUN-1")"

echo "== lists & audit"
R=$(req GET "igp&party_id=$P&date_from=$TODAY&date_to=$TODAY"); check "IGP list filtered by party" 1 "$(body "$R" | json "data|total")"
R=$(req GET "igp&q=LES-1234"); check "search by vehicle no" 1 "$([[ $(body "$R" | json "data|total") -ge 1 ]] && echo 1 || echo 0)"
R=$(req GET "transfers&status=cancelled&item_id=$FAB"); check "transfer list by status + item" 1 "$(body "$R" | json "data|total")"
R=$(req GET "audit&entity=inward_gate_passes&q=$IGP_NO"); check "IGP create + update audited" 2 "$(body "$R" | json "data|total")"
R=$(req GET "audit&entity=stock_transfers&action=cancel"); check "cancel audited" 1 "$([[ $(body "$R" | json "data|total") -ge 1 ]] && echo 1 || echo 0)"

rm -f "$JAR"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
