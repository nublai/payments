#!/usr/bin/env bash
# Fail if release-profile runtime bytecode exceeds the EIP-170 limit (24,576 bytes).
# Inherited FOUNDRY_* and DAPP_* variables are unset. This script sets FOUNDRY_PROFILE=release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

# EIP-170 caps deployed runtime bytecode at 24,576 bytes.
LIMIT=24576

# Drop inherited Foundry and Dapp settings, then set only what this script uses.
# FOUNDRY_OUT and FOUNDRY_CACHE_PATH are included, so the build stays in ./out and ./cache.
clear_foundry_env() {
    local entry name
    while IFS= read -r -d '' entry; do
        name="${entry%%=*}"
        case "$name" in
            FOUNDRY_*|DAPP_*) unset "$name" ;;
        esac
    done < <(env -0)
    export FOUNDRY_PROFILE=release
}
clear_foundry_env

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to check runtime bytecode size" >&2
    exit 1
fi

echo "Building with FOUNDRY_PROFILE=release (forge build --sizes)..."
before_json="$(mktemp)"
python3 - "$before_json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

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

def artifact_hash(artifact):
    bytecode = artifact.get("bytecode") or {}
    deployed = artifact.get("deployedBytecode") or {}
    payload = json.dumps(
        {
            "bytecode": bytecode.get("object") if isinstance(bytecode, dict) else bytecode,
            "deployedBytecode": deployed.get("object") if isinstance(deployed, dict) else deployed,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()

snapshot = {}
for name in names:
    path = Path("out") / f"{name}.sol" / f"{name}.json"
    if not path.is_file():
        snapshot[name] = {"exists": False}
        continue
    artifact = json.loads(path.read_text())
    snapshot[name] = {
        "exists": True,
        "hash": artifact_hash(artifact),
        "mtime_ns": path.stat().st_mtime_ns,
    }
Path(sys.argv[1]).write_text(json.dumps(snapshot))
PY

# No stamp: force the compiler to rewrite ./out. A cache hit must not bless
# whatever file is already there. FOUNDRY_OUT was unset above, so this write
# cannot be redirected.
build_log="$(mktemp)"
if [[ ! -f cache/release-artifact-sha256.json ]]; then
    FOUNDRY_PROFILE=release forge build --force --sizes 2>&1 | tee "$build_log"
else
    FOUNDRY_PROFILE=release forge build --sizes 2>&1 | tee "$build_log"
fi

python3 - "$LIMIT" "$before_json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

limit = int(sys.argv[1])
before = json.loads(Path(sys.argv[2]).read_text())
# The stamp is required when this build did not rewrite the artifact.
# A cache-hit log line is not the signal. A missing stamp is not success.
stamp_path = Path("cache/release-artifact-sha256.json")
stamp = {}
if stamp_path.is_file():
    stamp = json.loads(stamp_path.read_text())

# Contracts DeployUnified deploys from forge artifacts. Account is the
# EIP-170 concern; the others are checked the same way.
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

def artifact_hash(artifact):
    bytecode = artifact.get("bytecode") or {}
    deployed = artifact.get("deployedBytecode") or {}
    payload = json.dumps(
        {
            "bytecode": bytecode.get("object") if isinstance(bytecode, dict) else bytecode,
            "deployedBytecode": deployed.get("object") if isinstance(deployed, dict) else deployed,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()

failed = False
digests = {}
print(f"Release-profile runtime bytecode (limit {limit} bytes):")
for name in names:
    path = Path("out") / f"{name}.sol" / f"{name}.json"
    if not path.is_file():
        print(f"ERROR: missing artifact {path}", file=sys.stderr)
        failed = True
        continue

    artifact = json.loads(path.read_text())
    metadata = artifact.get("metadata")
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    settings = (metadata or {}).get("settings") or {}
    runs = (settings.get("optimizer") or {}).get("runs")
    expected_source = f"src/accounts/{name}.sol"
    target = settings.get("compilationTarget")
    meta_settings = settings.get("metadata") if isinstance(settings.get("metadata"), dict) else {}
    optimizer = settings.get("optimizer") if isinstance(settings.get("optimizer"), dict) else {}
    metadata_errors = []
    if settings.get("viaIR") is not True or runs != 200:
        metadata_errors.append(
            f"ERROR: {name} artifact is not the release profile "
            f"(viaIR={settings.get('viaIR')}, optimizer_runs={runs}); expected viaIR=true, runs=200"
        )
    if target != {expected_source: name}:
        metadata_errors.append(
            f"ERROR: {name} compilationTarget is {target!r}; "
            f"expected {{'{expected_source}': '{name}'}}"
        )
    if meta_settings.get("appendCBOR") is not False or meta_settings.get("bytecodeHash") != "none":
        metadata_errors.append(
            f"ERROR: {name} cbor metadata is appendCBOR={meta_settings.get('appendCBOR')!r}, "
            f"bytecodeHash={meta_settings.get('bytecodeHash')!r}; "
            f"expected appendCBOR=false, bytecodeHash=none"
        )
    if optimizer.get("enabled") is not True:
        metadata_errors.append(
            f"ERROR: {name} optimizer.enabled is {optimizer.get('enabled')!r}; expected true"
        )
    if settings.get("evmVersion") != "prague":
        metadata_errors.append(
            f"ERROR: {name} evmVersion is {settings.get('evmVersion')!r}; expected prague"
        )
    if metadata_errors:
        for message in metadata_errors:
            print(message, file=sys.stderr)
        failed = True
        continue
    digest = artifact_hash(artifact)
    digests[name] = digest
    previous = before.get(name) or {}
    rewritten = not previous.get("exists")
    if previous.get("exists"):
        if previous.get("hash") != digest or previous.get("mtime_ns") != path.stat().st_mtime_ns:
            rewritten = True
    expected = stamp.get(name)
    if expected is None:
        if not rewritten:
            print(
                f"ERROR: {name} artifact hash has no release stamp and this build did not rewrite it",
                file=sys.stderr,
            )
            failed = True
            continue
    elif digest != expected and not rewritten:
        print(
            f"ERROR: {name} artifact hash does not match the release stamp",
            file=sys.stderr,
        )
        failed = True
        continue

    deployed = artifact.get("deployedBytecode") or {}
    if not isinstance(deployed, dict):
        print(f"ERROR: {name} deployedBytecode is not an object", file=sys.stderr)
        failed = True
        continue
    link_refs = deployed.get("linkReferences") or {}
    if link_refs:
        print(f"ERROR: {name} deployed bytecode has link references {link_refs}", file=sys.stderr)
        failed = True
        continue
    obj = deployed.get("object")
    if not isinstance(obj, str) or obj in ("", "0x"):
        print(f"ERROR: {name} has no deployed bytecode in {path}", file=sys.stderr)
        failed = True
        continue
    body = obj[2:] if obj.startswith("0x") else obj
    if len(body) % 2 != 0:
        print(f"ERROR: {name} deployed bytecode is not valid hex", file=sys.stderr)
        failed = True
        continue
    size = len(body) // 2
    if size > limit:
        print(f"FAIL {name}: {size} bytes runtime, over the {limit}-byte limit", file=sys.stderr)
        failed = True
    else:
        print(f"ok   {name}: {size} bytes")

if failed:
    sys.exit(1)
stamp_path.parent.mkdir(parents=True, exist_ok=True)
stamp_path.write_text(json.dumps(digests, indent=2) + "\n")
print(f"Release runtime bytecode is within {limit} bytes.")
PY
rm -f "$build_log" "$before_json"
