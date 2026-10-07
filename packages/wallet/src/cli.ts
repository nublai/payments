import { Cli, z } from "incur";
import { readFileSync } from "node:fs";
import {
  resolveCliProcessExitCode,
  scheduleActiveHandleDumpIfRequested,
  updateCliProcessExitCode,
} from "./cli-runtime";
import { confirm, isCancel } from "@clack/prompts";

// Business logic — all existing execute* functions are reused unchanged.
import { executeAccountBalance } from "./lib/account-balance";
import {
  executeAccountCreate,
  resolveKeystorePath,
  assertAccountCreateCanInitialize,
  resolveAccountCreatePassword,
} from "./lib/account-create";
import {
  executeAccountDelegate,
  resolveAccountDelegatePassword,
} from "./lib/account-delegate";
import {
  AccountExportError,
  executeAccountExport,
  assertCanExportPrivateKeys,
  resolveAccountExportPassword,
} from "./lib/account-export";
import { executeAccountNonce } from "./lib/account-nonce";
import { executeAccountHistory } from "./lib/account-history";
import {
  executeAccountSend,
  resolveAccountSendPassword,
} from "./lib/account-send";
import {
  AccountSwapError,
  executeAccountSwap,
  resolveAccountSwapPassword,
} from "./lib/account-swap";
import { executeAccountStatus } from "./lib/account-status";
import {
  executeAccountUpdatePassword,
  assertAccountUpdateCurrentPassword,
  resolveAccountUpdatePasswords,
} from "./lib/account-update-password";
import {
  executeSessionCreate,
  resolveSessionCreatePassword,
} from "./lib/session-create";
import {
  executeSessionExport,
  resolveSessionExportPasswords,
  assertSessionExportInputs,
} from "./lib/session-export";
import { executeSessionImport } from "./lib/session-import";
import { executeSessionList } from "./lib/session-list";
import { executeSessionLock } from "./lib/session-lock";
import { executeSessionStart } from "./lib/session-start";
import { executeSessionStatus } from "./lib/session-status";
import { executeSessionStop } from "./lib/session-stop";
import { executeSessionRotate } from "./lib/session-rotate";
import { executeSessionRevoke } from "./lib/session-revoke";
import {
  executeSessionUnlock,
  resolveSessionUnlockPassword,
} from "./lib/session-unlock";
import { executePermissionsGrant } from "./lib/permissions-grant";
import { parseSpendLimitUnits } from "./lib/permissions-common";
import { executePermissionsList } from "./lib/permissions-list";
import { executePermissionsRevoke } from "./lib/permissions-revoke";
import { executePermissionsShow } from "./lib/permissions-show";
import { parseSpendLimit } from "./lib/session-common";
import {
  authUrlUnsetMessage,
  executeLogin,
  executeLogout,
  getAuthUrl,
  LoginError,
} from "./lib/login";
import { SessionDaemonClient } from "./lib/session-daemon-client";
import { normalizeChainName, type ChainName } from "./lib/network-config";
import {
  getQuote as getRelayQuote,
  pollIntentStatus as pollRelayIntentStatus,
  sumQuoteFeeUsd,
  type RelayCurrencyAmount,
  type RelayQuoteResponse,
} from "./lib/relay-link";
import {
  PromptCancelledError,
  readlineExistingPassword,
  readlineNewPassword,
} from "./lib/password-readline";
import { executeEscrowCreate } from "./lib/escrow-create";
import { EscrowError } from "./lib/escrow-common";
import { executeEscrowStatus } from "./lib/escrow-status";
import { executeEscrowSettle } from "./lib/escrow-settle";
import { executeEscrowRefund } from "./lib/escrow-refund";
import {
  AccountPasskeyError,
  executeAccountPasskey,
} from "./lib/account-passkey";
import {
  CONFIRM_FULL_ACCESS_PHRASE,
  CONFIRM_ORACLE_SIGN_PHRASE,
  CONFIRM_PASSKEY_PHRASE,
  CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
  CONFIRM_SEND_PHRASE,
  HumanConfirmationError,
  isInteractiveTerminal,
  isMcpCaller,
  privateKeyMcpRefusal,
  promptTerminalPhrase,
  quoteConfirmationMessage,
  requireHumanConfirmation,
} from "./lib/human-confirmation";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const ENV_REQUIRED_MESSAGE =
  "Missing --env. Pass `--env prod`, `--env stage`, or `--env dev`.";

// No default. Omitting --env must fail closed instead of selecting prod.
const envSchema = z
  .enum(["prod", "stage", "dev"], { error: ENV_REQUIRED_MESSAGE })
  .describe(ENV_REQUIRED_MESSAGE);
const profileSchema = z
  .string()
  .optional()
  .describe("Profile for default keystore resolution");
const keystorePathSchema = z
  .string()
  .optional()
  .describe("Explicit keystore path");
const chainSchema = z
  .string()
  .optional()
  .describe("Target chain (base, polygon, anvil)");
const passwordStdinSchema = z
  .boolean()
  .optional()
  .describe("Read password from stdin");
const legacySchema = z
  .boolean()
  .optional()
  .describe("Use legacy USDC.e on polygon");
const spendPeriodSchema = z
  .enum(["minute", "hour", "day", "week", "month", "year", "forever"])
  .optional()
  .describe(
    "Spend limit period (minute, hour, day, week, month, year, forever)",
  );
const permissionTypeSchema = z
  .enum(["call", "spend"])
  .describe("Permission type: call or spend");

const passwordEnv = z.object({
  TW_PASSWORD: z.string().optional().describe("Keystore password"),
});

// ---------------------------------------------------------------------------
// Password helpers (readline-based, writes prompts to stderr)
// ---------------------------------------------------------------------------

function readSingleValueFromStdin(label: string): string {
  const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error(`No ${label} provided on stdin`);
  return value;
}

function readPasswordFromStdin(): string {
  return readSingleValueFromStdin("password");
}

function readStdinLines(): string[] {
  return readFileSync(0, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
}

function readLoginTokenAndPassword(
  tokenStdin: boolean,
  passwordStdin: boolean,
): { tokenHex?: string; password?: string } {
  if (!tokenStdin) return {};
  if (!passwordStdin) return { tokenHex: readSingleValueFromStdin("token") };
  const lines = readStdinLines();
  const tokenHex = lines[0]?.trim();
  const password = lines[1]?.trim();
  if (!tokenHex)
    throw new Error("No token provided on stdin (expected first line)");
  if (!password)
    throw new Error("No password provided on stdin (expected second line)");
  return { tokenHex, password };
}

function handlePromptCancellation<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    if (error instanceof PromptCancelledError) {
      updateCliProcessExitCode(130);
      process.exit(130);
    }
    throw error;
  });
}

