import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { INTENT_TYPES } from "@nubl/relayer-client";
import {
  PhraseLessSignError,
  SwapSignRefused,
  reviewSwapSessionSignature,
} from "../src/lib/session-daemon-policy";
import { installFormerProdDeployments } from "./helpers/former-deployment-env";

let restoreFormerProdDeployments = () => {};

beforeAll(() => {
  restoreFormerProdDeployments = installFormerProdDeployments();
});

afterAll(() => {
  restoreFormerProdDeployments();
});

const USER = "0x1111111111111111111111111111111111111111";

const THIRD_PARTY = "0x6666666666666666666666666666666666666666";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ROUTER = "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f";

const APPROVAL_PROXY = "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE";

const ORCHESTRATOR = "0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8";

const SIMPLE_SETTLER = "0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE";

const relayAbi = parseAbi([
  "function multicall((address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)",
  "function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)",
]);

const settlerAbi = parseAbi([
  "function write(address sender, bytes32 settlementId, uint256 chainId, bytes signature)",
]);

type Call = { to: Address; value: bigint; data: Hex };

function nativeSwap(): Call {
  return {
    to: ROUTER,
    value: 1_000n,
    data: encodeFunctionData({
      abi: relayAbi,
      functionName: "multicall",
      args: [
        [
          {
            target: ROUTER,
            allowFailure: false,
            value: 0n,
            callData: "0xa6bd8c96",
          },
        ],
        USER,
        USER,
        "0x",
      ],
    }),
  };
}

function usdcSwap(): Call[] {
  return [
    {
      to: USDC,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [APPROVAL_PROXY, 5_000_000n],
      }),
    },
    {
      to: APPROVAL_PROXY,
      value: 0n,
      data: encodeFunctionData({
        abi: relayAbi,
        functionName: "transferAndMulticall",
        args: [
          [USDC],
          [5_000_000n],
          [
            {
              target: ROUTER,
              allowFailure: false,
              value: 0n,
              callData: "0x9bb43718",
            },
          ],
          USER,
          USER,
          "0x",
        ],
      }),
    },
  ];
}

function intent(calls: Call[], overrides: Record<string, unknown> = {}) {
  return {
    domain: {
      name: "Orchestrator",
      version: "0.5.5",
      chainId: 8453,
      verifyingContract: ORCHESTRATOR,
    },
    types: INTENT_TYPES,
    primaryType: "Intent" as const,
    message: {
      multichain: false,
      eoa: USER,
      calls,
      nonce: 1n,
      payer: zeroAddress,
      paymentToken: zeroAddress,
      paymentMaxAmount: 0n,
      combinedGas: 0n,
      encodedPreCalls: [],
      encodedFundTransfers: [],
      settler: zeroAddress,
      expiry: 0n,
      ...overrides,
    },
  };
}

function refusal(typedData: unknown): {
  name?: string;
  code?: string;
  message?: string;
} {
  try {
    reviewSwapSessionSignature(typedData);
  } catch (error) {
    if (error instanceof SwapSignRefused || error instanceof PhraseLessSignError) {
      return error;
    }

    throw error;
  }

  return {};
}

test("swap daemon refuses a multichain or cross-chain intent", () => {
  const cases = [
    intent([nativeSwap()], { multichain: true }),
    intent([nativeSwap()], { encodedFundTransfers: ["0x1234"] }),
    intent([nativeSwap()], { settler: SIMPLE_SETTLER }),
  ];

  for (const typedData of cases) {
    expect(refusal(typedData)).toMatchObject({
      name: "SwapSignRefused",
      code: "MULTICHAIN_INTENT",
    });
  }
});

test("swap daemon refuses an intent with pre-calls", () => {
  expect(
    refusal(intent([nativeSwap()], { encodedPreCalls: ["0x1234"] })),
  ).toMatchObject({
    name: "SwapSignRefused",
    code: "PRE_CALLS",
  });
});

test("swap daemon refuses calls that move funds out", () => {
  const transfer: Call = {
    to: USDC,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [THIRD_PARTY, 1n],
    }),
  };

  const transferFrom: Call = {
    to: USDC,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [USER, THIRD_PARTY, 1n],
    }),
  };

  const nativeSend: Call = { to: THIRD_PARTY, value: 1n, data: "0x" };

  for (const extra of [transfer, transferFrom, nativeSend]) {
    expect(refusal(intent([...usdcSwap(), extra]))).toMatchObject({
      name: "SwapSignRefused",
      code: "FUNDS_OUT",
    });
  }
});

test("swap daemon refuses a call to the settler", () => {
  const settlerWrite: Call = {
    to: SIMPLE_SETTLER,
    value: 0n,
    data: encodeFunctionData({
      abi: settlerAbi,
      functionName: "write",
      args: [USER, `0x${"11".repeat(32)}`, 8453n, "0x"],
    }),
  };

  expect(refusal(intent([nativeSwap(), settlerWrite]))).toMatchObject({
    name: "SwapSignRefused",
    code: "SETTLER_CALL",
  });
});

test("a single-chain native or USDC swap through Relay is still signed", () => {
  expect(() =>
    reviewSwapSessionSignature(intent([nativeSwap()])),
  ).not.toThrow();
  expect(() => reviewSwapSessionSignature(intent(usdcSwap()))).not.toThrow();
});
