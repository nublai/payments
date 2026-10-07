#!/usr/bin/env bash
# Fail if release-profile runtime bytecode exceeds the EIP-170 limit (24,576 bytes).
# FOUNDRY_PROFILE is hard-set to release. A caller cannot select another profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

# EIP-170 caps deployed runtime bytecode at 24,576 bytes.
LIMIT=24576

export FOUNDRY_PROFILE=release

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to check runtime bytecode size" >&2
    exit 1
fi

echo "Building with FOUNDRY_PROFILE=release (forge build --sizes)..."
FOUNDRY_PROFILE=release forge build --sizes

python3 - "$LIMIT" <<'PY'
import json
import sys
from pathlib import Path

limit = int(sys.argv[1])
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

failed = False
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
    if settings.get("viaIR") is not True or runs != 200:
        print(
            f"ERROR: {name} artifact is not the release profile "
            f"(viaIR={settings.get('viaIR')}, optimizer_runs={runs}); expected viaIR=true, runs=200",
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
print(f"Release runtime bytecode is within {limit} bytes.")
PY
