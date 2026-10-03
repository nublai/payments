---
title: "relayer: polygon submissions accepted but tx hashes missing on-chain"
type: incident
date: 2026-02-27
category: integration-issues
tags:
  - relayer
  - polygon
  - nonce
  - rpc
  - cloudflare-workers
status: solved
---

# relayer: polygon submissions accepted but tx hashes missing on-chain

## Summary
On production relayer, Polygon transactions were intermittently submitted (`intent submitted successfully`) but corresponding tx hashes were not visible on Polygon public RPC/PolygonScan. Signer capacity on `signer-137-0` accumulated pending rows and monitor jobs eventually exhausted retries.

## Symptoms
- `wallet_getCapabilities` showed Polygon signer pending growth on `0x277b7440CE050d9e9e428d1f349E51D468c7eB7E`.
- `wallet_getCallsStatus` stayed at `status=100` (pending) with empty receipts.
- Monitor queue logs showed:
  - `monitor retries exhausted without receipt`
  - terminal failures after attempt 30.
- `wallet_upgradeAccount` path hit `WaitForTransactionReceiptTimeoutError` (60s).
- Public Polygon RPC + PolygonScan returned `null` / “Transaction Hash not found” for relayer-produced hashes.

## Investigation Timeline
1. Queried prod `wallet_getCapabilities`; identified signer addresses and Polygon pending imbalance.
2. Checked last tx times on PolygonScan for both signers; observed stale signer-A activity.
3. Validated relayer timeout semantics:
   - monitor retries with capped attempts,
   - separate 60s wait in upgrade flow.
4. Added temporary debug visibility to `wallet_getCapabilities` (`debugSigners=true`) to expose signer pending rows and replacement metadata.
5. Identified concrete stuck tx IDs/hashes/nonces for signer-137-0.
6. Built temporary gated admin reconcile endpoint to retire orphaned pending rows and resync nonce.
7. Ran reconcile, verified pending dropped to 0 and old bundles transitioned to failed.
8. Updated Polygon RPC configuration and re-tested.
9. Confirmed fresh Polygon tx finalized successfully in logs:
   - `transaction finalized` with `chainId: 137`.

## Root Cause
Primary: RPC integration behavior for Polygon path produced tx hashes that did not propagate to canonical/public Polygon visibility, causing receipt polling to stall.

Compounding factors:
- Signer DO maintained pending/replacing rows for missing hashes, reducing capacity and creating perceived nonce blockage.
- Deterministic routing kept affected flows on signer-137-0 while pending rows were active.

Important nuance:
- Public on-chain nonce parity (`latest == pending`) indicated no active canonical mempool backlog even while relayer had local pending rows.

## Fix Implemented
### 1) Debug observability (temporary)
- Extended `wallet_getCapabilities` with optional `debugSigners` parameter.
- Returned signer-level pending rows:
  - `id`, `txHash`, `nonce`, `status`, `sentAt`, `queued`, `replacementAttempts`, `lastReplacementAt`.

### 2) Admin reconcile (temporary, gated)
- Added `wallet_debugReconcileSigner` with strict gates:
  - `DEBUG_RECONCILE_ENABLED=true`
  - `x-relayer-debug-token` must match `DEBUG_RECONCILE_TOKEN`
- Added internal SignerDO route `/debug/reconcile`:
  - dry-run support,
  - retire selected/all `pending|replacing` rows as `abandoned`,
  - atomic signer nonce recalculation from chain pending nonce + remaining local pending max.

### 3) Operational recovery
- Reconciled orphaned rows on signer-137-0.
- Updated Polygon RPC config.
- Verified new Polygon transaction successfully finalized.

## Validation Evidence
- Before reconcile: signer-137-0 showed pending rows with nonces ahead of public chain visibility.
- After reconcile: `pending=0`, full capacity restored.
- After RPC update + retest: observed successful Polygon finalize (`status=confirmed`) in wrangler tail.

## Runbook (if it reoccurs)
1. Confirm symptom:
   - `wallet_getCapabilities` with `debugSigners=true` on `0x89`.
2. For each pending `txHash`, check:
   - `eth_getTransactionByHash`
   - `eth_getTransactionReceipt`
   - PolygonScan visibility.
3. If hashes are missing externally and pending rows accumulate:
   - run `wallet_debugReconcileSigner` in `dryRun=true`,
   - apply reconcile for targeted tx IDs.
4. Recheck:
   - signer pending count/capacity,
   - `wallet_getCallsStatus` transitions,
   - fresh tx submit -> finalize in logs.
5. Disable debug gates after incident.

## Prevention
- Keep failover/health checks for `RPC_137` provider path.
- Alert when signer pending count grows while public tx visibility is absent.
- Maintain short-lived incident-only debug endpoint pattern with explicit env/token gates.
- Prefer retiring/debug tooling on branch; avoid merging to main unless ongoing need.

## Related Changes
- Commit: `0afa6ee9f7` (`relayer: add temporary signer reconcile debug tooling`)
- Files touched include:
  - signer DO reconcile route,
  - `wallet_debugReconcileSigner` RPC method,
  - capabilities debug signer payload,
  - tests for both paths.

## Cleanup Plan
- If stable for a full monitoring window, remove or revert temporary debug endpoint and env vars:
  - `DEBUG_RECONCILE_ENABLED`
  - `DEBUG_RECONCILE_TOKEN`
- Keep this document as historical incident reference.
