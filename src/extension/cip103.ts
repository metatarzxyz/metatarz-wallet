// CIP-0103 (Canton dApp standard, sync dApp API, OpenRPC v0.5.0).
//
// One transport-independent request handler: the browser-extension transport
// (content script -> service worker, see serviceWorker.ts) calls
// handleCip103Request() with the browser-reported origin of the requesting
// frame; a future WalletConnect transport can call it with the session's peer
// origin. Wallet-to-dApp events are published through onCip103Event(); each
// transport decides how to deliver them.
//
// ledgerApi is intentionally not supported (owner decision).

import { ethers } from 'ethers'
import type { Account, Network } from '@/extension/types'
import {
    addCantonConnectedSite,
    addToHistory,
    clearPk,
    getCachedPublicKeys,
    getNetworks,
    getSelectedNetwork,
    getSettings,
    getStoredAccounts,
    getStoredSelectedAccount,
    getUnlockedPk,
    isCantonSiteConnected,
    removeCantonConnectedSite,
    setCachedPublicKeys,
    strToHex,
} from '@/utils/platform'
import { rIdData, rIdWin, userApprove, userReject } from '@/extension/userRequest'
import { signHashDER, signMsgWithPk } from '@/utils/wallet'
import {
    callCip103Execute,
    callCip103Network,
    callCip103Prepare,
    cantonErrorMessage,
    isCantonChain,
    timedMessage,
    type MiddlewareError,
} from '@/utils/canton'

export const CIP103_PROVIDER_ID = 'metatarz-wallet'

const PROVIDER = { id: CIP103_PROVIDER_ID, version: '0.5.0', providerType: 'browser' as const }

const NO_ACCOUNT_REASON = 'No Canton account. Activate Canton in the wallet first.'
const NOT_CONNECTED_REASON = 'This site is not connected to the Canton wallet. Call connect first.'
const NOT_ENABLED_MESSAGE = "CIP-0103 is not enabled on this wallet's server"

// Error codes adopted by CIP-0103 (EIP-1193 / EIP-1474)
export const CIP103_ERRORS = {
    USER_REJECTED: 4001,
    UNAUTHORIZED: 4100,
    UNSUPPORTED_METHOD: 4200,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
    METHOD_NOT_FOUND: -32601,
    RESOURCE_UNAVAILABLE: -32002,
    TRANSACTION_REJECTED: -32003,
    NOT_SUPPORTED: -32004,
}

export class Cip103Error extends Error {
    code: number
    data?: unknown
    constructor(code: number, message: string, data?: unknown) {
        super(message)
        this.code = code
        this.data = data
    }
}

export type Cip103JsonRpcError = { code: number, message: string, data?: unknown }

