import { encodeAbiParameters, keccak256 } from 'viem'
import type { Hex } from 'viem'
import type { CreateEscrowParams } from './types.js'
import { buildEscrowStruct, ESCROW_STRUCT_ABI } from './buildEscrowStruct.js'

export function computeEscrowId(params: CreateEscrowParams): Hex {
    const escrowStruct = buildEscrowStruct(params)
    const encoded = encodeAbiParameters(ESCROW_STRUCT_ABI, [escrowStruct])
    return keccak256(encoded)
}
