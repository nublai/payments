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

# 2. Forge CI builds and tests with the release profile only.
release_tests_in_ci() {
    local workflow="$REPO_ROOT/.github/workflows/forge.yml"
    grep -q 'FOUNDRY_PROFILE=release forge test --ffi' "$workflow" || return 1
    if grep -q 'bun run --cwd packages/contracts test' "$workflow"; then
        echo "forge CI still runs the default-profile test script" >&2
        return 1
    fi
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
        if ! grep -q "have never been deployed" "$doc"; then
            echo "missing never-deployed note in $doc" >&2
            return 1
        fi
        if ! grep -q "inherited from the Towns deployment and are not ours" "$doc"; then
            echo "missing inherited-address note in $doc" >&2
            return 1
        fi
        if ! grep -q "replace every address in \`addresses.json\` and \`envs/\*.json\`" "$doc"; then
            echo "missing same-change address replacement note in $doc" >&2
            return 1
        fi
        if ! grep -q "on-chain code hash matches the release artifact" "$doc"; then
            echo "missing on-chain code-hash note in $doc" >&2
            return 1
        fi
    done
}

CHECK_SCRIPT="${RELEASE_CHECK_SCRIPT:-$SCRIPT_DIR/check-runtime-size.sh}"
DEPLOY_SCRIPT="${RELEASE_DEPLOY_SCRIPT:-$SCRIPT_DIR/deploy.sh}"

# Release-shaped artifact. Extra settings are what the checker must require.
write_release_artifacts() {
    python3 - "$@" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
# optional name=field mutations: appendCBOR=true enabled=false evm=cancun bytecode=0x61
mutations = {}
for arg in sys.argv[2:]:
    name, spec = arg.split("=", 1)
    mutations[name] = spec
names = ["Account","Orchestrator","Simulator","Escrow","MultiSigSigner","SimpleFunder","SimpleSettler","LayerZeroSettler"]
for name in names:
    spec = mutations.get(name, "")
    bytecode = "0x61" if spec == "bytecode" else "0x60"
    settings = {
        "viaIR": True,
        "optimizer": {"enabled": False if spec == "enabled" else True, "runs": 200},
        "metadata": {
            "bytecodeHash": "none",
            "appendCBOR": True if spec == "appendCBOR" else False,
        },
        "compilationTarget": {f"src/accounts/{name}.sol": name},
        "evmVersion": "cancun" if spec == "evm" else "prague",
    }
    directory = out / f"{name}.sol"
    directory.mkdir(parents=True, exist_ok=True)
    artifact = {
        "metadata": json.dumps({"settings": settings}),
        "bytecode": {"object": bytecode},
        "deployedBytecode": {"object": bytecode, "linkReferences": {}},
    }
    (directory / f"{name}.json").write_text(json.dumps(artifact))
PY
}

artifact_hashes() {
    python3 - "$@" <<'PY'
import hashlib, json, sys
from pathlib import Path
out = Path(sys.argv[1])
names = ["Account","Orchestrator","Simulator","Escrow","MultiSigSigner","SimpleFunder","SimpleSettler","LayerZeroSettler"]
stamp = {}
for name in names:
    artifact = json.loads((out / f"{name}.sol" / f"{name}.json").read_text())
    bytecode = artifact.get("bytecode") or {}
    deployed = artifact.get("deployedBytecode") or {}
    payload = json.dumps({
        "bytecode": bytecode.get("object") if isinstance(bytecode, dict) else bytecode,
        "deployedBytecode": deployed.get("object") if isinstance(deployed, dict) else deployed,
    }, sort_keys=True)
    stamp[name] = hashlib.sha256(payload.encode()).hexdigest()
json.dump(stamp, sys.stdout, indent=2)
print()
PY
}

install_forge_stub() {
    local bin="$1" log="$2" message="$3"
    mkdir -p "$bin"
    cat >"$bin/forge" <<EOF
#!/bin/sh
{
  echo CALL
  printf '%s\n' "\$@"
  echo ENV
  env | grep -E '^(FOUNDRY_|DAPP_)' | sort
  echo END
} >> "$log"
echo "$message"
exit 0
EOF
    chmod +x "$bin/forge"
}

