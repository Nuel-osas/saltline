#!/usr/bin/env bash
# Upgrade Saltline v2 on testnet to the code in this checkout and keep its state: a code deploy with NO init call.
# The near-cli-rs syntax is checked against `near contract deploy --help` (v0.30.1).
#
#   contract2/upgrade.sh                          # v2.saltline.testnet
#   CHECK_ONLY=1 contract2/upgrade.sh             # every gate, then stop before the deploy
#   CONTRACT_ID=other.testnet contract2/upgrade.sh
#
# It refuses to deploy unless every gate passes, in this order:
# 1. `cargo test`: the unit tests.
# 2. `cargo near build non-reproducible-wasm`: the release wasm this script deploys.
# 3. sandbox/fetch-live.sh: the code live on <id> now, into sandbox/res/.
# 4. The sandbox rehearsal, sandbox/tests/upgrade.rs: the live code with fresh state (a gun in every state, an open
#    raid, listings, a wreck, an impound, arrears), and a copy of <id>'s real state, each upgraded to the new wasm
#    with every view checked. It writes sandbox/res/upgrade-passed.
# 5. The rehearsal matches what goes out: the wasm is unchanged since it was tested, and <id> still runs the code
#    the rehearsal upgraded from.
# Then it deploys without an init call and reads back the code hash and the `economy` and `harbormaster` views.
#
# Why no init call is needed: the code keeps the root state's layout. What the new calls need (the Harbormaster's
# posture, the vendors' own prices and memos, the last sale prices, the day's scrip flow) has been in that layout
# since the first deploy, and the drawing, the leaderboard and the payout are computed when read.
#
# Needs: <id>'s full-access key in ~/.near-credentials/<network>/<id>.json; curl, jq and shasum. The first run
# builds the sandbox crate (near-workspaces), which takes a few minutes.
# Costs: gas, and 1 NEAR of <id>'s balance locked for every 100 kB the code grows by.
set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:-v2.saltline.testnet}"
NETWORK="${NETWORK:-testnet}"
RPC="${RPC:-https://rpc.testnet.near.org}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WASM="$HERE/target/near/saltline2.wasm"
RES="$HERE/sandbox/res"

code_hash() {
  curl -sf -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT_ID\"}}" \
    | jq -r '.result.code_hash // empty'
}

sha() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

if [ ! -f "$HOME/.near-credentials/$NETWORK/$CONTRACT_ID.json" ]; then
  echo "No key for $CONTRACT_ID in ~/.near-credentials/$NETWORK." >&2
  exit 1
fi

echo "• 1/5 unit tests"
(cd "$HERE" && cargo test)

echo "• 2/5 building the release wasm"
(cd "$HERE" && cargo near build non-reproducible-wasm)
BUILT="$(sha "$WASM")"
echo "  $(wc -c <"$WASM" | tr -d ' ') bytes, sha256 $BUILT"

echo "• 3/5 fetching the code live on $CONTRACT_ID"
CONTRACT_ID="$CONTRACT_ID" RPC="$RPC" "$HERE/sandbox/fetch-live.sh"

echo "• 4/5 rehearsing the upgrade on a sandbox"
rm -f "$RES/upgrade-passed"
(cd "$HERE/sandbox" && CONTRACT_ID="$CONTRACT_ID" cargo test --test upgrade -- --nocapture --test-threads=1)

echo "• 5/5 checking the rehearsal against what goes out"
if [ ! -f "$RES/upgrade-passed" ]; then
  echo "The sandbox upgrade test didn't pass (no $RES/upgrade-passed). Not deploying." >&2
  exit 1
fi
FROM="$(sed -n 's/^live=//p' "$RES/upgrade-passed")"
TO="$(sed -n 's/^new=//p' "$RES/upgrade-passed")"
if [ "$(sha "$WASM")" != "$BUILT" ]; then
  echo "$WASM changed while the tests ran. Not deploying." >&2
  exit 1
fi
LIVE="$(code_hash)"
if [ -z "$LIVE" ] || [ "$LIVE" != "$FROM" ]; then
  echo "$CONTRACT_ID runs '${LIVE:-unknown}' now, but the rehearsal upgraded from $FROM. Run this again." >&2
  exit 1
fi
if [ "$LIVE" = "$TO" ]; then
  echo "$CONTRACT_ID already runs $TO. Nothing to deploy."
  exit 0
fi
echo "  rehearsed: $FROM → $TO"

if [ "${CHECK_ONLY:-}" = "1" ]; then
  echo "CHECK_ONLY=1: every gate passed; not deploying."
  exit 0
fi

echo "• deploying $TO to $CONTRACT_ID, without an init call"
near contract deploy "$CONTRACT_ID" use-file "$WASM" without-init-call \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "• check"
NOW=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  NOW="$(code_hash)"
  [ "$NOW" = "$TO" ] && break
  sleep 2
done
if [ "$NOW" != "$TO" ]; then
  echo "$CONTRACT_ID's final code hash is '${NOW:-unknown}', expected $TO. Check the explorer before anything else." >&2
  exit 1
fi
echo "  $CONTRACT_ID runs $TO"
near contract call-function as-read-only "$CONTRACT_ID" economy json-args '{}' network-config "$NETWORK" now
near contract call-function as-read-only "$CONTRACT_ID" harbormaster json-args '{}' network-config "$NETWORK" now