export const toCip103Error = (e: unknown): Cip103JsonRpcError => {
    if (e instanceof Cip103Error) {
        return { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
    }
    console.warn('CIP-0103 internal error', e)
    return { code: CIP103_ERRORS.INTERNAL, message: 'Internal wallet error' }
}

export type Cip103Request = { method: string, params?: unknown }

export interface Cip103Context {
    // Origin of the requester as established by the transport (never taken from
    // request data). '' = unknown/opaque origin, which is never authorized.
    origin: string
    // True when the request comes from an embedded frame, shown in approval popups
    subframe: boolean
}

// ---------------------------------------------------------------------------
// Events

export type Cip103EventName = 'accountsChanged' | 'statusChanged' | 'connected' | 'txChanged'

export interface Cip103Event {
    event: Cip103EventName
    payload: unknown
    // Deliver only to this origin; undefined = every origin connected for Canton
    origin?: string
    // When true the receiving origin must (still) be connected for Canton
    requireConnected: boolean
}

type Cip103EventListener = (e: Cip103Event) => void
const eventListeners = new Set<Cip103EventListener>()

export const onCip103Event = (listener: Cip103EventListener) => {
    eventListeners.add(listener)
    return () => eventListeners.delete(listener)
}

const emit = (e: Cip103Event) => {
    eventListeners.forEach((l) => {
        try {
            l(e)
        } catch (err) {
            console.warn('CIP-0103 event listener failed', err)
        }
    })
}

// ---------------------------------------------------------------------------
// Network

// Used when the server does not report its network id (GET /api/v2/cip103/network
// takes precedence). dApps such as cantex.io compare these ids case-sensitively.
const FALLBACK_NETWORK_IDS: Record<number, string> = {
    31337: 'canton:MainNet',
    30337: 'canton:TestNet',
}

const middlewareUrl = (network: Network) => (network?.rpc ?? '').replace(/\/+$/, '')

/**
 * The Canton network CIP-0103 works on: the selected network if it is a Canton
 * network, otherwise the user's Canton mainnet (31337).
 */
const getActiveCantonNetwork = async (): Promise<Network | undefined> => {
    const [selected, networks] = await Promise.all([getSelectedNetwork(), getNetworks()])
    if (selected && isCantonChain(selected.chainId)) {
        return selected
    }
    return networks[31337]
}

type NetworkInfo = { ok: boolean, enabled: boolean, networkId: string, reason?: string }

const NETWORK_INFO_TTL_MS = 10 * 6e4
const NETWORK_INFO_FAIL_TTL_MS = 3e4
const networkInfoCache = new Map<string, { at: number, ttl: number, info: NetworkInfo }>()

const getNetworkInfo = async (network: Network): Promise<NetworkInfo> => {
    const url = middlewareUrl(network)
    const fallbackId = FALLBACK_NETWORK_IDS[network.chainId] ?? FALLBACK_NETWORK_IDS[31337]
    const key = `${network.chainId}|${url}`
    const cached = networkInfoCache.get(key)
    if (cached && Date.now() - cached.at < cached.ttl) {
        return cached.info
    }
    let info: NetworkInfo
    let ttl = NETWORK_INFO_TTL_MS
    try {
        if (!url) throw new Error('No middleware URL')
        const res = await callCip103Network(url)
        if (res?.code) {
            info = { ok: false, enabled: true, networkId: fallbackId, reason: `Canton server error (${res.code})` }
            ttl = NETWORK_INFO_FAIL_TTL_MS
        } else {
            info = {
                ok: true,
                enabled: res?.enabled !== false,
                networkId: typeof res?.network_id === 'string' && res.network_id ? res.network_id : fallbackId,
            }
        }
    } catch {
        info = { ok: false, enabled: true, networkId: fallbackId, reason: 'Canton server unreachable' }
        ttl = NETWORK_INFO_FAIL_TTL_MS
    }
    networkInfoCache.set(key, { at: Date.now(), ttl, info })
    return info
}

// ---------------------------------------------------------------------------
// Accounts

type CantonAccount = {
    account: Account // as stored: never carries a decrypted key
    partyId: string
    primary: boolean
    publicKey?: string // compressed secp256k1, hex without 0x
}

const PARTY_RE = /^[^:\s]+::[0-9a-fA-F]+$/

// The party of an account is registered against one Canton middleware; the
// wallet records the activation per network (network.tokens[address].canton.cc).
// Only accounts activated on the active Canton network are exposed, so a party
// registered on mainnet is never offered on testnet (and vice versa).
const isActivatedOn = (network: Network, networks: Record<number, Network>, address: string) => {
    const lookup = (n?: Network) => {
        const tokens = n?.tokens ?? {}
        const key = Object.keys(tokens).find((k) => k.toLowerCase() === address.toLowerCase())
        return key ? tokens[key]?.canton?.cc?.activated === true : false
    }
    return lookup(network) || lookup(networks[network.chainId])
}

const publicKeyMatches = (publicKey: string, address: string) => {
    try {
        return ethers.computeAddress('0x' + publicKey).toLowerCase() === address.toLowerCase()
    } catch {
        return false
    }
}

const getCantonAccounts = async (network: Network): Promise<CantonAccount[]> => {
    const [accounts, selected, networks] = await Promise.all([
        getStoredAccounts(),
        getStoredSelectedAccount(),
        getNetworks(),
    ])
    const eligible = (accounts ?? []).filter((a) =>
        a?.address && typeof a.cantonParty === 'string' && PARTY_RE.test(a.cantonParty) &&
        isActivatedOn(network, networks, a.address)
    )
    let cachedKeys = await getCachedPublicKeys()
    // A party activated while the wallet is unlocked has no cached key yet
    if (eligible.some((a) => !cachedKeys[a.address.toLowerCase()])) {
        await refreshCachedPublicKeys()
        cachedKeys = await getCachedPublicKeys()
    }
    const primaryAddress = (
        eligible.find((a) => a.address.toLowerCase() === (selected?.address ?? '').toLowerCase()) ?? eligible[0]
    )?.address
    return eligible.map((account) => {
        const cached = cachedKeys[account.address.toLowerCase()]
        return {
            account,
            partyId: account.cantonParty as string,
            primary: account.address === primaryAddress,
            publicKey: cached && publicKeyMatches(cached, account.address) ? cached : undefined,
        }
    })
}

/**
 * Caches the (public, non-secret) compressed keys of unlocked accounts, so the
 * Wallet objects can include publicKey while the wallet is locked. Private keys
 * are only read from the session store and never leave this function.
 */
export const refreshCachedPublicKeys = async (): Promise<void> => {
    const [accounts, cached] = await Promise.all([getStoredAccounts(), getCachedPublicKeys()])
    const next = { ...cached }
    let changed = false
    for (const a of accounts ?? []) {
        if (!a?.address || !a.cantonParty) continue
        const key = a.address.toLowerCase()
        if (next[key] && publicKeyMatches(next[key], a.address)) continue
        const pk = await getUnlockedPk(a.address)
        if (pk.length !== 66) continue
        try {
            const wallet = new ethers.Wallet(pk)
            if (wallet.address.toLowerCase() !== key) continue
            next[key] = wallet.signingKey.compressedPublicKey.slice(2)
            changed = true
        } catch {
            // ignore unusable keys
        }
    }
    if (changed) {
        await setCachedPublicKeys(next)
    }
}

// Wallet objects of the active Canton network. Accounts whose public key is not
// known (wallet locked and never unlocked since the cache was added) are omitted.
const toWallets = (accounts: CantonAccount[], networkId: string) =>
    accounts.filter((a) => !!a.publicKey).map((a) => {
        const [hint, namespace] = a.partyId.split('::')
        return {
            primary: a.primary,
            partyId: a.partyId,
            status: 'allocated' as const,
            hint,
            publicKey: a.publicKey as string,
            namespace,
            networkId,
            signingProviderId: CIP103_PROVIDER_ID,
        }
    })

// ---------------------------------------------------------------------------
// Status

type ConnectResult = {
    isConnected: boolean
    isNetworkConnected: boolean
    reason?: string
    networkReason?: string
}

type State = {
    network?: Network
    info?: NetworkInfo
    accounts: CantonAccount[]
    approved: boolean
}

const getState = async (origin: string): Promise<State> => {
    const network = await getActiveCantonNetwork()
    const [info, accounts, approved] = await Promise.all([
        network ? getNetworkInfo(network) : Promise.resolve(undefined),
        network ? getCantonAccounts(network) : Promise.resolve([] as CantonAccount[]),
        isCantonSiteConnected(origin),
    ])
    return { network, info, accounts, approved }
}

const connectResult = (s: State): ConnectResult => {
    const isConnected = s.approved && s.accounts.length > 0
    const isNetworkConnected = !!s.info?.ok
    const reason = isConnected ? undefined
        : !s.network ? 'No Canton network is configured in the wallet.'
        : !s.approved ? NOT_CONNECTED_REASON
        : NO_ACCOUNT_REASON
    const networkReason = isNetworkConnected ? undefined : (s.info?.reason ?? 'No Canton network is configured in the wallet.')
    return {
        isConnected,
        isNetworkConnected,
        ...(reason ? { reason } : {}),
        ...(networkReason ? { networkReason } : {}),
    }
}

// StatusEvent. Never includes session or accessToken. The network id is only
// shared with connected origins.
const statusOf = (s: State) => {
    const connection = connectResult(s)
    return {
        provider: PROVIDER,
        connection,
        ...(connection.isConnected && s.info ? { network: { networkId: s.info.networkId } } : {}),
    }
}

/** Throws 4100 unless the origin is approved and a Canton account exists. */
const requireConnected = async (ctx: Cip103Context): Promise<State & { network: Network, info: NetworkInfo }> => {
    if (!ctx.origin) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'Unauthorized: unknown origin')
    }
    const s = await getState(ctx.origin)
    if (!s.approved) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, NOT_CONNECTED_REASON)
    }
    if (!s.network || !s.info || !s.accounts.length) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, NO_ACCOUNT_REASON)
    }
    return s as State & { network: Network, info: NetworkInfo }
}

