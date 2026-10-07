/**
 * Former Base (8453) addresses, unsuffixed, for tests whose prod context
 * used to read deployments JSON. The JSON is the zero address until the
 * first deploy, so these fixtures keep the original guard assertions running.
 */
export const formerProd8453Env = {
    ACCOUNT: '0x2eEBFfcFABEB8cE3AC016effFeC37dBBAccCff2a',
    ACCOUNT_PROXY: '0x3Be52867f8Dca2911f81076B37921c334dE29551',
    ESCROW: '0x05f9597eed844410b7c0746A1C584188d0644730',
    MULTI_SIG_SIGNER: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
    ORCHESTRATOR: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8',
    SIMPLE_FUNDER: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
    SIMPLE_SETTLER: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
    SIMULATOR: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
} as const
