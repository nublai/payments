#!/bin/bash
set -e
# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

usage() {
  cat << EOF
Usage: $0 [options] [-- <test-filter>]

Development environment for @nubl/relayer-client integration tests.
Starts Anvil (multi-chain) and relayer services, optionally runs tests.

Options:
  --test, -t     Run integration tests then exit (cleanup services after)
  --watch, -w    Run tests in watch mode (services stay running after exit)
  --crosschain   Enable cross-chain mode (two anvils: 31337 + 41337)
  --stress       Configure for stress testing (5 signers, higher limits)
  --daemon, -d   Start services and exit without blocking (for use from justfile/CI)
  --help, -h     Show this help message

Test Filtering:
  Any arguments after -- are passed directly to vitest for filtering.
  You can filter by filename pattern or test name.

Environment Variables:
  FORK_RPC_URL   Fork from this RPC URL instead of fresh local chain
  FORK_BLOCK     Block number to fork at (only with FORK_RPC_URL)
  BLOCK_TIME     Block interval in seconds (default: 0.5)
  ANVIL_PORT     Anvil port for primary chain (default: 8545)
  ANVIL_PORT_ARB Anvil port for secondary chain (default: 8546)
  RELAYER_PORT   Relayer port (default: 8787)

Examples:
  $0                              Start services and keep running (dev mode)
  $0 --test                       Run all integration tests once and cleanup
  $0 --watch                      Run tests in watch mode for development
  $0 --stress --test              Run stress tests

  # Run specific scenarios (for targeted testing during development):
  $0 --test -- 01-account         Run only account delegation tests
  $0 --test -- nonce              Run only nonce management tests
  $0 --test -- 03-eth             Run only ETH gasless transfer tests
  $0 --watch -- verify-signature  Watch mode for signature verification tests

EOF
  exit 0
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(dirname "$SCRIPT_DIR")"
RELAYER_DIR="$SDK_DIR/../relayer"
CONTRACTS_DIR="$SDK_DIR/../contracts"

# Parse arguments
RUN_TESTS=false
STRESS_MODE=false
DAEMON_MODE=false
WATCH_MODE=false
CROSSCHAIN_MODE=true
TEST_FILTER=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h)
      usage
      ;;
    --test|-t)
      RUN_TESTS=true
      shift
      ;;
    --watch|-w)
      WATCH_MODE=true
      RUN_TESTS=true  # watch implies test
      shift
      ;;
    --stress)
      STRESS_MODE=true
      shift
      ;;
    --crosschain)
      CROSSCHAIN_MODE=true
      shift
      ;;
    --daemon|-d)
      DAEMON_MODE=true
      shift
      ;;
    --)
      # Everything after -- is passed to vitest
      shift
      TEST_FILTER="$*"
      RUN_TESTS=true  # filter implies test
      break
      ;;
    *)
      # Unknown arg - treat as test filter
      TEST_FILTER="$*"
      RUN_TESTS=true  # filter implies test
      break
      ;;
  esac
done

# Ports
ANVIL_PORT=${ANVIL_PORT:-8545}
ANVIL_PORT_ARB=${ANVIL_PORT_ARB:-8546}
RELAYER_PORT=${RELAYER_PORT:-8787}

# Anvil block time (seconds) - 0.5s default for faster tests
BLOCK_TIME=${BLOCK_TIME:-0.5}

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if a port is in use
is_port_in_use() {
  lsof -i ":$1" >/dev/null 2>&1
}

# Wait for a service to be ready
wait_for_service() {
  local url=$1
  local name=$2
  local max_attempts=${3:-30}
  local attempt=0

  log_info "Waiting for $name at $url..."
  while [ $attempt -lt $max_attempts ]; do
    if curl -s "$url" >/dev/null 2>&1; then
      log_success "$name is ready"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  log_error "$name did not start in time"
  return 1
}