const primaryOf = (s: State): CantonAccount => {
    const primary = s.accounts.find((a) => a.primary)
    if (!primary) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, NO_ACCOUNT_REASON)
    }
    return primary
}

// ---------------------------------------------------------------------------
// Approval popups (same mechanism as the EVM popups: resolved by wallet_approve
// from the popup window, rejected when the window closes or times out)

const randomRid = () => crypto.randomUUID().replace(/-/g, '')

const openApproval = (route: string, ctx: Cip103Context, param: unknown, data?: unknown, size = { width: 400, height: 550 }): Promise<void> => {
    const rid = randomRid()
    return new Promise<void>((resolve, reject) => {
        chrome.windows.create({
            height: size.height,
            width: size.width,
            url: chrome.runtime.getURL(`index.html?route=${route}&param=${strToHex(JSON.stringify(param))}&rid=${rid}&website=${strToHex(ctx.origin)}`),
            type: 'popup'
        }).then((win) => {
            const id = String(win?.id)
            userReject[id] = () => reject(new Cip103Error(CIP103_ERRORS.USER_REJECTED, 'User rejected the request'))
            userApprove[id] = () => resolve()
            rIdWin[id] = rid
            // Request data for the popup, read back with wallet_get_data (lossless, no URL size limit)
            if (data !== undefined) {
                rIdData[id] = data
            }
        }).catch((e) => {
            console.warn('CIP-0103: failed to open approval popup', e)
            reject(new Cip103Error(CIP103_ERRORS.INTERNAL, 'Could not open the approval window'))
        })
    })
}

