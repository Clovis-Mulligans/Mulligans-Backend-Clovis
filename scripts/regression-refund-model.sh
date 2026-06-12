#!/usr/bin/env bash
# scripts/regression-refund-model.sh
# Regression: refund-model validation (60% cap) + C1 return_request API exposure.
# Safe to run repeatedly: uses a fake order id for validation tests (no data written).
#
# Usage on dev EC2:
#   BUYER_EMAIL=you@test.com BUYER_PASSWORD=secret bash scripts/regression-refund-model.sh
# Optional: BASE_URL (default http://localhost:3001/api)

set -u
BASE_URL="${BASE_URL:-http://localhost:3001/api}"
FAKE_ORDER="00000000-0000-0000-0000-000000000000"
PASS=0; FAIL=0

if [ -z "${BUYER_EMAIL:-}" ] || [ -z "${BUYER_PASSWORD:-}" ]; then
  echo "Set BUYER_EMAIL and BUYER_PASSWORD env vars (a dev test account)."; exit 1
fi

json_get() { # json_get '<json>' key  -> prints value or empty
  node -e "try{const d=JSON.parse(process.argv[1]);const k=process.argv[2];const v=k.split('.').reduce((o,p)=>o&&o[p],d);if(v!==undefined&&v!==null)console.log(typeof v==='string'?v:JSON.stringify(v))}catch(e){}" "$1" "$2"
}

echo "== Login =="
LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$BUYER_EMAIL\",\"password\":\"$BUYER_PASSWORD\"}")
TOKEN=$(json_get "$LOGIN" token)
[ -z "$TOKEN" ] && TOKEN=$(json_get "$LOGIN" accessToken)
[ -z "$TOKEN" ] && TOKEN=$(json_get "$LOGIN" data.token)
if [ -z "$TOKEN" ]; then
  echo "LOGIN FAILED — response was:"; echo "$LOGIN"; exit 1
fi
echo "Login OK."

dispute_call() { # dispute_call <percent> -> prints response body
  local pct="$1"
  local body="{\"reason\":\"wrong_item\",\"description\":\"automated regression test\",\"requestedRefundPercent\":$pct,\"willingToReturn\":true}"
  # Try route shape A: POST /orders/:id/dispute
  local resp
  resp=$(curl -s -X POST "$BASE_URL/orders/$FAKE_ORDER/dispute" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body")
  # If the ROUTE itself doesn't exist (HTML 404 / Cannot POST), try shape B: POST /disputes
  if echo "$resp" | grep -qiE 'cannot post|<html'; then
    resp=$(curl -s -X POST "$BASE_URL/disputes" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"orderId\":\"$FAKE_ORDER\",\"order_id\":\"$FAKE_ORDER\",\"reason\":\"wrong_item\",\"description\":\"automated regression test\",\"requestedRefundPercent\":$pct,\"willingToReturn\":true}")
  fi
  echo "$resp"
}

check() { # check <name> <response> <must_contain> <must_not_contain>
  local name="$1" resp="$2" yes="$3" no="$4"
  if echo "$resp" | grep -qi "$yes" && { [ -z "$no" ] || ! echo "$resp" | grep -qi "$no"; }; then
    echo "PASS  $name"; PASS=$((PASS+1))
  else
    echo "FAIL  $name"; echo "      expected to contain: $yes"; [ -n "$no" ] && echo "      and NOT contain: $no"
    echo "      actual: $resp"; FAIL=$((FAIL+1))
  fi
}

echo; echo "== T1a: 70% rejected with rule message =="
R=$(dispute_call 70)
check "70% -> rule error" "$R" "Partial refunds can be up to 60" "not found"

echo; echo "== T1b: 60% passes validation (dies later at order lookup) =="
R=$(dispute_call 60)
check "60% -> reaches order lookup" "$R" "not found" "Partial refunds"

echo; echo "== T1c: 100 passes validation (dies later at order lookup) =="
R=$(dispute_call 100)
check "100 -> reaches order lookup" "$R" "not found" "Partial refunds"

echo; echo "== T1d: 65% (off-step) rejected =="
R=$(dispute_call 65)
check "65% -> rule error" "$R" "Partial refunds can be up to 60" "not found"

echo; echo "== C1: return_request key present on order detail =="
ORDERS=$(curl -s "$BASE_URL/orders" -H "Authorization: Bearer $TOKEN")
OID=$(node -e "try{const d=JSON.parse(process.argv[1]);const arr=d.orders||d.data||d;const o=Array.isArray(arr)?arr[0]:null;if(o&&o.id)console.log(o.id)}catch(e){}" "$ORDERS")
if [ -z "$OID" ]; then
  echo "SKIP  no orders on this account to check (log in with an account that has orders)"
else
  DETAIL=$(curl -s "$BASE_URL/orders/$OID" -H "Authorization: Bearer $TOKEN")
  check "order $OID exposes return_request" "$DETAIL" "return_request" ""
  # If a return exists on it, show the new fields for eyeballing
  RR=$(json_get "$DETAIL" "order.return_request"); [ -z "$RR" ] && RR=$(json_get "$DETAIL" "return_request")
  [ -n "$RR" ] && [ "$RR" != "null" ] && { echo "      return_request payload:"; echo "      $RR"; }
fi

echo; echo "=============================="
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "Validation layer + C1 exposure: GREEN" || echo "Investigate failures above before prod deploy"