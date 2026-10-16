# `nubl` Next Actions Matrix

This document defines what `next_actions` should include for each command.

Goal: keep agent guidance useful, safe, and concise.

## Implemented Now

- `root` (`nubl --json` with no command)
- `help`
- `status`
- `schema`

## Global Rules

- Include only immediate, high-signal follow-ups.
- Keep count small: 2-4 actions per response.
- Prefer read/verify actions after mutations.
- Use contextual templates with placeholders when arguments are required.
- Do not suggest destructive or secret-revealing actions by default.

## Never Suggest By Default

- `nubl account export --show-private`
- `nubl permissions revoke --all`
- Any action that can duplicate a financial side effect without explicit intent
- Any action requiring raw secret values inline

## Command Matrix

| Command                              | Include in `next_actions`                                                           | Avoid in `next_actions`                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `root` (`nubl --json` with no command) | `nubl status --json`, `nubl account status --json`, `nubl schema --json`                  | Mutating commands (`account create`, `session rotate`, `permissions grant`) |
| `help`                               | `nubl schema --json`, `nubl status --json`                                              | Mutating commands                                                           |
| `schema`                             | `nubl status --json`, `nubl account status --json`                                      | Low-value loops/repeats                                                     |
| `status`                             | `nubl account status --json`, `nubl schema --json`                                      | Mutating commands unless required by explicit status condition              |
| `address`                            | `nubl account balance --json`, `nubl account status --json`                             | Secret export                                                               |
| `account balance`                    | `nubl account status --json`, `nubl account nonce --json`                               | Financial mutations by default                                              |
| `account nonce`                      | `nubl account status --json`, `nubl account balance --json`                             | Unrelated permission/session mutations                                      |
| `account status`                     | `nubl session list --json`, `nubl permissions list --json`, `nubl account balance --json` | Destructive actions                                                         |
| `session list`                       | `nubl session create <session-name> --json`, `nubl account status --json`               | `session revoke` by default                                                 |
| `permissions list`                   | `nubl permissions show <key-ref> --json`, `nubl account status --json`                  | `permissions revoke --all`                                                  |
| `permissions show`                   | `nubl permissions list --json`, `nubl account status --json`                            | Destructive actions                                                         |
| `account create`                     | `nubl account status --json`, `nubl session list --json`                                | `account export --show-private`                                             |
| `account delegate`                   | `nubl account status --json`, `nubl permissions list --json`                            | `session revoke` default suggestion                                         |
| `send`                               | `nubl account balance --json`, `nubl account nonce --json`, `nubl account status --json`  | Immediate repeat send                                                       |
| `account change-password`            | `nubl session list --json`, `nubl account status --json`                                | Secret/credential output actions                                            |
| `session create`                     | `nubl session list --json`, `nubl permissions show <key-ref> --json`                    | Rotate/revoke as default happy-path next action                             |
| `session rotate`                     | `nubl session list --json`, `nubl account status --json`                                | Extra destructive follow-ups                                                |
| `session revoke`                     | `nubl session list --json`, `nubl account status --json`                                | Further revoke chains as default                                            |
| `permissions grant`                  | `nubl permissions show <key-ref> --json`, `nubl permissions list --json`                | `permissions revoke --all`                                                  |
| `permissions revoke`                 | `nubl permissions show <key-ref> --json`, `nubl permissions list --json`                | Additional destructive defaults                                             |

## New Command Checklist

When adding a command, choose `next_actions` in this order:

1. Verify result (`status`, `list`, `show`, balance/nonce checks).
2. Inspect nearby state (`account`, `session`, `permissions`).
3. Offer one optional mutation only if low-risk and context-appropriate.
4. Exclude high-risk actions unless command failed and user intent is explicit.

If uncertain, bias toward read-only actions.

## Quick Recipe for New Commands

1. Add a command entry in `src/lib/next-actions.ts`.
2. Wire one JSON success call site to include `next_actions`.
3. Add one JSON router test asserting `data.next_actions`.
