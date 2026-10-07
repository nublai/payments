#!/usr/bin/env bash
# One local agentic payment: Anvil -> contracts deploy:local -> wrangler relayer -> wallet CLI.
#
# Uses the repo's deploy and relayer scripts and the real `tw` CLI
# (`bun ./src/cli.ts`). Does not deploy a second protocol.
#
# Requires: anvil, cast, forge, bun, curl, python3, bc (fund-dev.sh), and Node >= 22
# on PATH. Wrangler refuses Node 20. If `node` is older and /tmp/node22/bin/node
# exists, that directory is prepended to PATH.
#
# Ports 8545, 8546, and 8787 must be free. The script stops the Anvil and relayer
# processes it starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.bun/bin:${PATH}"

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
  > /tmp/e2e-anvil-31337.log 2>&1 &
PIDS+=("$!")
anvil --port 8546 --chain-id 41337 \
  > /tmp/e2e-anvil-41337.log 2>&1 &
PIDS+=("$!")
wait_rpc http://127.0.0.1:8545
wait_rpc http://127.0.0.1:8546

echo "Deploying contracts (bun run deploy:local && bun run make-config)..."
(
  cd "$ROOT/packages/contracts"
  bun run deploy:local
  bun run make-config
)

# make-config strips local addresses out of addresses.json. The narrowed
# default session needs ESCROW_31337 and SIMPLE_SETTLER_31337 from this file.
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

echo "Building @nubl/relayer-client..."
(cd "$ROOT/packages/relayer-client" && bun run build)

WORKDIR="$(mktemp -d /tmp/agentic-payments-e2e.XXXXXX)"
KEYSTORE="$WORKDIR/account.json"
RECIPIENT="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export TW_PASSWORD="e2e-local-payment"

echo "Creating and delegating account..."
# account create installs the narrow default session and still requires the phrase.
# This script is the operator: it allocates a terminal and types the phrase.
CREATE_JSON="$(
  cd "$ROOT/packages/wallet"
  python3 "$ROOT/scripts/tw-tty-confirm.py" "CREATE FULL ACCESS SESSION" \
    bun ./src/cli.ts account create \
    --env dev \
    --keystore-path "$KEYSTORE" \
    --format json
)"
printf '%s\n' "$CREATE_JSON" | tee "$WORKDIR/account-create.json" >/dev/null
DELEGATED="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["addresses"]["delegated"])' <<<"$CREATE_JSON")"
CREATE_TX="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["txHash"])' <<<"$CREATE_JSON")"
echo "Delegated $DELEGATED create tx $CREATE_TX"

echo "Minting MockUSDC..."
bash "$ROOT/packages/wallet/scripts/fund-dev.sh" "$DELEGATED" 25 >/dev/null

balance_of() {
  cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url http://127.0.0.1:8545 | awk '{print $1}'
}

BEFORE_SENDER="$(balance_of "$DELEGATED")"
BEFORE_RECIP="$(balance_of "$RECIPIENT")"

echo "Sending 1 USDC..."
# send requires a human to type SEND USDC on a TTY. MCP and a non-TTY tw cannot
# do that. This script is the operator: it allocates a terminal and types the phrase.
SEND_JSON="$(
  cd "$ROOT/packages/wallet"
  python3 "$ROOT/scripts/tw-tty-confirm.py" "SEND USDC" \
    bun ./src/cli.ts send 1 "$RECIPIENT" \
    --env dev \
    --keystore-path "$KEYSTORE" \
    --format json
)"
printf '%s\n' "$SEND_JSON" | tee "$WORKDIR/send.json" >/dev/null
python3 - "$SEND_JSON" << 'PY'
import json, sys
data = json.loads(sys.argv[1])
status = data.get("bundle", {}).get("status")
tx = data.get("txHash")
if status != "confirmed" or not tx:
    raise SystemExit(f"send did not confirm: {data}")
print(f"bundle {data['bundle']['id']} status {status} tx {tx}")
PY

AFTER_SENDER="$(balance_of "$DELEGATED")"
AFTER_RECIP="$(balance_of "$RECIPIENT")"
python3 - "$BEFORE_SENDER" "$AFTER_SENDER" "$BEFORE_RECIP" "$AFTER_RECIP" << 'PY'
import sys
before_s, after_s, before_r, after_r = (int(x) for x in sys.argv[1:])
if after_s != before_s - 1_000_000:
    raise SystemExit(f"sender balance {before_s} -> {after_s}, expected -1000000")
if after_r != before_r + 1_000_000:
    raise SystemExit(f"recipient balance {before_r} -> {after_r}, expected +1000000")
print(f"USDC sender {before_s} -> {after_s}; recipient {before_r} -> {after_r}")
PY

echo "PASS local agentic payment"
echo "artifacts: $WORKDIR"
