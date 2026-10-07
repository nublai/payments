/**
 * Former published addresses from deployments JSON, before those files were
 * zeroed. Tests that still exercise prod send/swap/escrow/delegate behavior
 * install them as chain-suffixed env. Production JSON stays the zero address
 * so a process without this env fails closed with "not deployed".
 */

const KEYS = {
    orchestrator: 'ORCHESTRATOR',
    simpleFunder: 'SIMPLE_FUNDER',
    simulator: 'SIMULATOR',
    account: 'ACCOUNT',
    accountProxy: 'ACCOUNT_PROXY',
    simpleSettler: 'SIMPLE_SETTLER',
    escrow: 'ESCROW',
    multiSigSigner: 'MULTI_SIG_SIGNER',
} as const

type Field = keyof typeof KEYS

const FORMER: Record<number, Record<Field, string>> = {
    8453: {
        account: '0x2eEBFfcFABEB8cE3AC016effFeC37dBBAccCff2a',
        accountProxy: '0x3Be52867f8Dca2911f81076B37921c334dE29551',
        escrow: '0x05f9597eed844410b7c0746A1C584188d0644730',
        multiSigSigner: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
        orchestrator: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8',
        simpleFunder: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
        simpleSettler: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
        simulator: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
    },
    137: {
        account: '0x4f58d66c5d55B4E6f0aA578Df8D9342f63473FF6',
        accountProxy: '0xF42350E2c880fb325E9a42aa8695EBc354DEC5E8',
        escrow: '0x05f9597eed844410b7c0746A1C584188d0644730',
        multiSigSigner: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
        orchestrator: '0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC',
        simpleFunder: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
        simpleSettler: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
        simulator: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
    },
}

export function installFormerProdDeployments(): () => void {
    const previous = new Map<string, string | undefined>()
    for (const [chainId, addresses] of Object.entries(FORMER)) {
        for (const field of Object.keys(KEYS) as Field[]) {
            const key = `${KEYS[field]}_${chainId}`
            if (!previous.has(key)) previous.set(key, process.env[key])
            process.env[key] = addresses[field]
        }
    }
    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}