# Cleanup function
cleanup() {
  log_info "Cleaning up..."

  # Kill relayer
  if [ -n "$RELAYER_PID" ]; then
    kill $RELAYER_PID 2>/dev/null || true
    wait $RELAYER_PID 2>/dev/null || true
    log_info "Stopped Relayer (PID: $RELAYER_PID)"
  fi

  # Clear DO state after relayer is stopped
  if [ -d "$RELAYER_DIR/.wrangler/state" ]; then
    rm -rf "$RELAYER_DIR/.wrangler/state"
    log_info "Cleared Durable Object state"
  fi

  # Kill Anvil (primary chain)
  if [ -n "$ANVIL_PID" ]; then
    kill $ANVIL_PID 2>/dev/null || true
    log_info "Stopped Anvil (PID: $ANVIL_PID)"
  fi

  # Kill Anvil (secondary chain - multi-chain mode)
  if [ -n "$ANVIL_ARB_PID" ]; then
    kill $ANVIL_ARB_PID 2>/dev/null || true
    log_info "Stopped Anvil Secondary (PID: $ANVIL_ARB_PID)"
  fi
}

# Cleanup on error, interrupt (Ctrl+C), or termination
trap 'cleanup' ERR INT TERM

# Check for required tools and environment
check_dependencies() {
  if ! command -v anvil &>/dev/null; then
    log_error "anvil not found. Please install Foundry: https://getfoundry.sh"
    exit 1
  fi

  if ! command -v forge &>/dev/null; then
    log_error "forge not found. Please install Foundry: https://getfoundry.sh"
    exit 1
  fi

  if ! command -v bun &>/dev/null; then
    log_error "bun not found. Please install Bun: https://bun.sh"
    exit 1
  fi
}

# Start Anvil (primary chain)
start_anvil() {
  if is_port_in_use $ANVIL_PORT; then
    log_warn "Port $ANVIL_PORT already in use, assuming Anvil is running"
    ANVIL_ALREADY_RUNNING=true
    return 0
  fi

  log_info "Starting Anvil..."

  if [ -n "$FORK_RPC_URL" ]; then
    # Fork mode - fork from provided RPC URL
    log_info "Forking from $FORK_RPC_URL"
    ANVIL_ARGS="--port $ANVIL_PORT --chain-id 8453 --hardfork prague --block-time $BLOCK_TIME --fork-url $FORK_RPC_URL"

    if [ -n "$FORK_BLOCK" ]; then
      ANVIL_ARGS="$ANVIL_ARGS --fork-block-number $FORK_BLOCK"
    fi

    # Set chain ID for tests
    export TEST_CHAIN_ID=8453
  else
    # Local mode - fresh Anvil with chain ID 31337
    log_info "Starting local Anvil (chain 31337)"
    ANVIL_ARGS="--port $ANVIL_PORT --chain-id 31337 --hardfork prague --block-time $BLOCK_TIME"

    # Set chain ID for tests
    export TEST_CHAIN_ID=31337
  fi

  # Start Anvil in background
  anvil $ANVIL_ARGS > /tmp/anvil.log 2>&1 &
  ANVIL_PID=$!

  # Wait for Anvil to be ready
  wait_for_service "http://127.0.0.1:$ANVIL_PORT" "Anvil"

  log_success "Anvil started (PID: $ANVIL_PID)"
}

# Start Anvil for secondary chain (multi-chain mode only)
start_anvil_arb() {
  if [ "$CROSSCHAIN_MODE" != true ]; then
    return 0
  fi

  if is_port_in_use $ANVIL_PORT_ARB; then
    log_warn "Port $ANVIL_PORT_ARB already in use, assuming Anvil Secondary is running"
    ANVIL_ARB_ALREADY_RUNNING=true
    return 0
  fi

  log_info "Starting Anvil Secondary (chain 41337)..."
  ANVIL_ARB_ARGS="--port $ANVIL_PORT_ARB --chain-id 41337 --hardfork prague --block-time $BLOCK_TIME"

  # Start Anvil in background
  anvil $ANVIL_ARB_ARGS > /tmp/anvil-arb.log 2>&1 &
  ANVIL_ARB_PID=$!

  # Wait for Anvil to be ready
  wait_for_service "http://127.0.0.1:$ANVIL_PORT_ARB" "Anvil Secondary"

  log_success "Anvil Secondary started (PID: $ANVIL_ARB_PID)"
}