/** Standard password deps wired through env vars, stdin, or stderr readline. */
function passwordDeps(envPassword: string | undefined) {
  return {
    envPassword,
    readPasswordFromStdin,
    promptForExistingPassword: (msg?: string) =>
      handlePromptCancellation(
        readlineExistingPassword(msg ?? "Enter your keystore password:"),
      ),
    promptForPassword: () => handlePromptCancellation(readlineNewPassword()),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

function formatQuoteAmount(
  amount?: RelayCurrencyAmount,
  fallback = "unknown",
): string {
  const value = amount?.amountFormatted;
  if (value) {
    return value;
  }
  return amount?.amount ?? fallback;
}

function formatQuoteSummary(
  quote: RelayQuoteResponse,
  kind: "swap" | "bridge",
): string {
  const lines = [
    `${kind === "swap" ? "Swap" : "Bridge"} Quote:`,
    `  Sell: ${formatQuoteAmount(quote.details?.currencyIn)}`,
    `  Buy:  ${formatQuoteAmount(quote.details?.currencyOut)}`,
    `  Rate: ${quote.details?.rate ?? "unknown"}`,
    `  Total fees: $${sumQuoteFeeUsd(quote)}`,
    `  Estimated time: ${quote.details?.timeEstimate ? `~${quote.details.timeEstimate}s` : "unknown"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function writeRelayAudit(quote: RelayQuoteResponse): void {
  const lines = quote.steps.flatMap((step, stepIndex) =>
    step.items
      .filter((item) => item.status === "incomplete")
      .map(
        (item, itemIndex) =>
          `  [${stepIndex + 1}.${itemIndex + 1}] to=${item.data.to} value=${item.data.value} chainId=${item.data.chainId}`,
      ),
  );
  if (lines.length === 0) {
    return;
  }
  process.stderr.write(`Relay execution targets:\n${lines.join("\n")}\n`);
}

async function withStderrSpinner<T>(
  message: string,
  work: () => Promise<T>,
  options?: { showElapsed?: boolean },
): Promise<T> {
  const frames = ["|", "/", "-", "\\"];
  const startedAt = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    const elapsed = options?.showElapsed
      ? ` ${Math.floor((Date.now() - startedAt) / 1000)}s`
      : "";
    process.stderr.write(
      `\r${frames[frame % frames.length]} ${message}${elapsed}`,
    );
    frame += 1;
  }, 120);
  try {
    const result = await work();
    clearInterval(timer);
    process.stderr.write(
      `\r✓ ${message}${options?.showElapsed ? ` ${Math.floor((Date.now() - startedAt) / 1000)}s` : ""}\n`,
    );
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stderr.write(`\r✗ ${message}\n`);
    throw error;
  }
}

function normalizeOptionalChain(value?: string): ChainName | undefined {
  return value ? normalizeChainName(value) : undefined;
}

async function confirmHuman(
  reportError: (options: { code: string; message: string }) => never,
  operation: string,
  phrase: string,
): Promise<void> {
  try {
    await requireHumanConfirmation({
      operation,
      phrase,
      prompt: (expected) =>
        handlePromptCancellation(promptTerminalPhrase(expected)),
    });
  } catch (error) {
    if (error instanceof HumanConfirmationError) {
      reportError({ code: error.code, message: error.message });
    }
    throw error;
  }
}

function refuseQuoteWithoutHuman(kind: "swap" | "bridge"): void {
  if (isMcpCaller() || !isInteractiveTerminal()) {
    throw new AccountSwapError(
      "CONFIRMATION_REQUIRED",
      quoteConfirmationMessage(kind),
    );
  }
}

// ---------------------------------------------------------------------------
// Read version from package.json
// ---------------------------------------------------------------------------

function readVersionSync(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch (error) {
    process.stderr.write(
      `Failed to read version from package.json: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return "0.0.0";
  }
}

function parseRawSpendLimit(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      "Spend limit raw must be a positive integer in base units.",
    );
  }
  const amount = BigInt(normalized);
  if (amount <= 0n) {
    throw new Error("Spend limit raw must be greater than zero.");
  }
  return amount;
}

function resolveSpendLimitInput(input: {
  spendLimit?: string;
  spendLimitRaw?: string;
  parseHumanAmount: (value: string) => bigint;
}): bigint | undefined {
  if (input.spendLimit && input.spendLimitRaw) {
    throw new Error("Use either --spend-limit or --spend-limit-raw, not both.");
  }
  if (input.spendLimitRaw) {
    return parseRawSpendLimit(input.spendLimitRaw);
  }
  if (input.spendLimit) {
    return input.parseHumanAmount(input.spendLimit);
  }
  return undefined;
}

// ============================ ROOT CLI ====================================

const tw = Cli.create("tw", {
  description:
    "Wallet CLI — manage smart accounts, session keys, and permissions.",
  version: readVersionSync(),
  sync: {
    suggestions: [
      "create a new account",
      "check my account balance",
      "send 1 USDC to 0x...",
      "list my session keys",
    ],
  },
});

// ============================= ACCOUNT GROUP ==============================

const account = Cli.create("account", {
  description: "Account management commands",
});

account.command("balance", {
  description: "Show USDC balance for root account",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    legacy: legacySchema,
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    address: z.string(),
    chain: z.string(),
    contractAddress: z.string(),
    symbol: z.string(),
    balance: z.string(),
    formattedBalance: z.string(),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Check account balance",
    },
    {
      options: { env: "prod", chain: "polygon" },
      description: "Check polygon balance",
    },
  ],
  async run({ options }) {
    return executeAccountBalance({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      chain: options.chain as ChainName | undefined,
      legacy: options.legacy,
    });
  },
});

account.command("nonce", {
  description: "Read account nonce for a sequence key",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    seqKey: z.string().default("0").describe("Sequence key index"),
  }),
  output: z.object({
    type: z.string(),
    nonce: z.string(),
    address: z.string(),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Read nonce for account",
    },
  ],
  async run({ options }) {
    return executeAccountNonce({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      seqKey: BigInt(options.seqKey),
    });
  },
});

account.command("history", {
  description: "Show paginated relayer calls history for an EOA",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    address: z.string().optional().describe("EOA address override"),
    chain: z
      .string()
      .optional()
      .describe("Chain filter as comma-separated names (base, polygon, anvil)"),
    limit: z.coerce
      .number()
      .int()
      .optional()
      .describe("Page size (default 20, max 100)"),
    offset: z.coerce
      .number()
      .int()
      .optional()
      .describe("Page offset (default 0)"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    address: z.string(),
    keystorePath: z.string().optional(),
    networkScope: z.object({
      env: z.string(),
      chainIds: z.array(z.number()).optional(),
    }),
    page: z.object({
      limit: z.number(),
      offset: z.number(),
      returned: z.number(),
      total: z.number(),
    }),
    items: z.array(
      z.object({
        id: z.string(),
        chainId: z.number(),
        chain: z.string().nullable(),
        createdAt: z.number(),
      }),
    ),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Show history for local profile",
    },
    {
      options: {
        address: "0x1111111111111111111111111111111111111111",
        limit: 10,
        offset: 20,
      },
      description: "Query history for explicit EOA with pagination",
    },
    {
      options: { chain: "base,polygon" },
      description: "Scope history query to base and polygon",
    },
  ],
  async run({ options }) {
    return executeAccountHistory({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      address: options.address,
      chains: options.chain,
      limit: options.limit,
      offset: options.offset,
    });
  },
});

account.command("status", {
  description: "Show account readiness and diagnostics",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    legacy: legacySchema,
  }),
  output: z.object({
    type: z.string(),
    readiness: z.boolean(),
    addresses: z.object({
      root: z.string(),
      session: z.string(),
    }),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Check account status",
    },
  ],
  async run({ options, error }) {
    const result = await executeAccountStatus({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      legacy: options.legacy,
      name: options.profile,
      keystorePath: options.keystorePath,
    });
    if (!result.readiness) {
      const failures = result.checks
        .filter((c: { level: string }) => c.level === "fail")
        .map((c: { message: string }) => c.message);
      return error({
        code: "NOT_READY",
        message: failures.join("; ") || "Account is not ready",
        cta: {
          commands: [
            {
              command: "account create",
              description: "Create a new account",
            },
          ],
        },
      });
    }
    return result;
  },
});