copy_scripts() {
    local tmp="$1"
    mkdir -p "$tmp/scripts/sh" "$tmp/deployments" "$tmp/cache" "$tmp/out"
    cp "$CHECK_SCRIPT" "$tmp/scripts/sh/check-runtime-size.sh"
    cp "$DEPLOY_SCRIPT" "$tmp/scripts/sh/deploy.sh"
    chmod +x "$tmp/scripts/sh/check-runtime-size.sh" "$tmp/scripts/sh/deploy.sh"
}

# 1. Inherited FOUNDRY_* and DAPP_* must not reach forge.
foundry_env_unset() {
    local tmp log
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    copy_scripts "$tmp"
    install_forge_stub "$tmp/bin" "$log" "No files changed, compilation skipped"
    write_release_artifacts "$tmp/out"
    artifact_hashes "$tmp/out" >"$tmp/cache/release-artifact-sha256.json"
    local code
    set +e
    PATH="$tmp/bin:$PATH" \
        FOUNDRY_PROFILE=default \
        FOUNDRY_CBOR_METADATA=true \
        FOUNDRY_VIA_IR=false \
        FOUNDRY_OPTIMIZER=false \
        FOUNDRY_OPTIMIZER_RUNS=500 \
        FOUNDRY_EVM_VERSION=cancun \
        FOUNDRY_OUT=/tmp/out-redirect \
        FOUNDRY_CACHE_PATH=/tmp/cache-redirect \
        DAPP_VIA_IR=false \
        DAPP_OPTIMIZER_RUNS=500 \
        "$tmp/scripts/sh/check-runtime-size.sh" >"$tmp/check.out" 2>"$tmp/check.err"
    code=$?
    set -e
    if [[ "$code" -ne 0 ]]; then
        echo "size check failed while proving env unset (exit $code)" >&2
        cat "$tmp/check.err" >&2
        rm -rf "$tmp"
        return 1
    fi
    if grep -E '^(FOUNDRY_CBOR_METADATA|FOUNDRY_VIA_IR|FOUNDRY_OPTIMIZER|FOUNDRY_OPTIMIZER_RUNS|FOUNDRY_EVM_VERSION|FOUNDRY_OUT|FOUNDRY_CACHE_PATH|DAPP_)' "$log" >/dev/null; then
        echo "forge inherited a FOUNDRY_* or DAPP_* override" >&2
        cat "$log" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! grep -q '^FOUNDRY_PROFILE=release$' "$log"; then
        echo "forge did not see FOUNDRY_PROFILE=release" >&2
        cat "$log" >&2
        rm -rf "$tmp"
        return 1
    fi
    # deploy.sh must clear the same variables before forge script.
    : >"$log"
    set +e
    PATH="$tmp/bin:$PATH" \
        FOUNDRY_CBOR_METADATA=true \
        FOUNDRY_OUT=/tmp/out-redirect \
        DAPP_OPTIMIZER_RUNS=500 \
        "$tmp/scripts/sh/deploy.sh" \
        --chain 8453 --dry-run --skip-relayer \
        --rpc http://127.0.0.1:1 \
        --private-key 0xabc >"$tmp/deploy.out" 2>"$tmp/deploy.err"
    code=$?
    set -e
    if [[ "$code" -ne 0 ]]; then
        echo "deploy.sh failed while proving env unset (exit $code)" >&2
        cat "$tmp/deploy.err" >&2
        rm -rf "$tmp"
        return 1
    fi
    if grep -E '^(FOUNDRY_CBOR_METADATA|FOUNDRY_OUT|DAPP_)' "$log" >/dev/null; then
        echo "deploy.sh forge inherited a FOUNDRY_* or DAPP_* override" >&2
        cat "$log" >&2
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
}