const pendingConnects = new Map<string, Promise<void>>()

const requestCantonConnection = (ctx: Cip103Context, s: State): Promise<void> => {
    const pending = pendingConnects.get(ctx.origin)
    if (pending) return pending
    const request = (async () => {
        await openApproval('connect', ctx, {
            origin: ctx.origin,
            subframe: ctx.subframe,
            canton: true,
            networkId: s.info?.networkId ?? '',
            parties: s.accounts.map((a) => ({ partyId: a.partyId, primary: a.primary, name: a.account.name ?? '' })),
        })
        await addCantonConnectedSite(ctx.origin)
    })().finally(() => {
        pendingConnects.delete(ctx.origin)
    })
    pendingConnects.set(ctx.origin, request)
    return request
}

// ---------------------------------------------------------------------------
// Keys and signing

const unlockedKeyOf = async (account: Account): Promise<ethers.Wallet> => {
    const pk = await getUnlockedPk(account.address)
    if (pk.length !== 66) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'The wallet is locked')
    }
    const wallet = new ethers.Wallet(pk)
    if (wallet.address.toLowerCase() !== account.address.toLowerCase()) {
        throw new Cip103Error(CIP103_ERRORS.INTERNAL, 'Account key mismatch')
    }
    return wallet
}

const lockAfterUseIfConfigured = async () => {
    try {
        const settings = await getSettings()
        if (settings.encryptAfterEveryTx) {
            await clearPk()
        }
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// prepareExecute

const COMMAND_TYPES = ['CreateCommand', 'ExerciseCommand', 'CreateAndExerciseCommand', 'ExerciseByKeyCommand'] as const

type CommandSummary = { type: string, templateId?: string, choice?: string, contractId?: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Validates a JsPrepareSubmissionRequest and returns the command summaries. */
const validatePrepareRequest = (params: unknown, primaryParty: string): CommandSummary[] => {
    const invalid = (m: string) => new Cip103Error(CIP103_ERRORS.INVALID_PARAMS, m)
    if (!isPlainObject(params)) {
        throw invalid('params must be a JsPrepareSubmissionRequest object')
    }
    const { commands, actAs, readAs, disclosedContracts, commandId } = params
    if (!Array.isArray(commands) || commands.length === 0) {
        throw invalid('commands must be a non-empty array')
    }
    const summaries = commands.map((c, i) => {
        if (!isPlainObject(c) || Object.keys(c).length !== 1 || !(COMMAND_TYPES as readonly string[]).includes(Object.keys(c)[0])) {
            throw invalid(`commands[${i}] must be one of ${COMMAND_TYPES.join(', ')}`)
        }
        const type = Object.keys(c)[0]
        const inner = c[type]
        if (!isPlainObject(inner)) {
            throw invalid(`commands[${i}].${type} must be an object`)
        }
        return {
            type: type.replace(/Command$/, ''),
            templateId: str(inner.templateId),
            choice: str(inner.choice),
            contractId: str(inner.contractId),
        }
    })
    if (commandId !== undefined && (typeof commandId !== 'string' || !commandId)) {
        throw invalid('commandId must be a non-empty string')
    }
    const partyList = (v: unknown, name: string): string[] | undefined => {
        if (v === undefined) return undefined
        if (!Array.isArray(v) || v.some((p) => typeof p !== 'string')) {
            throw invalid(`${name} must be an array of party ids`)
        }
        return v as string[]
    }
    const act = partyList(actAs, 'actAs')
    if (act && !(act.length === 1 && act[0] === primaryParty)) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'actAs must be exactly the primary party of this wallet')
    }
    const read = partyList(readAs, 'readAs')
    if (read && read.some((p) => p !== primaryParty)) {
        throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'readAs may only contain the primary party of this wallet')
    }
    if (disclosedContracts !== undefined && !Array.isArray(disclosedContracts)) {
        throw invalid('disclosedContracts must be an array')
    }
    return summaries
}