account.command("create", {
  description: "Create local account keystore and delegate account",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    relayerUrl: z.string().optional().describe("Custom relayer URL"),
    rpcUrl: z.string().optional().describe("Custom RPC URL"),
    chainId: z.number().optional().describe("Custom chain ID"),
    resume: z.boolean().optional().describe("Resume from existing keystore"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    addresses: z.object({
      root: z.string(),
      session: z.string(),
      delegated: z.string(),
    }),
    keystorePath: z.string(),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Create account",
    },
  ],
  async run({ options, env }) {
    const keystorePath = resolveKeystorePath({
      env: options.env,
      keystorePath: options.keystorePath,
      name: options.profile,
    });
    await assertAccountCreateCanInitialize({
      keystorePath,
      resume: options.resume ?? false,
    });

    const password = await resolveAccountCreatePassword(
      {
        env: options.env,
        resume: options.resume ?? false,
        passwordStdin: options.passwordStdin ?? false,
        json: false,
        help: false,
      },
      passwordDeps(env.TW_PASSWORD),
    );

    return executeAccountCreate({
      env: options.env,
      relayerUrl: options.relayerUrl,
      rpcUrl: options.rpcUrl,
      chainId: options.chainId,
      keystorePath,
      password,
      resume: options.resume,
    });
  },
});

account.command("delegate", {
  description: "Delegate existing account on one or more chains",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: z.string().describe("Chain(s) to delegate on"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    rootAddress: z.string(),
    sessionAddress: z.string(),
    keystorePath: z.string(),
    results: z.array(
      z.object({
        chain: z.string(),
        status: z.string(),
      }),
    ),
  }),
  examples: [
    {
      options: { chain: "base", env: "prod", profile: "agent" },
      description: "Delegate on base",
    },
  ],
  async run({ options, env }) {
    const password = await resolveAccountDelegatePassword(
      {
        env: options.env,
        chains: options.chain.split(",").map((c) => c.trim()) as ChainName[],
        passwordStdin: options.passwordStdin ?? false,
        json: false,
        help: false,
      },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to delegate this account:",
            ),
          ),
      },
    );

    return executeAccountDelegate({
      env: options.env,
      chains: options.chain.split(",").map((c) => c.trim()) as ChainName[],
      name: options.profile,
      keystorePath: options.keystorePath,
      password,
    });
  },
});

