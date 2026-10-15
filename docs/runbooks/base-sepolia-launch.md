# Base Sepolia stage launch

First deploy to Base Sepolia (84532), context `stage`. Use `deploy.sh stage`, not `dev`. This is a runbook, not a deploy.

## 1. Prereqs

- Foundry 1.5.1 (`forge --version`). CI pins this.
- A deployer key (`--account`, `--ledger`, or `--private-key`). `--sender` is not enough.
- `--owner <addr>` (or `STAGE_OWNER`). Required outside local. Must not be the deployer or `--funder`.
- `ETHERSCAN_API_KEY` if you pass `--verify`. `foundry.toml` omits a custom explorer URL so Foundry 1.5 uses Etherscan V2 (`chainid=84532`).
- Deployer funded on Base Sepolia. RPC is `RPC_84532`, or `https://sepolia.base.org` if unset.

From `packages/contracts`.

## 2. Dry run first

```bash
./scripts/sh/deploy.sh stage --owner 0x... --account deployer --dry-run
```

`--dry-run` drops `--broadcast` and unsets `SAVE_DEPLOYMENTS`. It does not write `deployments/`.

`DeployUnified` only writes JSON when `SAVE_DEPLOYMENTS` is true. `deploy.sh` exports that only on broadcast. A hand-run of `DeployUnified` without `deploy.sh` needs `SAVE_DEPLOYMENTS=1` to save.

## 3. Broadcast

```bash
./scripts/sh/deploy.sh stage --owner 0x... --skip-relayer --account deployer --verify
```

`--skip-relayer` is required outside local when a mnemonic is set (`STAGE_RELAYER_MNEMONIC` or `--relayer-mnemonic`). Pass it on stage. Relayer setup is owner-only and the script would send it from the deployer.

`--resume` is refused. A partial broadcast can still write addresses into `deployments/envs/stage/84532/` for transactions that never landed. Check `cast code <addr> --rpc-url "${RPC_84532:-https://sepolia.base.org}"` before rerunning. Empty code means do not treat that JSON as live.

## 4. Owner: SimpleFunder wallets and ETH

`setGasWallet` and `setOrchestrators` are `onlyOwner` (`SimpleFunder.sol`). The owner signs. Derive the same HD path the relayer uses (`m/44'/60'/0'/0/{i}`, `SignerDO` / `vm.deriveKey`). Use the worker's `RELAYER_COUNT` (default `1`). `deploy.sh` defaults to `10`; do not whitelist 10 if the worker only uses 1.

```bash
RPC="${RPC_84532:-https://sepolia.base.org}"
SIMPLE_FUNDER="$(python3 -c 'import json; print(json.load(open("deployments/envs/stage/84532/simpleFunder.json"))["address"])')"
ORCH="$(python3 -c 'import json; print(json.load(open("deployments/envs/stage/84532/orchestrator.json"))["address"])')"
COUNT="${RELAYER_COUNT:-1}"

SIGNERS=()
for i in $(seq 0 $((COUNT - 1))); do
  SIGNERS+=("$(cast wallet address --mnemonic "$RELAYER_MNEMONIC" --mnemonic-derivation-path "m/44'/60'/0'/0/${i}")")
done
IFS=,
cast send "$SIMPLE_FUNDER" "setGasWallet(address[],bool)" "[${SIGNERS[*]}]" true \
  --rpc-url "$RPC" --account <owner-keystore>
cast send "$SIMPLE_FUNDER" "setOrchestrators(address[],bool)" "[$ORCH]" true \
  --rpc-url "$RPC" --account <owner-keystore>
```

Then fund SimpleFunder (it has `receive() payable`; `pullGas` draws from this pot) and each gas wallet (the signer pays for the `pullGas` tx itself). Without both, signer refill stays at `MIN_SIGNER_BALANCE` / `TARGET_SIGNER_BALANCE` (default 0.01 ETH).

```bash
cast send "$SIMPLE_FUNDER" --value 0.05ether --rpc-url "$RPC" --account deployer
cast send "${SIGNERS[0]}" --value 0.02ether --rpc-url "$RPC" --account deployer
```

## 5. Relayer order

The worker reads `@nubl/contracts` `dist/`, not the raw env JSON. Set the secrets in §6 (and delete a leftover `CONTEXT` secret) before `wrangler deploy`.

```bash
bun run --cwd packages/contracts make-config
# commit deployments/envs/stage/84532/*.json and deployments/addresses.json
# (not the gitignored envs/stage/.env files)
bun run --cwd packages/contracts build
cd packages/relayer
wrangler deploy --env stage
```

First time, also `wrangler queues create relayer-monitor-queue-stage`.

## 6. Relayer stage secrets

Set before deploy. `CHAIN_IDS=84532` only. Stage JSON for 137 / 8453 is zero; including those ids fails `validateEnv`.

```bash
wrangler secret put CHAIN_IDS --env stage          # 84532
wrangler secret put FEE_RECIPIENT --env stage      # required; startup refuses missing or zero
wrangler secret put QUOTE_SIGNING_SECRET --env stage
wrangler secret put RELAYER_MNEMONIC --env stage
wrangler secret put RPC_URL --env stage            # or RPC_84532
wrangler secret put RPC_84532 --env stage
```

`wrangler.toml` `[env.stage]` sets `PRIVY_ENABLED=true` and `CONTEXT=stage`. That requires `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, or set `PRIVY_ENABLED=false`.

`CONTEXT` is a var, not a secret. A leftover CONTEXT secret and the var cannot share a name (Cloudflare 10053). Before deploying:

```bash
wrangler secret delete CONTEXT --env stage
```

`MIN_SIGNER_BALANCE`: SignerDO treats a value with `.` as ETH and a value without `.` as wei. `MIN_SIGNER_BALANCE=1` is 1 wei, not 1 ETH. Example: `10000000000000000` is 0.01 ETH. Unset keeps that 0.01 ETH default. Startup `validatePoolConfig` also requires an integer (wei); `0.01` is refused.

## 7. Wallet CLI

```bash
export RELAYER_URL_STAGE=https://<worker-host>
tw --env stage
```

`--env stage` defaults to `base-sepolia` (84532). RPC is `RPC_84532`, or `https://sepolia.base.org`. Optional: `--chain base-sepolia`.

## 8. Verify

`deploy.sh` already runs `VerifyRelease` after broadcast. To run it again:

```bash
DEPLOYMENT_CONTEXT=stage DEPLOYER_ADDRESS="$OWNER" \
  FUNDER="${STAGE_FUNDER:-}" \
  forge script scripts/sol/VerifyRelease.s.sol:VerifyRelease \
  --rpc-url "${RPC_84532:-https://sepolia.base.org}" \
  --sig "run(uint256)" 84532 --ffi
```

`DEPLOYER_ADDRESS` is the `--owner` used at deploy. Set `FUNDER` if `--funder` / `STAGE_FUNDER` was set.

Explorer verify is `--verify` on `deploy.sh`, or later `forge verify-contract --chain 84532 <addr> <Contract>` with `ETHERSCAN_API_KEY`.
