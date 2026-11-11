#!/usr/bin/env bash
# Deploy Saltline's economy contract to testnet with near-cli-rs (checked against `near ... --help`, v0.30.1).
#
#   contract/deploy.sh                  # saltline.testnet
#   CONTRACT_ID=other.testnet contract/deploy.sh
#
# It does three things:
# 1. Creates the sub-accounts the contract names, unless they already exist: faucet.<id>, moss.<id>, ines.<id>
#    and qm.<id>. Each is funded by <id>, and its new key goes to the legacy keychain (~/.near-credentials).
#    Keys never go into this repo.
# 2. Builds the release wasm with cargo-near.
# 3. Deploys it to <id> and calls `new` in the same transaction.
#
# Needs: <id> already exists, with its full-access key in ~/.near-credentials/testnet/<id>.json.
# Costs: FAUCET_NEAR + 3 × BROKER_NEAR, plus about 3.5 NEAR of <id>'s balance locked by the code's storage.
set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:-saltline.testnet}"
NETWORK="${NETWORK:-testnet}"
RPC="${RPC:-https://rpc.testnet.near.org}"
FAUCET_NEAR="${FAUCET_NEAR:-12}"   # the faucet pays 0.3 NEAR per new player
BROKER_NEAR="${BROKER_NEAR:-1.5}"  # brokers only pay gas for their own calls
HERE="$(cd "$(dirname "$0")" && pwd)"

exists() {
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"amount"'
}

if ! exists "$CONTRACT_ID"; then
  echo "$CONTRACT_ID doesn't exist on $NETWORK. Create and fund it first." >&2
  exit 1
fi
if [ ! -f "$HOME/.near-credentials/$NETWORK/$CONTRACT_ID.json" ]; then
  echo "No key for $CONTRACT_ID in ~/.near-credentials/$NETWORK." >&2
  exit 1
fi

create() { # name, NEAR
  local id="$1.$CONTRACT_ID"
  if exists "$id"; then
    echo "• $id exists, skipping"
    return
  fi
  echo "• creating $id with $2 NEAR"
  near account create-account fund-myself "$id" "$2 NEAR" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$CONTRACT_ID" network-config "$NETWORK" sign-with-legacy-keychain send
}

create faucet "$FAUCET_NEAR"
create moss "$BROKER_NEAR"
create ines "$BROKER_NEAR"
create qm "$BROKER_NEAR"

echo "• building"
(cd "$HERE" && cargo near build non-reproducible-wasm)

INIT_ARGS=$(printf '{"owner_id":"%s","faucet_id":"faucet.%s","brokers":{"moss":"moss.%s","ines":"ines.%s","qm":"qm.%s"}}' \
  "$CONTRACT_ID" "$CONTRACT_ID" "$CONTRACT_ID" "$CONTRACT_ID" "$CONTRACT_ID")
echo "• deploying to $CONTRACT_ID and calling new($INIT_ARGS)"
near contract deploy "$CONTRACT_ID" use-file "$HERE/target/near/saltline.wasm" \
  with-init-call new json-args "$INIT_ARGS" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "• check"
near contract call-function as-read-only "$CONTRACT_ID" rules json-args '{}' network-config "$NETWORK" now
