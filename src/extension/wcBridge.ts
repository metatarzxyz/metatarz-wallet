// Service-worker side of the WalletConnect (Reown WalletKit) transport for the
// Canton dApp API.
//
// WalletKit itself runs in an offscreen document (offscreen.ts): MV3 service
// workers are suspended when idle and have no localStorage, so they cannot keep
// the relay websocket or the SDK's storage. The offscreen document forwards
// session proposals and requests here; this module owns every decision (approval
// popups, permission records, CIP-0103 handling) and tells the offscreen
// document what to answer. No WalletConnect library code is loaded here.
//
// Identity: a session is a CIP-0103 origin "walletconnect:<session topic>",
// approved while it is listed in chrome.storage.local walletconnectSessions.
// Popups show the peer's metadata URL, "via WalletConnect" and the Verify result.

import {
    getCantonShareInfo,
    handleCip103Request,
    onCip103Event,
    openApproval,
    Cip103Error,
    CIP103_ERRORS,
    type Cip103Context,
} from '@/extension/cip103'
import {
    getWalletConnectSessions,
    removeWalletConnectSession,
    setWalletConnectSession,
} from '@/utils/platform'
import {
    WC_CANTON_EVENTS,
    WC_CANTON_METHODS,
    WC_CANTON_NAMESPACE,
    WC_ERRORS,
    WC_OFFSCREEN_PATH,
    WC_TO_OFFSCREEN,
    WC_TO_SW,
    isWalletConnectSupported,
    isWcOrigin,
    isWcUri,
    wcOriginOf,
    wcTopicOf,
    type WcError,
    type WcPeer,
    type WcSessionRecord,
    type WcVerify,
} from '@/extension/wcConstants'

const UNSUPPORTED_REASON = 'WalletConnect is not available in this browser (it needs offscreen documents, which Firefox does not support).'

// ---------------------------------------------------------------------------
// Offscreen document

let creatingOffscreen: Promise<void> | undefined

const hasOffscreenDocument = async (): Promise<boolean> => {
    const url = chrome.runtime.getURL(WC_OFFSCREEN_PATH)
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
            documentUrls: [url],
        })
        return contexts.length > 0
    }
    return (await chrome.offscreen.hasDocument?.()) ?? false
}

export const ensureOffscreen = async (): Promise<void> => {
    if (!isWalletConnectSupported()) {
        throw new Error(UNSUPPORTED_REASON)
    }
    if (await hasOffscreenDocument()) return
    if (!creatingOffscreen) {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: WC_OFFSCREEN_PATH,
            reasons: [chrome.offscreen.Reason.LOCAL_STORAGE],
            justification: 'Hosts the WalletConnect client: keeps the relay connection and its session storage for dApps connected through WalletConnect.',
        }).catch((e) => {
            // A concurrent creation (e.g. another wake-up) already made it
            if (!String(e?.message ?? e).includes('single offscreen')) throw e
        }).finally(() => {
            creatingOffscreen = undefined
        })
    }
    await creatingOffscreen
}

const closeOffscreenIfUnused = async () => {
    try {
        if (pendingProposals > 0) return
        if (Object.keys(await getWalletConnectSessions()).length) return
        if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument()
    } catch {
        // ignore
    }
}

type OffscreenResponse = { ok: true, result?: any } | { ok: false, error: string }

const OFFSCREEN_CALL_TIMEOUT_MS = 60e3

