#!/usr/bin/env python3
"""Compare on-chain runtime to a Foundry release artifact.

Solady EIP-712 immutables include the chain id, and constructor immutables
include addresses such as the Orchestrator. A raw extcodehash false-fails
Orchestrator, Account, SimpleFunder, and SimpleSettler. Every span in
deployedBytecode.immutableReferences is zeroed on both sides before compare.

Prints ``match`` or ``mismatch`` with no newline and exits 0.
Exits 1 on usage or parse errors so ``vm.ffi`` reverts.
"""

import json
import sys


def normalize_hex(value: str) -> str:
    text = value.strip().lower()
    if text.startswith("0x"):
        text = text[2:]
    if len(text) % 2 != 0:
        raise ValueError("odd hex length")
    # Reject non-hex early.
    bytes.fromhex(text)
    return text


def mask_immutables(code: str, references: dict) -> str:
    buf = bytearray.fromhex(code)
    for spans in references.values():
        if not isinstance(spans, list):
            raise ValueError("immutableReferences span list is not a list")
        for span in spans:
            start = int(span["start"])
            length = int(span["length"])
            if start < 0 or length < 0 or start + length > len(buf):
                raise ValueError("immutable span is outside the runtime")
            buf[start : start + length] = b"\x00" * length
    return buf.hex()


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "usage: match-release-runtime.py <artifact.json> <runtime-hex>",
            file=sys.stderr,
        )
        sys.exit(1)
    artifact_path, runtime_hex = sys.argv[1], sys.argv[2]
    try:
        with open(artifact_path, encoding="utf-8") as handle:
            artifact = json.load(handle)
        deployed = artifact["deployedBytecode"]
        expected = normalize_hex(deployed["object"])
        actual = normalize_hex(runtime_hex)
        references = deployed.get("immutableReferences") or {}
        if not isinstance(references, dict):
            raise ValueError("immutableReferences is not an object")
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    if not actual or not expected or len(actual) != len(expected):
        sys.stdout.write("mismatch")
        return
    try:
        same = mask_immutables(actual, references) == mask_immutables(expected, references)
    except (KeyError, TypeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    sys.stdout.write("match" if same else "mismatch")


if __name__ == "__main__":
    main()