# 2. A bytecode swap is rejected without a cache-hit log line and without a matching stamp.
artifact_hash_required() {
    local tmp log code
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    copy_scripts "$tmp"
    # No stamp. Cache-hit log. Files are not rewritten.
    install_forge_stub "$tmp/bin" "$log" "No files changed, compilation skipped"
    write_release_artifacts "$tmp/out"
    set +e
    PATH="$tmp/bin:$PATH" "$tmp/scripts/sh/check-runtime-size.sh" >"$tmp/out.txt" 2>"$tmp/err.txt"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "checker accepted artifacts with no release stamp" >&2
        cat "$tmp/out.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! grep -q "release stamp" "$tmp/err.txt"; then
        echo "missing-stamp failure did not mention the release stamp (exit $code)" >&2
        cat "$tmp/err.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    # Stamp records the honest hash. The file is then flipped. The build log is
    # a fresh compile, and FOUNDRY_OUT points elsewhere so a redirected build
    # would not rewrite ./out.
    rm -rf "$tmp"
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    copy_scripts "$tmp"
    install_forge_stub "$tmp/bin" "$log" "Compiling 148 files with Solc 0.8.33"
    write_release_artifacts "$tmp/out"
    artifact_hashes "$tmp/out" >"$tmp/cache/release-artifact-sha256.json"
    local honest
    honest="$(cat "$tmp/cache/release-artifact-sha256.json")"
    write_release_artifacts "$tmp/out" Account=bytecode
    set +e
    PATH="$tmp/bin:$PATH" \
        FOUNDRY_OUT=/tmp/out-redirect \
        FOUNDRY_CACHE_PATH=/tmp/cache-redirect \
        "$tmp/scripts/sh/check-runtime-size.sh" >"$tmp/out.txt" 2>"$tmp/err.txt"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "checker accepted flipped bytecode when the log was not a cache hit" >&2
        cat "$tmp/out.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! grep -q "artifact hash" "$tmp/err.txt"; then
        echo "flipped bytecode failed without an artifact hash error (exit $code)" >&2
        cat "$tmp/err.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! cmp -s <(printf '%s\n' "$honest") "$tmp/cache/release-artifact-sha256.json"; then
        echo "checker replaced the release stamp with the flipped artifact hash" >&2
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
}

# 3. Values with spaces or command substitutions stay one argument.
quoted_forge_argv() {
    local tmp log marker code
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    marker="$tmp/evaluated"
    copy_scripts "$tmp"
    install_forge_stub "$tmp/bin" "$log" "No files changed, compilation skipped"
    write_release_artifacts "$tmp/out"
    artifact_hashes "$tmp/out" >"$tmp/cache/release-artifact-sha256.json"
    set +e
    PATH="$tmp/bin:$PATH" \
        "$tmp/scripts/sh/deploy.sh" \
        --chain 8453 --dry-run --skip-relayer \
        --rpc 'http://127.0.0.1:1 --optimize false' \
        --private-key "0xabc;\$(touch $marker) --optimizer-runs 1" \
        --sender '0x1111111111111111111111111111111111111111 --via-ir' \
        --contracts 'Escrow --evm-version cancun' \
        >"$tmp/deploy.out" 2>"$tmp/deploy.err"
    code=$?
    set -e
    if [[ -e "$marker" ]]; then
        echo "deploy.sh evaluated a command substitution in an argument (exit $code)" >&2
        cat "$log" >&2
        rm -rf "$tmp"
        return 1
    fi
    if [[ "$code" -ne 0 ]]; then
        echo "deploy.sh rejected a quoted argument (exit $code)" >&2
        cat "$tmp/deploy.err" >&2
        rm -rf "$tmp"
        return 1
    fi
    python3 - "$log" <<'PY'
import sys
text = open(sys.argv[1]).read().splitlines()
calls = []
mode = None
current = None
for line in text:
    if line == "CALL":
        current = {"args": [], "env": []}
        mode = "args"
    elif line == "ENV":
        mode = "env"
    elif line == "END":
        calls.append(current)
        mode = None
    elif mode == "args":
        current["args"].append(line)
    elif mode == "env":
        current["env"].append(line)
script_calls = [c for c in calls if "script" in c["args"]]
if not script_calls:
    sys.exit("forge script was not invoked")
args = script_calls[-1]["args"]
forbidden = {"--optimize", "--optimizer-runs", "--via-ir", "--evm-version", "--out", "-o", "-C", "--contracts"}
found = [arg for arg in args if arg in forbidden or arg.startswith("--optimize=") or arg.startswith("--evm-version=")]
if found:
    sys.exit("forge received bytecode flags as their own arguments: " + " ".join(found))
blob = "\n".join(args)
if "$(touch" not in blob:
    sys.exit("command substitution text was not preserved as data")
if " --optimize false" not in blob:
    sys.exit("rpc value was split on a space")
if "--via-ir" in args:
    sys.exit("--via-ir was split out of --sender")
PY
    rm -rf "$tmp"
}