// Middleware error ({ error, code } with the HTTP status) -> CIP-0103 error
const backendError = (res: MiddlewareError): Cip103Error => {
    switch (res?.code) {
        case 400:
            return new Cip103Error(CIP103_ERRORS.INVALID_PARAMS, res.error || 'Invalid request')
        case 403:
            return new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, cantonErrorMessage(res))
        case 410:
            return new Cip103Error(CIP103_ERRORS.TRANSACTION_REJECTED, 'prepared transaction expired')
        case 501:
            return new Cip103Error(CIP103_ERRORS.NOT_SUPPORTED, NOT_ENABLED_MESSAGE)
        case 502:
            return new Cip103Error(CIP103_ERRORS.RESOURCE_UNAVAILABLE, cantonErrorMessage(res))
        default:
            return new Cip103Error(CIP103_ERRORS.INTERNAL, cantonErrorMessage(res))
    }
}

// fetch() threw: no answer from the middleware (offline, timeout, CORS)
const callMiddleware = async <T extends MiddlewareError>(call: () => Promise<T>): Promise<T> => {
    let res: T
    try {
        res = await call()
    } catch (e) {
        console.warn('CIP-0103: middleware unreachable', e)
        throw new Cip103Error(CIP103_ERRORS.RESOURCE_UNAVAILABLE, 'Canton server unreachable')
    }
    if (!res || res.code) {
        throw backendError(res ?? { code: 500 })
    }
    return res
}

type ExecutedEvent = {
    status: 'executed'
    commandId: string
    payload: { updateId: string, completionOffset: number }
}

const runPrepareExecute = async (
    origin: string,
    network: Network,
    signer: CantonAccount,
    request: Record<string, unknown>,
    commandId: string,
): Promise<ExecutedEvent> => {
    const txEvent = (payload: unknown) => emit({ event: 'txChanged', payload, origin, requireConnected: true })
    txEvent({ status: 'pending', commandId })
    try {
        const wallet = await unlockedKeyOf(signer.account)
        const url = middlewareUrl(network)
        // Same auth as transfers: EIP-191 signature of "<action>:<unix seconds>" by the account's EVM key
        const message = timedMessage('cip103')
        const auth = { message, sig: await signMsgWithPk(message, wallet.privateKey) }

        const prepared = await callMiddleware(() => callCip103Prepare(url, auth, { ...request, commandId }))
        const txHash = prepared.transaction_hash
        if (typeof prepared.prepare_id !== 'string' || !prepared.prepare_id ||
            typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
            throw new Cip103Error(CIP103_ERRORS.INTERNAL, 'Unexpected response from the Canton server')
        }

        // Exactly as Canton transfers: DER signature over the prepared transaction hash
        const der = await signHashDER(txHash, wallet.privateKey)
        txEvent({
            status: 'signed',
            commandId,
            payload: { signature: der, signedBy: signer.partyId.split('::')[1], party: signer.partyId },
        })

        const executed = await callMiddleware(() => callCip103Execute(url, auth, {
            prepare_id: prepared.prepare_id,
            signature: '0x' + der,
            public_key: wallet.signingKey.compressedPublicKey,
        }))
        const offset = Number(executed.completion_offset)
        const event: ExecutedEvent = {
            status: 'executed',
            commandId,
            payload: {
                updateId: String(executed.update_id ?? ''),
                completionOffset: Number.isFinite(offset) ? offset : 0,
            },
        }
        txEvent(event)
        if (event.payload.updateId) {
            addToHistory({
                date: Date.now(),
                txHash: event.payload.updateId,
                chainId: network.chainId,
                ...(network.explorer ? { txUrl: `${network.explorer.replace(/\/+$/, '')}/updates/${event.payload.updateId}` } : {}),
                webiste: origin,
            }).catch(() => {})
        }
        return event
    } catch (e) {
        const error = toCip103Error(e)
        txEvent({ status: 'failed', commandId, error: { code: error.code, message: error.message } })
        throw e instanceof Cip103Error ? e : new Cip103Error(error.code, error.message)
    } finally {
        await lockAfterUseIfConfigured()
    }
}

