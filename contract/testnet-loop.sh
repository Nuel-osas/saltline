#!/usr/bin/env bash
# Play one real loop against the deployed contract on testnet:
#   register (by the faucet) → start_run → wait out the minimum → extract → sell → simulate → broker_export.
#
#   contract/testnet-loop.sh                     # pilot-1.saltline.testnet
#   PILOT=pilot-2 CALLSIGN=PILOT-2 contract/testnet-loop.sh
#
# Needs the keys deploy.sh saved (~/.near-credentials/testnet: the contract, faucet.<id> and moss.<id>). Creates
# <PILOT>.<id> with 1 NEAR if it doesn't exist; its key goes to the same keychain. Every call's output, with its
# transaction id, is appended to $LOG.
set -euo pipefail

CONTRACT_ID="${CONTRACT_ID:-saltline.testnet}"
NETWORK="${NETWORK:-testnet}"
RPC="${RPC:-https://rpc.testnet.near.org}"
PILOT_ID="${PILOT:-pilot-1}.$CONTRACT_ID"
CALLSIGN="${CALLSIGN:-PILOT-1}"
LOG="${LOG:-$(mktemp -t saltline-loop).log}"
echo "log: $LOG"

view() { # method, json args → the JSON result, from the RPC directly
  local args
  args=$(printf '%s' "$2" | base64 | tr -d '\n')
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT_ID\",\"method_name\":\"$1\",\"args_base64\":\"$args\"}}" \
    | python3 -I -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode() if "result" in r and "result" in r["result"] else json.dumps(r))'
}

call() { # signer, method, json args, gas
  echo "• $1 → $2 $3" | tee -a "$LOG"
  near contract call-function as-transaction "$CONTRACT_ID" "$2" json-args "$3" prepaid-gas "$4" attached-deposit '0 NEAR' \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send 2>&1 | tee -a "$LOG" | grep -E "Transaction ID|E_[A-Z_]+:|Error" || true
}

exists() {
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"amount"'
}

if ! exists "$PILOT_ID"; then
  echo "• creating $PILOT_ID with 1 NEAR" | tee -a "$LOG"
  near account create-account fund-myself "$PILOT_ID" '1 NEAR' autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$CONTRACT_ID" network-config "$NETWORK" sign-with-legacy-keychain send 2>&1 | tee -a "$LOG" | grep -E "Transaction ID|Error" || true
fi

if [ "$(view profile "{\"account_id\":\"$PILOT_ID\"}")" = "null" ]; then
  call "faucet.$CONTRACT_ID" register "{\"account_id\":\"$PILOT_ID\",\"callsign\":\"$CALLSIGN\"}" '50 Tgas'
fi
view profile "{\"account_id\":\"$PILOT_ID\"}"

call "$PILOT_ID" start_run '{"gear":[]}' '100 Tgas'
RUN_ID=$(view profile "{\"account_id\":\"$PILOT_ID\"}" | python3 -I -c 'import sys,json; print(json.load(sys.stdin)["active_run"])')
MANIFEST=$(view manifest "{\"run_id\":$RUN_ID}")
echo "manifest: $MANIFEST" | tee -a "$LOG"

# Open the lightest containers that fit the carry limit; remember the first non-fuel cargo to sell.
read -r OPENED WAIT SELL_TOKEN SELL_BROKER < <(printf '%s' "$MANIFEST" | python3 -I -c '
import sys, json
m = json.load(sys.stdin)
weight = {"copper": 1, "meds": 1, "chips": 1, "fuel": 2, "core": 1}
buyer = {"copper": "moss", "chips": "moss", "meds": "ines", "fuel": "ines", "core": "qm"}
spots, load, first = [], 0, None
for c in sorted(m["containers"], key=lambda c: weight[c["token_id"]] * int(c["amount"])):
    w = weight[c["token_id"]] * int(c["amount"])
    if load + w <= 6:
        load += w
        spots.append(c["spot"])
        if first is None or first == "fuel":
            first = c["token_id"]
print(json.dumps(spots, separators=(",", ":")), 45 + 8 * len(spots) + 5, first, buyer[first])
')
echo "• opening $OPENED; waiting ${WAIT}s of chain time" | tee -a "$LOG"
sleep "$WAIT"

call "$PILOT_ID" extract "{\"run_id\":$RUN_ID,\"opened\":$OPENED,\"wrecks\":[]}" '100 Tgas'
view balances "{\"account_id\":\"$PILOT_ID\"}"

call "$PILOT_ID" sell "{\"broker\":\"$SELL_BROKER\",\"token_id\":\"$SELL_TOKEN\",\"amount\":\"1\"}" '50 Tgas'
view balances "{\"account_id\":\"$PILOT_ID\"}"

echo "• simulate as a view (what the Dockside calls)" | tee -a "$LOG"
view simulate '{"hours":168,"traders":30,"seed":7}' | python3 -I -c 'import sys,json; w=json.load(sys.stdin); print(len(w), "points; moss at hour 168:", w[-1]["brokers"]["moss"])' | tee -a "$LOG"
echo "• simulate as a transaction, to read the gas it burns" | tee -a "$LOG"
call "$PILOT_ID" simulate '{"hours":168,"traders":30,"seed":7}' '300 Tgas'

call "moss.$CONTRACT_ID" broker_export '{"token_id":"copper","amount":"2","memo":"First testnet shipment. Waste is waste."}' '50 Tgas'
view recent '{"limit":8}'
echo "log: $LOG"
