#!/usr/bin/env bash
# Deploy Saltline v2 to testnet with near-cli-rs and call `new` in the same transaction. The near-cli-rs syntax is
# checked against `near contract deploy --help` (v0.30.1).
#
#   contract2/deploy.sh                       # v2.saltline.testnet
#   CHECK_ONLY=1 contract2/deploy.sh          # every check and the build, then stop before the deploy
#   ROOT=other.testnet contract2/deploy.sh    # v2.other.testnet, with faucet/harbormaster/moss/ines.other.testnet
#
# It creates no accounts. All five must exist already:
#   v2.<root>            the contract, and its own owner (the owner can pause and unpause, nothing else)
#   faucet.<root>        registers players
#   harbormaster.<root>  the Harbormaster's wallet
#   moss.<root>, ines.<root>   the vendors
#
# It refuses to run over an account that already has code: `new` can run once, and a second deploy would be an
# upgrade (contract2/upgrade.sh).
#
# Needs: v2.<root>'s full-access key in ~/.near-credentials/<network>/v2.<root>.json; curl, jq and shasum.
# Costs: about 4.7 NEAR of v2.<root>'s balance locked by the code's storage (1 NEAR per 100 kB), plus gas.
# Keys never go into this repo.
set -euo pipefail

ROOT="${ROOT:-saltline.testnet}"
CONTRACT_ID="${CONTRACT_ID:-v2.$ROOT}"
NETWORK="${NETWORK:-testnet}"
RPC="${RPC:-https://rpc.testnet.near.org}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WASM="$HERE/target/near/saltline2.wasm"
NO_CODE="11111111111111111111111111111111"

account() { # account id → the account's JSON, or nothing
  curl -sf -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | jq -c '.result // empty'
}

for id in "$CONTRACT_ID" "faucet.$ROOT" "harbormaster.$ROOT" "moss.$ROOT" "ines.$ROOT"; do
  if [ -z "$(account "$id")" ]; then
    echo "$id doesn't exist on $NETWORK (or $RPC didn't answer). Create and fund it first." >&2
    exit 1
  fi
done
if [ ! -f "$HOME/.near-credentials/$NETWORK/$CONTRACT_ID.json" ]; then
  echo "No key for $CONTRACT_ID in ~/.near-credentials/$NETWORK." >&2
  exit 1
fi
LIVE="$(account "$CONTRACT_ID" | jq -r '.code_hash')"
if [ "$LIVE" != "$NO_CODE" ]; then
  echo "$CONTRACT_ID already runs code $LIVE. This script only does the first deploy; use contract2/upgrade.sh." >&2
  exit 1
fi

echo "• unit tests"
(cd "$HERE" && cargo test)

echo "• building"
(cd "$HERE" && cargo near build non-reproducible-wasm)
echo "  $(wc -c <"$WASM" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$WASM" | cut -d' ' -f1)"

INIT_ARGS=$(printf '{"owner_id":"%s","faucet_id":"faucet.%s","harbormaster_id":"harbormaster.%s","vendors":{"moss":"moss.%s","ines":"ines.%s"}}' \
  "$CONTRACT_ID" "$ROOT" "$ROOT" "$ROOT" "$ROOT")
echo "• init args: $INIT_ARGS"

if [ "${CHECK_ONLY:-}" = "1" ]; then
  echo "CHECK_ONLY=1: every check passed and the wasm is built; not deploying."
  exit 0
fi

echo "• deploying to $CONTRACT_ID and calling new"
near contract deploy "$CONTRACT_ID" use-file "$WASM" \
  with-init-call new json-args "$INIT_ARGS" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "• check"
echo "  code hash on chain: $(account "$CONTRACT_ID" | jq -r '.code_hash')"
near contract call-function as-read-only "$CONTRACT_ID" vendors json-args '{}' network-config "$NETWORK" now
near contract call-function as-read-only "$CONTRACT_ID" harbormaster json-args '{}' network-config "$NETWORK" now
