#!/usr/bin/env bash
# API test for Batch 2 (master data, ink master, design library, settings, lookups).
# Needs an existing admin login. Usage:
#   BASE=http://127.0.0.1:8080 ADMIN_USER=admin ADMIN_PASS=Admin12345 tests/api_masters.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/index.php?r="
JAR=$(mktemp); PASS=0; FAIL=0
RUN=$(date +%s | tail -c 6)   # unique suffix so the test can be re-run on the same DB

json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode(".",$argv[1]) as $k){ $v=is_array($v)&&array_key_exists($k,$v)?$v[$k]:null; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v,JSON_UNESCAPED_UNICODE):(string)$v);' "$1"; }
req() { local out; out=$(curl -s -o - -w '\n%{http_code}' -X "$1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" ${3:+--data "$3"} "$API$2"); echo "$(tail -n1 <<<"$out")|$(sed '$d' <<<"$out")"; }
check() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi; }
code() { echo "${1%%|*}"; }
body() { echo "${1#*|}"; }

CSRF=""
R=$(req GET auth/bootstrap); CSRF=$(body "$R" | json data.csrf)
R=$(req POST auth/login "{\"username\":\"${ADMIN_USER:-admin}\",\"password\":\"${ADMIN_PASS:-Admin12345}\"}"); CSRF=$(body "$R" | json data.csrf)
check "admin login" 200 "$(code "$R")"

echo "== units"
R=$(req GET "units&status=active"); check "list units" 200 "$(code "$R")"
UNIT_M=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["data"]["items"] as $u) if($u["code"]==="m") echo $u["id"];')
UNIT_L=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["data"]["items"] as $u) if($u["code"]==="l") echo $u["id"];')
UNIT_KG=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["data"]["items"] as $u) if($u["code"]==="kg") echo $u["id"];')
R=$(req POST units '{"code":"m","name":"Dup","dimension":"length","to_base":1,"decimals":2}'); check "duplicate unit code 422" 422 "$(code "$R")"
R=$(req POST units "{\"code\":\"cm$RUN\",\"name\":\"Centimeter\",\"dimension\":\"length\",\"to_base\":0.01,\"decimals\":1,\"is_active\":true}")
check "create unit" 201 "$(code "$R")"; CM=$(body "$R" | json data.id)

echo "== warehouses"
R=$(req POST warehouses '{"name":"Sample Room","warehouse_type":"general","is_active":true}')
check "create warehouse with auto code" 201 "$(code "$R")"; WH=$(body "$R" | json data.id)
check "auto code WH…" 1 "$([[ $(body "$R" | json data.code) =~ ^WH[0-9]{4}$ ]] && echo 1 || echo 0)"

echo "== parties"
R=$(req POST parties '{"name":"No Type"}'); check "party needs a type 422" 422 "$(code "$R")"
check "error on is_customer" 1 "$([[ -n $(body "$R" | json errors.is_customer) ]] && echo 1 || echo 0)"
R=$(req POST parties "{\"name\":\"Al-Karim Textiles $RUN\",\"name_ur\":\"الکریم ٹیکسٹائل\",\"is_customer\":true,\"is_fabric_owner\":true,\"phone\":\"0300-1234567\",\"city\":\"Faisalabad\",\"is_active\":true}")
check "create party" 201 "$(code "$R")"; PARTY=$(body "$R" | json data.id)
check "urdu name stored" "الکریم ٹیکسٹائل" "$(body "$R" | json data.name_ur)"
R=$(req GET "parties&type=customer&q=Al-Karim"); check "filter customers" 1 "$([[ $(body "$R" | json data.total) -ge 1 ]] && echo 1 || echo 0)"

