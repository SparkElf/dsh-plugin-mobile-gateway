#!/usr/bin/env bash
#
# End-to-end check of the mobile path: mint a pairing code on the local gateway, then drive a full
# pairing and Session load through the entry VPS's stateless relay. One command, no phone, no manual
# steps.
#
#   scripts/e2e-mobile.sh
#
# The entry host must already run the stateless gateway and must not run the legacy disk cache.
# Override the unit/port if the deployment uses different names:
#   ENTRY_SERVICE=dsh-mobile-gateway ENTRY_PORT=7091 scripts/e2e-mobile.sh
#
# Exits non-zero on the first failed leg and prints which leg failed.
set -uo pipefail

NODE=/root/.nvm/versions/node/v24.18.0/bin/node
# The entry VPS carries the distribution's own Node, not this host's nvm install.
VPS_NODE=/usr/bin/node
HERE=$(cd "$(dirname "$0")" && pwd)
VPS=154.201.72.205
ENTRY_SERVICE=${ENTRY_SERVICE:-dsh-mobile-gateway}
ENTRY_PORT=${ENTRY_PORT:-7091}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR)

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n=== %s ===\n' "$1"; }

step "local gateway"
STATUS=$(curl -s --max-time 15 -H 'Host: localhost:3080' http://127.0.0.1:3080/mgw/status || true)
[ -n "$STATUS" ] || fail "the gateway did not answer /mgw/status"
VERSION=$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')
[ -n "$VERSION" ] || fail "/mgw/status carried no version"
pass "gateway $VERSION"

step "pairing code"
CODE=$(cd "$HERE/.." && timeout 180 "$NODE" "$HERE/mint-pairing-code.mjs" 2>/dev/null | tail -1)
[ -n "$CODE" ] || fail "could not mint a pairing code"
pass "pairing code ${CODE:0:10}..."

step "through the entry stateless gateway (/ws/mobile -> nginx -> stateless gateway -> tunnel)"
export SSHPASS=$(python3 -c "import yaml; d=yaml.safe_load(open('/root/.dsh/.credentials.yaml')); print([r['payload']['password'] for k,r in d.get('records',{}).items() if 'ssh' in k.lower()][0])")
sshpass -e scp "${SSH_OPTS[@]}" "$HERE/../bin/protocol-harness.mjs" root@$VPS:/tmp/ >/dev/null 2>&1 || fail "could not upload the harness"
# A Session with events in it, so the run exercises a real history page. Without one the flow
# completes on an empty Session list and proves nothing about the path that was broken.
KNOWN_SESSION=session-6f3e326e-e053-48c0-b4fa-50d013ce6817
if [ "${E2E_SKIP_HISTORY:-0}" = "1" ]; then
  sshpass -e ssh "${SSH_OPTS[@]}" root@$VPS "$VPS_NODE /tmp/protocol-harness.mjs --host 127.0.0.1 --port $ENTRY_PORT --code $CODE --timeout 30000" || fail "proxy flow did not complete"
  pass "proxy flow completed (history not checked)"
else
  FLOW=$(sshpass -e ssh "${SSH_OPTS[@]}" root@$VPS "$VPS_NODE /tmp/protocol-harness.mjs --host 127.0.0.1 --port $ENTRY_PORT --code $CODE --session $KNOWN_SESSION --timeout 30000" 2>&1)
  printf '%s\n' "$FLOW" | sed 's/^/  /'
  printf '%s' "$FLOW" | grep -q "结果: PASS" || fail "the flow did not pass (see above)"
  # The harness prints the id shortened; match the prefix it does print.
  SESSION_PREFIX=$(printf '%s' "$KNOWN_SESSION" | cut -c1-24)
  printf '%s' "$FLOW" | grep -q "history for $SESSION_PREFIX" || fail "the flow never served a history page"
  # The version the answer declares must match what the gateway announced, or the client rejects it.
  printf '%s' "$FLOW" | grep -q "formatVersion=3" || fail "the history answer did not declare the gateway's Session format"
  printf '%s' "$FLOW" | grep -qE "events=[1-9][0-9]*" || fail "the history page carried no events"
  pass "proxy flow completed with a non-empty history page"
fi

step "survivors"
# After the stateless migration the two disk-cache services must be inactive.
sshpass -e ssh "${SSH_OPTS[@]}" root@$VPS 'for unit in dsh-mobile-session-cache dsh-mobile-cache-proxy; do if systemctl is-active --quiet "$unit"; then exit 1; fi; done; exit 0' >/dev/null 2>&1 || fail "legacy cache services are still active"
pass "legacy cache services inactive"
sshpass -e ssh "${SSH_OPTS[@]}" root@$VPS "systemctl is-active $ENTRY_SERVICE" >/dev/null 2>&1 || fail "the stateless gateway ($ENTRY_SERVICE) is not active"
pass "stateless gateway active"
curl -s -o /dev/null --max-time 10 http://127.0.0.1:3080/ || fail "the local gateway stopped answering"
pass "local gateway answering"

printf '\n\033[32mMOBILE E2E PASSED\033[0m\n'
