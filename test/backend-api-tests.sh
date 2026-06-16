#!/bin/bash
#
# OmniSMS Backend API — Complete Test Suite
# Tests all critical endpoints with proper authentication
#
# Usage:
#   ./backend-api-tests.sh [BASE_URL]
#
# Environment variables:
#   BASE_URL        — Backend URL (default: https://omnisms-backend.onrender.com)
#   FIREBASE_TOKEN  — Firebase ID token for authenticated requests
#

set -e

BASE_URL="${1:-${BASE_URL:-https://omnisms-backend.onrender.com}}"
TOKEN="${FIREBASE_TOKEN:-}"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        OMNISMS BACKEND API — COMPLETE TEST SUITE              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "🌐 Base URL: $BASE_URL"
echo "🔐 Auth Token: ${TOKEN:+✅ Set (${#TOKEN} chars)}${TOKEN:-❌ Not set (some tests will fail with 401)}"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass=0
fail=0
total=0

test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected="$4"
  local headers="$5"
  local data="$6"
  
  total=$((total + 1))
  
  printf "%-50s ... " "$name"
  
  local cmd="curl -s -o /dev/null -w '%{http_code}' -X $method"
  
  if [ -n "$headers" ]; then
    cmd="$cmd $headers"
  fi
  
  if [ -n "$data" ]; then
    cmd="$cmd -d '$data'"
  fi
  
  cmd="$cmd '$BASE_URL$path'"
  
  local status
  status=$(eval "$cmd")
  
  if [ "$status" = "$expected" ]; then
    echo -e "${GREEN}✅ PASS${NC} (HTTP $status)"
    pass=$((pass + 1))
  else
    echo -e "${RED}❌ FAIL${NC} (expected $expected, got $status)"
    fail=$((fail + 1))
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 SECTION 1: HEALTH & STATUS ENDPOINTS (Public)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint "Root endpoint" "GET" "/" "200"
test_endpoint "Health check" "GET" "/health" "200"
test_endpoint "API status" "GET" "/api/status" "200"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔐 SECTION 2: AUTHENTICATION REQUIRED ENDPOINTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Without auth — should return 401
test_endpoint "GET /api/contacts (no auth)" "GET" "/api/contacts" "401"
test_endpoint "GET /api/messages (no auth)" "GET" "/api/messages" "401"
test_endpoint "POST /api/messages/send (no auth)" "POST" "/api/messages/send" "401" "-H 'Content-Type: application/json'" "{}"
test_endpoint "POST /api/transcription (no auth)" "POST" "/api/transcription" "401"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💬 SECTION 3: MESSAGES API (with auth if available)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ -n "$TOKEN" ]; then
  AUTH_HEADER="-H 'Authorization: Bearer $TOKEN'"
  
  test_endpoint "GET /api/messages (auth)" "GET" "/api/messages" "200" "$AUTH_HEADER"
  test_endpoint "GET /api/messages/conversations (auth)" "GET" "/api/messages/conversations" "200" "$AUTH_HEADER"
  
  # Send message without required fields — should return 400
  test_endpoint "POST /api/messages/send (invalid data)" "POST" "/api/messages/send" "400" "$AUTH_HEADER -H 'Content-Type: application/json'" "{}"
  
else
  echo "⚠️  Skipping authenticated tests — set FIREBASE_TOKEN to run"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎙️  SECTION 4: TRANSCRIPTION API"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Public endpoint
test_endpoint "GET /api/transcription/service/status" "GET" "/api/transcription/service/status" "200,503"

if [ -n "$TOKEN" ]; then
  # Upload without file — should return 400
  test_endpoint "POST /api/transcription (no file)" "POST" "/api/transcription" "400" "$AUTH_HEADER"
else
  test_endpoint "POST /api/transcription (no auth)" "POST" "/api/transcription" "401"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📨 SECTION 5: INFOBIP WEBHOOKS (Public endpoints)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Webhook should accept POST without auth
test_endpoint "POST /api/webhooks/infobip/inbound" "POST" "/api/webhooks/infobip/inbound" "200,400" "-H 'Content-Type: application/json'" '{"results":[]}'
test_endpoint "GET /api/webhooks/infobip/inbound/status" "GET" "/api/webhooks/infobip/inbound/status" "200"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📡 SECTION 6: SMS SENDING (requires Infobip config)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

test_endpoint "GET /api/sms/infobip/status" "GET" "/api/sms/infobip/status" "200"

if [ -n "$TOKEN" ]; then
  # Invalid data — should return 400 or 401
  test_endpoint "POST /api/sms/send (invalid)" "POST" "/api/sms/send" "400,401" "$AUTH_HEADER -H 'Content-Type: application/json'" "{}"
else
  test_endpoint "POST /api/sms/send (no auth)" "POST" "/api/sms/send" "401"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 TEST SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Total tests:  $total"
echo -e "✅ Passed:     ${GREEN}$pass${NC}"
echo -e "❌ Failed:     ${RED}$fail${NC}"
echo ""

if [ $fail -eq 0 ]; then
  echo -e "${GREEN}✅ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ Some tests failed${NC}"
  exit 1
fi
