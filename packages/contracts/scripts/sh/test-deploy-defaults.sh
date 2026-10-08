#!/usr/bin/env bash
# deploy.sh default checks: secrets are not printed, the owner is a separate
# address outside local, stage and prod use separate chains, and a zero
# LayerZero signer is refused. forge, cast, and the size check are stubs, so
# nothing here reaches a chain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PK="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
PASSWORD="hunter2-keystore-password"
OWNER="0x00000000000000000000000000000000000A11CE"
HOT="0x000000000000000000000000000000000000B0B0"
LZ_ENDPOINT="0x1a44076050125825900e736c501f859c50fE728c"
ZERO="0x0000000000000000000000000000000000000000"

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

TMP=""

setup_sandbox() {
    TMP="$(mktemp -d)"
    mkdir -p "$TMP/bin" "$TMP/scripts/sh" "$TMP/scripts/sol/common/bytecodes" "$TMP/deployments"
    cp "$SCRIPT_DIR/deploy.sh" "$TMP/scripts/sh/deploy.sh"
    chmod +x "$TMP/scripts/sh/deploy.sh"
    printf '#!/bin/sh\nexit 0\n' >"$TMP/scripts/sh/check-runtime-size.sh"
    chmod +x "$TMP/scripts/sh/check-runtime-size.sh"
    echo 0x00 >"$TMP/scripts/sol/common/bytecodes/multicall3.txt"
    echo 0x00 >"$TMP/scripts/sol/common/bytecodes/usdc.txt"
    cat >"$TMP/bin/forge" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >> "$TMP/forge.log"
echo END >> "$TMP/forge.log"
exit 0
EOF
    printf '#!/bin/sh\nexit 0\n' >"$TMP/bin/cast"
    chmod +x "$TMP/bin/forge" "$TMP/bin/cast"
    : >"$TMP/forge.log"
}

# Runs deploy.sh in the sandbox with a clean OWNER/FUNDER environment.
run_deploy() {
    set +e
    env -u OWNER -u FUNDER -u STAGE_OWNER -u PROD_OWNER -u DEV_OWNER \
        PATH="$TMP/bin:$PATH" \
        "$TMP/scripts/sh/deploy.sh" "$@" >"$TMP/out" 2>&1
    CODE=$?
    set -e
}

forge_called() {
    grep -qx 'script' "$TMP/forge.log"
}

# Expects deploy.sh to exit non-zero before forge script, printing $1.
expect_refused() {
    local message="$1"
    shift
    setup_sandbox
    run_deploy "$@"
    if [[ "$CODE" -eq 0 ]]; then
        echo "deploy.sh exited 0 for: $*" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if forge_called; then
        echo "deploy.sh ran forge script for: $*" >&2
        rm -rf "$TMP"
        return 1
    fi
    if ! grep -qF -- "$message" "$TMP/out"; then
        echo "deploy.sh failed without '$message' (exit $CODE) for: $*" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    rm -rf "$TMP"
}

private_key_not_printed() {
    setup_sandbox
    run_deploy --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer \
        --owner "$OWNER" --private-key "$PK"
    if [[ "$CODE" -ne 0 ]]; then
        echo "deploy.sh failed (exit $CODE)" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if grep -qF -- "${PK#0x}" "$TMP/out"; then
        echo "deploy.sh printed the private key:" >&2
        grep -F -- "${PK#0x}" "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if ! grep -qxF -- "$PK" "$TMP/forge.log"; then
        echo "forge did not receive the private key" >&2
        rm -rf "$TMP"
        return 1
    fi
    rm -rf "$TMP"
}

password_not_printed() {
    setup_sandbox
    run_deploy --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer \
        --owner "$OWNER" --account deployer --password "$PASSWORD"
    if [[ "$CODE" -ne 0 ]]; then
        echo "deploy.sh failed (exit $CODE)" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if grep -qF -- "$PASSWORD" "$TMP/out"; then
        echo "deploy.sh printed the keystore password:" >&2
        grep -F -- "$PASSWORD" "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if ! grep -qxF -- "$PASSWORD" "$TMP/forge.log"; then
        echo "forge did not receive the keystore password" >&2
        rm -rf "$TMP"
        return 1
    fi
    rm -rf "$TMP"
}

