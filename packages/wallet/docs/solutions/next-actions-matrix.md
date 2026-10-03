# `tw` Next Actions Matrix

This document defines what `next_actions` should include for each command.

Goal: keep agent guidance useful, safe, and concise.

## Implemented Now

- `root` (`tw --json` with no command)
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

- `tw account export --show-private`
- `tw permissions revoke --all`
- Any action that can duplicate a financial side effect without explicit intent
- Any action requiring raw secret values inline

## Command Matrix

| Command                              | Include in `next_actions`                                                           | Avoid in `next_actions`                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `root` (`tw --json` with no command) | `tw status --json`, `tw account status --json`, `tw schema --json`                  | Mutating commands (`account create`, `session rotate`, `permissions grant`) |
| `help`                               | `tw schema --json`, `tw status --json`                                              | Mutating commands                                                           |
| `schema`                             | `tw status --json`, `tw account status --json`                                      | Low-value loops/repeats                                                     |
| `status`                             | `tw account status --json`, `tw schema --json`                                      | Mutating commands unless required by explicit status condition              |
| `address`                            | `tw account balance --json`, `tw account status --json`                             | Secret export                                                               |
| `account balance`                    | `tw account status --json`, `tw account nonce --json`                               | Financial mutations by default                                              |
| `account nonce`                      | `tw account status --json`, `tw account balance --json`                             | Unrelated permission/session mutations                                      |
| `account status`                     | `tw session list --json`, `tw permissions list --json`, `tw account balance --json` | Destructive actions                                                         |
| `session list`                       | `tw session create <session-name> --json`, `tw account status --json`               | `session revoke` by default                                                 |
| `permissions list`                   | `tw permissions show <key-ref> --json`, `tw account status --json`                  | `permissions revoke --all`                                                  |
| `permissions show`                   | `tw permissions list --json`, `tw account status --json`                            | Destructive actions                                                         |
| `account create`                     | `tw account status --json`, `tw session list --json`                                | `account export --show-private`                                             |
| `account delegate`                   | `tw account status --json`, `tw permissions list --json`                            | `session revoke` default suggestion                                         |
| `send`                               | `tw account balance --json`, `tw account nonce --json`, `tw account status --json`  | Immediate repeat send                                                       |
| `account change-password`            | `tw session list --json`, `tw account status --json`                                | Secret/credential output actions                                            |
| `session create`                     | `tw session list --json`, `tw permissions show <key-ref> --json`                    | Rotate/revoke as default happy-path next action                             |
| `session rotate`                     | `tw session list --json`, `tw account status --json`                                | Extra destructive follow-ups                                                |
| `session revoke`                     | `tw session list --json`, `tw account status --json`                                | Further revoke chains as default                                            |
| `permissions grant`                  | `tw permissions show <key-ref> --json`, `tw permissions list --json`                | `permissions revoke --all`                                                  |
| `permissions revoke`                 | `tw permissions show <key-ref> --json`, `tw permissions list --json`                | Additional destructive defaults                                             |

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