# 3b. A bytecode-changing forge flag is refused after the size check.
bytecode_flags_refused() {
    local tmp log code
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    copy_scripts "$tmp"
    install_forge_stub "$tmp/bin" "$log" "No files changed, compilation skipped"
    write_release_artifacts "$tmp/out"
    artifact_hashes "$tmp/out" >"$tmp/cache/release-artifact-sha256.json"
    set +e
    PATH="$tmp/bin:$PATH" \
        "$tmp/scripts/sh/deploy.sh" \
        --chain 8453 --dry-run --skip-relayer \
        --rpc http://127.0.0.1:1 \
        --private-key --optimize \
        >"$tmp/deploy.out" 2>"$tmp/deploy.err"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "deploy.sh accepted a forge --optimize argument" >&2
        cat "$log" >&2
        rm -rf "$tmp"
        return 1
    fi
    if ! grep -q "refusing forge flag" "$tmp/deploy.err"; then
        echo "deploy.sh failed without refusing the forge flag (exit $code)" >&2
        cat "$tmp/deploy.err" >&2
        rm -rf "$tmp"
        return 1
    fi
    if grep -qx -- '--optimize' "$log"; then
        echo "forge script was invoked with --optimize" >&2
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
}

# 4. appendCBOR, optimizer.enabled, and evmVersion must match the release profile.
metadata_fields_required() {
    local tmp log code
    tmp="$(mktemp -d)"
    log="$tmp/forge.log"
    copy_scripts "$tmp"
    install_forge_stub "$tmp/bin" "$log" "No files changed, compilation skipped"
    write_release_artifacts "$tmp/out" Account=appendCBOR Orchestrator=enabled Simulator=evm
    artifact_hashes "$tmp/out" >"$tmp/cache/release-artifact-sha256.json"
    set +e
    PATH="$tmp/bin:$PATH" "$tmp/scripts/sh/check-runtime-size.sh" >"$tmp/out.txt" 2>"$tmp/err.txt"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "checker accepted non-release metadata" >&2
        cat "$tmp/out.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    local missing=0
    if ! grep -q "appendCBOR" "$tmp/err.txt"; then
        echo "expected appendCBOR mismatch" >&2
        missing=1
    fi
    if ! grep -q "optimizer.enabled" "$tmp/err.txt"; then
        echo "expected optimizer.enabled mismatch" >&2
        missing=1
    fi
    if ! grep -q "evmVersion" "$tmp/err.txt"; then
        echo "expected evmVersion mismatch" >&2
        missing=1
    fi
    if [[ "$missing" -ne 0 ]]; then
        cat "$tmp/err.txt" >&2
        rm -rf "$tmp"
        return 1
    fi
    rm -rf "$tmp"
}

# Masked runtime compare. A raw equality false-fails Solady EIP-712 chain id.
immutable_spans_are_masked() {
    python3 - <<'PY'
import json
import pathlib
import subprocess
import sys

helper = "scripts/sh/match-release-runtime.py"
artifact_path = pathlib.Path("out/Orchestrator.sol/Orchestrator.json")
artifact = json.loads(artifact_path.read_text())
deployed = artifact["deployedBytecode"]
raw = deployed["object"]
body = raw[2:] if raw.startswith("0x") else raw
refs = deployed.get("immutableReferences") or {}
spans = [(int(span["start"]), int(span["length"])) for group in refs.values() for span in group]
if not spans:
    sys.exit("Orchestrator artifact has no immutable spans to mask")

def run(code: str) -> str:
    return subprocess.check_output(["python3", helper, str(artifact_path), code], text=True)

start, _length = spans[0]
buf = bytearray.fromhex(body)
buf[start] ^= 0xFF
if run("0x" + buf.hex()) != "match":
    sys.exit("immutable byte change was not masked")
outside = next(i for i in range(len(buf)) if not any(s <= i < s + n for s, n in spans))
buf = bytearray.fromhex(body)
buf[outside] ^= 0xFF
if run("0x" + buf.hex()) != "mismatch":
    sys.exit("non-immutable byte change was ignored")
if run("0x") != "mismatch":
    sys.exit("empty code matched")
PY
}

