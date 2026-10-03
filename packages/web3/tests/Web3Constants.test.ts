import { BASE_SEPOLIA } from '../src/utils/Web3Constants'
import { describe, it, expect } from 'vitest'

describe('Web3Constants', () => {
    it('BASE_SEPOLIA', () => {
        expect(BASE_SEPOLIA).toBe(84532)
    })
})
