---
module: relayer
date: 2026-02-26
problem_type: integration_issue
component: polygon_signer_pool
symptoms:
  - "Polygon wallets intermittently reported `wallet_ready` failures while other capabilities looked healthy"
  - "13 transactions stayed in `pending` without naturally progressing to `confirmed` or `failed`"
  - "Queue monitor retries could recycle messages without a durable terminal path when finalization callbacks failed"
  - "Cloudflare Worker local config drifted from dashboard settings (workers_dev/observability mismatch)"
root_cause: multi_factor_integration_regression
resolution_type: code_fix
severity: high
tags: [relayer, polygon, signer-pool, durable-objects, replacement-policy, queue-retries, cloudflare-workers]
---

# Troubleshooting: Polygon `wallet_ready` Flapping and Long-Lived Pending Transactions

## Problem
Production relayer behavior showed a combined reliability issue: Polygon wallet readiness intermittently failed, and a backlog of pending transactions did not drain as expected.

## Environment
- Module: `packages/relayer`
- Affected Components:
  - RPC health/readiness checks
  - Signer Durable Object replacement policy
  - Queue monitor retry/finalization flow
  - Worker runtime configuration
- Date: 2026-02-26

## Symptoms
- `wallet_ready` could fail while `wallet_getCapabilities` still returned valid responses.
- Polygon queue accumulated 13 `pending` items.
- Some transactions remained pending beyond expected replacement progression.
- Wrangler warned local config differed from remote dashboard observability settings.

## Investigation Summary
1. Queried prod relayer endpoints and compared readiness vs capabilities behavior.
2. Correlated failures with worker logs and tail output, including intermittent SignerPool DO status failures.
3. Reviewed recent transaction replacement changes and traced regression to the non-trigger replacement path.
4. Re-ran focused tests after each fix to validate behavior.

## What Didn’t Work

**Attempted Solution 1:** Treat readiness as equivalent to capability checks.
- **Why it failed:** Capability endpoints could still respond while signer-pool readiness was failing for the specific pool path.

**Attempted Solution 2:** Wait for pending transactions to self-resolve.
- **Why it failed:** Non-trigger replacement path did not force terminalization after attempts were exhausted.

**Attempted Solution 3:** Rely on queue message body attempt counters.
- **Why it failed:** Body values are not the authoritative retry source for Cloudflare queue delivery lifecycle.

## Solution
Implemented a coordinated fix set across readiness, replacement, retries, tests, and runtime config.

1. **Fixed readiness pool routing**
- Updated health signer-pool probe to use per-chain pool query:
  - from: `http://do/status`
  - to: `http://do/status?poolName=pool-${chainId}`
- Added health test coverage for the `poolName` parameter.

2. **Fixed non-trigger replacement terminalization**
- Added logic for non-trigger replacement outcomes so retries increment and eventually mark transactions `stuck` instead of indefinite `pending`.
- Wired this path into signer DO transaction progression.
- Added targeted replacement-policy tests for exhausted non-trigger scenarios.

3. **Hardened queue monitor retry/finalization**
- Switched retry accounting to Cloudflare-provided `msg.attempts` (authoritative).
- Added max monitor attempts guard (`MAX_MONITOR_ATTEMPTS = 30`).
- Added explicit terminal path when attempts are exhausted and no receipt exists:
  - call signer `/finalized` with failed status
  - ack only after successful finalization callback
  - otherwise retry message
- Hardened receipt-present path so finalization callback failure causes retry.

4. **Aligned worker config with prod dashboard**
- Updated `wrangler.toml` to match prod dashboard for:
  - `workers_dev = true`
  - observability enabled
  - log sampling enabled at configured rate

5. **Strengthened regression tests**
- Added/expanded tests to ensure behavior is not shallow:
  - `msg.attempts` precedence over body attempt fields
  - exhausted retry path finalizes then acks
  - callback failure paths retry rather than falsely ack
  - replacement policy non-trigger exhaustion transitions out of indefinite pending

## Why This Works
1. Readiness now checks the correct chain pool, removing false-negative pool lookups.
2. Replacement flow now has a deterministic terminal condition for non-trigger paths.
3. Queue retries now use platform-native attempt state and enforce bounded retries.
4. Finalization callback reliability is enforced before ack, preventing silent dropped final states.
5. Config parity removes environment drift that obscures diagnosis.

## Validation
Commands run during fixes:

```bash
bun run test:run -- test/signer-replacement-policy.test.ts test/signer-tx-status-mapping.test.ts
bun run test:run -- test/queue.monitor-retry.test.ts test/queue.retired-jobs.test.ts
wrangler deploy --dry-run
```

Results:
- Replacement policy and status mapping tests passed.
- Queue retry/finalization tests passed.
- Wrangler dry-run no longer reported the previous local-vs-remote config mismatch block.

## Prevention
- Keep readiness checks chain-scoped when signer pools are partitioned by chain.
- Require bounded retry + explicit terminalization for every monitor/replacement state machine path.
- Prefer provider/runtime attempt counters over mutable payload attempt fields.
- Add prod-safe telemetry parity checks to release checklist (wrangler config vs dashboard settings).
- Treat `pending` growth alerts as SLO signals and investigate before backlog compaction is needed.

## Related Issues
- Existing relayer-cli integration troubleshooting reference:
  - [relayer account send simulation/revert failures](./relayer-cli-account-send-simulation-failed-20260219.md)
