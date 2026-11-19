// Canton swaps through the wallet's middleware (POST /api/v2/swap/{quote,prepare,execute}).
//
// Pure API and orchestration code: no extension, popup or CIP-0103 dependencies,
// so both the dApp method (metatarz_swap in extension/cip103.ts) and an in-wallet
// Swap tab can use it. Failures are thrown as SwapError, whose `kind` says what
// went wrong; callers map it to their own error model (CIP-0103 codes, UI text).
//
// Amounts are 18-decimal wei integer strings for every asset. Canton amounts have
// 10 decimals, so an input amount must be a multiple of 10^8 wei.
//
// Auth (prepare and execute): X-Message "swap:<unix seconds>" signed EIP-191 by
// the account's EVM key, accepted by the middleware for 5 minutes.

import { ethers } from 'ethers'
import { readMiddlewareResponse, timedMessage, type MiddlewareError } from '@/utils/canton'
import { signHashDER, signMsgWithPk } from '@/utils/wallet'

export const SWAP_DECIMALS = 18
// 10^(18 - 10): the smallest input step Canton can represent
export const SWAP_AMOUNT_STEP = 10n ** 8n
// Below this share of the wallet's own quote, a minimum output is a high slippage tolerance
export const HIGH_SLIPPAGE_MIN_BPS = 9700n

const SYMBOL_RE = /^[A-Za-z][A-Za-z0-9.]{0,15}$/
const WEI_RE = /^[0-9]{1,78}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/

export const SLIPPAGE_MESSAGE = 'Price moved beyond your slippage tolerance; please try again'
const EXPIRED_MESSAGE = 'The prepared swap expired; please try again'
const UNAVAILABLE_MESSAGE = 'Swaps are not available on this network'
const UNREACHABLE_MESSAGE = 'Canton server unreachable'

/**
 * - invalid: bad parameters, or rejected by the server (400/409: insufficient
 *   balance, too many pending swaps, insufficient liquidity, price moved, ...)
 * - unacceptable: the prepared swap failed the wallet's safety check, or expired (410)
 * - unavailable: swaps are not enabled on this server (404/501)
 * - unreachable: no answer from the server (network error, timeout, 502)
 * - internal: anything else (401/403/500, unexpected responses)
 */
export type SwapErrorKind = 'invalid' | 'unacceptable' | 'unavailable' | 'unreachable' | 'internal'

export class SwapError extends Error {
    kind: SwapErrorKind
    status?: number
    constructor(kind: SwapErrorKind, message: string, status?: number) {
        super(message)
        this.kind = kind
        this.status = status
    }
}

export type SwapParams = { from: string, to: string, amount: string, minAmountOut: string }

export type SwapQuote = {
    from: string
    to: string
    amount_in: string
    amount_out: string
    rate: string
    spread_bps: number
}

export type SwapPrepared = {
    transfer_id: string
    transaction_hash: string
    party_id: string
    trade_id: string
    amount_in: string
    amount_out: string
    expires_at: string
}

export type SwapExecuted = { status: string, update_id: string, trade_id: string }

export type SwapResult = {
    status: 'funded'
    tradeId: string
    updateId: string
    from: string
    to: string
    amountIn: string
    amountOut: string
}

export type SwapAuth = { message: string, sig: string }

// ---------------------------------------------------------------------------
// Validation and formatting

const isPositiveWei = (v: unknown): v is string => typeof v === 'string' && WEI_RE.test(v) && BigInt(v) > 0n

