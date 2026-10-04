#!/usr/bin/env bash
# Read-only checks for verify-agentic-payments. Does not install, deploy, or start processes.
set -u

fail=0
fail_msg() {
  echo "DOCTOR FAIL: $1" >&2
  fail=1
}

if ! command -v node >/dev/null 2>&1; then
  fail_msg "node is not on PATH (need major >= 22; this machine has /tmp/node22/bin)"
else
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  case "$major" in
    ''|*[!0-9]*)
      fail_msg "could not read node major from $(command -v node) ($(node -v 2>/dev/null || echo unknown))"
      ;;
    *)
      if [[ "$major" -lt 22 ]]; then
        fail_msg "node major is $major ($(node -v)); need >= 22 (this machine has /tmp/node22/bin)"
      fi
      ;;
  esac
fi

for cmd in anvil cast forge bun curl python3 bc lsof; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail_msg "missing required command: $cmd"
  fi
done

if ! command -v ss >/dev/null 2>&1; then
  fail_msg "ss is not on PATH; the e2e scripts use ss to decide whether ports 8545, 8546, and 8787 are free"
else
  port_listening() {
    ss -ltn "sport = :$1" | awk 'NR>1 {found=1} END {exit found?0:1}'
  }
  for port in 8545 8546 8787; do
    if port_listening "$port"; then
      fail_msg "port $port is already in use"
    fi
  done
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "DOCTOR PASS: node $(node -v) (major >= 22); anvil cast forge bun curl python3 bc lsof on PATH; ports 8545 8546 8787 free"