const sendToOffscreen = async (action: string, payload: Record<string, unknown> = {}): Promise<any> => {
    await ensureOffscreen()
    // Retry briefly while the document has no listener yet ("Receiving end does not exist")
    let lastError = 'WalletConnect is not ready'
    for (let i = 0; i < 20; i++) {
        let res: OffscreenResponse | undefined
        try {
            res = await Promise.race([
                chrome.runtime.sendMessage({ type: WC_TO_OFFSCREEN, action, ...payload }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WalletConnect did not answer in time')), OFFSCREEN_CALL_TIMEOUT_MS)),
            ])
        } catch (e) {
            lastError = String((e as Error)?.message ?? e)
            if (!/receiving end/i.test(lastError)) break
        }
        if (res && typeof res === 'object' && 'ok' in res) {
            if (res.ok) return res.result
            throw new Error(res.error)
        }
        await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(lastError)
}

// ---------------------------------------------------------------------------
// Helpers

const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '')

const toPeer = (metadata: any): WcPeer => ({
    name: str(metadata?.name, 128) || 'Unknown dApp',
    description: str(metadata?.description, 512),
    url: str(metadata?.url, 512),
    // Only https icons are shown (no data:/javascript: URLs from the peer)
    icon: (Array.isArray(metadata?.icons) ? metadata.icons : []).map((i: unknown) => str(i, 1024))
        .find((i: string) => /^https:\/\//i.test(i)) ?? '',
})

const toVerify = (verifyContext: any): WcVerify => {
    const v = verifyContext?.verified ?? {}
    const validation = ['VALID', 'INVALID', 'UNKNOWN'].includes(v.validation) ? v.validation : 'UNKNOWN'
    return { validation, origin: str(v.origin, 512), isScam: v.isScam === true }
}

// The WalletConnect chain id is CAIP-2 "canton:<network-ref>"; the CIP-0103
// network id already has that form.
const wcChainOf = (networkId: string) => (networkId.startsWith('canton:') ? networkId : `canton:${networkId}`)

// Canton network ids are operator-defined and dApps disagree on spelling
// (e.g. cantex.io uses "canton:MainNet", others "canton:mainnet" or
// "canton:da-mainnet"). Compare them by a canonical form and answer each dApp
// with the chain id it asked for.
const canonicalChain = (chain: string): string => {
    let ref = String(chain).replace(/^canton:/i, '').toLowerCase().replace(/[-_\s]/g, '')
    if (ref.startsWith('da')) ref = ref.slice(2)
    if (ref === 'main' || ref === 'production' || ref === 'prod') ref = 'mainnet'
    if (ref === 'test') ref = 'testnet'
    if (ref === 'dev') ref = 'devnet'
    return `canton:${ref}`
}
const sameChain = (a: string, b: string) => canonicalChain(a) === canonicalChain(b)

// Rewrites networkId values in a CIP-0103 result to the session's chain spelling
const withSessionNetworkId = (value: unknown, walletNetworkId: string, sessionChain: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => withSessionNetworkId(v, walletNetworkId, sessionChain))
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = k === 'networkId' && typeof v === 'string' && sameChain(v, walletNetworkId)
            ? sessionChain
            : withSessionNetworkId(v, walletNetworkId, sessionChain)
    }
    return out
}

// CAIP-10: canton:<network-ref>:<party id, percent-encoded so "::" becomes %3A%3A>
const wcAccountOf = (chain: string, partyId: string) => `${chain}:${encodeURIComponent(partyId)}`

// Namespace entries of a proposal for "canton" ("canton" or "canton:<ref>" keys)
const cantonEntries = (namespaces: unknown): { chains: string[], methods: string[] }[] => {
    if (!namespaces || typeof namespaces !== 'object') return []
    return Object.entries(namespaces as Record<string, any>)
        .filter(([key]) => key === WC_CANTON_NAMESPACE || key.startsWith(`${WC_CANTON_NAMESPACE}:`))
        .map(([key, ns]) => ({
            chains: key.includes(':') ? [key] : (Array.isArray(ns?.chains) ? ns.chains.map(String) : []),
            methods: Array.isArray(ns?.methods) ? ns.methods.map(String) : [],
        }))
}

const otherRequiredNamespaces = (namespaces: unknown): string[] =>
    namespaces && typeof namespaces === 'object'
        ? Object.keys(namespaces).filter((k) => k !== WC_CANTON_NAMESPACE && !k.startsWith(`${WC_CANTON_NAMESPACE}:`))
        : []

const notify = (title: string, message: string) => {
    try {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('assets/extension-icon/wallet_128.png'),
            title,
            message,
        } as any)
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// Session proposals

let pendingProposals = 0
const pendingApprovals = new Set<Promise<unknown>>()

const rejectProposal = (id: number, error: WcError) => sendToOffscreen('rejectSession', { id, error })