# Red's resume PoC. On 3d56401, forge --resume rebroadcasts stored MultiSigSigner
# initcode (codesize 2614). deploy.sh must refuse before that broadcast.
resume_rebroadcast_refused() {
    local port=18545
    local rpc="http://127.0.0.1:${port}"
    local signer="0x1DdE1F548A0b0a676D325B2633eA3E5F5E7C52c8"
    local tmp pid code size
    tmp="$(mktemp -d)"
    anvil --port "$port" --chain-id 31337 --silent >"$tmp/anvil.log" 2>&1 &
    pid=$!
    cleanup_resume() {
        trap - RETURN
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        rm -rf \
            "$PROJECT_ROOT/broadcast/DeployUnified.s.sol/31337" \
            "$PROJECT_ROOT/cache/DeployUnified.s.sol/31337" \
            "$tmp"
    }
    trap cleanup_resume RETURN
    local ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if cast block-number --rpc-url "$rpc" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 0.25
    done
    if [[ "$ready" -ne 1 ]]; then
        echo "anvil did not start for the resume proof" >&2
        cat "$tmp/anvil.log" >&2
        return 1
    fi
    python3 - "$rpc" "$PROJECT_ROOT" <<'PY'
import json
import sys
from pathlib import Path
rpc, root = sys.argv[1], Path(sys.argv[2])
art = json.loads((root / "out/MultiSigSigner.sol/MultiSigSigner.json").read_text())
init = art["bytecode"]["object"]
if init.startswith("0x"):
    init = init[2:]
tx = {
    "hash": None,
    "transactionType": "CREATE2",
    "contractName": "Account",
    "contractAddress": "0x5D44479c3Fa8b08409dcabc57C75CaAd173202dA",
    "function": None,
    "arguments": None,
    "transaction": {
        "from": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "to": "0x4e59b44847b379578588920cA78FbF26c0B4956C",
        "gas": "0x1e8480",
        "value": "0x0",
        "input": "0x" + ("00" * 32) + init,
        "nonce": "0x0",
        "chainId": "0x7a69",
    },
    "additionalContracts": [],
    "isFixedGasLimit": True,
}
seq = {
    "transactions": [tx],
    "receipts": [],
    "libraries": [],
    "pending": [],
    "returns": {},
    "timestamp": 1,
    "chain": 31337,
    "commit": None,
}
broadcast = root / "broadcast/DeployUnified.s.sol/31337"
cache = root / "cache/DeployUnified.s.sol/31337"
broadcast.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
(broadcast / "run-latest.json").write_text(json.dumps(seq))
(cache / "run-latest.json").write_text(json.dumps({"transactions": [{"rpc": rpc}]}))
PY
    size="$(cast codesize "$signer" --rpc-url "$rpc")"
    if [[ "$size" != "0" ]]; then
        echo "MultiSigSigner was not empty before --resume (codesize $size)" >&2
        return 1
    fi
    set +e
    "$SCRIPT_DIR/deploy.sh" --chain 31337 --rpc "$rpc" --skip-relayer --resume \
        >"$tmp/out" 2>"$tmp/err"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "deploy.sh accepted --resume" >&2
        cat "$tmp/err" >&2
        return 1
    fi
    if ! grep -q "refusing --resume" "$tmp/err"; then
        echo "deploy.sh failed without refusing --resume (exit $code)" >&2
        cat "$tmp/err" >&2
        return 1
    fi
    size="$(cast codesize "$signer" --rpc-url "$rpc")"
    if [[ "$size" != "0" ]]; then
        echo "--resume rebroadcast stored initcode (MultiSigSigner codesize $size)" >&2
        return 1
    fi
}