owner_unset_refused() {
    expect_refused "owner is not set" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK"
}

owner_equal_to_funder_refused() {
    expect_refused "owner equals the funder" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK" \
        --owner "$HOT" --funder "${HOT,,}"
}

owner_equal_to_sender_refused() {
    expect_refused "owner equals the deployer" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK" \
        --owner "$HOT" --sender "${HOT,,}"
}

zero_lz_signer_refused() {
    expect_refused "LayerZero signer is the zero address" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK" \
        --owner "$OWNER" --lz-endpoint "$LZ_ENDPOINT" --lz-signer "$ZERO" || return 1
    expect_refused "LayerZero signer is the zero address" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK" \
        --owner "$OWNER" --lz-endpoint "$LZ_ENDPOINT" || return 1
    expect_refused "LayerZero signer is the zero address" \
        --chain 8453 --rpc http://127.0.0.1:1 --dry-run --skip-relayer --private-key "$PK" \
        --owner "$OWNER" --contracts LayerZeroSettler
}

# Expects `deploy.sh <env>` to pass [chain] to forge script.
expect_env_chain() {
    local env_name="$1" chain="$2"
    setup_sandbox
    run_deploy "$env_name" --rpc http://127.0.0.1:1 --dry-run --skip-relayer \
        --owner "$OWNER" --private-key "$PK"
    if [[ "$CODE" -ne 0 ]]; then
        echo "deploy.sh $env_name failed (exit $CODE)" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    if ! grep -qxF -- "[$chain]" "$TMP/forge.log"; then
        echo "deploy.sh $env_name did not deploy to chain $chain; forge got:" >&2
        grep -x -- '\[[0-9,]*\]' "$TMP/forge.log" >&2 || true
        rm -rf "$TMP"
        return 1
    fi
    rm -rf "$TMP"
}

stage_is_base_sepolia() { expect_env_chain stage 84532; }
prod_is_base() { expect_env_chain prod 8453; }

local_needs_no_owner() {
    setup_sandbox
    run_deploy --chain 31337 --rpc http://127.0.0.1:1 --dry-run --skip-relayer
    if [[ "$CODE" -ne 0 ]] || ! forge_called; then
        echo "local deploy without an owner did not reach forge script (exit $CODE)" >&2
        cat "$TMP/out" >&2
        rm -rf "$TMP"
        return 1
    fi
    rm -rf "$TMP"
}

if [[ "${1:-}" == "--only" ]]; then
    "$2"
    exit $?
fi

echo "deploy.sh default checks (packages/contracts)"
if private_key_not_printed; then pass "--private-key is not printed"; else fail "--private-key is not printed"; fi
if password_not_printed; then pass "--password is not printed"; else fail "--password is not printed"; fi
if owner_unset_refused; then pass "unset owner is refused outside local"; else fail "unset owner is refused outside local"; fi
if owner_equal_to_funder_refused; then pass "owner equal to funder is refused"; else fail "owner equal to funder is refused"; fi
if owner_equal_to_sender_refused; then pass "owner equal to deployer is refused"; else fail "owner equal to deployer is refused"; fi
if zero_lz_signer_refused; then pass "zero LayerZero signer is refused"; else fail "zero LayerZero signer is refused"; fi
if stage_is_base_sepolia; then pass "stage deploys to Base Sepolia 84532"; else fail "stage deploys to Base Sepolia 84532"; fi
if prod_is_base; then pass "prod deploys to Base 8453"; else fail "prod deploys to Base 8453"; fi
if local_needs_no_owner; then pass "local deploy needs no owner"; else fail "local deploy needs no owner"; fi

if [[ "$failures" -ne 0 ]]; then
    echo "$failures check(s) failed" >&2
    exit 1
fi
echo "All deploy.sh default checks passed."
