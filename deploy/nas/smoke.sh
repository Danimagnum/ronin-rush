#!/bin/sh
# Local checks through the same path Funnel uses (127.0.0.1:3310). Exit 1 on any failure.
#   sh smoke.sh  (no sudo needed)
set -u
BASE="${1:-http://127.0.0.1:3310}"
fail=0
check() { if [ "$2" = "$3" ]; then printf '  ok   %s\n' "$1"; else printf '  FAIL %s (got %s, want %s)\n' "$1" "$2" "$3"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
echo "smoke test against $BASE"
check "proxy alive"            "$(code "$BASE/nginx-health")" 200
check "web page"               "$(code "$BASE/")" 200
check "verify page"            "$(code "$BASE/verify")" 200
check "API health"             "$(curl -s --max-time 5 "$BASE/health" | grep -o '"status":"ok"')" '"status":"ok"'
check "API round (REST)"       "$(code "$BASE/api/round")" 200
check "frame-ancestors header" "$(curl -sI --max-time 5 "$BASE/" | grep -ci 'frame-ancestors')" 1
check "Socket.IO handshake"    "$(curl -s --max-time 5 "$BASE/socket.io/?EIO=4&transport=polling" | cut -c1-7)" '0{"sid"'
ws="$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: cm9uaW4tcnVzaC1zbW9rZQ==' "$BASE/socket.io/?EIO=4&transport=websocket")"
check "WebSocket upgrade"      "$ws" 101
[ $fail = 0 ] && echo "all checks passed" || echo "some checks failed"
exit $fail
