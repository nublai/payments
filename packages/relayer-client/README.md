# @nubl/relayer-client

A slim, viem-style SDK for EIP-7702 relayer workflows.

The package intentionally has two layers:

- Low-level actions (`prepareCalls`, `sendPreparedCalls`, `getKeys`, `waitForBundle`) for full control.
- Optional DX helpers (`createRelayerClient`, `getChainKeys`, `signPreparedCalls`, `executePreparedCalls`) for common delegated-account flows.

## Installation

```bash
bun add @nubl/relayer-client viem
```

## Quick Start (Low-Level)

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { relayerActions, waitForBundle } from "@nubl/relayer-client";

const client = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
}).extend(
  relayerActions({
    relayerUrl: "https://your-relayer.example.com",
  }),
);

const signerKey = "0x..." as const;
const account = privateKeyToAccount(signerKey);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http("https://mainnet.base.org"),
});

// 1) Ensure account is upgraded/delegated
await client.upgradeAccount({
  accountAddress: account.address,
  signerKey,
  delegation: "0x...AccountProxyAddress",
});

// 2) Prepare
const prepared = await client.prepareCalls({
  from: account.address,
  calls: [
    {
      target: "0x000000000000000000000000000000000000dEaD",
      value: 1_000_000_000_000_000n,
      data: "0x",
    },
  ],
  // optional but recommended for deterministic simulation in delegated flows
  nonce: 0n,
});

// 3) Sign typed data
const signature = await walletClient.signTypedData(prepared.typedData);

// 4) Send
const { id } = await client.sendPreparedCalls({
  context: prepared.context,
  signature,
});

// 5) Wait for terminal status
const finalStatus = await waitForBundle(client, { id });
if (finalStatus.status !== "confirmed") {
  throw new Error(
    `bundle failed: ${finalStatus.receipt?.intentError ?? "unknown"}`,
  );
}
```

## Quick Start (Helper Layer)

```ts
import {
  createRelayerClient,
  executePreparedCalls,
} from "@nubl/relayer-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chainId = 8453;
const rpcUrl = "https://mainnet.base.org";
const relayerUrl = "https://your-relayer.example.com";

const signerKey = "0x..." as const;
const account = privateKeyToAccount(signerKey);

const client = createRelayerClient({
  chainId,
  rpcUrl,
  relayerUrl,
  authSigner: {
    address: account.address,
    chainId,
    signMessage: (message) =>
      account.signMessage({ message: { raw: message } }),
  },
});

const walletClient = createWalletClient({
  account,
  chain: client.chain,
  transport: http(rpcUrl),
});

const execution = await executePreparedCalls({
  client,
  from: account.address,
  calls: [
    {
      target: "0x000000000000000000000000000000000000dEaD",
      value: 1_000_000_000_000_000n,
      data: "0x",
    },
  ],
  signer: {
    type: "typedData",
    signTypedData: (typedData) => walletClient.signTypedData(typedData),
  },
});

console.log(execution.id, execution.finalStatus.status);
```

`createRelayerClient` requires `authSigner` so relayer requests are HTTP-signed.

## Delegated Signer Workflow

When a delegated signer key (session/bot key) signs on behalf of an account:

- Signer must sign an ERC-1271 transformed digest (`computeErc1271Digest`).
- Signature should be wrapped with `wrapSignature` and key hash.
- The new `signPreparedCalls` helper handles this flow. It recomputes the EIP-712 digest (`Orchestrator` / `0.5.5`, the verifying contract, the requested calls, nonce, expiry, and fee caps) and signs that rebuilt typed data. Pass `expected` with `nonce`, `expiry`, and `combinedGasCeiling`. Expiry `0`, a past expiry, an expiry beyond one hour, and combined gas above the ceiling are refused. The quote `paymentAmount` must be within `paymentMaxAmount`.

`upgradeAccount` recomputes the EIP-7702 authorization from the caller chain id, the EOA nonce read on the wallet RPC, and the `delegation` argument. It signs a SignedCall rebuilt from `authorizeKeys`. Pass `orchestrator` (or set `ORCHESTRATOR_<chainId>`).

Relayer URLs must be `https` unless the host is loopback. Pass `allowInsecureHttp` only for local dev. Fetches use `redirect: 'manual'` and refuse a 3xx. On chain 31337, `executePreparedCalls` reads the orchestrator from `ORCHESTRATOR_31337` when `verifyingContract` is omitted, reads the nonce from the account when `nonce` is omitted, and requires `paymentMaxAmount` off local chains.

```ts
import {
  computeKeyHash,
  encodeSecp256k1Key,
  signPreparedCalls,
} from "@nubl/relayer-client";
import { sign } from "viem/accounts";

