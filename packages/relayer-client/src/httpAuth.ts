import type { EthHttpSigner, SignOptions } from '@slicekit/erc8128'

export interface HttpAuthOptions {
    signer?: EthHttpSigner
    signOptions?: SignOptions
    authToken?: string
    authTokenProvider?: () => Promise<string | null>
}

export interface HttpAuthConfig {
    authSigner?: EthHttpSigner
    authSignOptions?: SignOptions
    authToken?: string
    authTokenProvider?: () => Promise<string | null>
}

export function getHttpAuthOptions(config: HttpAuthConfig): HttpAuthOptions | undefined {
    const hasSigner = Boolean(config.authSigner)
    const hasToken = typeof config.authToken === 'string' && config.authToken.trim().length > 0
    const hasProvider = typeof config.authTokenProvider === 'function'

    if (!hasSigner && !hasToken && !hasProvider) {
        return undefined
    }

    return {
        signer: config.authSigner,
        signOptions: config.authSignOptions,
        authToken: config.authToken,
        authTokenProvider: config.authTokenProvider,
    }
}