# Red's selective-deploy PoC. A Towns orchestrator.json with no matching code
# must not be the Account constructor argument. Mismatched code at the CREATE2
# address must revert.
selective_json_must_match_release() {
    local port=18547
    local rpc="http://127.0.0.1:${port}"
    local pk="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    local orch="0xE6CfdB399efdc88FA11964072AB519c65c044130"
    local account="0x4343Bd720052fb353b8571b595a9AfC31Aae07B1"
    local towns="0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8"
    local wrong="0x77C054f302C2FeB1790588747991c81c1fF97F76"
    local dir="$PROJECT_ROOT/deployments/envs/prod/8453"
    local tmp pid code size deployed
    tmp="$(mktemp -d)"
    cp -a "$dir" "$tmp/8453"
    anvil --port "$port" --chain-id 8453 --silent >"$tmp/anvil.log" 2>&1 &
    pid=$!
    cleanup_selective() {
        trap - RETURN
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        rm -rf "$dir"
        mkdir -p "$dir"
        cp -a "$tmp/8453/." "$dir/"
        rm -rf \
            "$PROJECT_ROOT/broadcast/DeployUnified.s.sol/8453" \
            "$PROJECT_ROOT/cache/DeployUnified.s.sol/8453" \
            "$tmp"
    }
    trap cleanup_selective RETURN
    local ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if cast block-number --rpc-url "$rpc" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 0.25
    done
    if [[ "$ready" -ne 1 ]]; then
        echo "anvil did not start for the selective proof" >&2
        cat "$tmp/anvil.log" >&2
        return 1
    fi
    local multicall
    multicall="$(tr -d '[:space:]' < "$PROJECT_ROOT/scripts/sol/common/bytecodes/multicall3.txt")"
    cast rpc anvil_setCode "0xcA11bde05977b3631167028862bE2a173976CA11" "$multicall" --rpc-url "$rpc" >/dev/null
    python3 - "$dir" "$towns" <<'PY'
import json, sys
from pathlib import Path
path, towns = Path(sys.argv[1]), sys.argv[2]
(path / "orchestrator.json").write_text(json.dumps({"address": towns}) + "\n")
PY
    cast rpc anvil_setCode "$orch" "0x600160005260206000f3" --rpc-url "$rpc" >/dev/null
    set +e
    RPC_8453="$rpc" "$SCRIPT_DIR/deploy.sh" \
        --chain 8453 --rpc "$rpc" --context prod \
        --contracts Account --skip-relayer --private-key "$pk" \
        >"$tmp/mismatch.out" 2>"$tmp/mismatch.err"
    code=$?
    set -e
    if [[ "$code" -eq 0 ]]; then
        echo "selective deploy accepted mismatched CREATE2 Orchestrator code" >&2
        cat "$tmp/mismatch.out" >&2
        return 1
    fi
    if ! grep -q "at CREATE2 address does not match the release artifact" "$tmp/mismatch.out" "$tmp/mismatch.err"; then
        echo "selective deploy failed without the CREATE2 mismatch revert (exit $code)" >&2
        cat "$tmp/mismatch.err" >&2
        tail -40 "$tmp/mismatch.out" >&2
        return 1
    fi
    size="$(cast codesize "$wrong" --rpc-url "$rpc")"
    if [[ "$size" != "0" ]]; then
        echo "Towns orchestrator was used as the Account constructor (codesize $size at $wrong)" >&2
        return 1
    fi
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    anvil --port "$port" --chain-id 8453 --silent >"$tmp/anvil.log" 2>&1 &
    pid=$!
    ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if cast block-number --rpc-url "$rpc" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 0.25
    done
    if [[ "$ready" -ne 1 ]]; then
        echo "anvil did not restart for the selective proof" >&2
        return 1
    fi
    cast rpc anvil_setCode "0xcA11bde05977b3631167028862bE2a173976CA11" "$multicall" --rpc-url "$rpc" >/dev/null
    python3 - "$dir" "$towns" <<'PY'
import json, sys
from pathlib import Path
path, towns = Path(sys.argv[1]), sys.argv[2]
(path / "orchestrator.json").write_text(json.dumps({"address": towns}) + "\n")
PY
    set +e
    RPC_8453="$rpc" "$SCRIPT_DIR/deploy.sh" \
        --chain 8453 --rpc "$rpc" --context prod \
        --contracts Account --skip-relayer --private-key "$pk" \
        >"$tmp/deploy.out" 2>"$tmp/deploy.err"
    code=$?
    set -e
    if [[ "$code" -ne 0 ]]; then
        echo "selective deploy did not replace an unmatched JSON orchestrator (exit $code)" >&2
        cat "$tmp/deploy.err" >&2
        tail -50 "$tmp/deploy.out" >&2
        return 1
    fi
    if ! grep -q "Ignoring deployment file; on-chain code does not match the release artifact" "$tmp/deploy.out"; then
        echo "selective deploy did not ignore the Towns orchestrator file" >&2
        tail -50 "$tmp/deploy.out" >&2
        return 1
    fi
    if grep -q "Found existing (file): orchestrator" "$tmp/deploy.out"; then
        echo "selective deploy used the Towns orchestrator file" >&2
        return 1
    fi
    size="$(cast codesize "$wrong" --rpc-url "$rpc")"
    if [[ "$size" != "0" ]]; then
        echo "Account landed at the Towns-constructor address $wrong (codesize $size)" >&2
        return 1
    fi
    size="$(cast codesize "$account" --rpc-url "$rpc")"
    if [[ "$size" == "0" ]]; then
        echo "release Account was not deployed at $account" >&2
        return 1
    fi
    size="$(cast codesize "$orch" --rpc-url "$rpc")"
    if [[ "$size" == "0" ]]; then
        echo "release Orchestrator was not deployed at $orch" >&2
        return 1
    fi
    deployed="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"].lower())' "$dir/account.json")"
    if [[ "$deployed" != "${account,,}" ]]; then
        echo "account.json is $deployed, expected ${account,,}" >&2
        return 1
    fi
}