tw.command("send", {
  description:
    'Send USDC with the session key. An interactive terminal must type "SEND USDC". MCP and non-interactive callers cannot confirm.',
  args: z.object({
    amount: z.string().describe("Amount of USDC to send"),
    recipient: z.string().describe("Recipient address or ENS name"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    session: z
      .string()
      .optional()
      .describe(
        "Use a specific local session name from the profile sessions directory",
      ),
    chain: chainSchema,
    legacy: legacySchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    sender: z.string(),
    chain: z.string(),
    bundle: z.object({ id: z.string(), status: z.string() }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: {
        amount: "1",
        recipient: "0x1111111111111111111111111111111111111111",
      },
      options: { env: "prod" },
      description: "Send 1 USDC",
    },
  ],
  async run({ args, options, env, error: reportError }) {
    await confirmHuman(reportError, "Sending USDC", CONFIRM_SEND_PHRASE);
    return executeAccountSend({
      env: options.env,
      amount: args.amount,
      recipient: args.recipient,
      chain: options.chain as ChainName | undefined,
      legacy: options.legacy,
      name: options.profile,
      keystorePath: options.keystorePath,
      sessionFile: options.sessionFile,
      sessionName: options.session,
      password: env.TW_PASSWORD,
      resolvePassword: () =>
        resolveAccountSendPassword(
          {
            env: options.env,
            amount: args.amount,
            recipient: args.recipient,
            chain: options.chain as ChainName,
            legacy: options.legacy ?? false,
            keystorePath: options.keystorePath,
            name: options.profile,
            passwordStdin: options.passwordStdin ?? false,
            json: false,
            help: false,
          },
          {
            ...passwordDeps(env.TW_PASSWORD),
            promptForExistingPassword: () =>
              handlePromptCancellation(
                readlineExistingPassword(
                  "Enter your keystore password to sign this transfer:",
                ),
              ),
          },
        ),
    });
  },
});

tw.command("swap", {
  description: "Swap tokens on the same chain via relay.link",
  options: z.object({
    from: z.string().describe("Source token (ETH, USDC)"),
    to: z.string().describe("Destination token (ETH, USDC)"),
    amount: z.string().describe("Amount of source token to swap"),
    slippage: z.coerce
      .number()
      .optional()
      .describe("Slippage tolerance as percentage (default: 0.5)"),
    yes: z
      .boolean()
      .optional()
      .describe(
        "Skip the quote prompt in an interactive terminal. Refused for MCP and non-interactive callers.",
      ),
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    session: z
      .string()
      .optional()
      .describe(
        "Use a specific local session name from the profile sessions directory",
      ),
    chain: chainSchema,
    passwordStdin: passwordStdinSchema,
  }),
  alias: { yes: "y" },
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    sender: z.string(),
    sourceChain: z.string(),
    destinationChain: z.string(),
    fromToken: z.object({ symbol: z.string(), amount: z.string() }),
    toToken: z.object({ symbol: z.string(), estimatedAmount: z.string() }),
    bundle: z.object({ id: z.string(), status: z.string() }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  async run({ options, env }) {
    refuseQuoteWithoutHuman("swap");

    return executeAccountSwap(
      {
        operation: "swap",
        env: options.env,
        fromToken: options.from,
        toToken: options.to,
        amount: options.amount,
        slippage: options.slippage,
        sourceChain: normalizeOptionalChain(options.chain),
        destinationChain: normalizeOptionalChain(options.chain),
        name: options.profile,
        keystorePath: options.keystorePath,
        sessionFile: options.sessionFile,
        sessionName: options.session,
        password: env.TW_PASSWORD,
        resolvePassword: () =>
          resolveAccountSwapPassword(
            {
              env: options.env,
              passwordStdin: options.passwordStdin ?? false,
            },
            {
              ...passwordDeps(env.TW_PASSWORD),
              promptForExistingPassword: () =>
                handlePromptCancellation(
                  readlineExistingPassword(
                    "Enter your keystore password to sign this swap:",
                  ),
                ),
            },
          ),
        yes: options.yes,
      },
      {
        getQuote: (request, depsArg) =>
          withStderrSpinner("Fetching relay quote", () =>
            getRelayQuote(request, depsArg),
          ),
        pollIntentStatus: (requestId, pollOptions, depsArg) =>
          withStderrSpinner(
            "Waiting for bridge fill",
            () => pollRelayIntentStatus(requestId, pollOptions, depsArg),
            { showElapsed: true },
          ),
        confirmQuote: async (quote) => {
          process.stderr.write(formatQuoteSummary(quote, "swap"));
          const confirmed = await confirm({
            message: "Proceed?",
            initialValue: false,
            output: process.stderr,
          });
          if (isCancel(confirmed)) {
            throw new PromptCancelledError();
          }
          return confirmed;
        },
        auditQuote: writeRelayAudit,
      },
    );
  },
});

tw.command("bridge", {
  description: "Bridge tokens cross-chain via relay.link",
  options: z.object({
    token: z.string().describe("Token to bridge (ETH, USDC)"),
    amount: z.string().describe("Amount to bridge"),
    toChain: z.string().describe("Destination chain (base, polygon)"),
    recipient: z
      .string()
      .optional()
      .describe("Destination address (default: same as sender)"),
    slippage: z.coerce
      .number()
      .optional()
      .describe("Slippage tolerance as percentage (default: 0.5)"),
    yes: z
      .boolean()
      .optional()
      .describe(
        "Skip the quote prompt in an interactive terminal. Refused for MCP and non-interactive callers.",
      ),
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    session: z
      .string()
      .optional()
      .describe(
        "Use a specific local session name from the profile sessions directory",
      ),
    chain: chainSchema,
    passwordStdin: passwordStdinSchema,
  }),
  alias: { yes: "y" },
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    status: z.string(),
    keystorePath: z.string(),
    network: z.object({
      env: z.string(),
      relayerUrl: z.string(),
      rpcUrl: z.string(),
      chainId: z.number(),
    }),
    sender: z.string(),
    recipient: z.string(),
    sourceChain: z.string(),
    destinationChain: z.string(),
    fromToken: z.object({
      symbol: z.string(),
      address: z.string(),
      amount: z.string(),
      amountBaseUnits: z.string(),
    }),
    toToken: z.object({
      symbol: z.string(),
      address: z.string(),
      estimatedAmount: z.string(),
    }),
    rate: z.string(),
    totalFeesUsd: z.string(),
    slippage: z.string(),
    relayRequestId: z.string().optional(),
    destinationTxHash: z.string().optional(),
    bundle: z.object({
      id: z.string(),
      status: z.string(),
      statusCode: z.number().optional(),
    }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  async run({ options, env }) {
    refuseQuoteWithoutHuman("bridge");

    return executeAccountSwap(
      {
        operation: "bridge",
        env: options.env,
        fromToken: options.token,
        toToken: options.token,
        amount: options.amount,
        slippage: options.slippage,
        sourceChain: normalizeOptionalChain(options.chain),
        destinationChain: normalizeChainName(options.toChain),
        recipient: options.recipient,
        name: options.profile,
        keystorePath: options.keystorePath,
        sessionFile: options.sessionFile,
        sessionName: options.session,
        password: env.TW_PASSWORD,
        resolvePassword: () =>
          resolveAccountSwapPassword(
            {
              env: options.env,
              passwordStdin: options.passwordStdin ?? false,
            },
            {
              ...passwordDeps(env.TW_PASSWORD),
              promptForExistingPassword: () =>
                handlePromptCancellation(
                  readlineExistingPassword(
                    "Enter your keystore password to sign this bridge:",
                  ),
                ),
            },
          ),
        yes: options.yes,
      },
      {
        getQuote: (request, depsArg) =>
          withStderrSpinner("Fetching relay quote", () =>
            getRelayQuote(request, depsArg),
          ),
        pollIntentStatus: (requestId, pollOptions, depsArg) =>
          withStderrSpinner(
            "Waiting for bridge fill",
            () => pollRelayIntentStatus(requestId, pollOptions, depsArg),
            { showElapsed: true },
          ),
        confirmQuote: async (quote) => {
          process.stderr.write(formatQuoteSummary(quote, "bridge"));
          const confirmed = await confirm({
            message: "Proceed?",
            initialValue: false,
            output: process.stderr,
          });
          if (isCancel(confirmed)) {
            throw new PromptCancelledError();
          }
          return confirmed;
        },
        auditQuote: writeRelayAudit,
      },
    );
  },
});

account.command("export", {
  description: "Export account metadata or private keys",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    showPrivate: z
      .boolean()
      .optional()
      .describe(
        "Include private keys. Requires typing EXPORT PRIVATE KEYS in an interactive terminal. TW_PASSWORD does not skip that prompt, and MCP cannot confirm it.",
      ),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    addresses: z.object({
      root: z.string(),
      session: z.string(),
      delegated: z.string().optional(),
    }),
    keystorePath: z.string(),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Export account metadata",
    },
  ],
  async run({ options, env, error: reportError }) {
    try {
      await assertCanExportPrivateKeys({
        showPrivate: options.showPrivate ?? false,
        isInteractive: isInteractiveTerminal(),
        mcp: isMcpCaller(),
        promptForTypedConfirmation: (expectedPhrase: string) =>
          handlePromptCancellation(promptTerminalPhrase(expectedPhrase)),
      });
    } catch (error) {
      if (
        error instanceof AccountExportError &&
        (error.code === "PRIVATE_EXPORT_CONFIRMATION_REQUIRED" ||
          error.code === "PRIVATE_EXPORT_CONFIRMATION_FAILED")
      ) {
        reportError({ code: error.code, message: error.message });
      }
      throw error;
    }

    const password = await resolveAccountExportPassword(
      {
        env: options.env,
        keystorePath: options.keystorePath,
        name: options.profile,
        json: false,
        passwordStdin: options.passwordStdin ?? false,
        showPrivate: options.showPrivate ?? false,
        help: false,
      },
      passwordDeps(env.TW_PASSWORD),
    );

    return executeAccountExport({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      showPrivate: options.showPrivate ?? false,
      password,
    });
  },
});

account.command("change-password", {
  description: "Update keystore password",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    currentPasswordStdin: z
      .boolean()
      .optional()
      .describe("Read current password from stdin"),
    newPasswordStdin: z
      .boolean()
      .optional()
      .describe("Read new password from stdin"),
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    keystorePath: z.string(),
    activeSession: z.string(),
    updatedSessions: z.array(z.string()),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Update keystore password",
    },
  ],
  async run({ options, env }) {
    const readPasswordLinesFromStdin = (): string[] => {
      const raw = readFileSync(0, "utf8");
      const lines = raw.split("\n").map((l) => l.trim());
      if (!lines[0])
        throw new Error("Expected at least one password line on stdin");
      return lines;
    };

    const passwords = await resolveAccountUpdatePasswords(
      {
        env: options.env,
        keystorePath: options.keystorePath,
        name: options.profile,
        currentPasswordStdin: options.currentPasswordStdin ?? false,
        newPasswordStdin: options.newPasswordStdin ?? false,
        json: false,
        help: false,
      },
      {
        envPassword: env.TW_PASSWORD,
        readPasswordLinesFromStdin,
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword("Enter your current keystore password:"),
          ),
        promptForPassword: () =>
          handlePromptCancellation(readlineNewPassword()),
        isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        validateCurrentPassword: (currentPassword: string) =>
          assertAccountUpdateCurrentPassword({
            env: options.env,
            name: options.profile,
            keystorePath: options.keystorePath,
            currentPassword,
          }),
      },
    );

    return executeAccountUpdatePassword({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      currentPassword: passwords.currentPassword,
      newPassword: passwords.newPassword,
    });
  },
});

