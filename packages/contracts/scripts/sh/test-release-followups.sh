#!/usr/bin/env bash
# Checks for the release-profile follow-ups. Each one fails on 0e58142 and passes after.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
REPO_ROOT="$(dirname "$(dirname "$PROJECT_ROOT")")"
cd "$PROJECT_ROOT"

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

# 1. A release-profile Orchestrator artifact planted at out/Account.sol/Account.json
# must be rejected. A stub forge prints a cache hit so the planted file is not rewritten.
substitution_rejected() {
    local tmp bin
    tmp="$(mktemp -d)"
    bin="$tmp/bin"
    mkdir -p "$bin" "$tmp/scripts/sh" "$tmp/out/Account.sol"
    cp "$SCRIPT_DIR/check-runtime-size.sh" "$tmp/scripts/sh/check-runtime-size.sh"
    chmod +x "$tmp/scripts/sh/check-runtime-size.sh"
    cat >"$bin/forge" <<'EOF'
#!/bin/sh
echo "No files changed, compilation skipped"
exit 0
EOF
    chmod +x "$bin/forge"
    python3 - "$tmp/out" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
names = [
    "Account",
    "Orchestrator",
    "Simulator",
    "Escrow",
    "MultiSigSigner",
    "SimpleFunder",
    "SimpleSettler",
    "LayerZeroSettler",
]
for name in names:
    # Account's file is a release Orchestrator artifact. The other files match their names.
    target_name = "Orchestrator" if name == "Account" else name
    target_source = f"src/accounts/{target_name}.sol"
    directory = out / f"{name}.sol"
    directory.mkdir(parents=True, exist_ok=True)
    artifact = {
        "metadata": json.dumps({
            "settings": {
                "viaIR": True,
                "optimizer": {"runs": 200},
                "compilationTarget": {target_source: target_name},
            }
        }),
        "bytecode": {"object": "0x60"},
        "deployedBytecode": {"object": "0x60", "linkReferences": {}},
    }
    (directory / f"{name}.json").write_text(json.dumps(artifact))
PY
    local out err code
    out="$tmp/stdout.txt"
    err="$tmp/stderr.txt"
    set +e
    PATH="$bin:$PATH" "$tmp/scripts/sh/check-runtime-size.sh" >"$out" 2>"$err"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "checker accepted substituted artifact" >&2
        echo "stdout:" >&2
        cat "$out" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! grep -q "compilationTarget" "$err"; then
        echo "checker failed without a compilationTarget error (exit $code)" >&2
        cat "$err" >&2
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
}

# 2. Forge CI runs the release profile suite in addition to the default suite.
release_tests_in_ci() {
    grep -q 'FOUNDRY_PROFILE=release forge test --ffi' "$REPO_ROOT/.github/workflows/forge.yml"
}

# 3. build:contracts and generate run the same size check.
package_scripts_run_check() {
    python3 - <<'PY'
import json
import pathlib
import sys
pkg = json.loads(pathlib.Path("package.json").read_text())
missing = [
    name
    for name in ("build:contracts", "generate")
    if "check-runtime-size.sh" not in pkg["scripts"][name]
]
if missing:
    print("scripts do not run check-runtime-size.sh: " + ", ".join(missing), file=sys.stderr)
    sys.exit(1)
PY
}

# 4. deploy.sh refuses a symlink planted under deployments/.
symlink_refused() {
    local link="$PROJECT_ROOT/deployments/__symlink_probe"
    rm -f "$link"
    ln -s /tmp "$link"
    local out code
    out="$(mktemp)"
    set +e
    timeout 20 ./scripts/sh/deploy.sh local --dry-run >"$out" 2>&1
    code=$?
    set -e
    rm -f "$link"
    if ! grep -q "refusing symlink" "$out"; then
        echo "deploy.sh did not refuse the symlink (exit $code)" >&2
        sed -n '1,40p' "$out" >&2
        rm -f "$out"
        return 1
    fi
    if [[ "$code" -eq 0 ]]; then
        echo "deploy.sh exited 0 with a symlink present" >&2
        rm -f "$out"
        return 1
    fi
    rm -f "$out"
}

# 5. Deployment docs record the release-profile salt-0 CREATE2 addresses.
release_addresses_documented() {
    local doc addr
    local -a addrs=(
        0x13122A1dc74D0adc144c904e963d7d58BBe0E5f9
        0x1DdE1F548A0b0a676D325B2633eA3E5F5E7C52c8
        0xE6CfdB399efdc88FA11964072AB519c65c044130
        0x58915cA306aF01724EC5d9AfE75a1Ce4C8dc4A08
    )
    for doc in "$PROJECT_ROOT/README.md" "$PROJECT_ROOT/scripts/README.md"; do
        for addr in "${addrs[@]}"; do
            if ! grep -q "$addr" "$doc"; then
                echo "missing $addr in $doc" >&2
                return 1
            fi
        done
        if ! grep -q "published default-profile addresses will not match" "$doc"; then
            echo "missing published-address warning in $doc" >&2
            return 1
        fi
    done
}

if [[ "${1:-}" == "--only" ]]; then
    "$2"
    exit $?
fi

echo "Release follow-up checks (packages/contracts)"
if substitution_rejected; then pass "substituted artifact rejected"; else fail "substituted artifact rejected"; fi
if release_tests_in_ci; then pass "CI runs release forge test"; else fail "CI runs release forge test"; fi
if package_scripts_run_check; then pass "build:contracts and generate run the size check"; else fail "build:contracts and generate run the size check"; fi
if symlink_refused; then pass "deploy.sh refuses a symlink"; else fail "deploy.sh refuses a symlink"; fi
if release_addresses_documented; then pass "docs list release CREATE2 addresses"; else fail "docs list release CREATE2 addresses"; fi

if [[ "$failures" -ne 0 ]]; then
    echo "$failures check(s) failed" >&2
    exit 1
fi
echo "All release follow-up checks passed."
