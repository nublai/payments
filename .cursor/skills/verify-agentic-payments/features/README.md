# Features

Two local flows. Each one is a repo script. This directory only says what the user does and what the script drives.

| Feature | Script | Pass line |
| --- | --- | --- |
| [Local payment](local-payment.md) | `bun run e2e:local-payment` | `PASS local agentic payment` |
| [Local escrow](local-escrow.md) | `bun run e2e:local-escrow` | `PASS local escrow` |

Swap, bridge, and login are not features here. See the gotchas in each file.