account.command("passkey", {
  description:
    "Authorize a P-256 WebAuthn key on a local Account and verify the wrapped signature",
  options: z.object({
    rpcUrl: z
      .string()
      .describe("Anvil JSON-RPC URL (osaka hardfork, RIP-7212 at 0x100)"),
    privateKey: z
      .string()
      .describe(
        "EOA private key that becomes the delegated account. Not accepted over MCP. Run this command in an interactive terminal and type AUTHORIZE PASSKEY.",
      ),
    publicKey: z.string().describe("P-256 public key, 64-byte x||y hex"),
    digest: z
      .string()
      .describe("32-byte digest the clientDataJSON challenge commits to"),
    authenticatorData: z.string().describe("WebAuthn authenticatorData hex"),
    clientDataJson: z.string().describe("clientDataJSON bytes as hex"),
    r: z.string().describe("P-256 signature r"),
    s: z.string().describe("P-256 signature s"),
    prehash: z
      .enum(["0", "1"])
      .optional()
      .describe(
        "Prehash flag: 1 sha256s the digest before the challenge check",
      ),
  }),
  output: z.object({
    type: z.string(),
    valid: z.boolean(),
    keyHash: z.string(),
    account: z.string(),
    implementation: z.string(),
  }),
  examples: [
    {
      options: {
        rpcUrl: "http://127.0.0.1:18545",
        publicKey: "0x" + "11".repeat(64),
        digest: "0x" + "22".repeat(32),
      },
      description: "Verify a passkey assertion against a local Account",
    },
  ],
  async run({ options, error: reportError }) {
    if (isMcpCaller()) {
      reportError({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        message: privateKeyMcpRefusal(
          "account passkey",
          CONFIRM_PASSKEY_PHRASE,
        ),
      });
    }
    await confirmHuman(
      reportError,
      "Authorizing a passkey",
      CONFIRM_PASSKEY_PHRASE,
    );
    try {
      return await executeAccountPasskey({
        rpcUrl: options.rpcUrl,
        privateKey: options.privateKey as `0x${string}`,
        publicKey: options.publicKey as `0x${string}`,
        digest: options.digest as `0x${string}`,
        authenticatorData: options.authenticatorData as `0x${string}`,
        clientDataJson: options.clientDataJson as `0x${string}`,
        r: BigInt(options.r),
        s: BigInt(options.s),
        prehash: options.prehash === "1",
      });
    } catch (err) {
      if (err instanceof AccountPasskeyError) {
        return reportError({ code: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reportError({ code: "PASSKEY_FAILED", message });
    }
  },
});

// ============================= SESSION GROUP ==============================

const session = Cli.create("session", {
  description: "Session key management commands",
});

const daemon = Cli.create("daemon", {
  description: "Session daemon process management",
});

session.command("create", {
  description: "Create and authorize a session key",
  args: z.object({
    sessionName: z.string().describe("Name for the new session key"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    activate: z.boolean().optional().describe("Set as active session"),
    resume: z.boolean().optional().describe("Resume interrupted delegation"),
    fullAccess: z
      .boolean()
      .optional()
      .describe(
        "Grant full access (wildcard permissions). Cannot be combined with --target, --selector, --spend-limit, --spend-limit-raw, or --spend-period. Requires typing CREATE FULL ACCESS SESSION in an interactive terminal. MCP cannot confirm it.",
      ),
    target: z
      .string()
      .optional()
      .describe(
        "Target contract address for call permission. Omit with --selector to use wildcard call permissions.",
      ),
    selector: z
      .string()
      .optional()
      .describe(
        "Function selector for call permission. Omit with --target to use wildcard call permissions.",
      ),
    spendLimit: z
      .string()
      .optional()
      .describe("Spend limit in USDC human units (for example, 10 = 10 USDC)"),
    spendLimitRaw: z
      .string()
      .optional()
      .describe(
        "Spend limit in raw base units (mutually exclusive with --spend-limit)",
      ),
    spendPeriod: spendPeriodSchema,
    expiry: z
      .string()
      .optional()
      .describe(
        "Session key expiry as a duration (e.g., 24h, 7d, 4w). The key automatically becomes invalid after this period.",
      ),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    session: z.object({
      name: z.string(),
      address: z.string(),
      checkpoint: z.string(),
      keyHash: z.string(),
      expiry: z.number(),
    }),
    activeSession: z.string(),
    bundle: z.object({ id: z.string() }),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { sessionName: "worker-1" },
      options: { profile: "agent", env: "prod" },
      description: "Create a session key",
    },
  ],
  async run({ args, options, env, error: reportError }) {
    if (options.fullAccess) {
      await confirmHuman(
        reportError,
        "Creating a full-access session",
        CONFIRM_FULL_ACCESS_PHRASE,
      );
    }
    const password = await resolveSessionCreatePassword(
      { passwordStdin: options.passwordStdin ?? false },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to authorize this session key:",
            ),
          ),
      },
    );

    const result = await executeSessionCreate({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      sessionName: args.sessionName,
      activate: options.activate,
      resume: options.resume,
      fullAccess: options.fullAccess,
      target: options.target as `0x${string}` | undefined,
      selectors: options.selector
        ? [options.selector as `0x${string}`]
        : undefined,
      spendLimit: resolveSpendLimitInput({
        spendLimit: options.spendLimit,
        spendLimitRaw: options.spendLimitRaw,
        parseHumanAmount: parseSpendLimit,
      }),
      spendPeriod: options.spendPeriod,
      expiry: options.expiry,
      password,
    });

    return result;
  },
});

session.command("export", {
  description: "Export a session keystore as a portable file",
  args: z.object({
    sessionName: z.string().describe("Session name to export"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    output: z.string().describe("Output file path for exported session"),
    overwrite: z
      .boolean()
      .optional()
      .describe("Overwrite output file if it exists"),
    passwordStdin: passwordStdinSchema,
    exportPasswordStdin: z
      .boolean()
      .optional()
      .describe("Read export password from stdin"),
  }),
  env: z.object({
    TW_PASSWORD: z.string().optional().describe("Keystore password"),
    TW_EXPORT_PASSWORD: z
      .string()
      .optional()
      .describe("Password for exported session file"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    output: z.string(),
    sessionName: z.string(),
  }),
  async run({ args, options, env }) {
    await assertSessionExportInputs({
      output: options.output,
      overwrite: options.overwrite,
    });
    const passwords = await resolveSessionExportPasswords(
      {
        passwordStdin: options.passwordStdin ?? false,
        exportPasswordStdin: options.exportPasswordStdin,
      },
      {
        envPassword: env.TW_PASSWORD,
        envExportPassword: env.TW_EXPORT_PASSWORD,
        readPasswordFromStdin,
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to export this session:",
            ),
          ),
        promptForExportPassword: () =>
          handlePromptCancellation(readlineNewPassword()),
        isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      },
    );
    return executeSessionExport({
      env: options.env,
      sessionName: args.sessionName,
      output: options.output,
      name: options.profile,
      keystorePath: options.keystorePath,
      password: passwords.password,
      exportPassword: passwords.exportPassword,
    });
  },
});

session.command("import", {
  description: "Import a portable session file as a session-only profile",
  args: z.object({
    input: z.string().describe("Path to portable session file"),
  }),
  options: z.object({
    env: envSchema,
    profile: z.string().describe("Profile name to install the session as"),
    overwrite: z
      .boolean()
      .optional()
      .describe("Overwrite existing session profile file"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    profile: z.string(),
    sessionPath: z.string(),
  }),
  async run({ args, options }) {
    return executeSessionImport({
      input: args.input,
      profile: options.profile,
      env: options.env,
      overwrite: options.overwrite,
    });
  },
});

session.command("list", {
  description: "List local sessions",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    onChain: z
      .boolean()
      .optional()
      .describe("Check on-chain authorization status"),
  }),
  output: z.object({
    type: z.string(),
    activeSession: z.string(),
    sessions: z.array(
      z.object({
        name: z.string(),
        address: z.string(),
        active: z.boolean(),
        kind: z.enum(["session", "agent"]),
        keyHash: z.string(),
        checkpoint: z.string(),
      }),
    ),
  }),
  examples: [
    { options: { profile: "agent" }, description: "List sessions" },
    {
      options: { profile: "agent", onChain: true },
      description: "List with on-chain status",
    },
  ],
  async run({ options }) {
    return executeSessionList({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      onChain: options.onChain,
    });
  },
});

session.command("rotate", {
  description: "Rotate active session key",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    newName: z.string().optional().describe("Name for the new session key"),
    resume: z.boolean().optional().describe("Resume interrupted rotation"),
    fullAccess: z
      .boolean()
      .optional()
      .describe(
        "Grant full access. Cannot be combined with --target, --selector, --spend-limit, --spend-limit-raw, or --spend-period. Requires typing ROTATE FULL ACCESS SESSION in an interactive terminal. MCP cannot confirm it.",
      ),
    target: z
      .string()
      .optional()
      .describe(
        "Target contract address for call permission. Omit with --selector to use wildcard call permissions.",
      ),
    selector: z
      .string()
      .optional()
      .describe(
        "Function selector for call permission. Omit with --target to use wildcard call permissions.",
      ),
    spendLimit: z
      .string()
      .optional()
      .describe("Spend limit in USDC human units (for example, 10 = 10 USDC)"),
    spendLimitRaw: z
      .string()
      .optional()
      .describe(
        "Spend limit in raw base units (mutually exclusive with --spend-limit)",
      ),
    spendPeriod: spendPeriodSchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    oldSessionName: z.string(),
    newSessionName: z.string(),
    bundle: z.object({ id: z.string() }),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      options: { env: "prod", profile: "agent" },
      description: "Rotate active session",
    },
  ],
  async run({ options, env, error: reportError }) {
    if (options.fullAccess) {
      await confirmHuman(
        reportError,
        "Rotating to a full-access session",
        CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
      );
    }
    const password = await resolveSessionCreatePassword(
      { passwordStdin: options.passwordStdin ?? false },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to rotate the session key:",
            ),
          ),
      },
    );

    return executeSessionRotate({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      newName: options.newName,
      resume: options.resume,
      fullAccess: options.fullAccess,
      target: options.target as `0x${string}` | undefined,
      selectors: options.selector
        ? [options.selector as `0x${string}`]
        : undefined,
      spendLimit: resolveSpendLimitInput({
        spendLimit: options.spendLimit,
        spendLimitRaw: options.spendLimitRaw,
        parseHumanAmount: parseSpendLimit,
      }),
      spendPeriod: options.spendPeriod,
      password,
    });
  },
});