echo "== ink colours + ink master"
R=$(req GET "ink-colours&status=active"); C_ID=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["data"]["items"] as $c) if($c["code"]==="C") echo $c["id"];')
M_ID=$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["data"]["items"] as $c) if($c["code"]==="M") echo $c["id"];')
check "CMYK colours seeded" 1 "$([[ -n "$C_ID" && -n "$M_ID" ]] && echo 1 || echo 0)"
R=$(req POST ink-colours "{\"code\":\"G$RUN\",\"name\":\"Green\",\"hex\":\"#00a651\",\"is_active\":true}")
check "create special colour" 201 "$(code "$R")"; check "hex upper-cased" "#00A651" "$(body "$R" | json data.hex)"
R=$(req POST items "{\"name\":\"Cyan ink bad unit\",\"item_type\":\"ink\",\"unit_id\":$UNIT_M,\"ink_colour_id\":$C_ID,\"process_type\":\"sublimation\"}")
check "ink with length unit 422" 422 "$(code "$R")"
R=$(req POST items "{\"name\":\"Cyan Ink $RUN\",\"item_type\":\"ink\",\"unit_id\":$UNIT_L,\"ink_colour_id\":$C_ID,\"brand\":\"Sawgrass\",\"process_type\":\"sublimation\",\"rate_per_liter\":\"4500\",\"reorder_level\":\"5\",\"is_active\":true,\"quality\":\"ignored\"}")
check "create ink item" 201 "$(code "$R")"; INK_C=$(body "$R" | json data.id)
check "rate per liter kept" "4500" "$(body "$R" | json data.rate_per_liter)"
check "fabric-only field cleared" "" "$(body "$R" | json data.quality)"
check "ink code prefix" 1 "$([[ $(body "$R" | json data.code) =~ ^INK[0-9]{4}$ ]] && echo 1 || echo 0)"
R=$(req POST items "{\"name\":\"Magenta Ink $RUN\",\"item_type\":\"ink\",\"unit_id\":$UNIT_L,\"ink_colour_id\":$M_ID,\"process_type\":\"any\",\"rate_per_liter\":\"5000\",\"is_active\":true}")
INK_M=$(body "$R" | json data.id)

echo "== items"
R=$(req POST items "{\"name\":\"Polyester Micro $RUN\",\"item_type\":\"grey_fabric\",\"unit_id\":$UNIT_M,\"quality\":\"Micro 120\",\"gsm\":\"110\",\"width_inch\":\"58\",\"is_active\":true}")
check "create grey fabric" 201 "$(code "$R")"; GREY=$(body "$R" | json data.id)
R=$(req POST items "{\"name\":\"Printed Micro $RUN\",\"item_type\":\"finished_fabric\",\"unit_id\":$UNIT_M,\"gsm\":\"110\",\"width_inch\":\"58\",\"is_active\":true}")
FIN=$(body "$R" | json data.id)
R=$(req POST items "{\"name\":\"Sublimation Paper 90gsm $RUN\",\"item_type\":\"paper\",\"unit_id\":$UNIT_M,\"gsm\":\"90\",\"width_inch\":\"64\",\"rate\":\"28\",\"is_active\":true}")
PAPER=$(body "$R" | json data.id)
R=$(req POST items "{\"name\":\"Anti-migration $RUN\",\"item_type\":\"chemical\",\"unit_id\":$UNIT_KG,\"rate\":\"900\",\"is_active\":true}")
CHEM=$(body "$R" | json data.id)
R=$(req GET "items&item_type=ink&q=$RUN"); check "filter ink items" 2 "$(body "$R" | json data.total)"

echo "== machines"
R=$(req POST machines "{\"name\":\"Mimaki TS300 $RUN\",\"machine_type\":\"sublimation\",\"speed_m_per_hr\":\"60\",\"hourly_cost\":\"1500\",\"is_active\":true}")
check "create machine" 201 "$(code "$R")"; MACH=$(body "$R" | json data.id)

echo "== settings"
R=$(req GET settings); check "read settings" "12" "$(body "$R" | json data.ink_ml_per_sqm_full)"
R=$(req PUT settings '{"company_name":"Test Prints","ink_ml_per_sqm_full":"12","ink_reference_gsm":"100","default_wastage_pct":"3","whatsapp_support":"+923001234567"}')
check "update settings" 200 "$(code "$R")"; check "whatsapp normalised" 923001234567 "$(body "$R" | json data.whatsapp_support)"