# Release profile write access is deployments/ only. Foundry 1.5 has no
# --profile flag; deploy.sh selects the profile with FOUNDRY_PROFILE.
release_can_write_deployments() {
    local cfg probe inside outside_src outside_deploy code
    if ! grep -q 'export FOUNDRY_PROFILE=release' "$SCRIPT_DIR/deploy.sh"; then
        echo "deploy.sh does not set FOUNDRY_PROFILE=release" >&2
        return 1
    fi
    if grep -q -- '--profile' "$SCRIPT_DIR/deploy.sh"; then
        echo "deploy.sh passes --profile, which this Foundry rejects" >&2
        return 1
    fi
    if ! grep -q 'bun run deploy:local' "$REPO_ROOT/scripts/e2e-local-payment.sh"; then
        echo "e2e-local-payment does not deploy through deploy:local" >&2
        return 1
    fi
    if ! grep -q 'bun run deploy:local' "$REPO_ROOT/scripts/e2e-local-escrow.sh"; then
        echo "e2e-local-escrow does not deploy through deploy:local" >&2
        return 1
    fi
    cfg="$(env -u FOUNDRY_PROFILE FOUNDRY_PROFILE=release forge config --json)"
    python3 -c '
import json, sys
c = json.loads(sys.argv[1])
writes = []
for entry in c.get("fs_permissions") or []:
    access = entry.get("access")
    if access is True or access == "read-write":
        writes.append(entry.get("path"))
if writes != ["./deployments"]:
    print("release write paths: " + repr(writes), file=sys.stderr)
    sys.exit(1)
if c.get("via_ir") is not True or c.get("optimizer_runs") != 200:
    print("release profile is not via_ir with 200 runs", file=sys.stderr)
    sys.exit(1)
' "$cfg" || return 1

    mkdir -p "$PROJECT_ROOT/cache"
    probe="$PROJECT_ROOT/scripts/sol/FsProbe.s.sol"
    inside="$PROJECT_ROOT/deployments/__fs_probe.json"
    outside_src="$PROJECT_ROOT/src/__fs_probe.txt"
    outside_deploy="$PROJECT_ROOT/deploy/__fs_probe.txt"
    cleanup_probe() {
        rm -f "$probe" "$inside" "$outside_src" "$outside_deploy"
        rmdir "$PROJECT_ROOT/deploy" 2>/dev/null || true
    }
    cleanup_probe
    trap cleanup_probe RETURN
    mkdir -p "$PROJECT_ROOT/deploy"
    cat >"$probe" <<'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script} from "forge-std/Script.sol";
contract FsProbe is Script {
    function writeInside() external {
        vm.writeFile("deployments/__fs_probe.json", "{\"ok\":true}");
    }
    function writeSrc() external {
        vm.writeFile("src/__fs_probe.txt", "no");
    }
    function writeDeployDir() external {
        vm.writeFile("deploy/__fs_probe.txt", "no");
    }
}
EOF
    env -u FOUNDRY_PROFILE FOUNDRY_PROFILE=release \
        forge script "$probe:FsProbe" --sig "writeInside()" --offline \
        >"$PROJECT_ROOT/cache/fs-probe-inside.out" 2>&1
    if [[ ! -f "$inside" ]]; then
        echo "release profile did not write deployments/" >&2
        cat "$PROJECT_ROOT/cache/fs-probe-inside.out" >&2
        return 1
    fi
    set +e
    env -u FOUNDRY_PROFILE FOUNDRY_PROFILE=release \
        forge script "$probe:FsProbe" --sig "writeSrc()" --offline \
        >"$PROJECT_ROOT/cache/fs-probe-src.out" 2>&1
    code=$?
    set -e
    if [[ "$code" -eq 0 || -f "$outside_src" ]]; then
        echo "release profile wrote outside deployments/ (src)" >&2
        return 1
    fi
    if ! grep -q "not allowed to be accessed for write operations" "$PROJECT_ROOT/cache/fs-probe-src.out"; then
        echo "src write failed for a reason other than fs_permissions" >&2
        cat "$PROJECT_ROOT/cache/fs-probe-src.out" >&2
        return 1
    fi
    set +e
    env -u FOUNDRY_PROFILE FOUNDRY_PROFILE=release \
        forge script "$probe:FsProbe" --sig "writeDeployDir()" --offline \
        >"$PROJECT_ROOT/cache/fs-probe-deploy.out" 2>&1
    code=$?
    set -e
    if [[ "$code" -eq 0 || -f "$outside_deploy" ]]; then
        echo "release profile wrote ./deploy" >&2
        return 1
    fi
    if ! grep -q "not allowed to be accessed for write operations" "$PROJECT_ROOT/cache/fs-probe-deploy.out"; then
        echo "./deploy write failed for a reason other than fs_permissions" >&2
        cat "$PROJECT_ROOT/cache/fs-probe-deploy.out" >&2
        return 1
    fi
    rm -f "$PROJECT_ROOT/cache/fs-probe-inside.out" "$PROJECT_ROOT/cache/fs-probe-src.out" "$PROJECT_ROOT/cache/fs-probe-deploy.out"
}