session.command("revoke", {
  description: "Revoke and delete a session key",
  args: z.object({
    sessionName: z.string().describe("Name of the session to revoke"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    force: z
      .boolean()
      .optional()
      .describe("Force revoke without on-chain check"),
    resume: z.boolean().optional().describe("Resume interrupted revocation"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    sessionName: z.string(),
    bundle: z.object({ id: z.string() }),
    fileDeleted: z.boolean(),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { sessionName: "worker-1" },
      options: { profile: "agent", env: "prod" },
      description: "Revoke a session",
    },
  ],
  async run({ args, options, env }) {
    const password = await resolveSessionCreatePassword(
      { passwordStdin: options.passwordStdin ?? false },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to revoke this session key:",
            ),
          ),
      },
    );

    return executeSessionRevoke({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      sessionName: args.sessionName,
      force: options.force,
      resume: options.resume,
      password,
    });
  },
});

daemon.command("start", {
  description: "Start session signing daemon",
  options: z.object({
    foreground: z
      .boolean()
      .optional()
      .describe("Run daemon in foreground mode"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    pid: z.number(),
    socketPath: z.string(),
    alreadyRunning: z.boolean(),
  }),
  async run({ options }) {
    const result = await executeSessionStart({
      foreground: options.foreground,
    });
    if (!result.untilStopped) {
      return result;
    }
    const { untilStopped: _u, ...toPrint } = result;
    const useJson = process.argv.includes("--json");
    process.stdout.write(
      useJson
        ? JSON.stringify(toPrint) + "\n"
        : Object.entries(toPrint)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n") + "\n",
    );
    await result.untilStopped;
    return toPrint;
  },
});

daemon.command("stop", {
  description: "Stop session signing daemon",
  output: z.object({
    type: z.string(),
    status: z.string(),
    ok: z.boolean(),
    stopped: z.boolean(),
    pid: z.number().optional(),
    warning: z.string().optional(),
    cleanupErrors: z.array(z.string()).optional(),
  }),
  async run() {
    return executeSessionStop();
  },
});

daemon.command("unlock", {
  description: "Unlock a local session into the in-memory signer daemon",
  args: z.object({
    sessionName: z.string().describe("Session name to unlock"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    duration: z
      .string()
      .optional()
      .describe("TTL duration (for example 1h, 30m, 1d)"),
    force: z.boolean().optional().describe("Allow durations longer than 24h"),
    device: z
      .boolean()
      .optional()
      .describe("Also cache the agent encryption device in daemon memory"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    status: z.string(),
    name: z.string(),
    address: z.string(),
    expiresAt: z.number(),
  }),
  async run({ args, options, env }) {
    const password = await resolveSessionUnlockPassword(
      {
        passwordStdin: options.passwordStdin ?? false,
      },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to unlock this session key:",
            ),
          ),
      },
    );
    return executeSessionUnlock({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      sessionName: args.sessionName,
      password,
      duration: options.duration,
      force: options.force,
      device: options.device,
    });
  },
});

daemon.command("lock", {
  description: "Remove an unlocked session key from the signer daemon",
  args: z.object({
    sessionName: z.string().describe("Session name to lock"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    ok: z.boolean(),
    name: z.string(),
  }),
  async run({ args }) {
    return executeSessionLock({
      sessionName: args.sessionName,
    });
  },
});

daemon.command("status", {
  description: "Show signer daemon uptime and loaded keys",
  output: z.object({
    type: z.string(),
    status: z.string(),
    socketPath: z.string(),
    startedAt: z.number().optional(),
    keys: z.array(
      z.object({
        name: z.string(),
        address: z.string(),
        kind: z.string().optional(),
        expiresAt: z.number(),
        ttlSeconds: z.number(),
      }),
    ),
  }),
  async run() {
    return executeSessionStatus();
  },
});

// ========================== PERMISSIONS GROUP ==============================

const permissions = Cli.create("permissions", {
  description: "Permission rule management commands",
});

permissions.command("list", {
  description: "List keys and permission summaries",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
  }),
  output: z.object({
    type: z.string(),
    keys: z.array(
      z.object({
        name: z.string().nullable().optional(),
        hash: z.string(),
        role: z.string(),
        type: z.string(),
        summary: z.object({
          callPermissionCount: z.number(),
          spendLimitCount: z.number(),
        }),
      }),
    ),
  }),
  examples: [
    { options: { profile: "agent" }, description: "List permission keys" },
  ],
  async run({ options }) {
    return executePermissionsList({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
    });
  },
});

permissions.command("show", {
  description: "Show all call/spend rules for a key",
  args: z.object({
    keyRef: z
      .string()
      .optional()
      .describe("Key reference (name or hash prefix)"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    keyName: z.string().optional().describe("Key name to look up"),
    keyHash: z.string().optional().describe("Key hash to look up"),
  }),
  output: z.object({
    type: z.string(),
    key: z.object({
      hash: z.string(),
      name: z.string().nullable().optional(),
      role: z.string(),
      type: z.string(),
    }),
    callPermissions: z.array(
      z.object({
        id: z.string(),
        hashId: z.string(),
      }),
    ),
    spendLimits: z.array(
      z.object({
        id: z.string(),
        hashId: z.string(),
        limit: z.string(),
        spent: z.string(),
        remaining: z.string(),
      }),
    ),
  }),
  examples: [
    {
      args: { keyRef: "worker-1" },
      options: { profile: "agent" },
      description: "Show rules for a key",
    },
  ],
  async run({ args, options }) {
    return executePermissionsShow({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      keyRef: args.keyRef,
      keyName: options.keyName,
      keyHash: options.keyHash as `0x${string}` | undefined,
    });
  },
});

permissions.command("grant", {
  description: "Grant one call or spend permission rule",
  args: z.object({
    keyRef: z
      .string()
      .optional()
      .describe("Key reference (name or hash prefix)"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    keyName: z.string().optional().describe("Key name"),
    keyHash: z.string().optional().describe("Key hash"),
    type: permissionTypeSchema,
    target: z.string().optional().describe("Target contract address"),
    selector: z.string().optional().describe("Function selector"),
    token: z.string().optional().describe("Spend token address"),
    spendLimit: z
      .string()
      .optional()
      .describe("Spend limit in USDC human units (for example, 10 = 10 USDC)"),
    spendLimitRaw: z
      .string()
      .optional()
      .describe(
        "Spend limit in raw base units (mutually exclusive with --spend-limit)",
      ),
    period: spendPeriodSchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    bundle: z.object({ id: z.string() }),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { keyRef: "worker-1" },
      options: { type: "call", target: "0x...", selector: "0x..." },
      description: "Grant a call permission",
    },
  ],
  async run({ args, options, env }) {
    const password = await resolveSessionCreatePassword(
      { passwordStdin: options.passwordStdin ?? false },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to grant this permission rule:",
            ),
          ),
      },
    );

    return executePermissionsGrant({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      keyRef: args.keyRef,
      keyName: options.keyName,
      keyHash: options.keyHash as `0x${string}` | undefined,
      grantType: options.type,
      target: options.target as `0x${string}` | undefined,
      selector: options.selector as `0x${string}` | undefined,
      token: options.token as `0x${string}` | undefined,
      spendLimit: resolveSpendLimitInput({
        spendLimit: options.spendLimit,
        spendLimitRaw: options.spendLimitRaw,
        parseHumanAmount: parseSpendLimitUnits,
      }),
      period: options.period,
      password,
    });
  },
});

