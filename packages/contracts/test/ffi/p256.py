#!/usr/bin/env python3
"""OpenSSL P-256 helpers for Foundry ffi. stdout is raw bytes (no newline)."""

import base64
import subprocess
import sys
import tempfile
from pathlib import Path


def _hex_arg(value: str) -> bytes:
    value = value.strip().removeprefix("0x").removeprefix("0X")
    if value == "" or len(value) % 2:
        raise SystemExit("expected even-length hex")
    return bytes.fromhex(value)


def _b64url(digest: bytes) -> bytes:
    if len(digest) != 32:
        raise SystemExit(f"digest must be 32 bytes, got {len(digest)}")
    return base64.urlsafe_b64encode(digest).rstrip(b"=")


def _parse_der_sig(der: bytes) -> tuple[int, int]:
    if len(der) < 8 or der[0] != 0x30:
        raise SystemExit("bad signature der")
    i = 2
    if der[i] != 0x02:
        raise SystemExit("bad signature r tag")
    i += 1
    rlen = der[i]
    i += 1
    r = int.from_bytes(der[i : i + rlen], "big")
    i += rlen
    if der[i] != 0x02:
        raise SystemExit("bad signature s tag")
    i += 1
    slen = der[i]
    i += 1
    s = int.from_bytes(der[i : i + slen], "big")
    return r, s


def _abi_encode(xy: bytes, r: int, s: int) -> bytes:
    if len(xy) != 64:
        raise SystemExit(f"public key must be 64 bytes, got {len(xy)}")
    offset = (96).to_bytes(32, "big")
    head = offset + r.to_bytes(32, "big") + s.to_bytes(32, "big")
    body = len(xy).to_bytes(32, "big") + xy  # already 32-aligned
    return head + body


def _sign(preimage: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        key = root / "key.pem"
        msg = root / "msg.bin"
        sig = root / "sig.der"
        pub = root / "pub.der"
        msg.write_bytes(preimage)
        subprocess.check_call(
            ["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(key)],
            stderr=subprocess.DEVNULL,
        )
        subprocess.check_call(
            ["openssl", "dgst", "-sha256", "-sign", str(key), "-out", str(sig), str(msg)],
            stderr=subprocess.DEVNULL,
        )
        subprocess.check_call(
            ["openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER", "-out", str(pub)],
            stderr=subprocess.DEVNULL,
        )
        der = pub.read_bytes()
        if len(der) < 65 or der[-65] != 0x04:
            raise SystemExit("unexpected SPKI public key encoding")
        r, s = _parse_der_sig(sig.read_bytes())
        return _abi_encode(der[-64:], r, s)


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("b64", "sign"):
        raise SystemExit("usage: p256.py b64|sign <hex>")
    raw = _hex_arg(sys.argv[2])
    if sys.argv[1] == "b64":
        sys.stdout.write(_b64url(raw).decode())
    else:
        signed = _sign(raw)
        sys.stdout.write("0x" + signed.hex())


if __name__ == "__main__":
    main()
