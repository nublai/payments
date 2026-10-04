#!/usr/bin/env bash
# One local USDC escrow: same Anvil, deploy:local, and wrangler relayer as
# e2e-local-payment.sh, then the real `tw` CLI (`bun ./src/cli.ts`).
#
# Creates an escrow, checks on-chain status, and settles it with the Anvil
# deployer key. SimpleSettler.write accepts only that owner's signature
# (packages/contracts/src/accounts/SimpleSettler.sol). The key is the public
# Anvil default, the same DEFAULT_LOCAL_PRIVATE_KEY deploy.sh already uses.
#
# Requires: anvil, cast, forge, bun, curl, python3, bc (fund-dev.sh), and Node >= 22
# on PATH. Wrangler refuses Node 20. If `node` is older and /tmp/node22/bin/node
# exists, that directory is prepended to PATH.
#
# Ports 8545, 8546, and 8787 must be free. The script stops the Anvil and relayer
# processes it starts.
set -euo pipefail

# Print command stdout on failure. CLI errors are JSON on stdout, which a bare
# command substitution would discard under set -e.
run_out() {
  local status
  local out
  set +e
  out="$("$@")"
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    printf '%s\n' "$out" >&2
    exit "$status"
  fi
  printf '%s\n' "$out"
}


ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.foundry/bin:${HOME}/.bun/bin:${PATH}"

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])'
}

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 22 ]]; then
  if [[ -x /tmp/node22/bin/node ]]; then
    export PATH="/tmp/node22/bin:${PATH}"
  fi
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 22 ]]; then
  echo "Node >= 22 is required to start the wrangler relayer (found: $(command -v node >/dev/null && node -v || echo none))." >&2
  exit 1
fi

for cmd in anvil cast forge bun curl python3 bc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

port_listening() {
  ss -ltn "sport = :$1" | awk 'NR>1 {found=1} END {exit found?0:1}'
}

for port in 8545 8546 8787; do
  if port_listening "$port"; then
    echo "Port $port is already in use. Stop that process before running the e2e." >&2
    exit 1
  fi
done

PIDS=()
kill_tree() {
  local pid="$1"
  local kid
  for kid in $(ps -o pid= --ppid "$pid" 2>/dev/null || true); do
    kill_tree "$kid"
  done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill_tree "$pid"
  done
}
trap cleanup EXIT

wait_rpc() {
  local url="$1"
  local i
  for i in $(seq 1 50); do
    if cast chain-id --rpc-url "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "RPC did not come up: $url" >&2
  return 1
}

echo "Starting Anvil 31337 (8545) and 41337 (8546)..."
anvil --port 8545 --chain-id 31337 --block-time 2 --base-fee 1000000000 \
  > /tmp/e2e-escrow-anvil-31337.log 2>&1 &
PIDS+=("$!")
anvil --port 8546 --chain-id 41337 \
  > /tmp/e2e-escrow-anvil-41337.log 2>&1 &
PIDS+=("$!")
wait_rpc http://127.0.0.1:8545
wait_rpc http://127.0.0.1:8546

echo "Deploying contracts (bun run deploy:local && bun run make-config)..."
(
  cd "$ROOT/packages/contracts"
  bun run deploy:local
  bun run make-config
)


# dev.sh skips `bun run build` when dist/index.js exists. Drop it so this run
# recompiles @agentic-payments/contracts and exports getAddressesWithFallback.
echo "Rebuilding @agentic-payments/contracts..."
rm -rf "$ROOT/packages/contracts/dist"
(
  cd "$ROOT/packages/contracts"
  bun run build
)

# make-config writes this file and then removes local keys from addresses.json.
# Export only ADDRESS=0x... lines so PATH and other vars stay intact.
LOCAL_ENV="$ROOT/packages/contracts/deployments/envs/local/.env"
if [[ ! -f "$LOCAL_ENV" ]]; then
  echo "Missing $LOCAL_ENV after make-config." >&2
  exit 1
fi
exported=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(0x[0-9a-fA-F]{40})$ ]] || continue
  export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  exported=$((exported + 1))
done < "$LOCAL_ENV"
if [[ "$exported" -lt 1 ]]; then
  echo "No address keys in $LOCAL_ENV" >&2
  exit 1
fi
echo "Exported $exported local address keys"

echo "Starting wrangler relayer..."
RELAYER_PID="$(bash "$ROOT/packages/relayer/scripts/dev.sh" --background)"
PIDS+=("$RELAYER_PID")
echo "Relayer pid $RELAYER_PID"

echo "Building @agentic-payments/relayer-client..."
(cd "$ROOT/packages/relayer-client" && bun run build)

WORKDIR="$(mktemp -d /tmp/agentic-payments-e2e-escrow.XXXXXX)"
KEYSTORE="$WORKDIR/account.json"
# Anvil account #1. Receives USDC when the escrow is settled.
SELLER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
# Anvil account #0, SimpleSettler owner on local deploy.
ORACLE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ORACLE="$(cast wallet address --private-key "$ORACLE_KEY")"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export TW_PASSWORD="e2e-local-payment"
export TW_ORACLE_PRIVATE_KEY="$ORACLE_KEY"