const signerAddress = "0x..." as const;
const signerPrivateKey = "0x..." as const;
const signerKeyHash = computeKeyHash(
  "secp256k1",
  encodeSecp256k1Key(signerAddress),
);

const signed = await signPreparedCalls({
  prepared,
  signer: {
    type: "delegated",
    signerAddress,
    signerKeyHash,
    signDigest: (digest) =>
      sign({ hash: digest, privateKey: signerPrivateKey }),
  },
});

await client.sendPreparedCalls({
  context: prepared.context,
  signature: signed.signature,
});
```

## Key Lookup Helpers

Use chain-aware key helpers to avoid rewriting chain-id selection and key-hash lookups.

```ts
import { getChainKeys, findAuthorizedKey } from "@nubl/relayer-client";

const keys = await client.getKeys({ address: accountAddress });
const chainKeys = getChainKeys(keys, client.chain.id);
const authorized = findAuthorizedKey(keys, client.chain.id, signerKeyHash);

console.log(chainKeys.length, authorized?.role);
```

## API Overview

### Decorator

- `relayerActions(config)`

### Core Actions

- `checkHealth(client)`
- `getCapabilities(client)`
- `upgradeAccount(client, params)`
- `prepareCalls(client, params)`
- `sendPreparedCalls(client, params)`
- `getCallsStatus(client, params)`
- `getCallsHistory(client, params)`
- `getKeys(client, params)`
- `verifySignature(client, params)`
- `waitForBundle(client, params)`

### Helpers (Phase 1/2 DX layer)

- `createRelayerClient(config)`
- `getChainKeys(keysResponse, chainId)`
- `findAuthorizedKey(keysResponse, chainId, keyHash)`
- `signPreparedCalls(params)`
- `executePreparedCalls(params)`

### Signature Utilities

- `wrapSignature(signature, keyHash, prehash?)`
- `computeErc1271Digest(originalDigest, accountAddress)`
- `computeKeyHash(type, publicKey)`
- `encodeSecp256k1Key(address)`

## Troubleshooting

### 1) Wrapped signature issues

If delegated execution fails with unauthorized/signature errors:

- ensure you wrap delegated signatures with the signer key hash
- ensure the signer key hash matches the authorized key on the account

### 2) ERC-1271 digest mismatch

For delegated signers, sign the ERC-1271 transformed digest (not the raw digest).

### 3) Nonce/session key simulation mismatch

For deterministic simulation in delegated flows, pass explicit `nonce` and `sessionKey` to `prepareCalls`.

### 4) Bundle intent failures

Inspect `finalStatus.receipt?.intentError` to distinguish permission failures from signature failures.

### 5) Post-auth propagation delay

After updating permissions/keys, simulation can briefly lag behind on-chain confirmation. Use bounded retries.

## Development Note (Monorepo)

In this monorepo, `@nubl/relayer-client` imports shared RPC schema types from
`@nubl/relayer/rpc/schema/*` to stay aligned with relayer endpoint contracts.

When changing relayer request/response shapes, update relayer schema files first and
then verify relayer-client build/tests.