if [[ "${1:-}" == "--only" ]]; then
    "$2"
    exit $?
fi

echo "Release follow-up checks (packages/contracts)"
if substitution_rejected; then pass "substituted artifact rejected"; else fail "substituted artifact rejected"; fi
if foundry_env_unset; then pass "FOUNDRY_* and DAPP_* are unset"; else fail "FOUNDRY_* and DAPP_* are unset"; fi
if artifact_hash_required; then pass "artifact hash is always required"; else fail "artifact hash is always required"; fi
if quoted_forge_argv; then pass "forge arguments are not evaluated"; else fail "forge arguments are not evaluated"; fi
if bytecode_flags_refused; then pass "bytecode-changing forge flags are refused"; else fail "bytecode-changing forge flags are refused"; fi
if metadata_fields_required; then pass "release metadata fields are required"; else fail "release metadata fields are required"; fi
if release_tests_in_ci; then pass "CI runs release forge test"; else fail "CI runs release forge test"; fi
if package_scripts_run_check; then pass "build:contracts and generate run the size check"; else fail "build:contracts and generate run the size check"; fi
if symlink_refused; then pass "deploy.sh refuses a symlink"; else fail "deploy.sh refuses a symlink"; fi
if release_addresses_documented; then pass "docs list release CREATE2 addresses"; else fail "docs list release CREATE2 addresses"; fi
if release_can_write_deployments; then pass "release profile can write deployments/"; else fail "release profile can write deployments/"; fi
if immutable_spans_are_masked; then pass "immutable spans are masked"; else fail "immutable spans are masked"; fi
if resume_rebroadcast_refused; then pass "--resume is refused"; else fail "--resume is refused"; fi
if selective_json_must_match_release; then pass "JSON dependency must match the release runtime"; else fail "JSON dependency must match the release runtime"; fi

if [[ "$failures" -ne 0 ]]; then
    echo "$failures check(s) failed" >&2
    exit 1
fi
echo "All release follow-up checks passed."
