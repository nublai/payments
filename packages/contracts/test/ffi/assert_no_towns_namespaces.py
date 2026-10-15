#!/usr/bin/env python3
"""Fail if a src/ namespace string or erc7201 annotation contains 'towns'."""

import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "src"))
NS = re.compile(
    r'keccak256\(\s*"([^"]*)"\s*\)'
    r"|@custom:storage-location\s+\S+:(\S+)",
    re.IGNORECASE,
)
TOWNS = re.compile(r"towns", re.IGNORECASE)

hits = []
for dirpath, _, filenames in os.walk(ROOT):
    for name in filenames:
        if not name.endswith(".sol"):
            continue
        path = os.path.join(dirpath, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for match in NS.finditer(text):
            ident = match.group(1) or match.group(2) or ""
            if TOWNS.search(ident):
                rel = os.path.relpath(path, os.path.join(ROOT, ".."))
                hits.append(f"{rel}: {ident}")

if hits:
    sys.stdout.write("towns in src namespace:\n" + "\n".join(hits) + "\n")
    sys.exit(1)
