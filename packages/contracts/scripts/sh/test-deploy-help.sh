#!/usr/bin/env bash
# deploy.sh --help prints the environment shortcuts as literal text and exits 0.
# The keystore password is prompted; help must not show it on argv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

out="$(mktemp)"
set +e
"$SCRIPT_DIR/deploy.sh" --help >"$out" 2>&1
code=$?
set -e

if [[ "$code" -eq 0 ]]; then
    pass "deploy.sh --help exits 0"
else
    fail "deploy.sh --help exits 0 (got $code)"
fi

if grep -qF 'context `dev`' "$out" && grep -qF 'context `stage`' "$out"; then
    pass "help contains literal dev and stage context text"
else
    fail "help contains literal dev and stage context text"
fi

if grep -qF -- '--password' "$out"; then
    fail "help does not contain --password"
else
    pass "help does not contain --password"
fi

if [[ "$failures" -ne 0 ]]; then
    echo "deploy.sh --help output:" >&2
    cat "$out" >&2
    rm -f "$out"
    exit 1
fi
rm -f "$out"