# Deploy contracts (only in local mode, and only if we started Anvil)
deploy_contracts() {
  if [ -n "$FORK_RPC_URL" ]; then
    log_info "Fork mode - using existing contracts from forked chain"
    return 0
  fi

  if [ "$ANVIL_ALREADY_RUNNING" = true ]; then
    log_info "Anvil was already running, assuming contracts are deployed"
    return 0
  fi

  log_info "Building and deploying contracts..."

  cd "$CONTRACTS_DIR"

  # Build contracts first (generates TypeScript ABIs needed by relayer)
  bun run build:contracts

  # Deploy contracts to local context (includes both 31337 + 41337)
  log_info "Deploying contracts to local context (chains 31337 + 41337)..."
  bun run deploy:local
  log_success "Contracts deployed to local chains"

  # Generate .env files from deployment artifacts
  log_info "Generating deployment config..."
  bun run make-config
  log_success "Deployment config generated"

  cd "$SDK_DIR"
}

# Start the relayer worker (delegates to relayer's dev.sh)
start_relayer() {
  if is_port_in_use $RELAYER_PORT; then
    log_warn "Port $RELAYER_PORT already in use, assuming relayer is running"
    # Still export RPC URLs for tests even when relayer is already running
    if [ "$CROSSCHAIN_MODE" = true ]; then
      export RPC_31337="http://127.0.0.1:$ANVIL_PORT"
      export RPC_41337="http://127.0.0.1:$ANVIL_PORT_ARB"
    fi
    return 0
  fi

  log_info "Starting relayer worker..."

  # Build args for relayer dev.sh
  local args="--background"
  [ "$STRESS_MODE" = true ] && args="$args --stress"

  # Export env vars for relayer dev.sh
  export ANVIL_PORT
  export RELAYER_PORT
  export CHAIN_IDS=${TEST_CHAIN_IDS:-31337,41337}
  export PRIMARY_CHAIN_ID=${TEST_CHAIN_ID:-31337}
  # Integration scenarios do not send auth by default. Use a non-existent protected
  # method here so relayer auth remains opt-in unless the caller explicitly overrides it.
  export AUTH_PROTECTED_METHODS=${AUTH_PROTECTED_METHODS:-wallet__integration_test_auth_only}

  # Export multi-chain RPC URLs for crosschain mode
  if [ "$CROSSCHAIN_MODE" = true ]; then
    export RPC_31337="http://127.0.0.1:$ANVIL_PORT"
    export RPC_41337="http://127.0.0.1:$ANVIL_PORT_ARB"
  fi

  # Start relayer and capture PID
  RELAYER_PID=$("$RELAYER_DIR/scripts/dev.sh" $args)

  log_success "Relayer started (PID: $RELAYER_PID)"
}