const handleProposal = async (msg: any): Promise<void> => {
    const id = Number(msg?.id)
    const proposal = msg?.proposal ?? {}
    const peer = toPeer(proposal?.proposer?.metadata)
    const verify = toVerify(msg?.verifyContext)
    const required = proposal?.requiredNamespaces ?? {}
    const optional = proposal?.optionalNamespaces ?? {}

    const requested = [...cantonEntries(required), ...cantonEntries(optional)]
    if (!requested.length) {
        notify('WalletConnect', `${peer.name} did not request the Canton namespace; this wallet only supports Canton over WalletConnect.`)
        return rejectProposal(id, { code: WC_ERRORS.NAMESPACE_NOT_FOUND, message: 'Canton namespace not found in proposal' })
    }
    const others = otherRequiredNamespaces(required)
    if (others.length) {
        notify('WalletConnect', `${peer.name} requires unsupported networks (${others.join(', ')}).`)
        return rejectProposal(id, { sdk: 'UNSUPPORTED_NAMESPACE_KEY', message: `Unsupported namespaces: ${others.join(', ')}` })
    }

    const share = await getCantonShareInfo()
    if (!share || !share.parties.length) {
        notify('WalletConnect', 'No Canton account. Activate Canton in the wallet first, then connect again.')
        return rejectProposal(id, { code: WC_ERRORS.EXECUTION_ERROR, message: 'No Canton account. Activate Canton in the wallet first.' })
    }
    if (!share.enabled) {
        notify('WalletConnect', "The Canton dApp API is not enabled on this wallet's server.")
        return rejectProposal(id, { code: WC_ERRORS.EXECUTION_ERROR, message: "CIP-0103 is not enabled on this wallet's server" })
    }
    const walletChain = wcChainOf(share.networkId)
    const requiredCanton = cantonEntries(required)
    const requestedChains = requested.flatMap((e) => e.chains)
    // Use the dApp's own spelling of the wallet's network (if it named one)
    const chain = requestedChains.length ? requestedChains.find((c) => sameChain(c, walletChain)) : walletChain
    if (!chain) {
        notify('WalletConnect', `${peer.name} asked for ${requestedChains.join(', ')}, but the wallet is on ${walletChain}.`)
        return rejectProposal(id, { sdk: 'UNSUPPORTED_CHAINS', message: `The wallet is on ${walletChain}` })
    }
    const unsupportedMethods = requiredCanton.flatMap((e) => e.methods).filter((m) => !WC_CANTON_METHODS.includes(m))
    if (unsupportedMethods.length) {
        return rejectProposal(id, { sdk: 'UNSUPPORTED_METHODS', message: `Unsupported methods: ${unsupportedMethods.join(', ')}` })
    }

    const accounts = share.parties.map((p) => wcAccountOf(chain, p.partyId))
    const namespaces = {
        [WC_CANTON_NAMESPACE]: {
            chains: [chain],
            accounts,
            methods: [...WC_CANTON_METHODS],
            events: [...WC_CANTON_EVENTS],
        },
    }

    try {
        await openApproval('wc-proposal', { origin: '', subframe: false }, { kind: 'wc-proposal' }, {
            kind: 'wc-proposal',
            peer,
            verify,
            networkId: share.networkId,
            chain,
            parties: share.parties,
            methods: [...WC_CANTON_METHODS],
            requestedMethods: [...new Set(requested.flatMap((e) => e.methods))],
            events: [...WC_CANTON_EVENTS],
        }, { width: 480, height: 720 })
    } catch {
        return rejectProposal(id, { sdk: 'USER_REJECTED' })
    }

    const approval = sendToOffscreen('approveSession', { id, namespaces })
    pendingApprovals.add(approval)
    try {
        const session = await approval
        const topic = str(session?.topic, 128)
        if (!topic) throw new Error('No session topic')
        await setWalletConnectSession({
            topic,
            peer: toPeer(session?.peer?.metadata ?? proposal?.proposer?.metadata),
            verify,
            chains: [chain],
            accounts,
            methods: [...WC_CANTON_METHODS],
            networkId: share.networkId,
            date: Date.now(),
        })
    } catch (e) {
        console.warn('WalletConnect: approveSession failed', e)
        notify('WalletConnect', `Could not connect ${peer.name}: the request expired or the connection failed. Try again with a new link.`)
    } finally {
        pendingApprovals.delete(approval)
    }
}

// ---------------------------------------------------------------------------
// Session requests

type WcResult = { result: unknown } | { error: WcError & { data?: unknown } }

const CIP103_METHOD: Record<string, string> = {
    canton_prepareSignExecute: 'prepareExecuteAndWait',
    canton_listAccounts: 'listAccounts',
    canton_getPrimaryAccount: 'getPrimaryAccount',
    canton_getActiveNetwork: 'getActiveNetwork',
    canton_status: 'status',
    canton_ledgerApi: 'ledgerApi',
    canton_signMessage: 'signMessage',
}

