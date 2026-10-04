#!/bin/bash
set -e

# Relayer development server
#
# Usage:
#   ./scripts/dev.sh                     # Start relayer (auto-generates .dev.vars)
#   ./scripts/dev.sh --stress            # Enable stress mode (10 signers)
#   ./scripts/dev.sh --background        # Start in background, echo PID
#
# Environment variables:
#   ANVIL_PORT     - Anvil RPC port for primary chain (default: 8545)
#   ANVIL_PORT_ARB - Anvil RPC port for secondary chain (default: 8546)
#   RELAYER_PORT   - Relayer port (default: 8787)
#   CHAIN_IDS      - Comma-separated chain IDs (default: 31337,41337)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAYER_DIR="$(dirname "$SCRIPT_DIR")"
CONTRACTS_DIR="$RELAYER_DIR/../contracts"
REPO_ROOT="$RELAYER_DIR/../.."

# Parse arguments
STRESS_MODE=false
BACKGROUND=false
for arg in "$@"; do
  case $arg in
    --stress)
      STRESS_MODE=true
      shift
      ;;
    --background)
      BACKGROUND=true
      shift
      ;;
  esac
done

# Ports
ANVIL_PORT=${ANVIL_PORT:-8545}
ANVIL_PORT_ARB=${ANVIL_PORT_ARB:-8546}
RELAYER_PORT=${RELAYER_PORT:-8787}
CHAIN_IDS=${CHAIN_IDS:-31337,41337}
PRIMARY_CHAIN_ID=${PRIMARY_CHAIN_ID:-31337}
export RPC_31337="http://127.0.0.1:$ANVIL_PORT"
export RPC_41337="http://127.0.0.1:$ANVIL_PORT_ARB"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1" >&2
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Clear Durable Object state (resets pending transaction counts)
clear_do_state() {
  if [ -d "$RELAYER_DIR/.wrangler/state" ]; then
    rm -rf "$RELAYER_DIR/.wrangler/state"
    log_info "Cleared Durable Object state"
  fi
}

append_contract_addresses() {
  local env_file="$CONTRACTS_DIR/deployments/envs/local/.env"
  if [ -f "$env_file" ]; then
    log_info "Copying contract addresses from $env_file..."
    cat "$env_file" >> "$RELAYER_DIR/.dev.vars"
    log_success "Contract addresses added"
  else
    log_error "Contract addresses not found: $env_file"
    log_error "Run 'bun deploy:local' first"
    exit 1
  fi
}

# Generate .dev.vars for local development
make_config() {
  log_info "Creating .dev.vars for multi-chain (31337 + 41337)..."

  # Set signer count based on mode
  local relayer_count=5
  if [ "$STRESS_MODE" = true ]; then
    relayer_count=10
  fi

  cat > "$RELAYER_DIR/.dev.vars" << EOF
# Auto-generated for local development
# ------------------------------------------------------------
# Core settings
CONTEXT=local
RPC_URL=http://127.0.0.1:$ANVIL_PORT
RELAYER_MNEMONIC=test test test test test test test test test test test junk
# ------------------------------------------------------------
# Chain configuration
CHAIN_IDS=$CHAIN_IDS
RELAYER_COUNT=$relayer_count

# ------------------------------------------------------------
# Local gas headroom (stabilizes reimbursement/funder execution in integration tests)
INTENT_GAS_BUFFER=50000
PAYMENT_GAS_BUFFER=88000
TX_GAS_BUFFER=50000

# ------------------------------------------------------------
# Auth configuration (non-secret defaults; override via shell env)
ERC8128_ENABLED=${ERC8128_ENABLED:-true}
PRIVY_ENABLED=${PRIVY_ENABLED:-false}
AUTH_PROTECTED_METHODS=${AUTH_PROTECTED_METHODS:-wallet_sendPreparedCalls}
PRIVY_APP_ID=${PRIVY_APP_ID:-}
PRIVY_APP_SECRET=${PRIVY_APP_SECRET:-}
EOF

  echo "" >> "$RELAYER_DIR/.dev.vars"
  echo "# ------------------------------------------------------------" >> "$RELAYER_DIR/.dev.vars"
  echo "# RPC endpoints" >> "$RELAYER_DIR/.dev.vars"
  echo "RPC_31337=$RPC_31337" >> "$RELAYER_DIR/.dev.vars"
  echo "RPC_41337=$RPC_41337" >> "$RELAYER_DIR/.dev.vars"

  echo "" >> "$RELAYER_DIR/.dev.vars"
  echo "# ------------------------------------------------------------" >> "$RELAYER_DIR/.dev.vars"
  echo "# Contract addresses (by chain)" >> "$RELAYER_DIR/.dev.vars"
  append_contract_addresses

  # Add stress mode settings if enabled
  if [ "$STRESS_MODE" = true ]; then
    configure_stress_mode
  fi

  log_success "Created .dev.vars"
}

# Configure relayer for stress testing (multi-signer mode)
configure_stress_mode() {
  log_info "Configuring stress mode (10 signers)..."

  cat >> "$RELAYER_DIR/.dev.vars" << EOF
MAX_PENDING_PER_SIGNER=32
MAX_PENDING_TOTAL=500
EOF

  log_success "Stress mode enabled"
}

# Wait for relayer health endpoint
wait_for_relayer() {
  local url=$1
  local max_attempts=${2:-60}
  local attempt=0

  log_info "Waiting for Relayer at $url..."
  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      log_success "Relayer is ready"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  log_error "Relayer did not start in time"
  log_error "Relayer log output:"
  cat /tmp/relayer.log 2>/dev/null || echo "(no log file)"
  return 1
}

# Build @agentic-payments/contracts if dist is missing (needed for wrangler to resolve imports)
build_contracts() {
  local CONTRACTS_DIR="$RELAYER_DIR/../contracts"
  if [ ! -f "$CONTRACTS_DIR/dist/index.js" ]; then
    log_info "Building @agentic-payments/contracts..."
    (cd "$CONTRACTS_DIR" && bun run build) >&2
    log_success "Contracts built"
  fi
}

# Check if port is in use
is_port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Main
main() {
  if ! command -v lsof >/dev/null 2>&1; then
    log_error "lsof is not on PATH"
    exit 1
  fi

  cd "$RELAYER_DIR"

  # Build contracts if needed
  build_contracts

  # Always generate fresh config
  make_config

  # Clear DO state for clean start
  clear_do_state

  # Check if port already in use
  if is_port_in_use $RELAYER_PORT; then
    log_error "Port $RELAYER_PORT already in use"
    exit 1
  fi

  if [ "$BACKGROUND" = true ]; then
    # Background mode: start wrangler, echo PID
    log_info "Starting relayer in background..."
    bun run dev:wrangler > /tmp/relayer.log 2>&1 &
    RELAYER_PID=$!

    # Cleanup on failure - kill wrangler if health check fails
    trap 'kill $RELAYER_PID 2>/dev/null || true' EXIT

    wait_for_relayer "http://127.0.0.1:$RELAYER_PORT/health"

    # Success - clear trap so parent owns the process
    trap - EXIT

    # Echo PID to stdout (logs go to stderr)
    echo "$RELAYER_PID"
  else
    # Foreground mode: run wrangler directly
    log_info "Starting relayer on port $RELAYER_PORT (multi-chain: 31337 + 41337)..."
    exec bun run dev:wrangler
  fi
}

main "$@"
