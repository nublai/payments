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

# Drop inherited Foundry and Dapp settings, then set only what this script uses.
# A caller FOUNDRY_* or DAPP_* value must not change the release bytecode.
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

# Refuse forge script flags that change bytecode after the size check.
refuse_bytecode_changing_flags() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            --optimize|--optimize=*|--optimizer-runs|--optimizer-runs=*|--via-ir|--evm-version|--evm-version=*|--out|--out=*|-o|--contracts|--contracts=*|-C|--use|--use=*|--no-cbor-metadata|--cbor-metadata|--cbor-metadata=*|--bytecode-hash|--bytecode-hash=*|--revert-strings|--revert-strings=*|--use-literal-content|--extra-output|--extra-output=*|--deny|--deny=*|--skip|--skip=*|--libraries|--libraries=*|--remappings|--remappings=*|--hh|--ast|--build-info|--build-info-path|--build-info-path=*|--root|--root=*)
                echo -e "${RED}Error: refusing forge flag ${arg} after the size check${NC}" >&2
                exit 1
                ;;
        esac
    done
}

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
  --help                   Show this help message

--resume is refused. forge script --resume rebroadcasts stored initcode and
does not compare it to the release artifact.

Compiler:
  Inherited FOUNDRY_* and DAPP_* variables are unset. FOUNDRY_PROFILE=release
  is then set for forge build and forge script. Runtime bytecode must be
  <= 24576 bytes or the script exits before broadcast. Forge flags that
  change bytecode (--optimize, --via-ir, --evm-version, --out, and similar)
  are refused.

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
            echo -e "${RED}Error: refusing --resume. forge script --resume rebroadcasts stored initcode and does not compare it to the release artifact.${NC}" >&2
            exit 1
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

    # Build auth args as separate words. Values are not passed through eval.
    local -a auth_args=()
    if [[ -n "$LEDGER" ]]; then
        auth_args=(--ledger --hd-paths "$LEDGER")
    elif [[ -n "$ACCOUNT" ]]; then
        auth_args=(--account "$ACCOUNT")
        if [[ -n "$PASSWORD" ]]; then
            auth_args+=(--password "$PASSWORD")
        fi
    elif [[ -n "$PRIVATE_KEY" ]]; then
        auth_args=(--private-key "$PRIVATE_KEY")
    elif [[ "$chain_id" == "31337" || "$chain_id" == "41337" ]]; then
        auth_args=(--private-key "$DEFAULT_LOCAL_PRIVATE_KEY")
    else
        echo -e "${RED}Error: Authentication required. Use --account, --ledger, or --private-key${NC}"
        exit 1
    fi

    # Build script signature. Constructor-style args are added as their own words later.
    local script_sig
    if [[ -n "$CONTRACTS" ]]; then
        script_sig="runSelective(uint256[],string)"
    else
        script_sig="run(uint256[])"
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

    # Each value is one array element. Spaces and metacharacters are not evaluated.
    local -a forge_cmd=(
        forge
        script
        scripts/sol/DeployUnified.s.sol:DeployUnified
        --rpc-url "$rpc"
        --sig "$script_sig"
    )
    if [[ -n "$CONTRACTS" ]]; then
        forge_cmd+=("[$chain_id]" "$CONTRACTS")
    else
        forge_cmd+=("[$chain_id]")
    fi
    forge_cmd+=(--ffi)
    forge_cmd+=("${auth_args[@]}")

    if [[ -n "$SENDER" ]]; then
        forge_cmd+=(--sender "$SENDER")
    fi
    if [[ -n "$GAS_PRICE" ]]; then
        forge_cmd+=(--gas-price "${GAS_PRICE}gwei")
    fi
    if [[ -n "$PRIORITY_FEE" ]]; then
        forge_cmd+=(--priority-gas-price "${PRIORITY_FEE}gwei")
    fi
    if [[ -n "$VERIFY" ]]; then
        forge_cmd+=(--verify)
        if [[ -n "$ETHERSCAN_KEY" ]]; then
            forge_cmd+=(--etherscan-api-key "$ETHERSCAN_KEY")
        elif [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
            forge_cmd+=(--etherscan-api-key "$ETHERSCAN_API_KEY")
        fi
    fi
    if [[ -z "$DRY_RUN" ]]; then
        forge_cmd+=(--broadcast)
    fi

    refuse_bytecode_changing_flags "${forge_cmd[@]}"

    echo -e "${YELLOW}Command:$(printf ' %q' "${forge_cmd[@]}")${NC}"
    echo ""

    "${forge_cmd[@]}"

    if [[ -z "$DRY_RUN" ]]; then
        verify_release_runtimes "$chain_id" "$context" "$rpc"
    fi

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
echo "  Compiler: FOUNDRY_PROFILE=release"
[[ -n "$SKIP_RELAYER" ]] && echo "  Relayer setup: skipped"
[[ -n "$VERIFY" ]] && echo "  Verification: enabled"
[[ -n "$DRY_RUN" ]] && echo "  Mode: dry-run (no broadcast)"
echo ""

# Compare non-zero deployment JSON to the release runtime. Zero addresses and
# empty code are skipped. AccountProxy is not the Account artifact.
# Immutables are masked by match-release-runtime.py.
verify_release_runtimes() {
    local chain_id="$1"
    local context="$2"
    local rpc="$3"
    local dir="$PROJECT_ROOT/deployments/envs/$context/$chain_id"
    local file stem name addr code result
    [[ -d "$dir" ]] || return 0
    shopt -s nullglob
    for file in "$dir"/*.json; do
        stem="$(basename "$file" .json)"
        case "$stem" in
            account) name="Account" ;;
            orchestrator) name="Orchestrator" ;;
            simulator) name="Simulator" ;;
            escrow) name="Escrow" ;;
            multiSigSigner) name="MultiSigSigner" ;;
            simpleFunder) name="SimpleFunder" ;;
            simpleSettler) name="SimpleSettler" ;;
            layerZeroSettler) name="LayerZeroSettler" ;;
            *) continue ;;
        esac
        addr="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' "$file")"
        addr="${addr,,}"
        if [[ "$addr" == "0x0000000000000000000000000000000000000000" ]]; then
            continue
        fi
        code="$(cast code "$addr" --rpc-url "$rpc")"
        if [[ -z "$code" || "$code" == "0x" ]]; then
            continue
        fi
        result="$(python3 "$SCRIPT_DIR/match-release-runtime.py" "$PROJECT_ROOT/out/${name}.sol/${name}.json" "$code")"
        if [[ "$result" != "match" ]]; then
            echo -e "${RED}Error: ${name} at ${addr} on-chain code hash does not match the release artifact${NC}" >&2
            exit 1
        fi
        echo "  on-chain code hash matches the release artifact: $name $addr"
    done
    shopt -u nullglob
}

# Foundry fs_permissions follow a symlink inside an allowed directory.
# Refuse those before any forge build or broadcast.
# Residuals, not refused here: a hardlink under deployments/ or deploy/,
# a symlink created after this check, and vm.ffi paths (including `..` and
# absolute paths). CI runs from a fresh checkout.
refuse_deployment_symlinks() {
    local dir link
    for dir in "$PROJECT_ROOT/deployments" "$PROJECT_ROOT/deploy"; do
        if [[ -L "$dir" ]]; then
            echo -e "${RED}Error: refusing symlink $dir${NC}" >&2
            exit 1
        fi
        if [[ ! -d "$dir" ]]; then
            continue
        fi
        while IFS= read -r -d '' link; do
            echo -e "${RED}Error: refusing symlink $link${NC}" >&2
            exit 1
        done < <(find -P "$dir" -type l -print0)
    done
}

refuse_deployment_symlinks

# Release-profile size check before any forge script broadcast.
"$SCRIPT_DIR/check-runtime-size.sh"

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