/** Validates swap parameters; throws SwapError('invalid') with a clear message. */
export const validateSwapParams = (params: unknown): SwapParams => {
    const invalid = (m: string) => new SwapError('invalid', m)
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw invalid('params must be an object { from, to, amount, minAmountOut }')
    }
    const { from, to, amount, minAmountOut } = params as Record<string, unknown>
    if (typeof from !== 'string' || !SYMBOL_RE.test(from)) {
        throw invalid('from must be an asset symbol (letters, digits and dots, at most 16 characters)')
    }
    if (typeof to !== 'string' || !SYMBOL_RE.test(to)) {
        throw invalid('to must be an asset symbol (letters, digits and dots, at most 16 characters)')
    }
    if (from === to) {
        throw invalid('from and to must differ')
    }
    if (!isPositiveWei(amount)) {
        throw invalid('amount must be a positive integer string in wei (18 decimals)')
    }
    if (BigInt(amount) % SWAP_AMOUNT_STEP !== 0n) {
        throw invalid('amount must be a multiple of 10^8 wei (Canton amounts have 10 decimals)')
    }
    if (!isPositiveWei(minAmountOut)) {
        throw invalid('minAmountOut must be a positive integer string in wei (18 decimals)')
    }
    return { from, to, amount, minAmountOut }
}

/** Display symbol of a pool symbol ("Amulet" is shown as CC). */
export const swapSymbolLabel = (symbol: string) => (symbol === 'Amulet' ? 'CC' : symbol)

/** Formats a wei amount with 18 decimals, without trailing zeros. */
export const formatSwapAmount = (wei: string) => {
    try {
        return ethers.formatUnits(BigInt(wei), SWAP_DECIMALS).replace(/\.0$/, '')
    } catch {
        return wei
    }
}