echo "== designs"
D="{\"name\":\"Floral $RUN\",\"party_id\":$PARTY,\"process_type\":\"sublimation\",\"basis_gsm\":\"110\",\"basis_width_inch\":\"58\",\"finished_item_id\":$FIN,\"default_machine_id\":$MACH,\"is_active\":true,"
R=$(req POST designs "$D\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\"},{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"10\"}],\"bom\":[]}")
check "duplicate colour 422" 422 "$(code "$R")"; check "error keyed inks.1.ink_colour_id" 1 "$([[ -n $(body "$R" | json errors.inks\.1\.ink_colour_id 2>/dev/null; body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo $d["errors"]["inks.1.ink_colour_id"]??"";') ]] && echo 1 || echo 0)"
R=$(req POST designs "{\"name\":\"No basis\",\"process_type\":\"sublimation\",\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\"}]}")
check "basis gsm/width required for calc" 1 "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo (int)isset($d["errors"]["basis_gsm"], $d["errors"]["basis_width_inch"]);')"
R=$(req POST designs "$D\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\",\"item_id\":$INK_M}]}")
check "ink item colour mismatch 422" 422 "$(code "$R")"
R=$(req POST designs "$D\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\",\"item_id\":$INK_C},{\"ink_colour_id\":$M_ID,\"coverage_pct\":\"25\"},{\"ink_colour_id\":$M_ID,\"coverage_pct\":\"\"}],\"bom\":[{\"item_id\":$PAPER,\"qty_per_meter\":\"1.05\",\"wastage_pct\":\"2\"},{\"item_id\":$CHEM,\"qty_per_meter\":\"0.005\"},{\"item_id\":$INK_C,\"qty_per_meter\":\"1\"}]}")
check "ink item in BOM rejected" 1 "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo (int)isset($d["errors"]["bom.2.item_id"]);')"
R=$(req POST designs "$D\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\",\"item_id\":$INK_C},{\"ink_colour_id\":$M_ID,\"coverage_pct\":\"25\"},{\"ink_colour_id\":\"\",\"coverage_pct\":\"\"}],\"bom\":[{\"item_id\":$PAPER,\"qty_per_meter\":\"1.05\",\"wastage_pct\":\"2\"},{\"item_id\":$CHEM,\"qty_per_meter\":\"0.005\"}]}")
check "create design" 201 "$(code "$R")"; DES=$(body "$R" | json data.id)
B=$(body "$R")
# 12 ml/m² × 40% × (58 × 0.0254 m) × 110/100 = 7.7785 ml/m (cyan)
check "cyan ml/m calculated" "7.7785" "$(php -r '$d=json_decode($argv[1],true); foreach($d["data"]["inks"] as $l) if($l["colour_code"]==="C") echo rtrim(rtrim($l["ml_per_meter"],"0"),".");' "$B")"
check "colour count auto" 2 "$(json data.colour_count <<<"$B")"
check "coverage total auto" "65.00" "$(json data.ink_coverage_pct <<<"$B")"
# cost: C 7.7785/1000×4500 = 35.0033 ; M 4.8616/1000×5000 (default 'any' ink) = 24.308 ; total 59.3113
check "ink cost per meter" "59.3113" "$(json data.costs.ink_cost_per_meter <<<"$B")"
check "magenta (no ink chosen) costed via a default magenta ink" 1 "$(php -r '$d=json_decode($argv[1],true); foreach($d["data"]["inks"] as $l) if($l["colour_code"]==="M") echo (int)!empty($l["costing_item"]["id"]);' "$B")"
# BOM: paper 1.05×1.02×28 = 29.988 ; chem 0.005×900 = 4.5 → 34.488
check "BOM cost per meter" "34.488" "$(json data.costs.bom_cost_per_meter <<<"$B")"
check "auto design code" 1 "$([[ $(json data.design_code <<<"$B") =~ ^D[0-9]{4}$ ]] && echo 1 || echo 0)"
R=$(req PUT "designs/$DES" "$D\"inks\":[{\"ink_colour_id\":$C_ID,\"coverage_pct\":\"40\",\"is_manual\":true,\"ml_per_meter\":\"9.5\",\"item_id\":$INK_C}],\"bom\":[]}")
check "update design with manual ml" "9.5000" "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo $d["data"]["inks"][0]["ml_per_meter"];')"
check "bom lines replaced" 0 "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true); echo count($d["data"]["bom"]);')"

