# Wallet

`tw` is the local CLI for Agentic Payments accounts.

It stores an encrypted keystore on the machine that runs the agent, delegates that account through the relayer, and signs USDC transfers, swaps, bridges, escrow, and permission updates with session keys. Spend limits are enforced by the Account contract. `tw --mcp` serves the same commands to an MCP client. `send`, escrow create and refund, private-key export, session export, full-access sessions and permission grants, passkey, and oracle-key settle refuse over MCP and ask a human to run them in a terminal. `tw --json` prints structured output.

There is no chat command and no separate wallet SDK in this repo. Command reference is in the [package README](../README.md). The relayer is documented in [packages/relayer/README.md](../../relayer/README.md).
