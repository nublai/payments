#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PIDS=()

cleanup() {
    trap - EXIT INT TERM
    # Reuse mode may not start any child processes.
    set +e
    set +u
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
}

handle_shutdown() {
    cleanup
    exit 0
}

trap cleanup EXIT
trap handle_shutdown INT TERM

start_or_reuse_anvil() {
    local port="$1"
    shift

    if nc -z localhost "$port" 2>/dev/null; then
        echo "Reusing existing RPC on port $port"
        return
    fi

    anvil "$@" &
    PIDS+=("$!")
}

start_or_reuse_anvil 8545 --port 8545 --chain-id 31337 --block-time 2 --base-fee 1000000000
start_or_reuse_anvil 8546 --port 8546 --chain-id 41337

while ! nc -z localhost 8545 2>/dev/null; do sleep 0.1; done
while ! nc -z localhost 8546 2>/dev/null; do sleep 0.1; done

bun deploy:local
bun make-config

if ((${#PIDS[@]} > 0)); then
    wait
else
    echo "Using existing Anvil processes. Press Ctrl+C to stop this script."
    while nc -z localhost 8545 2>/dev/null && nc -z localhost 8546 2>/dev/null; do
        sleep 2
    done
fi
