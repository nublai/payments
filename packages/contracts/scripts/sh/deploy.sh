#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# =============================================================================
# DEFAULT VALUES
# =============================================================================
DEFAULT_RPC_31337="http://localhost:8545"
DEFAULT_RPC_41337="http://localhost:8546"
DEFAULT_RPC_84532="https://sepolia.base.org"
DEFAULT_RPC_8453="https://mainnet.base.org"
DEFAULT_RPC_10="https://mainnet.optimism.io"
DEFAULT_RPC_42161="https://arb1.arbitrum.io/rpc"
DEFAULT_RPC_137="https://polygon-rpc.com"

DEFAULT_RELAYER_MNEMONIC="test test test test test test test test test test test junk"
DEFAULT_RELAYER_COUNT=10
DEFAULT_LOCAL_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# =============================================================================
# USAGE
# =============================================================================
usage() {
    cat << EOF
Usage: $0 [environment] [options]

Environments (shortcuts):
  local          Deploy to local Anvil (chains 31337,41337)
  dev            Deploy to Base Sepolia (chain 84532)
  stage          Deploy to Base Mainnet (chain 8453)
  prod           Deploy to Base Mainnet (chain 8453)

Or specify chain directly:
  --chain <id>   Chain ID(s) to deploy to (comma-separated for multiple)

Options:
  --rpc <url>              RPC URL (required if chain not recognized)
  --contracts <list>       Comma-separated contracts to deploy (default: all)
  --context <name>         Deployment context for output dir (default: derived from chain)

Authentication (one required for non-local):
  --account <name>         Use keystore account
  --password <pass>        Password for keystore account
  --ledger <path>          Use Ledger with HD path
  --private-key <key>      Use private key directly
  --sender <addr>          Sender address (for simulations or with unlocked accounts)

Contract Configuration:
  --funder <addr>          SimpleFunder funder address
  --owner <addr>           Owner address for contracts (SimpleFunder, SimpleSettler, etc.)
  --relayer-mnemonic <m>   Mnemonic for relayer signers
  --relayer-count <n>      Number of relayer signers (default: 10)
  --skip-relayer           Skip relayer setup phase

LayerZero (optional):
  --lz-endpoint <addr>     LayerZero endpoint address
  --lz-signer <addr>       LayerZero settler signer

Gas Settings:
  --gas-price <gwei>       Gas price in gwei
  --priority-fee <gwei>    Priority fee in gwei (EIP-1559)

Verification:
  --verify                 Verify contracts on block explorer
  --etherscan-key <key>    Etherscan API key (overrides env)

Other:
  --dry-run                Simulate without broadcasting
  --resume                 Skip contracts that are already deployed
  --help                   Show this help message

Examples:
  # Local development
  $0 local

  # Dev (Base Sepolia) with keystore (interactive password prompt)
  $0 dev --account deployer

  # Dev with keystore and password
  $0 dev --account deployer --password "mypassword"

  # Prod with Ledger and verification
  $0 prod --ledger "m/44'/60'/0'/0/0" --verify

  # Deploy to Optimism
  $0 --chain 10 --contracts SimpleSettler --account deployer

  # Deploy to multiple chains
  $0 --chain 10,42161 --contracts Orchestrator --account deployer

  # Custom configuration
  $0 --chain 8453 --funder 0x123... --owner 0x456... --skip-relayer --account deployer

  # Deploy specific contracts without relayer setup
  $0 dev --contracts SimpleFunder,SimpleSettler --skip-relayer --account deployer

EOF
    exit 1
}

# =============================================================================
# ARGUMENT PARSING
# =============================================================================
CHAINS=""
RPC_URL_INPUT=""
CONTRACTS=""
CONTEXT=""
ACCOUNT=""
PASSWORD=""
LEDGER=""
PRIVATE_KEY=""
SENDER=""
FUNDER=""
OWNER=""
RELAYER_MNEMONIC=""
RELAYER_COUNT=""
SKIP_RELAYER=""
LZ_ENDPOINT=""
LZ_SIGNER=""
GAS_PRICE=""
PRIORITY_FEE=""
VERIFY=""
ETHERSCAN_KEY=""
DRY_RUN=""
RESUME=""