permissions.command("revoke", {
  description: "Revoke one rule or all rules for a key",
  args: z.object({
    keyRef: z
      .string()
      .optional()
      .describe("Key reference (name or hash prefix)"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    keyName: z.string().optional().describe("Key name"),
    keyHash: z.string().optional().describe("Key hash"),
    rule: z.string().optional().describe("Rule hash ID to revoke"),
    all: z.boolean().optional().describe("Revoke all rules for the key"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    bundle: z.object({ id: z.string() }),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { keyRef: "worker-1" },
      options: { all: true },
      description: "Revoke all rules for a key",
    },
  ],
  async run({ args, options, env }) {
    const password = await resolveSessionCreatePassword(
      { passwordStdin: options.passwordStdin ?? false },
      {
        ...passwordDeps(env.TW_PASSWORD),
        promptForExistingPassword: () =>
          handlePromptCancellation(
            readlineExistingPassword(
              "Enter your keystore password to revoke this permission:",
            ),
          ),
      },
    );

    return executePermissionsRevoke({
      env: options.env,
      chain: options.chain as ChainName | undefined,
      name: options.profile,
      keystorePath: options.keystorePath,
      keyRef: args.keyRef,
      keyName: options.keyName,
      keyHash: options.keyHash as `0x${string}` | undefined,
      rule: options.rule,
      all: options.all,
      password,
    });
  },
});

// ---------------------------------------------------------------------------
// Escrow commands
// ---------------------------------------------------------------------------

const escrow = Cli.create("escrow", {
  description: "USDC escrow — create, settle, refund, and check status",
});

escrow.command("create", {
  description: "Create a new USDC escrow with a seller and oracle",
  args: z.object({
    amount: z.string().describe("Amount of USDC to escrow"),
    seller: z
      .string()
      .describe("Seller address to receive funds on settlement"),
  }),
  options: z.object({
    oracle: z.string().describe("Oracle address authorized to sign settlement"),
    deadline: z
      .string()
      .describe(
        "Refund deadline: relative (1h, 2d, 30m, 1w) or unix timestamp",
      ),
    salt: z
      .string()
      .optional()
      .describe("Optional salt for unique escrow IDs on repeated orders"),
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    chain: chainSchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    status: z.string(),
    escrowId: z.string(),
    orderId: z.string(),
    chain: z.string(),
    buyer: z.string(),
    seller: z.string(),
    oracle: z.string(),
    amount: z.string(),
    amountBaseUnits: z.string().optional(),
    deadline: z.string(),
    deadlineTimestamp: z.string().optional(),
    escrowAddress: z.string().optional(),
    bundle: z.object({
      id: z.string(),
      status: z.string(),
      statusCode: z.number().optional(),
    }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: {
        amount: "50",
        seller: "0x1111111111111111111111111111111111111111",
      },
      options: {
        oracle: "0x2222222222222222222222222222222222222222",
        deadline: "24h",
        env: "prod",
      },
      description: "Create 50 USDC escrow with 24h deadline",
    },
  ],
  async run({ args, options, env, error: reportError }) {
    try {
      return await executeEscrowCreate({
        env: options.env,
        amount: args.amount,
        seller: args.seller,
        oracle: options.oracle,
        deadline: options.deadline,
        salt: options.salt,
        chain: options.chain as ChainName | undefined,
        name: options.profile,
        keystorePath: options.keystorePath,
        sessionFile: options.sessionFile,
        password: env.TW_PASSWORD,
        resolvePassword: () =>
          resolveAccountSendPassword(
            {
              env: options.env,
              chain: options.chain as ChainName,
              keystorePath: options.keystorePath,
              name: options.profile,
              passwordStdin: options.passwordStdin ?? false,
              legacy: false,
              json: false,
              help: false,
            },
            {
              ...passwordDeps(env.TW_PASSWORD),
              promptForExistingPassword: () =>
                handlePromptCancellation(
                  readlineExistingPassword(
                    "Enter your keystore password to sign this escrow:",
                  ),
                ),
            },
          ),
      });
    } catch (err) {
      if (err instanceof EscrowError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

escrow.command("status", {
  description: "Check the on-chain status of an escrow",
  args: z.object({
    escrowId: z.string().describe("Escrow ID (32-byte hex)"),
  }),
  options: z.object({
    env: envSchema,
    chain: chainSchema,
  }),
  output: z.object({
    type: z.string(),
    escrowId: z.string(),
    chain: z.string(),
    status: z.string(),
    escrow: z.any().optional(),
    escrowAddress: z.string(),
  }),
  examples: [
    {
      args: { escrowId: "0xabcd..." },
      description:
        "Check escrow status (escrowId must be full 32-byte hex, 0x + 64 chars)",
    },
  ],
  async run({ args, options, error: reportError }) {
    try {
      return await executeEscrowStatus({
        env: options.env,
        escrowId: args.escrowId,
        chain: options.chain as ChainName | undefined,
      });
    } catch (err) {
      if (err instanceof EscrowError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

escrow.command("settle", {
  description: "Settle an escrow by submitting an oracle settlement signature",
  args: z.object({
    escrowId: z.string().describe("Escrow ID (32-byte hex)"),
  }),
  options: z.object({
    settlementId: z
      .string()
      .describe(
        "Settlement ID (bytes32 order ID used at creation). Obtain from create flow or tw escrow status.",
      ),
    oracle: z.string().describe("Oracle address that signs the settlement"),
    oraclePrivateKey: z
      .string()
      .optional()
      .describe(
        "Oracle private key to sign settlement. Not accepted as an MCP argument. A human must type SIGN ESCROW SETTLEMENT in an interactive terminal. Prefer TW_ORACLE_PRIVATE_KEY so the key is not in the process list.",
      ),
    signature: z
      .string()
      .optional()
      .describe(
        "Pre-signed oracle settlement signature (if oracle signed offline)",
      ),
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    chain: chainSchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv.extend({
    TW_ORACLE_PRIVATE_KEY: z
      .string()
      .optional()
      .describe("Oracle private key (prefer over --oracle-private-key)"),
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    escrowId: z.string(),
    chain: z.string(),
    submitter: z.string(),
    oracle: z.string(),
    bundle: z.object({
      id: z.string(),
      status: z.string(),
      statusCode: z.number().optional(),
    }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { escrowId: "0xabcd..." },
      options: {
        settlementId: "0x1234...",
        oracle: "0x2222222222222222222222222222222222222222",
        env: "dev",
      },
      description:
        "Settle from a terminal with TW_ORACLE_PRIVATE_KEY. Type SIGN ESCROW SETTLEMENT. MCP cannot pass the oracle key.",
    },
  ],
  async run({ args, options, env, error: reportError }) {
    if (isMcpCaller() && options.oraclePrivateKey) {
      reportError({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        message: privateKeyMcpRefusal(
          "escrow settle",
          CONFIRM_ORACLE_SIGN_PHRASE,
        ),
      });
    }
    const oracleKey = options.oraclePrivateKey ?? env.TW_ORACLE_PRIVATE_KEY;
    if (oracleKey && !options.signature) {
      await confirmHuman(
        reportError,
        "Signing an escrow settlement with the oracle private key",
        CONFIRM_ORACLE_SIGN_PHRASE,
      );
    }
    try {
      return await executeEscrowSettle({
        env: options.env,
        escrowId: args.escrowId,
        settlementId: options.settlementId,
        oracle: options.oracle,
        oraclePrivateKey: oracleKey,
        signature: options.signature,
        chain: options.chain as ChainName | undefined,
        name: options.profile,
        keystorePath: options.keystorePath,
        sessionFile: options.sessionFile,
        password: env.TW_PASSWORD,
        resolvePassword: () =>
          resolveAccountSendPassword(
            {
              env: options.env,
              chain: options.chain as ChainName,
              keystorePath: options.keystorePath,
              name: options.profile,
              passwordStdin: options.passwordStdin ?? false,
              legacy: false,
              json: false,
              help: false,
            },
            {
              ...passwordDeps(env.TW_PASSWORD),
              promptForExistingPassword: () =>
                handlePromptCancellation(
                  readlineExistingPassword(
                    "Enter your keystore password to submit settlement:",
                  ),
                ),
            },
          ),
      });
    } catch (err) {
      if (err instanceof EscrowError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

escrow.command("refund", {
  description:
    "Trigger a permissionless refund after the escrow deadline has passed",
  args: z.object({
    escrowId: z.string().describe("Escrow ID (32-byte hex)"),
  }),
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    sessionFile: z
      .string()
      .optional()
      .describe("Use a portable session file directly"),
    chain: chainSchema,
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    status: z.string(),
    escrowId: z.string(),
    chain: z.string(),
    submitter: z.string(),
    bundle: z.object({
      id: z.string(),
      status: z.string(),
      statusCode: z.number().optional(),
    }),
    signerMode: z.enum(["daemon", "direct", "fallback_direct"]),
    txHash: z.string().optional(),
  }),
  examples: [
    {
      args: { escrowId: "0xabcd..." },
      options: { env: "prod" },
      description: "Refund escrow after deadline",
    },
  ],
  async run({ args, options, env, error: reportError }) {
    try {
      return await executeEscrowRefund({
        env: options.env,
        escrowId: args.escrowId,
        chain: options.chain as ChainName | undefined,
        name: options.profile,
        keystorePath: options.keystorePath,
        sessionFile: options.sessionFile,
        password: env.TW_PASSWORD,
        resolvePassword: () =>
          resolveAccountSendPassword(
            {
              env: options.env,
              chain: options.chain as ChainName,
              keystorePath: options.keystorePath,
              name: options.profile,
              passwordStdin: options.passwordStdin ?? false,
              legacy: false,
              json: false,
              help: false,
            },
            {
              ...passwordDeps(env.TW_PASSWORD),
              promptForExistingPassword: () =>
                handlePromptCancellation(
                  readlineExistingPassword(
                    "Enter your keystore password to submit refund:",
                  ),
                ),
            },
          ),
      });
    } catch (err) {
      if (err instanceof EscrowError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

// Top-level address command
tw.command("address", {
  description: "Show funding address with optional QR/link output",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    token: z
      .string()
      .default("USDC")
      .describe("Funding token symbol or address"),
    amount: z.string().optional().describe("Funding amount hint"),
    decimals: z
      .number()
      .optional()
      .describe("Token decimals (required for custom token + amount)"),
    link: z.boolean().optional().describe("Print payment URI"),
    qr: z.boolean().optional().describe("Print QR code from payment URI"),
  }),
  output: z.object({
    type: z.string(),
    address: z.string(),
    token: z.object({
      symbol: z.string().nullable().optional(),
      address: z.string(),
      decimals: z.number().nullable().optional(),
    }),
    chain: z.object({ name: z.string(), chainId: z.number() }),
    funding: z
      .object({
        paymentUri: z.string().optional(),
        qrPayload: z.string().optional(),
      })
      .optional(),
  }),
  examples: [
    { description: "Show funding address" },
    { options: { qr: true }, description: "Show with QR code" },
    {
      options: { link: true, amount: "100" },
      description: "Show with payment link",
    },
  ],
  async run({ options }) {
    const { executeAddress } = await import("./lib/address");
    return executeAddress({
      env: options.env,
      name: options.profile,
      keystorePath: options.keystorePath,
      chain: options.chain as ChainName | undefined,
      token: options.token,
      amount: options.amount,
      decimals: options.decimals,
      qr: options.qr,
      link: options.link,
    });
  },
});

tw.command("login", {
  description:
    "Authenticate via browser and install a session-only login profile",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
    tokenStdin: z.boolean().optional().describe("Read login token from stdin"),
    passwordStdin: passwordStdinSchema,
  }),
  env: passwordEnv,
  output: z.object({
    type: z.string(),
    status: z.string(),
    profile: z.string(),
    profileDir: z.string(),
    accountAddress: z.string(),
    sessionAddress: z.string(),
    chainId: z.number(),
    expiryEpochMs: z.number(),
  }),
  async run({ options, env, error: reportError }) {
    try {
      const profile = options.profile ?? "default";
      const stdinInput = readLoginTokenAndPassword(
        options.tokenStdin === true,
        options.passwordStdin === true,
      );

      const tokenHex =
        stdinInput.tokenHex ??
        (await (async () => {
          const isInteractive = Boolean(
            process.stdin.isTTY && process.stdout.isTTY,
          );
          if (!isInteractive) {
            throw new Error(
              "Token required in non-interactive mode. Use --token-stdin to pipe the login token.",
            );
          }
          const authUrl = getAuthUrl(options.env);
          if (!authUrl) {
            throw new Error(authUrlUnsetMessage(options.env));
          }
          process.stderr.write(
            `Open this URL to authorize your session:\n  ${authUrl}\n`,
          );
          return handlePromptCancellation(
            readlineExistingPassword("Paste login token:"),
          );
        })());

      const password =
        stdinInput.password ??
        (await resolveSessionCreatePassword(
          {
            passwordStdin: stdinInput.tokenHex
              ? false
              : (options.passwordStdin ?? false),
          },
          {
            ...passwordDeps(env.TW_PASSWORD),
            promptForExistingPassword: () =>
              handlePromptCancellation(
                readlineExistingPassword(
                  "Enter your keystore password to encrypt this login profile:",
                ),
              ),
          },
        ));

      return await executeLogin({
        tokenHex,
        profile,
        env: options.env,
        password,
      });
    } catch (err) {
      if (err instanceof LoginError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

tw.command("logout", {
  description:
    "Remove local login profile session key (does not revoke on-chain authorization)",
  options: z.object({
    env: envSchema,
    profile: profileSchema,
  }),
  output: z.object({
    type: z.string(),
    status: z.string(),
    profile: z.string(),
    warning: z.string(),
  }),
  async run({ options, error: reportError }) {
    try {
      return await executeLogout({
        profile: options.profile ?? "default",
        env: options.env,
      });
    } catch (err) {
      if (err instanceof LoginError) {
        return reportError({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
});

// Mount command groups
tw.command(account);
tw.command(session);
tw.command(daemon);
tw.command(permissions);
tw.command(escrow);

async function main(): Promise<void> {
  let exitCode = 0;
  // incur's MCP server resolves once stdio is attached. process.exit here would
  // tear that server down before a client can list or call tools.
  const mcp = process.argv.includes("--mcp");

  await tw.serve(process.argv.slice(2), {
    exit: (code) => {
      exitCode = code;
      updateCliProcessExitCode(code);
    },
  });

  if (mcp) return;
  process.exit(resolveCliProcessExitCode(exitCode));
}

await main();

export default tw;
