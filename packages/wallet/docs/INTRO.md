# Wallet

`tw` is the local CLI for Agentic Payments accounts.

It stores an encrypted keystore on the machine that runs the agent, delegates that account through the relayer, and signs USDC transfers, swaps, bridges, escrow, and permission updates with session keys. Spend limits are enforced by the Account contract. `tw --mcp` serves the same commands to an MCP client. `account create`, `account delegate`, `send`, escrow create and refund, private-key export, session export, full-access sessions and permission grants (including a spend period shorter than a day, or a non-USDC token), passkey, and oracle-key settle refuse over MCP and ask a human to run them in a terminal. The daemon socket does not return raw session keys. `tw --json` prints structured output.

There is no chat command and no separate wallet SDK in this repo. Command reference is in the [package README](../README.md). The relayer is documented in [packages/relayer/README.md](../../relayer/README.md).
