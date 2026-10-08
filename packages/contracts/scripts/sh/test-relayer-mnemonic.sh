#!/usr/bin/env bash
# deploy.sh must refuse the public test mnemonic outside local Anvil, and
# .env.example must not ship it. deploy.sh runs from a temp copy with stub
# forge, cast, and size check, so nothing builds, simulates, or broadcasts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

TEST_MNEMONIC="test test test test test test test test test test test junk"

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/scripts/sh" "$tmp/scripts/sol/common/bytecodes"
cp "$SCRIPT_DIR/deploy.sh" "$tmp/scripts/sh/deploy.sh"
touch "$tmp/scripts/sol/common/bytecodes/multicall3.txt" "$tmp/scripts/sol/common/bytecodes/usdc.txt"
cat >"$tmp/scripts/sh/check-runtime-size.sh" <<EOF
#!/bin/sh
echo size-check >>"$tmp/calls"
EOF
cat >"$tmp/bin/cast" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$tmp/bin/forge" <<EOF
#!/bin/sh
echo "forge \$1 \$7 mnemonic=\$RELAYER_MNEMONIC" >>"$tmp/calls"
exit 1
EOF
chmod +x "$tmp/scripts/sh/deploy.sh" "$tmp/scripts/sh/check-runtime-size.sh" "$tmp/bin/cast" "$tmp/bin/forge"

# run_deploy <NAME=VALUE or -> <deploy.sh args...>. Output goes to $tmp/out, calls to $tmp/calls.
run_deploy() {
    local assign="$1"
    shift
    local -a extra=()
    [[ "$assign" != "-" ]] && extra=("$assign")
    rm -f "$tmp/calls"
    local code=0
    env -u RELAYER_MNEMONIC -u DEV_RELAYER_MNEMONIC -u STAGE_RELAYER_MNEMONIC -u PROD_RELAYER_MNEMONIC \
        PATH="$tmp/bin:$PATH" "${extra[@]}" "$tmp/scripts/sh/deploy.sh" "$@" >"$tmp/out" 2>&1 || code=$?
    touch "$tmp/calls"
    return "$code"
}

# Non-local target with the test mnemonic: nonzero exit, refusal message, and no size check or forge call.
expect_refused() {
    local name="$1"
    shift
    if run_deploy "$@"; then
        fail "$name: deploy.sh exited 0"
        cat "$tmp/out" >&2
        return
    fi
    if ! grep -q "refusing the public test mnemonic" "$tmp/out" || [[ -s "$tmp/calls" ]]; then
        fail "$name: not refused before the build"
        tail -n 3 "$tmp/out" | sed 's/^/  out: /' >&2
        sed 's/^/  calls: /' "$tmp/calls" >&2
        return
    fi
    pass "$name"
}

expect_refused "dev with --relayer-mnemonic test mnemonic is refused" \
    - dev --relayer-mnemonic "$TEST_MNEMONIC" --private-key 0x01 --dry-run
expect_refused "dev with DEV_RELAYER_MNEMONIC test mnemonic is refused" \
    DEV_RELAYER_MNEMONIC="$TEST_MNEMONIC" dev --private-key 0x01 --dry-run
expect_refused "--chain 8453 with test mnemonic is refused" \
    - --chain 8453 --rpc http://127.0.0.1:1 --relayer-mnemonic "$TEST_MNEMONIC" --private-key 0x01 --dry-run
expect_refused "--chain 31337,84532 with test mnemonic is refused" \
    - --chain 31337,84532 --relayer-mnemonic "$TEST_MNEMONIC" --dry-run

# deploy.sh local must still pass the test mnemonic to forge script for the local e2e flows.
run_deploy - local --dry-run || true
if grep -q "forge script \[31337\] mnemonic=$TEST_MNEMONIC" "$tmp/calls"; then
    pass "local deploy still uses the test mnemonic"
else
    fail "local deploy still uses the test mnemonic"
    tail -n 3 "$tmp/out" | sed 's/^/  out: /' >&2
    sed 's/^/  calls: /' "$tmp/calls" >&2
fi

# A non-local deploy with no mnemonic must not pick up the test mnemonic as a default.
run_deploy - dev --private-key 0x01 --dry-run || true
if grep -q "forge script \[84532\] mnemonic=$" "$tmp/calls"; then
    pass "dev deploy has no default mnemonic"
else
    fail "dev deploy has no default mnemonic"
    tail -n 3 "$tmp/out" | sed 's/^/  out: /' >&2
    sed 's/^/  calls: /' "$tmp/calls" >&2
fi

if grep -q "$TEST_MNEMONIC" "$PROJECT_ROOT/.env.example"; then
    fail ".env.example does not contain the test mnemonic"
    grep -n "$TEST_MNEMONIC" "$PROJECT_ROOT/.env.example" >&2
else
    pass ".env.example does not contain the test mnemonic"
fi

if [[ "$failures" -ne 0 ]]; then
    echo "$failures check(s) failed" >&2
    exit 1
fi
echo "All relayer mnemonic checks passed."