const handleSessionRequest = async (msg: any): Promise<WcResult> => {
    // A request can race the storing of a session that was just approved
    await Promise.allSettled([...pendingApprovals])
    const topic = str(msg?.topic, 128)
    const record = topic ? (await getWalletConnectSessions())[topic] : undefined
    if (!record) {
        return { error: { code: WC_ERRORS.DISCONNECTED, message: 'This WalletConnect session is not connected to the wallet' } }
    }
    const method = str(msg?.method, 128)
    const cipMethod = CIP103_METHOD[method]
    if (!cipMethod || !record.methods.includes(method)) {
        return { error: { sdk: 'UNSUPPORTED_METHODS', message: `Unsupported method ${method}` } }
    }
    const chainId = str(msg?.chainId, 256)
    const share = await getCantonShareInfo()
    if (share && chainId && !sameChain(chainId, wcChainOf(share.networkId))) {
        return { error: { code: WC_ERRORS.EXECUTION_ERROR, message: `The wallet is on ${wcChainOf(share.networkId)}, not ${chainId}` } }
    }
    const ctx: Cip103Context = {
        origin: wcOriginOf(topic),
        subframe: false,
        transport: 'walletconnect',
        // Metadata from the approved session; Verify from this request
        peer: { ...record.peer, verify: msg?.verifyContext ? toVerify(msg.verifyContext) : record.verify },
    }
    const params = msg?.params === undefined || msg?.params === null ? {} : msg.params
    try {
        const raw = await handleCip103Request({ method: cipMethod, params }, ctx)
        if (method === 'canton_prepareSignExecute') {
            // { status: 'executed', commandId, payload } without the CIP-0103 { tx } wrapper
            return { result: (raw as { tx?: unknown })?.tx ?? raw }
        }
        if (method === 'canton_ledgerApi') {
            // Raw Ledger API JSON, returned untouched
            return { result: raw === undefined ? null : raw }
        }
        // Report the network with the spelling this session was approved with
        const result = share ? withSessionNetworkId(raw, share.networkId, record.chains[0]) : raw
        return { result: result === undefined ? null : result }
    } catch (e) {
        const code = e instanceof Cip103Error ? e.code : CIP103_ERRORS.INTERNAL
        const message = e instanceof Cip103Error ? e.message : 'Internal wallet error'
        if (code === CIP103_ERRORS.USER_REJECTED) {
            return { error: { code: WC_ERRORS.USER_REJECTED, message } }
        }
        if (code === CIP103_ERRORS.METHOD_NOT_FOUND || code === CIP103_ERRORS.UNSUPPORTED_METHOD) {
            return { error: { sdk: 'UNSUPPORTED_METHODS', message } }
        }
        if (!(await getWalletConnectSessions())[topic]) {
            return { error: { code: WC_ERRORS.DISCONNECTED, message: 'This WalletConnect session was disconnected' } }
        }
        // The CIP-0103 code is kept in data (e.g. 4100 "Wallet is locked", -32602)
        return { error: { code: WC_ERRORS.EXECUTION_ERROR, message, data: { cip103Code: code } } }
    }
}

// ---------------------------------------------------------------------------
// Events: CIP-0103 accountsChanged / statusChanged to every session, and
// chainChanged when the active Canton network differs from the session's last one.

const emitToSession = (record: WcSessionRecord, name: string, data: unknown) =>
    sendToOffscreen('emitSessionEvent', {
        topic: record.topic,
        chainId: record.chains[0],
        event: { name, data },
    }).catch((e) => console.warn(`WalletConnect: ${name} not delivered`, e))

const forwardEvent = async (event: { event: string, payload: unknown, origin?: string }) => {
    if (event.event !== 'accountsChanged' && event.event !== 'statusChanged') return
    if (event.origin !== undefined && !isWcOrigin(event.origin)) return
    const sessions = await getWalletConnectSessions()
    const targets = Object.values(sessions).filter((r) => event.origin === undefined || r.topic === wcTopicOf(event.origin))
    if (!targets.length || !isWalletConnectSupported()) return
    const share = await getCantonShareInfo()
    for (const record of targets) {
        const payload = share ? withSessionNetworkId(event.payload, share.networkId, record.chains[0]) : event.payload
        await emitToSession(record, event.event, payload)
        if (event.event === 'statusChanged' && share && !sameChain(share.networkId, record.networkId)) {
            await emitToSession(record, 'chainChanged', { chainId: wcChainOf(share.networkId) })
            await setWalletConnectSession({ ...record, networkId: share.networkId })
        }
    }
}

