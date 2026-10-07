# Wallet

`tw` is the local CLI for Agentic Payments accounts.

It stores an encrypted keystore on the machine that runs the agent, delegates that account through the relayer, and signs USDC transfers, swaps, bridges, escrow, and permission updates with session keys. Spend limits are enforced by the Account contract. `tw --mcp` serves the same commands to an MCP client. `account create`, `account delegate`, `send`, escrow create and refund, private-key export, session export, full-access sessions and permission grants (including a spend period shorter than a day, a non-USDC token, `increaseAllowance`, or a combined USDC spend above 10 per day), daemon unlock of a full-access session, `session rotate --narrow`, revoking a full-access session, passkey, and oracle-key settle refuse over MCP and ask a human to run them in a terminal. The default new session is USDC transfer and approve, escrow, refund, settler write, escrow settle, and 10 USDC per day. Swap and bridge need an explicit full-access session. The daemon socket does not return raw session keys. `tw --json` prints structured output.

There is no chat command and no separate wallet SDK in this repo. Command reference is in the [package README](../README.md). The relayer is documented in [packages/relayer/README.md](../../relayer/README.md).