const prepareExecute = async (ctx: Cip103Context, params: unknown, wait: boolean) => {
    const s = await requireConnected(ctx)
    if (s.info.ok && !s.info.enabled) {
        throw new Cip103Error(CIP103_ERRORS.NOT_SUPPORTED, NOT_ENABLED_MESSAGE)
    }
    const signer = primaryOf(s)
    const summaries = validatePrepareRequest(params, signer.partyId)
    const request = params as Record<string, unknown>
    const commandId = typeof request.commandId === 'string' ? request.commandId : crypto.randomUUID()
    let rawJson: string
    try {
        rawJson = JSON.stringify(request, null, 2)
    } catch {
        throw new Cip103Error(CIP103_ERRORS.INVALID_PARAMS, 'params are not serializable')
    }

    await openApproval('canton-tx', ctx, { kind: 'tx' }, {
        kind: 'tx',
        origin: ctx.origin,
        subframe: ctx.subframe,
        networkId: s.info.networkId,
        party: signer.partyId,
        accountName: signer.account.name ?? '',
        address: signer.account.address,
        commandId,
        commandIdGenerated: request.commandId === undefined,
        commands: summaries,
        disclosedCount: Array.isArray(request.disclosedContracts) ? request.disclosedContracts.length : 0,
        rawJson,
    }, { width: 600, height: 760 })

    const run = runPrepareExecute(ctx.origin, s.network, signer, request, commandId)
    if (wait) {
        return { tx: await run }
    }
    // prepareExecute returns once approved; progress is reported with txChanged
    run.catch(() => {})
    return null
}

// ---------------------------------------------------------------------------
// signMessage

const signMessage = async (ctx: Cip103Context, params: unknown) => {
    const s = await requireConnected(ctx)
    if (!isPlainObject(params) || typeof params.message !== 'string') {
        throw new Cip103Error(CIP103_ERRORS.INVALID_PARAMS, 'params.message must be a string')
    }
    const message = params.message
    const signer = primaryOf(s)
    await openApproval('canton-sign', ctx, { kind: 'message' }, {
        kind: 'message',
        origin: ctx.origin,
        subframe: ctx.subframe,
        networkId: s.info.networkId,
        party: signer.partyId,
        accountName: signer.account.name ?? '',
        address: signer.account.address,
        message,
    }, { width: 480, height: 640 })
    try {
        const wallet = await unlockedKeyOf(signer.account)
        // This wallet's Canton party keys are secp256k1 (the account's EVM key), not
        // Ed25519: the signature is ECDSA over SHA-256(UTF-8 message), DER encoded.
        // signHashDER hashes its input with SHA-256 before signing, so it is given
        // the raw UTF-8 bytes of the message.
        const der = await signHashDER(ethers.hexlify(ethers.toUtf8Bytes(message)), wallet.privateKey)
        return { signature: ethers.encodeBase64('0x' + der) }
    } finally {
        await lockAfterUseIfConfigured()
    }
}

// ---------------------------------------------------------------------------
// Request handler

