#!/usr/bin/env bash
set -euo pipefail

PROXY="${1:-http://127.0.0.1:18080}"   # functions only
ADMIN="${2:-http://127.0.0.1:19090}"   # panel + admin API

echo "smoke: proxy=$PROXY admin=$ADMIN"

expect_200() {
  local url="$1"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$code" != "200" ]; then
    echo "FAIL $url -> $code"
    exit 1
  fi
  echo "ok   $url"
}

expect_not() {
  local url="$1"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$code" = "200" ]; then
    echo "FAIL (expected non-200) $url -> $code"
    exit 1
  fi
  echo "ok   $url -> $code (blocked)"
}

# functions on the proxy port
expect_200 "$PROXY/hello?name=smoke"
expect_200 "$PROXY/slow"
# panel + admin API on the management port
expect_200 "$ADMIN/"
expect_200 "$ADMIN/admin/healthz"
expect_200 "$ADMIN/admin/api/status"
expect_200 "$ADMIN/admin/api/functions"
# the proxy port must NOT expose the panel
expect_not "$PROXY/"

echo "smoke OK"
