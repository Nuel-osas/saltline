#!/usr/bin/env bash
# Download the code that is live on the contract account, for the upgrade rehearsal in tests/upgrade.rs.
#
#   contract/sandbox/fetch-live.sh                         # saltline.testnet
#   CONTRACT_ID=other.testnet contract/sandbox/fetch-live.sh
#
# Writes res/live.wasm and res/live.code_hash (the chain's base58 SHA-256 of that code). tests/upgrade.rs checks
# the hash again when it deploys the file to the sandbox, and contract/upgrade.sh checks it against the chain once
# more just before it deploys.
#
# res/ is gitignored: the wasm is about 350 KB, changes with every deploy, and is always one RPC call away.
set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:-saltline.testnet}"
RPC="${RPC:-https://rpc.testnet.near.org}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$HERE/res"
mkdir -p "$RES"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -sf -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$CONTRACT_ID\"}}" \
  >"$TMP"
HASH="$(jq -r '.result.hash // empty' "$TMP")"
if [ -z "$HASH" ]; then
  echo "No code on $CONTRACT_ID: $(jq -c '.error // .' "$TMP")" >&2
  exit 1
fi
jq -r '.result.code_base64' "$TMP" | base64 -d >"$RES/live.wasm"
printf '%s\n' "$HASH" >"$RES/live.code_hash"
echo "$CONTRACT_ID: $(wc -c <"$RES/live.wasm" | tr -d ' ') bytes, code hash $HASH → $RES/live.wasm"