// ---------------------------------------------------------------------------
// Offscreen -> service worker messages

const isOffscreenSender = (sender: chrome.runtime.MessageSender) =>
    sender?.id === chrome.runtime.id && !sender?.tab && sender?.url === chrome.runtime.getURL(WC_OFFSCREEN_PATH)

const onOffscreenMessage = async (msg: any): Promise<unknown> => {
    switch (msg?.event) {
        case 'ready': {
            // Reconcile WalletKit's sessions with the wallet's records
            const active = new Set<string>(Array.isArray(msg?.topics) ? msg.topics.map(String) : [])
            const records = await getWalletConnectSessions()
            for (const topic of Object.keys(records)) {
                if (!active.has(topic)) await removeWalletConnectSession(topic)
            }
            const stale = [...active].filter((t) => !records[t])
            for (const topic of stale) {
                sendToOffscreen('disconnectSession', { topic }).catch(() => {})
            }
            return { ok: true }
        }
        case 'keepalive':
            return { ok: true }
        case 'session_proposal': {
            pendingProposals++
            try {
                await handleProposal(msg)
            } finally {
                pendingProposals--
            }
            return { handled: true }
        }
        case 'session_request':
            return await handleSessionRequest(msg)
        case 'session_delete': {
            await removeWalletConnectSession(str(msg?.topic, 128))
            closeOffscreenIfUnused()
            return { ok: true }
        }
        default:
            return { ok: false }
    }
}

// ---------------------------------------------------------------------------
// Wallet UI requests (wc_* methods, only from the wallet's own pages)

const friendlyPairError = (e: unknown): string => {
    const m = String((e as Error)?.message ?? e)
    if (/expired/i.test(m)) return 'This WalletConnect link has expired. Get a new one from the dApp and try again.'
    if (/already exists/i.test(m)) return 'This WalletConnect link was already used. Get a new one from the dApp and try again.'
    if (/invalid|missing/i.test(m)) return 'This is not a valid WalletConnect link.'
    if (/offscreen|not available/i.test(m)) return UNSUPPORTED_REASON
    return 'Could not connect: ' + m
}

export const handleWalletConnectUiRequest = async (method: string, params: any): Promise<unknown> => {
    const supported = isWalletConnectSupported()
    switch (method) {
        case 'wc_status':
            return { supported, ...(supported ? {} : { reason: UNSUPPORTED_REASON }) }
        case 'wc_sessions':
            return Object.values(await getWalletConnectSessions()).sort((a, b) => b.date - a.date)
        case 'wc_pair': {
            if (!supported) return { error: UNSUPPORTED_REASON }
            const uri = str(params?.uri, 4096).trim()
            if (!isWcUri(uri)) {
                return { error: 'Paste a WalletConnect v2 link: it starts with "wc:" and contains "@2".' }
            }
            try {
                await sendToOffscreen('pair', { uri })
                return { ok: true }
            } catch (e) {
                return { error: friendlyPairError(e) }
            }
        }
        case 'wc_disconnect': {
            const topic = str(params?.topic, 128)
            await removeWalletConnectSession(topic)
            if (supported) {
                await sendToOffscreen('disconnectSession', { topic }).catch((e) => console.warn('WalletConnect: disconnect failed', e))
                closeOffscreenIfUnused()
            }
            return { ok: true }
        }
        default:
            return { error: 'Unknown method' }
    }
}

// ---------------------------------------------------------------------------

export const startWalletConnectBridge = () => {
    if (!isWalletConnectSupported()) return

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type !== WC_TO_SW) return false
        if (!isOffscreenSender(sender)) {
            sendResponse({ ok: false })
            return false
        }
        onOffscreenMessage(msg).then(sendResponse).catch((e) => {
            console.warn('WalletConnect: message failed', e)
            sendResponse({ error: { code: WC_ERRORS.EXECUTION_ERROR, message: 'Internal wallet error' } })
        })
        return true
    })

    onCip103Event((event) => {
        forwardEvent(event).catch((e) => console.warn('WalletConnect: event failed', e))
    })

    // Keep existing sessions reachable: (re)start the offscreen document on every
    // service worker start (browser start-up, wake-up after suspension)
    getWalletConnectSessions().then((sessions) => {
        if (Object.keys(sessions).length) return ensureOffscreen()
    }).catch((e) => console.warn('WalletConnect: could not start', e))
}
