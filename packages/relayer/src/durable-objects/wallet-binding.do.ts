import { DurableObject } from 'cloudflare:workers'

import type { Env } from '../types/env'

/**
 * Global OIDC wallet bindings.
 *
 * Every other relayer table is a SQLite Durable Object. There is no D1
 * database. Address uniqueness and (issuer, subject) ownership have to be
 * decided in one transaction, so this is a single named object rather than a
 * per-account shard. A shard would make one direction of that check a
 * cross-object read.
 */
export class WalletBindingDO extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.migrateSchema()
    }

    private migrateSchema(): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        address TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bindings_identity
      ON bindings (issuer, subject);

      CREATE TABLE IF NOT EXISTS bind_nonces (
        nonce TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        address TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
    `)
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async fetch(_request: Request): Promise<Response> {
        throw new Error('Fetch not implemented, call methods directly over rpc')
    }

    async issueNonce(input: {
        issuer: string
        subject: string
        address: string
        chainId: number
        nowSeconds: number
        ttlSeconds: number
    }): Promise<
        | { ok: true; nonce: string; expiresAt: number }
        | { ok: false; reason: 'address_taken' | 'invalid' }
    > {
        const address = normalizeAddress(input.address)
        if (
            !input.issuer ||
            !input.subject ||
            !address ||
            !Number.isInteger(input.chainId) ||
            !Number.isInteger(input.nowSeconds) ||
            !Number.isInteger(input.ttlSeconds) ||
            input.ttlSeconds < 1 ||
            input.ttlSeconds > 3600
        ) {
            return { ok: false, reason: 'invalid' }
        }

        const owner = this.ownerRow(address)
        if (owner && (owner.issuer !== input.issuer || owner.subject !== input.subject)) {
            return { ok: false, reason: 'address_taken' }
        }

        const nonce = randomNonce()
        const expiresAt = input.nowSeconds + input.ttlSeconds
        this.sql.exec(
            `INSERT INTO bind_nonces (nonce, issuer, subject, address, chain_id, expires_at, used)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
            nonce,
            input.issuer,
            input.subject,
            address,
            input.chainId,
            expiresAt,
        )
        return { ok: true, nonce, expiresAt }
    }

    async bind(input: {
        nonce: string
        issuer: string
        subject: string
        address: string
        chainId: number
        expiry: number
        nowSeconds: number
    }): Promise<
        | { ok: true }
        | {
              ok: false
              reason:
                  | 'nonce_unknown'
                  | 'nonce_used'
                  | 'nonce_expired'
                  | 'nonce_mismatch'
                  | 'address_taken'
          }
    > {
        const address = normalizeAddress(input.address)
        const outcome = this.ctx.storage.transactionSync(() => {
            const nonce = this.sql
                .exec(
                    `SELECT issuer, subject, address, chain_id, expires_at, used
           FROM bind_nonces WHERE nonce = ?`,
                    input.nonce,
                )
                .toArray()
                .at(0) as NonceRow | undefined

            if (!nonce) return { ok: false as const, reason: 'nonce_unknown' as const }
            if (nonce.used) return { ok: false as const, reason: 'nonce_used' as const }
            if (nonce.expires_at <= input.nowSeconds) {
                return { ok: false as const, reason: 'nonce_expired' as const }
            }
            if (
                nonce.issuer !== input.issuer ||
                nonce.subject !== input.subject ||
                nonce.address !== address ||
                nonce.chain_id !== input.chainId ||
                nonce.expires_at !== input.expiry
            ) {
                return { ok: false as const, reason: 'nonce_mismatch' as const }
            }

            const owner = this.ownerRow(address)
            if (owner && (owner.issuer !== input.issuer || owner.subject !== input.subject)) {
                return { ok: false as const, reason: 'address_taken' as const }
            }

            if (!owner) {
                this.sql.exec(
                    `INSERT INTO bindings (address, issuer, subject, chain_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
                    address,
                    input.issuer,
                    input.subject,
                    input.chainId,
                    input.nowSeconds,
                )
            }

            this.sql.exec(`UPDATE bind_nonces SET used = 1 WHERE nonce = ?`, input.nonce)
            return { ok: true as const }
        })

        return outcome
    }

    async accountsFor(issuer: string, subject: string): Promise<string[]> {
        return this.sql
            .exec<{ address: string }>(
                `SELECT address FROM bindings WHERE issuer = ? AND subject = ? ORDER BY created_at ASC, address ASC`,
                issuer,
                subject,
            )
            .toArray()
            .map((row) => row.address)
    }

    async ownerOf(address: string): Promise<{ issuer: string; subject: string } | null> {
        const row = this.ownerRow(normalizeAddress(address))
        if (!row) return null
        return { issuer: row.issuer, subject: row.subject }
    }

    private ownerRow(address: string): { issuer: string; subject: string } | undefined {
        return this.sql
            .exec<{ issuer: string; subject: string }>(
                `SELECT issuer, subject FROM bindings WHERE address = ?`,
                address,
            )
            .toArray()
            .at(0)
    }
}

interface NonceRow {
    issuer: string
    subject: string
    address: string
    chain_id: number
    expires_at: number
    used: number
}

export const WALLET_BINDING_OBJECT = 'wallet-bindings'

function normalizeAddress(address: string): string {
    return address.trim().toLowerCase()
}

function randomNonce(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    let hex = ''
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0')
    }
    return hex
}
