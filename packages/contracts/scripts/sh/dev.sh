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

wait_for_port() {
    local port="$1"
    local deadline=$((SECONDS + 30))
    while ! nc -z localhost "$port" 2>/dev/null; do
        if (( SECONDS >= deadline )); then
            echo "timed out waiting for port $port" >&2
            exit 1
        fi
        sleep 0.1
    done
}

if ! command -v nc >/dev/null 2>&1; then
    echo "nc is not on PATH" >&2
    exit 1
fi

start_or_reuse_anvil 8545 --port 8545 --chain-id 31337 --block-time 2 --base-fee 1000000000
start_or_reuse_anvil 8546 --port 8546 --chain-id 41337

wait_for_port 8545
wait_for_port 8546

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
