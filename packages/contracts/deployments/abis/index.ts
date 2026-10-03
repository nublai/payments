//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Escrow
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const escrowAbi = [
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      {
        name: "_escrows",
        internalType: "struct IEscrow.Escrow[]",
        type: "tuple[]",
        components: [
          { name: "salt", internalType: "bytes12", type: "bytes12" },
          { name: "depositor", internalType: "address", type: "address" },
          { name: "recipient", internalType: "address", type: "address" },
          { name: "token", internalType: "address", type: "address" },
          { name: "escrowAmount", internalType: "uint256", type: "uint256" },
          { name: "refundAmount", internalType: "uint256", type: "uint256" },
          { name: "refundTimestamp", internalType: "uint256", type: "uint256" },
          { name: "settler", internalType: "address", type: "address" },
          { name: "sender", internalType: "address", type: "address" },
          { name: "settlementId", internalType: "bytes32", type: "bytes32" },
          { name: "senderChainId", internalType: "uint256", type: "uint256" },
        ],
      },
    ],
    name: "escrow",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    name: "escrows",
    outputs: [
      { name: "salt", internalType: "bytes12", type: "bytes12" },
      { name: "depositor", internalType: "address", type: "address" },
      { name: "recipient", internalType: "address", type: "address" },
      { name: "token", internalType: "address", type: "address" },
      { name: "escrowAmount", internalType: "uint256", type: "uint256" },
      { name: "refundAmount", internalType: "uint256", type: "uint256" },
      { name: "refundTimestamp", internalType: "uint256", type: "uint256" },
      { name: "settler", internalType: "address", type: "address" },
      { name: "sender", internalType: "address", type: "address" },
      { name: "settlementId", internalType: "bytes32", type: "bytes32" },
      { name: "senderChainId", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "escrowIds", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "refund",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "escrowIds", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "refundDepositor",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "escrowIds", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "refundRecipient",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "escrowIds", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "settle",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    name: "statuses",
    outputs: [
      { name: "", internalType: "enum IEscrow.EscrowStatus", type: "uint8" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "escrowId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "EscrowCreated",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "escrowId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "EscrowRefundedDepositor",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "escrowId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "EscrowRefundedRecipient",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "escrowId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
    ],
    name: "EscrowSettled",
  },
  { type: "error", inputs: [], name: "InvalidEscrow" },
  { type: "error", inputs: [], name: "InvalidStatus" },
  { type: "error", inputs: [], name: "RefundInvalid" },
  { type: "error", inputs: [], name: "SettlementInvalid" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MultiSigSigner
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const multiSigSignerAbi = [
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "ownerKeyHash", internalType: "bytes32", type: "bytes32" },
    ],
    name: "addOwner",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "account", internalType: "address", type: "address" },
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
    ],
    name: "getConfig",
    outputs: [
      { name: "threshold", internalType: "uint256", type: "uint256" },
      { name: "ownerKeyHashes", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "threshold", internalType: "uint256", type: "uint256" },
      { name: "ownerKeyHashes", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "initConfig",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "digest", internalType: "bytes32", type: "bytes32" },
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "signature", internalType: "bytes", type: "bytes" },
    ],
    name: "isValidSignatureWithKeyHash",
    outputs: [{ name: "magicValue", internalType: "bytes4", type: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "ownerKeyHash", internalType: "bytes32", type: "bytes32" },
    ],
    name: "removeOwner",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "threshold", internalType: "uint256", type: "uint256" },
    ],
    name: "setThreshold",
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "error", inputs: [], name: "ConfigAlreadySet" },
  { type: "error", inputs: [], name: "InvalidKeyHash" },
  { type: "error", inputs: [], name: "InvalidThreshold" },
  { type: "error", inputs: [], name: "OwnerNotFound" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Orchestrator
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const orchestratorAbi = [
  { type: "receive", stateMutability: "payable" },
  {
    type: "function",
    inputs: [],
    name: "CALL_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "DOMAIN_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "INTENT_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MULTICHAIN_NONCE_PREFIX",
    outputs: [{ name: "", internalType: "uint16", type: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "SIGNED_CALL_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "eoa", internalType: "address", type: "address" }],
    name: "accountImplementationOf",
    outputs: [{ name: "result", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "encodedIntent", internalType: "bytes", type: "bytes" }],
    name: "execute",
    outputs: [{ name: "err", internalType: "bytes4", type: "bytes4" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "encodedIntents", internalType: "bytes[]", type: "bytes[]" },
    ],
    name: "execute",
    outputs: [{ name: "errs", internalType: "bytes4[]", type: "bytes4[]" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "parentEOA", internalType: "address", type: "address" },
      {
        name: "preCalls",
        internalType: "struct ICommon.SignedCall[]",
        type: "tuple[]",
        components: [
          { name: "eoa", internalType: "address", type: "address" },
          { name: "executionData", internalType: "bytes", type: "bytes" },
          { name: "nonce", internalType: "uint256", type: "uint256" },
          { name: "signature", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    name: "executePreCalls",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "selfCallPayVerifyCall537021665",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "isStateOverride", internalType: "bool", type: "bool" },
      { name: "combinedGasOverride", internalType: "uint256", type: "uint256" },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateExecute",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "token", internalType: "address", type: "address" },
      { name: "recipient", internalType: "address", type: "address" },
      { name: "amount", internalType: "uint256", type: "uint256" },
    ],
    name: "withdrawTokens",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      { name: "eoa", internalType: "address", type: "address", indexed: true },
      {
        name: "nonce",
        internalType: "uint256",
        type: "uint256",
        indexed: true,
      },
      {
        name: "incremented",
        internalType: "bool",
        type: "bool",
        indexed: false,
      },
      { name: "err", internalType: "bytes4", type: "bytes4", indexed: false },
    ],
    name: "IntentExecuted",
  },
  { type: "error", inputs: [], name: "CallError" },
  { type: "error", inputs: [], name: "InsufficientGas" },
  { type: "error", inputs: [], name: "IntentExpired" },
  { type: "error", inputs: [], name: "InvalidPreCallEOA" },
  { type: "error", inputs: [], name: "OrderAlreadyFilled" },
  { type: "error", inputs: [], name: "PaymentError" },
  { type: "error", inputs: [], name: "PreCallError" },
  { type: "error", inputs: [], name: "PreCallVerificationError" },
  { type: "error", inputs: [], name: "Reentrancy" },
  { type: "error", inputs: [], name: "SimulateExecuteFailed" },
  {
    type: "error",
    inputs: [{ name: "gUsed", internalType: "uint256", type: "uint256" }],
    name: "SimulationPassed",
  },
  { type: "error", inputs: [], name: "StateOverrideError" },
  { type: "error", inputs: [], name: "UnauthorizedCallContext" },
  { type: "error", inputs: [], name: "UnsupportedAccountImplementation" },
  { type: "error", inputs: [], name: "VerificationError" },
  { type: "error", inputs: [], name: "VerifiedCallError" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SimpleFunder
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const simpleFunderAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "_funder", internalType: "address", type: "address" },
      { name: "_owner", internalType: "address", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  { type: "receive", stateMutability: "payable" },
  {
    type: "function",
    inputs: [],
    name: "cancelOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "pendingOwner", internalType: "address", type: "address" },
    ],
    name: "completeOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "", internalType: "address", type: "address" },
      { name: "digest", internalType: "bytes32", type: "bytes32" },
      {
        name: "transfers",
        internalType: "struct ICommon.Transfer[]",
        type: "tuple[]",
        components: [
          { name: "token", internalType: "address", type: "address" },
          { name: "amount", internalType: "uint256", type: "uint256" },
        ],
      },
      { name: "funderSignature", internalType: "bytes", type: "bytes" },
    ],
    name: "fund",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "digest", internalType: "bytes32", type: "bytes32" },
      {
        name: "transfers",
        internalType: "struct ICommon.Transfer[]",
        type: "tuple[]",
        components: [
          { name: "token", internalType: "address", type: "address" },
          { name: "amount", internalType: "uint256", type: "uint256" },
        ],
      },
      { name: "funderSignature", internalType: "bytes", type: "bytes" },
    ],
    name: "fund",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "funder",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "address", type: "address" }],
    name: "gasWallets",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    name: "nonces",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "address", type: "address" }],
    name: "orchestrators",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "owner",
    outputs: [{ name: "result", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "pendingOwner", internalType: "address", type: "address" },
    ],
    name: "ownershipHandoverExpiresAt",
    outputs: [{ name: "result", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "amount", internalType: "uint256", type: "uint256" }],
    name: "pullGas",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "requestOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [{ name: "newFunder", internalType: "address", type: "address" }],
    name: "setFunder",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "wallets", internalType: "address[]", type: "address[]" },
      { name: "isGasWallet", internalType: "bool", type: "bool" },
    ],
    name: "setGasWallet",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "ocs", internalType: "address[]", type: "address[]" },
      { name: "val", internalType: "bool", type: "bool" },
    ],
    name: "setOrchestrators",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "newOwner", internalType: "address", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    name: "usedDigests",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "token", internalType: "address", type: "address" },
      { name: "recipient", internalType: "address", type: "address" },
      { name: "amount", internalType: "uint256", type: "uint256" },
    ],
    name: "withdrawTokens",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "token", internalType: "address", type: "address" },
      { name: "recipient", internalType: "address", type: "address" },
      { name: "amount", internalType: "uint256", type: "uint256" },
      { name: "deadline", internalType: "uint256", type: "uint256" },
      { name: "nonce", internalType: "uint256", type: "uint256" },
      { name: "signature", internalType: "bytes", type: "bytes" },
    ],
    name: "withdrawTokensWithSignature",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "pendingOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipHandoverCanceled",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "pendingOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipHandoverRequested",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "oldOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "newOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipTransferred",
  },
  { type: "error", inputs: [], name: "AlreadyInitialized" },
  { type: "error", inputs: [], name: "DeadlineExpired" },
  { type: "error", inputs: [], name: "DigestUsed" },
  { type: "error", inputs: [], name: "InvalidFunderSignature" },
  { type: "error", inputs: [], name: "InvalidNonce" },
  { type: "error", inputs: [], name: "InvalidWithdrawalSignature" },
  { type: "error", inputs: [], name: "NewOwnerIsZeroAddress" },
  { type: "error", inputs: [], name: "NoHandoverRequest" },
  { type: "error", inputs: [], name: "OnlyGasWallet" },
  { type: "error", inputs: [], name: "OnlyOrchestrator" },
  { type: "error", inputs: [], name: "Unauthorized" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SimpleSettler
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const simpleSettlerAbi = [
  {
    type: "constructor",
    inputs: [{ name: "_owner", internalType: "address", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [],
    name: "cancelOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "pendingOwner", internalType: "address", type: "address" },
    ],
    name: "completeOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "owner",
    outputs: [{ name: "result", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "pendingOwner", internalType: "address", type: "address" },
    ],
    name: "ownershipHandoverExpiresAt",
    outputs: [{ name: "result", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "settlementId", internalType: "bytes32", type: "bytes32" },
      { name: "attester", internalType: "address", type: "address" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
    ],
    name: "read",
    outputs: [{ name: "isSettled", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "requestOwnershipHandover",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "settlementId", internalType: "bytes32", type: "bytes32" },
      { name: "settlerContext", internalType: "bytes", type: "bytes" },
    ],
    name: "send",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "", internalType: "bytes32", type: "bytes32" },
      { name: "", internalType: "address", type: "address" },
      { name: "", internalType: "uint256", type: "uint256" },
    ],
    name: "settled",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "newOwner", internalType: "address", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "sender", internalType: "address", type: "address" },
      { name: "settlementId", internalType: "bytes32", type: "bytes32" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
    ],
    name: "write",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "sender", internalType: "address", type: "address" },
      { name: "settlementId", internalType: "bytes32", type: "bytes32" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "signature", internalType: "bytes", type: "bytes" },
    ],
    name: "write",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "pendingOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipHandoverCanceled",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "pendingOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipHandoverRequested",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "oldOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "newOwner",
        internalType: "address",
        type: "address",
        indexed: true,
      },
    ],
    name: "OwnershipTransferred",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "sender",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "settlementId",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "receiverChainId",
        internalType: "uint256",
        type: "uint256",
        indexed: false,
      },
    ],
    name: "Sent",
  },
  { type: "error", inputs: [], name: "AlreadyInitialized" },
  { type: "error", inputs: [], name: "InvalidSettlementSignature" },
  { type: "error", inputs: [], name: "NewOwnerIsZeroAddress" },
  { type: "error", inputs: [], name: "NoHandoverRequest" },
  { type: "error", inputs: [], name: "Unauthorized" },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Simulator
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const simulatorAbi = [
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "oc", internalType: "address", type: "address" },
      { name: "paymentPerGasPrecision", internalType: "uint8", type: "uint8" },
      { name: "paymentPerGas", internalType: "uint256", type: "uint256" },
      {
        name: "combinedGasIncrement",
        internalType: "uint256",
        type: "uint256",
      },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateCombinedGas",
    outputs: [
      { name: "gasUsed", internalType: "uint256", type: "uint256" },
      { name: "combinedGas", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "oc", internalType: "address", type: "address" },
      { name: "overrideCombinedGas", internalType: "bool", type: "bool" },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateGasUsed",
    outputs: [{ name: "gasUsed", internalType: "uint256", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "multicall3", internalType: "address", type: "address" },
      {
        name: "calls",
        internalType: "struct IMulticall3.Call3[]",
        type: "tuple[]",
        components: [
          { name: "target", internalType: "address", type: "address" },
          { name: "allowFailure", internalType: "bool", type: "bool" },
          { name: "callData", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "oc", internalType: "address", type: "address" },
      { name: "paymentPerGasPrecision", internalType: "uint8", type: "uint8" },
      { name: "paymentPerGas", internalType: "uint256", type: "uint256" },
      {
        name: "combinedGasIncrement",
        internalType: "uint256",
        type: "uint256",
      },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateMulticall3CombinedGas",
    outputs: [
      { name: "gasUsed", internalType: "uint256", type: "uint256" },
      { name: "multicall3Gas", internalType: "uint256", type: "uint256" },
      { name: "combinedGas", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "multicall3", internalType: "address", type: "address" },
      {
        name: "calls",
        internalType: "struct IMulticall3.Call3[]",
        type: "tuple[]",
        components: [
          { name: "target", internalType: "address", type: "address" },
          { name: "allowFailure", internalType: "bool", type: "bool" },
          { name: "callData", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "oc", internalType: "address", type: "address" },
      { name: "paymentPerGasPrecision", internalType: "uint8", type: "uint8" },
      { name: "paymentPerGas", internalType: "uint256", type: "uint256" },
      {
        name: "combinedGasIncrement",
        internalType: "uint256",
        type: "uint256",
      },
      {
        name: "combinedGasVerificationOffset",
        internalType: "uint256",
        type: "uint256",
      },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateMulticall3V1Logs",
    outputs: [
      { name: "gasUsed", internalType: "uint256", type: "uint256" },
      { name: "multicall3Gas", internalType: "uint256", type: "uint256" },
      { name: "combinedGas", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      { name: "oc", internalType: "address", type: "address" },
      { name: "paymentPerGasPrecision", internalType: "uint8", type: "uint8" },
      { name: "paymentPerGas", internalType: "uint256", type: "uint256" },
      {
        name: "combinedGasIncrement",
        internalType: "uint256",
        type: "uint256",
      },
      {
        name: "combinedGasVerificationOffset",
        internalType: "uint256",
        type: "uint256",
      },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "simulateV1Logs",
    outputs: [
      { name: "gasUsed", internalType: "uint256", type: "uint256" },
      { name: "combinedGas", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "payable",
  },
] as const;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// TownsAccount
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const townsAccountAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "orchestrator", internalType: "address", type: "address" },
    ],
    stateMutability: "payable",
  },
  { type: "fallback", stateMutability: "payable" },
  { type: "receive", stateMutability: "payable" },
  {
    type: "function",
    inputs: [],
    name: "ANY_FN_SEL",
    outputs: [{ name: "", internalType: "bytes4", type: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "ANY_KEYHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "ANY_TARGET",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "CALL_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "DOMAIN_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "EMPTY_CALLDATA_FN_SEL",
    outputs: [{ name: "", internalType: "bytes4", type: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "EXECUTE_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "MULTICHAIN_NONCE_PREFIX",
    outputs: [{ name: "", internalType: "uint16", type: "uint16" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "ORCHESTRATOR",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "SIGN_TYPEHASH",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "approvedSignatureCheckers",
    outputs: [{ name: "", internalType: "address[]", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      {
        name: "key",
        internalType: "struct TownsAccount.Key",
        type: "tuple",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    name: "authorize",
    outputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "callCheckerInfos",
    outputs: [
      {
        name: "results",
        internalType: "struct GuardedExecutor.CallCheckerInfo[]",
        type: "tuple[]",
        components: [
          { name: "target", internalType: "address", type: "address" },
          { name: "checker", internalType: "address", type: "address" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "target", internalType: "address", type: "address" },
      { name: "data", internalType: "bytes", type: "bytes" },
    ],
    name: "canExecute",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "canExecutePackedInfos",
    outputs: [{ name: "", internalType: "bytes32[]", type: "bytes32[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "nonce", internalType: "uint256", type: "uint256" }],
    name: "checkAndIncrementNonce",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [
      {
        name: "calls",
        internalType: "struct ERC7821.Call[]",
        type: "tuple[]",
        components: [
          { name: "to", internalType: "address", type: "address" },
          { name: "value", internalType: "uint256", type: "uint256" },
          { name: "data", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "nonce", internalType: "uint256", type: "uint256" },
    ],
    name: "computeDigest",
    outputs: [{ name: "result", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "eip712Domain",
    outputs: [
      { name: "fields", internalType: "bytes1", type: "bytes1" },
      { name: "name", internalType: "string", type: "string" },
      { name: "version", internalType: "string", type: "string" },
      { name: "chainId", internalType: "uint256", type: "uint256" },
      { name: "verifyingContract", internalType: "address", type: "address" },
      { name: "salt", internalType: "bytes32", type: "bytes32" },
      { name: "extensions", internalType: "uint256[]", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "mode", internalType: "bytes32", type: "bytes32" },
      { name: "executionData", internalType: "bytes", type: "bytes" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    inputs: [],
    name: "getContextKeyHash",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "getKey",
    outputs: [
      {
        name: "key",
        internalType: "struct TownsAccount.Key",
        type: "tuple",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "getKeys",
    outputs: [
      {
        name: "keys",
        internalType: "struct TownsAccount.Key[]",
        type: "tuple[]",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
      },
      { name: "keyHashes", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "seqKey", internalType: "uint192", type: "uint192" }],
    name: "getNonce",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      {
        name: "key",
        internalType: "struct TownsAccount.Key",
        type: "tuple",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    name: "hash",
    outputs: [{ name: "", internalType: "bytes32", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    inputs: [{ name: "nonce", internalType: "uint256", type: "uint256" }],
    name: "invalidateNonce",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "digest", internalType: "bytes32", type: "bytes32" },
      { name: "signature", internalType: "bytes", type: "bytes" },
    ],
    name: "isValidSignature",
    outputs: [{ name: "", internalType: "bytes4", type: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "i", internalType: "uint256", type: "uint256" }],
    name: "keyAt",
    outputs: [
      {
        name: "",
        internalType: "struct TownsAccount.Key",
        type: "tuple",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "keyCount",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "label",
    outputs: [{ name: "", internalType: "string", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "paymentAmount", internalType: "uint256", type: "uint256" },
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "intentDigest", internalType: "bytes32", type: "bytes32" },
      { name: "encodedIntent", internalType: "bytes", type: "bytes" },
    ],
    name: "pay",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "token", internalType: "address", type: "address" },
      {
        name: "period",
        internalType: "enum GuardedExecutor.SpendPeriod",
        type: "uint8",
      },
    ],
    name: "removeSpendLimit",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "revoke",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "target", internalType: "address", type: "address" },
      { name: "checker", internalType: "address", type: "address" },
    ],
    name: "setCallChecker",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "target", internalType: "address", type: "address" },
      { name: "fnSel", internalType: "bytes4", type: "bytes4" },
      { name: "can", internalType: "bool", type: "bool" },
    ],
    name: "setCanExecute",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [{ name: "newLabel", internalType: "string", type: "string" }],
    name: "setLabel",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "checker", internalType: "address", type: "address" },
      { name: "isApproved", internalType: "bool", type: "bool" },
    ],
    name: "setSignatureCheckerApproval",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "token", internalType: "address", type: "address" },
      {
        name: "period",
        internalType: "enum GuardedExecutor.SpendPeriod",
        type: "uint8",
      },
      { name: "limit", internalType: "uint256", type: "uint256" },
    ],
    name: "setSpendLimit",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "keyHashes", internalType: "bytes32[]", type: "bytes32[]" },
    ],
    name: "spendAndExecuteInfos",
    outputs: [
      {
        name: "spends",
        internalType: "struct GuardedExecutor.SpendInfo[][]",
        type: "tuple[][]",
        components: [
          { name: "token", internalType: "address", type: "address" },
          {
            name: "period",
            internalType: "enum GuardedExecutor.SpendPeriod",
            type: "uint8",
          },
          { name: "limit", internalType: "uint256", type: "uint256" },
          { name: "spent", internalType: "uint256", type: "uint256" },
          { name: "lastUpdated", internalType: "uint256", type: "uint256" },
          { name: "currentSpent", internalType: "uint256", type: "uint256" },
          { name: "current", internalType: "uint256", type: "uint256" },
        ],
      },
      { name: "executes", internalType: "bytes32[][]", type: "bytes32[][]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "keyHash", internalType: "bytes32", type: "bytes32" }],
    name: "spendInfos",
    outputs: [
      {
        name: "results",
        internalType: "struct GuardedExecutor.SpendInfo[]",
        type: "tuple[]",
        components: [
          { name: "token", internalType: "address", type: "address" },
          {
            name: "period",
            internalType: "enum GuardedExecutor.SpendPeriod",
            type: "uint8",
          },
          { name: "limit", internalType: "uint256", type: "uint256" },
          { name: "spent", internalType: "uint256", type: "uint256" },
          { name: "lastUpdated", internalType: "uint256", type: "uint256" },
          { name: "currentSpent", internalType: "uint256", type: "uint256" },
          { name: "current", internalType: "uint256", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "unixTimestamp", internalType: "uint256", type: "uint256" },
      {
        name: "period",
        internalType: "enum GuardedExecutor.SpendPeriod",
        type: "uint8",
      },
    ],
    name: "startOfSpendPeriod",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    inputs: [{ name: "mode", internalType: "bytes32", type: "bytes32" }],
    name: "supportsExecutionMode",
    outputs: [{ name: "result", internalType: "bool", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "digest", internalType: "bytes32", type: "bytes32" },
      { name: "signature", internalType: "bytes", type: "bytes" },
    ],
    name: "unwrapAndValidateSignature",
    outputs: [
      { name: "isValid", internalType: "bool", type: "bool" },
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [
      { name: "previousVersion", internalType: "bytes32", type: "bytes32" },
    ],
    name: "upgradeHook",
    outputs: [{ name: "", internalType: "bool", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    inputs: [
      { name: "newImplementation", internalType: "address", type: "address" },
    ],
    name: "upgradeProxyAccount",
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "key",
        internalType: "struct TownsAccount.Key",
        type: "tuple",
        components: [
          { name: "expiry", internalType: "uint40", type: "uint40" },
          {
            name: "keyType",
            internalType: "enum TownsAccount.KeyType",
            type: "uint8",
          },
          { name: "isSuperAdmin", internalType: "bool", type: "bool" },
          { name: "publicKey", internalType: "bytes", type: "bytes" },
        ],
        indexed: false,
      },
    ],
    name: "Authorized",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "target",
        internalType: "address",
        type: "address",
        indexed: false,
      },
      {
        name: "checker",
        internalType: "address",
        type: "address",
        indexed: false,
      },
    ],
    name: "CallCheckerSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "target",
        internalType: "address",
        type: "address",
        indexed: false,
      },
      { name: "fnSel", internalType: "bytes4", type: "bytes4", indexed: false },
      { name: "can", internalType: "bool", type: "bool", indexed: false },
    ],
    name: "CanExecuteSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "implementation",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "isApproved",
        internalType: "bool",
        type: "bool",
        indexed: false,
      },
    ],
    name: "ImplementationApprovalSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "implementation",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "caller",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "isApproved",
        internalType: "bool",
        type: "bool",
        indexed: false,
      },
    ],
    name: "ImplementationCallerApprovalSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "newLabel",
        internalType: "string",
        type: "string",
        indexed: false,
      },
    ],
    name: "LabelSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "nonce",
        internalType: "uint256",
        type: "uint256",
        indexed: false,
      },
    ],
    name: "NonceInvalidated",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
    ],
    name: "Revoked",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "checker",
        internalType: "address",
        type: "address",
        indexed: true,
      },
      {
        name: "isApproved",
        internalType: "bool",
        type: "bool",
        indexed: false,
      },
    ],
    name: "SignatureCheckerApprovalSet",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "token",
        internalType: "address",
        type: "address",
        indexed: false,
      },
      {
        name: "period",
        internalType: "enum GuardedExecutor.SpendPeriod",
        type: "uint8",
        indexed: false,
      },
    ],
    name: "SpendLimitRemoved",
  },
  {
    type: "event",
    anonymous: false,
    inputs: [
      {
        name: "keyHash",
        internalType: "bytes32",
        type: "bytes32",
        indexed: false,
      },
      {
        name: "token",
        internalType: "address",
        type: "address",
        indexed: false,
      },
      {
        name: "period",
        internalType: "enum GuardedExecutor.SpendPeriod",
        type: "uint8",
        indexed: false,
      },
      {
        name: "limit",
        internalType: "uint256",
        type: "uint256",
        indexed: false,
      },
    ],
    name: "SpendLimitSet",
  },
  { type: "error", inputs: [], name: "BatchOfBatchesDecodingError" },
  { type: "error", inputs: [], name: "CannotSelfExecute" },
  {
    type: "error",
    inputs: [{ name: "token", internalType: "address", type: "address" }],
    name: "ExceededSpendLimit",
  },
  { type: "error", inputs: [], name: "ExceedsCapacity" },
  { type: "error", inputs: [], name: "FnSelectorNotRecognized" },
  { type: "error", inputs: [], name: "IndexOutOfBounds" },
  { type: "error", inputs: [], name: "InvalidNonce" },
  { type: "error", inputs: [], name: "InvalidPublicKey" },
  { type: "error", inputs: [], name: "KeyDoesNotExist" },
  { type: "error", inputs: [], name: "KeyHashIsZero" },
  { type: "error", inputs: [], name: "KeyTypeCannotBeSuperAdmin" },
  { type: "error", inputs: [], name: "NewImplementationIsZero" },
  { type: "error", inputs: [], name: "NewSequenceMustBeLarger" },
  { type: "error", inputs: [], name: "NoSpendPermissions" },
  { type: "error", inputs: [], name: "OpDataError" },
  { type: "error", inputs: [], name: "PaymasterNonceError" },
  { type: "error", inputs: [], name: "SuperAdminCanExecuteEverything" },
  { type: "error", inputs: [], name: "SuperAdminCanSpendAnything" },
  { type: "error", inputs: [], name: "Unauthorized" },
  {
    type: "error",
    inputs: [
      { name: "keyHash", internalType: "bytes32", type: "bytes32" },
      { name: "target", internalType: "address", type: "address" },
      { name: "data", internalType: "bytes", type: "bytes" },
    ],
    name: "UnauthorizedCall",
  },
  { type: "error", inputs: [], name: "UnsupportedExecutionMode" },
] as const;