echo "== design image"
IMG=$(mktemp --suffix=.png); php -r '$i=imagecreatetruecolor(1200,800); imagefill($i,0,0,imagecolorallocate($i,30,120,200)); imagepng($i,$argv[1]);' "$IMG"
R=$(curl -s -w '\n%{http_code}' -b "$JAR" -H "X-CSRF-Token: $CSRF" -F "image=@$IMG;type=image/png" "${API}designs/$DES/image")
check "upload image" 200 "$(tail -n1 <<<"$R")"
THUMB=$(sed '$d' <<<"$R" | json data.thumb_url)
check "thumb url" 1 "$([[ "$THUMB" == api/index.php* ]] && echo 1 || echo 0)"
H=$(curl -s -D - -o /tmp/claude-0/thumb.jpg -b "$JAR" "$BASE/$THUMB")
check "thumb served as jpeg" 1 "$(grep -ci '^content-type: image/jpeg' <<<"$H")"
check "thumb resized to 360px" 360 "$(php -r '$s=getimagesize("/tmp/claude-0/thumb.jpg"); echo max($s[0],$s[1]);')"
echo "not an image" > "$IMG.txt"
R=$(curl -s -w '\n%{http_code}' -b "$JAR" -H "X-CSRF-Token: $CSRF" -F "image=@$IMG.txt;type=image/png" "${API}designs/$DES/image")
check "non-image rejected 422" 422 "$(tail -n1 <<<"$R")"
check "image not served without login" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$THUMB")"
check "path traversal impossible (no file param)" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${API}designs/999999/image")"

echo "== lookups"
R=$(req GET "lookups&sets=units,parties,ink_colours,items,machines,designs,ink_params,warehouses")
check "lookups 200" 200 "$(code "$R")"
check "lookup option shape" 1 "$(body "$R" | php -r '$d=json_decode(stream_get_contents(STDIN),true)["data"]; echo (int)(isset($d["items"][0]["value"],$d["items"][0]["label"]) && $d["ink_params"]["reference_gsm"]==100);')"

echo "== delete protection & soft delete"
R=$(req DELETE "items/$PAPER"); check "paper used by design BOM? (bom removed → deletable)" 200 "$(code "$R")"
R=$(req DELETE "items/$INK_C"); check "ink used in design cannot be deleted 409" 409 "$(code "$R")"
R=$(req DELETE "units/$UNIT_M"); check "unit in use 409" 409 "$(code "$R")"
R=$(req DELETE "units/$CM"); check "unused unit deleted" 200 "$(code "$R")"
R=$(req GET "units/$CM"); check "deleted unit hidden" 404 "$(code "$R")"
R=$(req DELETE "warehouses/$WH"); check "unused warehouse deleted" 200 "$(code "$R")"
R=$(req DELETE "designs/$DES"); check "design soft-deleted" 200 "$(code "$R")"
R=$(req DELETE "items/$INK_C"); check "ink deletable once its design is deleted" 200 "$(code "$R")"

echo "== audit"
R=$(req GET "audit&entity=designs"); check "design changes audited" 1 "$([[ $(body "$R" | json data.total) -ge 4 ]] && echo 1 || echo 0)"

rm -f "$JAR" "$IMG" "$IMG.txt"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