# Print status
print_status() {
  local chain_id=${TEST_CHAIN_ID:-31337}
  local chain_ids=${TEST_CHAIN_IDS:-31337,41337}
  local mode="Local"
  [ -n "$FORK_RPC_URL" ] && mode="Fork"
  [ "$CROSSCHAIN_MODE" = true ] && mode="Multi-chain"

  echo ""
  echo -e "${GREEN}============================================${NC}"
  echo -e "${GREEN}  Integration Test Environment Ready${NC}"
  echo -e "${GREEN}============================================${NC}"
  echo ""
  echo -e "  Mode:         ${BLUE}$mode${NC}"
  echo -e "  Chain ID:     ${BLUE}$chain_id${NC}"
  echo -e "  Chain IDs:    ${BLUE}$chain_ids${NC}"
  echo -e "  Anvil RPC:    ${BLUE}http://127.0.0.1:$ANVIL_PORT${NC}"
  if [ "$CROSSCHAIN_MODE" = true ]; then
    echo -e "  Anvil Secondary: ${BLUE}http://127.0.0.1:$ANVIL_PORT_ARB${NC} (chain 41337)"
  fi
  echo -e "  Relayer:      ${BLUE}http://127.0.0.1:$RELAYER_PORT${NC}"

  if [ "$STRESS_MODE" = true ]; then
    echo -e "  Stress Mode:  ${YELLOW}Enabled (5 signers)${NC}"
  fi

  echo ""
  echo -e "  To run tests:"
  if [ "$STRESS_MODE" = true ]; then
    echo -e "    ${YELLOW}cd $SDK_DIR && TEST_CHAIN_ID=$chain_id bun run test:stress${NC}"
  else
    echo -e "    ${YELLOW}cd $SDK_DIR && TEST_CHAIN_ID=$chain_id bun run test:integration${NC}"
  fi
  echo ""
  echo -e "  To stop services:"
  local pids="$ANVIL_PID $RELAYER_PID"
  [ -n "$ANVIL_ARB_PID" ] && pids="$pids $ANVIL_ARB_PID"
  echo -e "    ${YELLOW}kill $pids${NC}"
  echo ""
  echo -e "  Logs:"
  echo -e "    Anvil:   /tmp/anvil.log"
  [ "$CROSSCHAIN_MODE" = true ] && echo -e "    Anvil Secondary: /tmp/anvil-arb.log"
  echo -e "    Relayer: /tmp/relayer.log"
  echo ""
}

# Run tests and return exit code
run_tests() {
  cd "$SDK_DIR"

  # Capture exit code explicitly to prevent set -e from bypassing cleanup
  local exit_code=0

  # Build vitest command with optional filter
  local filter_args=""
  if [ -n "$TEST_FILTER" ]; then
    filter_args="$TEST_FILTER"
    log_info "Test filter: $filter_args"
  fi

  if [ "$STRESS_MODE" = true ]; then
    log_info "Running stress tests..."
    echo ""
    TEST_CHAIN_ID=${TEST_CHAIN_ID:-31337} TEST_CHAIN_IDS=${TEST_CHAIN_IDS:-31337,41337} bunx vitest run --project stress $filter_args || exit_code=$?
  elif [ "$WATCH_MODE" = true ]; then
    log_info "Running integration tests in watch mode..."
    echo ""
    TEST_CHAIN_ID=${TEST_CHAIN_ID:-31337} TEST_CHAIN_IDS=${TEST_CHAIN_IDS:-31337,41337} bunx vitest --project integration $filter_args || exit_code=$?
  else
    log_info "Running integration tests..."
    echo ""
    TEST_CHAIN_ID=${TEST_CHAIN_ID:-31337} TEST_CHAIN_IDS=${TEST_CHAIN_IDS:-31337,41337} bunx vitest run --project integration $filter_args || exit_code=$?
  fi

  return $exit_code
}

# Main
main() {
  log_info "Starting integration test environment..."

  check_dependencies

  start_anvil
  start_anvil_arb
  deploy_contracts
  start_relayer

  if [ "$RUN_TESTS" = true ]; then
    # Run tests
    echo ""
    run_tests
    TEST_EXIT_CODE=$?

    # Only cleanup for non-watch mode (watch mode user wants to iterate)
    if [ "$WATCH_MODE" != true ]; then
      log_info "Tests completed. Cleaning up..."
      cleanup

      if [ $TEST_EXIT_CODE -eq 0 ]; then
        log_success "All tests passed!"
      else
        log_error "Tests failed with exit code $TEST_EXIT_CODE"
      fi
    fi

    exit $TEST_EXIT_CODE
  elif [ "$DAEMON_MODE" = true ]; then
    # Daemon mode - start services and exit (for justfile/CI)
    print_status
    log_info "Services started in daemon mode"
  else
    # Dev mode - print status and wait
    print_status
    log_info "Press Ctrl+C to stop all services"
    tail -f /dev/null
  fi
}

main "$@"
