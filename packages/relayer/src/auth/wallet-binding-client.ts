import type { Env } from '../types/env'
import type { WalletBindingDO } from '../durable-objects/wallet-binding.do'
import { WALLET_BINDING_OBJECT } from '../durable-objects/wallet-binding.do'

export function walletBindingStub(env: Env): DurableObjectStub<WalletBindingDO> {
    const namespace = env.WALLET_BINDING

    if (!namespace) {
        throw new Error('WALLET_BINDING binding is missing')
    }

    return namespace.get(namespace.idFromName(WALLET_BINDING_OBJECT))
}