# Check for environment shortcut as first arg
case "${1:-}" in
    local|dev|stage|prod)
        ENV_SHORTCUT="$1"
        shift
        ;;
    --*|"")
        ENV_SHORTCUT=""
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo -e "${RED}Unknown environment or option: $1${NC}"
        usage
        ;;
esac

while [[ $# -gt 0 ]]; do
    case $1 in
        --chain)
            CHAINS="$2"
            shift 2
            ;;
        --rpc)
            RPC_URL_INPUT="$2"
            shift 2
            ;;
        --contracts)
            CONTRACTS="$2"
            shift 2
            ;;
        --context)
            CONTEXT="$2"
            shift 2
            ;;
        --account)
            ACCOUNT="$2"
            shift 2
            ;;
        --password)
            PASSWORD="$2"
            shift 2
            ;;
        --ledger)
            LEDGER="$2"
            shift 2
            ;;
        --private-key)
            PRIVATE_KEY="$2"
            shift 2
            ;;
        --sender)
            SENDER="$2"
            shift 2
            ;;
        --funder)
            FUNDER="$2"
            shift 2
            ;;
        --owner)
            OWNER="$2"
            shift 2
            ;;
        --relayer-mnemonic)
            RELAYER_MNEMONIC="$2"
            shift 2
            ;;
        --relayer-count)
            RELAYER_COUNT="$2"
            shift 2
            ;;
        --skip-relayer)
            SKIP_RELAYER="true"
            shift
            ;;
        --lz-endpoint)
            LZ_ENDPOINT="$2"
            shift 2
            ;;
        --lz-signer)
            LZ_SIGNER="$2"
            shift 2
            ;;
        --gas-price)
            GAS_PRICE="$2"
            shift 2
            ;;
        --priority-fee)
            PRIORITY_FEE="$2"
            shift 2
            ;;
        --verify)
            VERIFY="true"
            shift
            ;;
        --etherscan-key)
            ETHERSCAN_KEY="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN="true"
            shift
            ;;
        --resume)
            RESUME="true"
            shift
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# =============================================================================
# RESOLVE ENVIRONMENT SHORTCUTS
# =============================================================================
if [[ -n "$ENV_SHORTCUT" ]]; then
    case "$ENV_SHORTCUT" in
        local)
            CHAINS="${CHAINS:-31337,41337}"
            CONTEXT="${CONTEXT:-local}"
            PRIVATE_KEY="${PRIVATE_KEY:-${LOCAL_PRIVATE_KEY:-$DEFAULT_LOCAL_PRIVATE_KEY}}"
            RELAYER_MNEMONIC="${RELAYER_MNEMONIC:-${RELAYER_MNEMONIC:-$DEFAULT_RELAYER_MNEMONIC}}"
            ;;
        dev)
            CHAINS="${CHAINS:-84532}"
            CONTEXT="${CONTEXT:-dev}"
            RELAYER_MNEMONIC="${RELAYER_MNEMONIC:-${DEV_RELAYER_MNEMONIC:-}}"
            FUNDER="${FUNDER:-${DEV_FUNDER:-}}"
            OWNER="${OWNER:-${DEV_DEPLOYER_ADDRESS:-}}"
            ;;
        stage)
            CHAINS="${CHAINS:-8453}"
            CONTEXT="${CONTEXT:-stage}"
            RELAYER_MNEMONIC="${RELAYER_MNEMONIC:-${STAGE_RELAYER_MNEMONIC:-}}"
            FUNDER="${FUNDER:-${STAGE_FUNDER:-}}"
            OWNER="${OWNER:-${STAGE_DEPLOYER_ADDRESS:-}}"
            ;;
        prod)
            CHAINS="${CHAINS:-8453}"
            CONTEXT="${CONTEXT:-prod}"
            RELAYER_MNEMONIC="${RELAYER_MNEMONIC:-${PROD_RELAYER_MNEMONIC:-}}"
            FUNDER="${FUNDER:-${PROD_FUNDER:-}}"
            OWNER="${OWNER:-${PROD_DEPLOYER_ADDRESS:-}}"
            ;;
    esac
fi

# =============================================================================
# VALIDATION
# =============================================================================
if [[ -z "$CHAINS" ]]; then
    echo -e "${RED}Error: No chain specified. Use environment shortcut or --chain${NC}"
    usage
