# Towns Wallet

Your keys. Your agent. No middlemen.

## The Premise

Every crypto wallet ever built assumes a human is sitting there. Click to approve. Scan the QR code. Copy the seed phrase to a piece of paper.

That era is ending. AI agents are transacting on-chain right now — swapping tokens, bridging assets, managing treasuries, paying other agents. They run around the clock. They don't have thumbs. They will never click "Confirm" on a browser extension.

And here's the thing most people miss: agents need the cypherpunk guarantees _more_ than humans ever did. A human who gets rugged can call a lawyer, file a chargeback, write an angry tweet. An agent has no recourse outside the code. For an agent, the smart contract isn't a convenience — it's the entire legal system. The cryptographic boundary isn't a feature — it's the only thing standing between autonomous operation and catastrophic loss.

An agent with unrestricted access to a private key is a liability. An agent routing every transaction through a custody service is a bottleneck. The original promise — your keys, your rules, math as the authority — was always the right architecture. Agents just made it the only one that works.

## The Problem

Agents interacting with blockchains face three compounding failures.

**They can't onboard.** There is no KYC flow for a background process. No app to download. No fiat onramp that accepts a cron job. An agent needs to generate a key, fund an account, and start transacting — all from a script, a pipeline, or a shell. The entire wallet ecosystem assumes a human is steering. For an agent, that means every existing onboarding flow is a dead end.

**They can't operate safely with full access.** Giving an agent an unrestricted private key means one bug, one prompt injection, one logic error can drain everything. There's no "undo" on a blockchain. Agents need scoped permissions — the ability to swap on Uniswap but not transfer to arbitrary addresses, to spend 100 USDC per day but not 10,000. The boundaries have to be set by a human and enforced by code — not by policy, not by trust, by the chain itself.

**They can't coordinate with each other.** When one agent needs to pay another, or two agents need to collaborate on a multi-step strategy, they need a direct communication channel. Routing agent-to-agent coordination through a centralized API or a shared database defeats the purpose — it reintroduces the middleman that crypto was designed to eliminate. The agents need to talk to each other privately, directly, with end-to-end encryption, and without a platform in the middle deciding who can communicate with whom.

## The Solution

Towns Wallet is a local-first CLI wallet built for agents and power users. It manages encrypted keystores wherever your agent runs — Claude Code, Codex, a container, a server — and interacts with the blockchain through the same Towns Account and Towns Relayer infrastructure that powers the Towns app and Rodeo. Same account. Same relayer. Different surface.

Where the Towns app gives you a GUI, Towns Wallet gives you TUI (terminal ui) — a CLI that works anywhere an agent can call a shell command.

Four properties make it work:

**Local-first key management.** Encrypted keystores live on your system, next to the agent that uses them. No signup. No API key. No custody service holding your keys. The keys stay where the agent runs — encrypted, portable, under your control.

**Session keys with on-chain guardrails.** Towns Wallet creates scoped signers — session keys authorized to act on behalf of your account but only within boundaries you define. Which contracts they can call. Which functions they can invoke. How much they can spend per day, per week, or ever. These limits aren't enforced by a policy document or a terms-of-service agreement. They're enforced by your smart contract, on-chain, every. single. transaction - verified.

**A session daemon for autonomous operation.** Like `ssh-agent` for SSH or `gpg-agent` for PGP, Towns Wallet runs a local daemon that acts as a signing oracle. You unlock a session key once — the daemon handles signing requests on your behalf without exposing the key itself. Keys are loaded with a time-to-live: 15 minutes, 4 hours, whatever the task requires. When the TTL expires, the key is evicted automatically. Private key material never touches disk in plaintext and never leaves the daemon process. The agent asks the daemon to sign; the daemon signs and returns the result. No password prompts in the loop.

**Encrypted agent-to-agent messaging.** Towns Wallet creates agent identities backed by session keys, each with its own encryption device. Two agents establish a named channel over Towns Protocol using a shared secret — end-to-end encrypted, with messages flowing as NDJSON over stdout. Pipe an LLM's output into `tw chat listen --interactive` and the agent can receive, reason, and respond — all through standard I/O.

## Two Agents, No Humans

Here's what this looks like in practice.

A concierge agent handles user requests — swaps, bridges, payments. A treasury agent manages the community fund. Both are Towns Wallet identities running on separate machines.

The concierge creates an account and an agent identity. The treasury does the same. They establish an encrypted channel — the concierge creates it, gets a shared secret, and the treasury binds using that secret. From this point on, they communicate directly over Towns Protocol. No server reads their messages. No middleware sits between them.

The concierge's session daemon is unlocked with a 4-hour TTL. A user asks it to rebalance — swap ETH for USDC on Base, bridge 500 USDC to Polygon, send 200 to the treasury. The concierge executes each step through the Towns Relayer, signing autonomously within its daily spend limits. When the swap settles, it messages the treasury agent over the encrypted channel: "200 USDC incoming, tx hash attached." The treasury verifies the on-chain receipt, updates its ledger, and responds with a confirmation — all over the same encrypted channel, all as structured NDJSON that the concierge parses without human intervention.

Every transaction is scoped by on-chain permissions. Every message is end-to-end encrypted. Every signing key is evicted from the daemon when its TTL expires. No human touched anything after the initial setup.

## Why This Matters

**For the team.** We didn't build another wallet SDK. We built the missing piece — the CLI surface that gives agents and power users direct, local-key access to Towns Account, the same smart contract that the Towns app and Rodeo interact with through Privy. Different signing paths, same on-chain account. The permissions, spend limits, and session keys that protect a Towns app user protect a Towns Wallet user the same way — enforced by the same contract, on the same chain.

**For developers.** Run `tw --llms` and Towns Wallet outputs a machine-readable manifest of every command, argument, and schema — designed for LLM agents to discover and use your wallet without reading docs. Output uses TOON format by default, a token-efficient structured format that gives agents the same information as JSON at a fraction of the token cost. Every command supports `--json` for structured output. This is wallet-as-API, not wallet-as-app.

**For the ecosystem.** The cypherpunks wrote code because they understood that privacy and autonomy aren't granted by institutions — they're enforced by mathematics. That insight didn't expire. It just found its most demanding audience. When agents can manage their own keys, enforce their own boundaries, and communicate directly with other agents — crypto becomes the coordination layer it was always supposed to be. Not finance with extra steps. Infrastructure for a world where most on-chain actors aren't human, and the code is the only authority they'll ever answer to.

---

The cypherpunks wrote code. We still do.

Towns Wallet is the CLI entry point to the Towns ecosystem. For command reference and usage, see the [README](../README.md). For the account and relayer infrastructure underneath, see [Towns Relayer](../../relayer/docs/INTRO.md).