/** True when minAmountOut is below 97% of the quoted output. */
export const isHighSlippage = (minAmountOut: string, quotedAmountOut: string) => {
    try {
        return BigInt(minAmountOut) * 10000n < BigInt(quotedAmountOut) * HIGH_SLIPPAGE_MIN_BPS
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// API

/** Middleware error ({ error, code } with the HTTP status) -> SwapError. */
export const swapBackendError = (res: MiddlewareError | undefined, step: 'quote' | 'prepare' | 'execute'): SwapError => {
    const status = res?.code ?? 500
    const message = typeof res?.error === 'string' && res.error ? res.error : ''
    switch (status) {
        case 400:
        case 409:
            return new SwapError('invalid', message || 'Invalid swap request', status)
        case 404:
            // A missing route means swaps are off; at execute it is a prepared swap
            // that no longer exists ("swap not found")
            return step === 'execute'
                ? new SwapError('unacceptable', EXPIRED_MESSAGE, status)
                : new SwapError('unavailable', UNAVAILABLE_MESSAGE, status)
        case 410:
            return new SwapError('unacceptable', EXPIRED_MESSAGE, status)
        case 501:
            return new SwapError('unavailable', UNAVAILABLE_MESSAGE, status)
        case 502:
            return new SwapError('unreachable', UNREACHABLE_MESSAGE, status)
        case 401:
            if (message === 'user not found') {
                return new SwapError('internal', 'This account is not registered with Canton. Activate CC in Manage Tokens first.', status)
            }
            return new SwapError('internal', 'The wallet signature was rejected as expired or invalid. Check that your device clock is correct and try again.', status)
        case 403:
            return new SwapError('internal', 'Not authorized: ' + (message || 'request rejected'), status)
        default:
            return new SwapError('internal', message ? 'Swap failed: ' + message : 'Swap failed. Try again later', status)
    }
}

const post = async <T>(url: string, path: string, body: unknown, step: 'quote' | 'prepare' | 'execute', timeoutMs: number, auth?: SwapAuth): Promise<T> => {
    let res: (T & MiddlewareError) | undefined
    try {
        const response = await fetch(url.replace(/\/+$/, '') + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(auth ? { 'X-Signature': auth.sig, 'X-Message': auth.message } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        })
        res = await readMiddlewareResponse(response)
    } catch (e) {
        console.warn(`swap ${step}: server unreachable`, e)
        throw new SwapError('unreachable', UNREACHABLE_MESSAGE)
    }
    if (!res || typeof res !== 'object' || res.code) {
        throw swapBackendError(res, step)
    }
    return res
}

/** Signed auth header for prepare and execute, by the account's EVM key. */
export const swapAuth = async (privateKey: string): Promise<SwapAuth> => {
    const message = timedMessage('swap')
    return { message, sig: await signMsgWithPk(message, privateKey) }
}

/** POST /api/v2/swap/quote: indicative quote, public (no auth, no ledger activity). */
export const fetchSwapQuote = async (url: string, p: { from: string, to: string, amount: string }): Promise<SwapQuote> => {
    const q = await post<SwapQuote>(url, '/api/v2/swap/quote', { from: p.from, to: p.to, amount: p.amount }, 'quote', 10000)
    if (!isPositiveWei(q.amount_out)) {
        throw new SwapError('internal', 'Unexpected quote from the Canton server')
    }
    return q
}

/** POST /api/v2/swap/prepare: firm on-ledger quote and the accept transaction to sign. */
export const prepareSwap = (url: string, auth: SwapAuth, p: SwapParams): Promise<SwapPrepared> =>
    post<SwapPrepared>(url, '/api/v2/swap/prepare', {
        from: p.from,
        to: p.to,
        amount: p.amount,
        min_amount_out: p.minAmountOut,
    }, 'prepare', 60000, auth)

/**
 * The wallet's own check of a prepared swap before signing it: exactly the
 * requested input, at least the minimum output, for this party, not expired, and
 * a well-formed hash. Throws SwapError('unacceptable').
 */
export const checkPreparedSwap = (prepared: SwapPrepared, p: SwapParams, partyId: string, now = Date.now()) => {
    const ok = !!prepared &&
        typeof prepared.transfer_id === 'string' && !!prepared.transfer_id &&
        prepared.amount_in === p.amount &&
        isPositiveWei(prepared.amount_out) && BigInt(prepared.amount_out) >= BigInt(p.minAmountOut) &&
        prepared.party_id === partyId &&
        typeof prepared.expires_at === 'string' && Date.parse(prepared.expires_at) > now &&
        typeof prepared.transaction_hash === 'string' && HASH_RE.test(prepared.transaction_hash)
    if (!ok) {
        throw new SwapError('unacceptable', SLIPPAGE_MESSAGE)
    }
}

/** Signs a checked prepared swap with the account's Canton key and executes it. */
export const executePreparedSwap = async (url: string, auth: SwapAuth, privateKey: string, prepared: SwapPrepared): Promise<SwapExecuted> => {
    const wallet = new ethers.Wallet(privateKey)
    // Exactly as Canton transfers: DER signature (hex) over the prepared transaction hash
    const der = await signHashDER(prepared.transaction_hash, wallet.privateKey)
    return await post<SwapExecuted>(url, '/api/v2/swap/execute', {
        transfer_id: prepared.transfer_id,
        signature: der,
        signed_by: prepared.party_id.split('::')[1],
        public_key: wallet.signingKey.compressedPublicKey,
        transaction_hash: prepared.transaction_hash,
    }, 'execute', 120000, auth)
}

export type ExecuteSwapArgs = SwapParams & {
    url: string // middleware base URL of the Canton network
    account: { address: string, pk: string } // unlocked account (EVM key = Canton key)
    partyId: string // the account's Canton party
}

/** Full swap: auth, prepare, safety check, sign, execute. */
export const executeSwap = async (args: ExecuteSwapArgs): Promise<SwapResult> => {
    const p = validateSwapParams(args)
    if (!/^[^:\s]+::[0-9a-fA-F]+$/.test(args.partyId)) {
        throw new SwapError('internal', 'Invalid Canton party')
    }
    let wallet: ethers.Wallet
    try {
        wallet = new ethers.Wallet(args.account.pk)
    } catch {
        throw new SwapError('internal', 'The wallet is locked')
    }
    if (wallet.address.toLowerCase() !== args.account.address.toLowerCase()) {
        throw new SwapError('internal', 'Account key mismatch')
    }
    const auth = await swapAuth(wallet.privateKey)
    const prepared = await prepareSwap(args.url, auth, p)
    checkPreparedSwap(prepared, p, args.partyId)
    const executed = await executePreparedSwap(args.url, auth, wallet.privateKey, prepared)
    return {
        status: 'funded',
        tradeId: String(executed.trade_id || prepared.trade_id || ''),
        updateId: String(executed.update_id ?? ''),
        from: p.from,
        to: p.to,
        amountIn: prepared.amount_in,
        amountOut: prepared.amount_out,
    }
}