export const handleCip103Request = async (req: Cip103Request, ctx: Cip103Context): Promise<unknown> => {
    switch (req?.method) {
        case 'status': {
            return statusOf(await getState(ctx.origin))
        }
        case 'isConnected': {
            return connectResult(await getState(ctx.origin))
        }
        case 'connect': {
            if (!ctx.origin) {
                throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'Unauthorized: unknown origin')
            }
            let s = await getState(ctx.origin)
            if (!s.network || !s.accounts.length) {
                return { ...connectResult(s), isConnected: false, reason: NO_ACCOUNT_REASON }
            }
            if (!s.approved) {
                await requestCantonConnection(ctx, s)
                s = await getState(ctx.origin)
            }
            const status = statusOf(s)
            emit({ event: 'connected', payload: status, origin: ctx.origin, requireConnected: true })
            emit({ event: 'statusChanged', payload: status, origin: ctx.origin, requireConnected: true })
            return status.connection
        }
        case 'disconnect': {
            // statusChanged for the origin is emitted by the cantonConnectedSites watcher
            if (ctx.origin) {
                await removeCantonConnectedSite(ctx.origin)
            }
            return null
        }
        case 'getActiveNetwork': {
            const s = await requireConnected(ctx)
            return { networkId: s.info.networkId }
        }
        case 'listAccounts': {
            const s = await requireConnected(ctx)
            return toWallets(s.accounts, s.info.networkId)
        }
        case 'getPrimaryAccount': {
            const s = await requireConnected(ctx)
            const primary = toWallets(s.accounts, s.info.networkId).find((w) => w.primary)
            if (!primary) {
                throw new Cip103Error(CIP103_ERRORS.UNAUTHORIZED, 'Unlock the wallet to share the Canton account')
            }
            return primary
        }
        case 'signMessage': {
            return await signMessage(ctx, req.params)
        }
        case 'prepareExecute': {
            return await prepareExecute(ctx, req.params, false)
        }
        case 'prepareExecuteAndWait': {
            return await prepareExecute(ctx, req.params, true)
        }
        case 'ledgerApi': {
            throw new Cip103Error(CIP103_ERRORS.UNSUPPORTED_METHOD, 'ledgerApi is not supported by this wallet')
        }
        default: {
            throw new Cip103Error(CIP103_ERRORS.METHOD_NOT_FOUND, 'Method not found')
        }
    }
}

// ---------------------------------------------------------------------------
// State watcher: emits accountsChanged / statusChanged to connected origins when
// the selected account or network (or anything else the Canton account list
// depends on) changes, and statusChanged to origins whose approval was revoked.

let lastSnapshot: string | undefined
let snapshotTimer: ReturnType<typeof setTimeout> | undefined

const emitIfAccountsChanged = async () => {
    const network = await getActiveCantonNetwork()
    const [info, accounts] = network
        ? await Promise.all([getNetworkInfo(network), getCantonAccounts(network)])
        : [undefined, [] as CantonAccount[]]
    const wallets = info ? toWallets(accounts, info.networkId) : []
    const snapshot = JSON.stringify({ chainId: network?.chainId ?? 0, networkId: info?.networkId ?? '', wallets, n: accounts.length })
    if (snapshot === lastSnapshot) return
    lastSnapshot = snapshot
    // Payloads as seen by a connected origin; delivery is limited to connected origins
    emit({ event: 'accountsChanged', payload: wallets, requireConnected: true })
    emit({ event: 'statusChanged', payload: statusOf({ network, info, accounts, approved: true }), requireConnected: true })
}

const scheduleSnapshot = () => {
    if (snapshotTimer) clearTimeout(snapshotTimer)
    snapshotTimer = setTimeout(() => {
        emitIfAccountsChanged().catch((e) => console.warn('CIP-0103: state check failed', e))
    }, 300)
}

const WATCHED_LOCAL_KEYS = ['selectedAccount', 'selectedNetwork', 'accounts', 'networks', 'cantonPublicKeys']

export const watchCip103State = () => {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && 'unlockedPks' in changes) {
            refreshCachedPublicKeys().catch((e) => console.warn('CIP-0103: public key cache failed', e))
            return
        }
        if (area !== 'local') return
        if ('cantonConnectedSites' in changes) {
            const before = Object.keys(changes.cantonConnectedSites.oldValue ?? {})
            const after = changes.cantonConnectedSites.newValue ?? {}
            const removed = before.filter((o) => !Object.prototype.hasOwnProperty.call(after, o))
            for (const origin of removed) {
                getState(origin).then((s) => {
                    emit({ event: 'statusChanged', payload: statusOf(s), origin, requireConnected: false })
                }).catch(() => {})
            }
        }
        if (WATCHED_LOCAL_KEYS.some((k) => k in changes)) {
            scheduleSnapshot()
        }
    })
}