fi

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================
get_default_rpc() {
    local chain_id="$1"
    case "$chain_id" in
        31337) echo "$DEFAULT_RPC_31337" ;;
        41337) echo "$DEFAULT_RPC_41337" ;;
        84532) echo "${RPC_84532:-$DEFAULT_RPC_84532}" ;;
        8453)  echo "${RPC_8453:-$DEFAULT_RPC_8453}" ;;
        10)    echo "${RPC_10:-$DEFAULT_RPC_10}" ;;
        42161) echo "${RPC_42161:-$DEFAULT_RPC_42161}" ;;
        137)   echo "${RPC_137:-$DEFAULT_RPC_137}" ;;
        *)     echo "" ;;
    esac
}

get_default_context() {
    local chain_id="$1"
    case "$chain_id" in
        31337) echo "local" ;;
        41337) echo "local" ;;
        84532) echo "dev" ;;
        8453)  echo "prod" ;;
        10)    echo "optimism" ;;
        42161) echo "arbitrum" ;;
        137)   echo "polygon" ;;
        *)     echo "chain-$chain_id" ;;
    esac
}

get_chain_name() {
    local chain_id="$1"
    case "$chain_id" in
        31337) echo "Local Base" ;;
        41337) echo "Local Arbitrum" ;;
        84532) echo "Base Sepolia" ;;
        8453)  echo "Base Mainnet" ;;
        10)    echo "Optimism" ;;
        42161) echo "Arbitrum One" ;;
        137)   echo "Polygon" ;;
        *)     echo "Chain $chain_id" ;;
    esac
}

setup_local_anvil() {
    local rpc="$1"
    echo -e "${YELLOW}Setting up local Anvil...${NC}"

    # Multicall3 - use pre-compiled bytecode (no Multicall3.sol in this repo)
    local multicall3_addr="0xcA11bde05977b3631167028862bE2a173976CA11"
    local multicall3_code
    multicall3_code=$(cat "$PROJECT_ROOT/scripts/sol/common/bytecodes/multicall3.txt")
    cast rpc anvil_setCode "$multicall3_addr" "$multicall3_code" --rpc-url "$rpc" > /dev/null
    echo "  Multicall3: $multicall3_addr"

    # USDC (MockUSDC) - use pre-compiled bytecode for reliability
    local usdc_addr="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    local usdc_code
    usdc_code=$(cat "$PROJECT_ROOT/scripts/sol/common/bytecodes/usdc.txt")
    cast rpc anvil_setCode "$usdc_addr" "$usdc_code" --rpc-url "$rpc" > /dev/null
    echo "  USDC: $usdc_addr"

    # Mine a block
    cast rpc anvil_mine 1 --rpc-url "$rpc" > /dev/null

    echo -e "${GREEN}Local Anvil setup complete${NC}"
    echo ""
}