echo "Creating and delegating account..."
CREATE_JSON="$(
  cd "$ROOT/packages/wallet"
  run_out bun ./src/cli.ts account create \
    --env dev \
    --keystore-path "$KEYSTORE" \
    --format json
)"
printf '%s\n' "$CREATE_JSON" | tee "$WORKDIR/account-create.json" >/dev/null
BUYER="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["addresses"]["delegated"])' <<<"$CREATE_JSON")"
CREATE_TX="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["txHash"])' <<<"$CREATE_JSON")"
echo "Buyer $BUYER create tx $CREATE_TX oracle $ORACLE"

echo "Minting MockUSDC..."
bash "$ROOT/packages/wallet/scripts/fund-dev.sh" "$BUYER" 25 >/dev/null

balance_of() {
  cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url http://127.0.0.1:8545 | awk '{print $1}'
}

BEFORE_BUYER="$(balance_of "$BUYER")"
BEFORE_SELLER="$(balance_of "$SELLER")"

echo "Creating 1 USDC escrow..."
ESCROW_JSON="$(
  cd "$ROOT/packages/wallet"
  run_out bun ./src/cli.ts escrow create 1 "$SELLER" \
    --oracle "$ORACLE" \
    --deadline 1h \
    --env dev \
    --keystore-path "$KEYSTORE" \
    --format json
)"
printf '%s\n' "$ESCROW_JSON" | tee "$WORKDIR/escrow-create.json" >/dev/null
python3 - "$ESCROW_JSON" << 'PY'
import json, sys
data = json.loads(sys.argv[1])
status = data.get("bundle", {}).get("status")
tx = data.get("txHash")
if data.get("status") != "complete" or status != "confirmed" or not tx:
    raise SystemExit(f"escrow create did not confirm: {data}")
if not data.get("escrowId") or not data.get("orderId"):
    raise SystemExit(f"escrow create missing ids: {data}")
print(f"bundle {data['bundle']['id']} status {status} tx {tx}")
PY

ESCROW_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["escrowId"])' <<<"$ESCROW_JSON")"
ORDER_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["orderId"])' <<<"$ESCROW_JSON")"
CREATE_BUNDLE_TX="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["txHash"])' <<<"$ESCROW_JSON")"

AFTER_CREATE_BUYER="$(balance_of "$BUYER")"
python3 - "$BEFORE_BUYER" "$AFTER_CREATE_BUYER" << 'PY'
import sys
before, after = (int(x) for x in sys.argv[1:])
if after != before - 1_000_000:
    raise SystemExit(f"buyer balance {before} -> {after}, expected -1000000 after create")
print(f"USDC buyer locked {before} -> {after}")
PY

echo "Reading escrow status..."
STATUS_OUT="$(
  cd "$ROOT/packages/wallet"
  run_out bun ./src/cli.ts escrow status "$ESCROW_ID" --env dev
)"
printf '%s\n' "$STATUS_OUT" | tee "$WORKDIR/escrow-status-created.txt" >/dev/null
python3 - "$STATUS_OUT" << 'PY'
import re, sys
text = sys.argv[1]
match = re.search(r"(?m)^status:\s*(\S+)", text)
if not match:
    raise SystemExit(f"escrow status output missing status field:\n{text}")
status = match.group(1)
if status != "created":
    raise SystemExit(f"escrow status {status}, expected created")
print(f"escrow status {status}")
PY

echo "Settling escrow..."
SETTLE_JSON="$(
  cd "$ROOT/packages/wallet"
  run_out bun ./src/cli.ts escrow settle "$ESCROW_ID" \
    --settlement-id "$ORDER_ID" \
    --oracle "$ORACLE" \
    --env dev \
    --keystore-path "$KEYSTORE" \
    --format json
)"
printf '%s\n' "$SETTLE_JSON" | tee "$WORKDIR/escrow-settle.json" >/dev/null
python3 - "$SETTLE_JSON" << 'PY'
import json, sys
data = json.loads(sys.argv[1])
status = data.get("bundle", {}).get("status")
tx = data.get("txHash")
if data.get("status") != "complete" or status != "confirmed" or not tx:
    raise SystemExit(f"escrow settle did not confirm: {data}")
print(f"bundle {data['bundle']['id']} status {status} tx {tx}")
PY
SETTLE_TX="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["txHash"])' <<<"$SETTLE_JSON")"

FINAL_OUT="$(
  cd "$ROOT/packages/wallet"
  run_out bun ./src/cli.ts escrow status "$ESCROW_ID" --env dev
)"
printf '%s\n' "$FINAL_OUT" | tee "$WORKDIR/escrow-status-final.txt" >/dev/null
AFTER_SELLER="$(balance_of "$SELLER")"
python3 - "$FINAL_OUT" "$BEFORE_SELLER" "$AFTER_SELLER" "$SETTLE_TX" "$CREATE_BUNDLE_TX" << 'PY'
import re, sys
text, before_s, after_s, settle_tx, create_tx = sys.argv[1:]
match = re.search(r"(?m)^status:\s*(\S+)", text)
if not match:
    raise SystemExit(f"escrow status output missing status field:\n{text}")
status = match.group(1)
before_i, after_i = int(before_s), int(after_s)
if status != "finalized":
    raise SystemExit(f"escrow status {status}, expected finalized")
if after_i != before_i + 1_000_000:
    raise SystemExit(f"seller balance {before_i} -> {after_i}, expected +1000000")
print(
    f"ASSERT escrow status {status} tx {settle_tx}; seller USDC {before_i} -> {after_i}; create tx {create_tx}"
)
PY

echo "PASS local escrow"
echo "artifacts: $WORKDIR"
