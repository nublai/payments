#!/usr/bin/env bash
# Mint MockUSDC on local Anvil to a given address.
# Usage: ./scripts/fund-dev.sh <address> [amount_usdc]

set -euo pipefail

ADDRESS=${1:?Usage: fund-dev.sh <address> [amount_usdc]}
AMOUNT=${2:-1000}
DECIMALS=6
RAW=$(echo "$AMOUNT * 10^$DECIMALS" | bc)

cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "mint(address,uint256)" "$ADDRESS" "$RAW" \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

echo "Minted ${AMOUNT} MockUSDC to ${ADDRESS}"
