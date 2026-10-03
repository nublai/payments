export {
    bigIntReplacer,
    serializeCall,
    serializeIntent,
    serializeContext,
    deserializeContext,
    getChainIdFromContext,
    type SerializedCall,
    type SerializedIntent,
} from './serialize'

export { isDelegatedAccount } from './account'

export { computeKeyHash, encodeSecp256k1Key, type KeyType } from './keyHash'

export {
    decodeIntentError,
    isKnownIntentError,
    INTENT_ERRORS,
    type IntentErrorName,
} from './errors'

export {
    ANY_TARGET,
    EMPTY_CALLDATA_SELECTOR,
    ERC20_SELECTORS,
    ANY_FUNCTION_SELECTOR,
} from './constants'

export { getClientChain, createWalletFromPrivateKey, getWalletAccount } from './wallet'

export {
    computeErc1271Digest,
    ERC1271_SIGN_TYPEHASH,
    DOMAIN_TYPEHASH_ONLY_VERIFYING_CONTRACT,
} from './erc1271'

export { wrapSignature } from './signature'