deploy_to_chain() {
    local chain_id="$1"
    local rpc="$2"
    local context="$3"

    local chain_name
    chain_name=$(get_chain_name "$chain_id")

    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Deploying to $chain_name (chain $chain_id)${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Setup local Anvil if needed
    if [[ "$chain_id" == "31337" || "$chain_id" == "41337" ]]; then
        setup_local_anvil "$rpc"
    fi

    # Build auth args
    local auth_args=""
    if [[ -n "$LEDGER" ]]; then
        # Use printf %q to properly escape for shell re-evaluation
        auth_args="--ledger --hd-paths $(printf "$LEDGER")"
    elif [[ -n "$ACCOUNT" ]]; then
        auth_args="--account $ACCOUNT"
        if [[ -n "$PASSWORD" ]]; then
            auth_args="$auth_args --password $PASSWORD"
        fi
    elif [[ -n "$PRIVATE_KEY" ]]; then
        auth_args="--private-key $PRIVATE_KEY"
    elif [[ "$chain_id" == "31337" || "$chain_id" == "41337" ]]; then
        auth_args="--private-key $DEFAULT_LOCAL_PRIVATE_KEY"
    else
        echo -e "${RED}Error: Authentication required. Use --account, --ledger, or --private-key${NC}"
        exit 1
    fi

    # Build script signature
    local script_sig script_args
    if [[ -n "$CONTRACTS" ]]; then
        script_sig="runSelective(uint256[],string)"
        script_args="\"[$chain_id]\" \"$CONTRACTS\""
    else
        script_sig="run(uint256[])"
        script_args="\"[$chain_id]\""
    fi

    # Export environment variables for the Solidity script
    export SAVE_DEPLOYMENTS=1
    export DEPLOYMENT_CONTEXT="$context"
    export RPC_URL="$rpc"
    export RELAYER_COUNT="${RELAYER_COUNT:-$DEFAULT_RELAYER_COUNT}"

    # Relayer setup
    if [[ -n "$SKIP_RELAYER" ]]; then
        export RELAYER_MNEMONIC=""
    else
        export RELAYER_MNEMONIC="${RELAYER_MNEMONIC:-}"
    fi

    # Contract configuration
    export FUNDER="${FUNDER:-}"
    export DEPLOYER_ADDRESS="${OWNER:-}"

    # LayerZero
    export LZ_ENDPOINT="${LZ_ENDPOINT:-}"
    export LZ_SETTLER_SIGNER="${LZ_SIGNER:-0x0000000000000000000000000000000000000000}"

    # Build forge command
    local forge_cmd="forge script scripts/sol/DeployUnified.s.sol:DeployUnified"
    forge_cmd="$forge_cmd --rpc-url $rpc"
    forge_cmd="$forge_cmd --sig \"$script_sig\" $script_args"
    forge_cmd="$forge_cmd --ffi"
    forge_cmd="$forge_cmd $auth_args"

    # Sender address
    if [[ -n "$SENDER" ]]; then
        forge_cmd="$forge_cmd --sender $SENDER"
    fi

    # Gas settings
    if [[ -n "$GAS_PRICE" ]]; then
        forge_cmd="$forge_cmd --gas-price ${GAS_PRICE}gwei"
    fi
    if [[ -n "$PRIORITY_FEE" ]]; then
        forge_cmd="$forge_cmd --priority-gas-price ${PRIORITY_FEE}gwei"
    fi

    # Verification
    if [[ -n "$VERIFY" ]]; then
        forge_cmd="$forge_cmd --verify"
        if [[ -n "$ETHERSCAN_KEY" ]]; then
            forge_cmd="$forge_cmd --etherscan-api-key $ETHERSCAN_KEY"
        elif [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
            forge_cmd="$forge_cmd --etherscan-api-key $ETHERSCAN_API_KEY"
        fi
    fi

    # Broadcast
    if [[ -z "$DRY_RUN" ]]; then
        forge_cmd="$forge_cmd --broadcast"
    fi

    # Resume (skip deployed)
    if [[ -n "$RESUME" ]]; then
        forge_cmd="$forge_cmd --resume"
    fi

    echo -e "${YELLOW}Command: $forge_cmd${NC}"
    echo ""

    eval "$forge_cmd"

    echo -e "${GREEN}✅ Deployment complete for $chain_name${NC}"
    echo ""
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================
echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║           Agentic Payments Deployment Script                 ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Parse chain list
IFS=',' read -ra CHAIN_ARRAY <<< "$CHAINS"

# Show deployment plan
echo -e "${YELLOW}Deployment Plan:${NC}"
echo "  Chains: ${CHAIN_ARRAY[*]}"
echo "  Contracts: ${CONTRACTS:-all}"
echo "  Context: ${CONTEXT:-auto}"
[[ -n "$SKIP_RELAYER" ]] && echo "  Relayer setup: skipped"
[[ -n "$VERIFY" ]] && echo "  Verification: enabled"
[[ -n "$DRY_RUN" ]] && echo "  Mode: dry-run (no broadcast)"
[[ -n "$RESUME" ]] && echo "  Resume: enabled"
echo ""

# Deploy to each chain
for chain_id in "${CHAIN_ARRAY[@]}"; do
    # Trim whitespace
    chain_id=$(echo "$chain_id" | xargs)

    # Resolve RPC URL
    local_rpc="$RPC_URL_INPUT"
    if [[ -z "$local_rpc" ]]; then
        local_rpc=$(get_default_rpc "$chain_id")
    fi
    if [[ -z "$local_rpc" ]]; then
        echo -e "${RED}Error: No RPC URL for chain $chain_id. Use --rpc to specify.${NC}"
        exit 1
    fi

    # Resolve context
    local_context="$CONTEXT"
    if [[ -z "$local_context" ]]; then
        local_context=$(get_default_context "$chain_id")
    fi

    deploy_to_chain "$chain_id" "$local_rpc" "$local_context"
done

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              All deployments complete! 🎉                  ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
