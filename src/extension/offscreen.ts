// Offscreen document hosting Reown WalletKit for the Canton WalletConnect transport.
//
// The service worker creates this document on demand (see wcBridge.ts). It keeps
// the WalletConnect relay websocket open and WalletKit's storage (IndexedDB of
// the extension origin), which an MV3 service worker cannot. It holds no keys and
// makes no decisions: proposals and requests are forwarded to the service worker
// with chrome.runtime messaging (the only extension API offscreen documents get),
// and the answers are relayed back to the dApp.

import { Core } from '@walletconnect/core'
import { WalletKit, type WalletKitTypes } from '@reown/walletkit'
import { getSdkError } from '@walletconnect/utils'
import {
    WC_ERRORS,
    WC_METADATA,
    WC_PROJECT_ID,
    WC_TO_OFFSCREEN,
    WC_TO_SW,
    type WcError,
} from '@/extension/wcConstants'

type Kit = Awaited<ReturnType<typeof WalletKit.init>>

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 6e4
const KEEPALIVE_MS = 20e3

const toSw = (msg: Record<string, unknown>): Promise<any> =>
    chrome.runtime.sendMessage({ type: WC_TO_SW, ...msg })

// While a proposal or request is pending, ping the service worker so it is not
// suspended in the middle of the flow (approval popups also ping it).
let pending = 0
let keepalive: ReturnType<typeof setInterval> | undefined
const track = async <T>(work: () => Promise<T>): Promise<T> => {
    pending++
    if (!keepalive) {
        keepalive = setInterval(() => {
            toSw({ event: 'keepalive' }).catch(() => {})
        }, KEEPALIVE_MS)
    }
    try {
        return await work()
    } finally {
        pending--
        if (pending === 0 && keepalive) {
            clearInterval(keepalive)
            keepalive = undefined
        }
    }
}

const toRpcError = (error: WcError & { data?: unknown }) => {
    if ('sdk' in error) {
        const base = getSdkError(error.sdk)
        return { code: base.code, message: error.message || base.message }
    }
    return {
        code: Number.isInteger(error?.code) ? error.code : WC_ERRORS.EXECUTION_ERROR,
        message: String(error?.message ?? 'Request failed'),
        // JSON-RPC error data is a string on the WalletConnect wire
        ...(error?.data !== undefined && error?.data !== null ? { data: typeof error.data === 'string' ? error.data : JSON.stringify(error.data) } : {}),
    }
}

const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))

const handledProposals = new Set<number>()
const handledRequests = new Set<number>()

const onProposal = (kit: Kit) => async (ev: WalletKitTypes.SessionProposal) => {
    if (handledProposals.has(ev.id)) return
    handledProposals.add(ev.id)
    await track(async () => {
        let handled = false
        try {
            const res = await toSw({ event: 'session_proposal', id: ev.id, proposal: ev.params, verifyContext: ev.verifyContext })
            handled = res?.handled === true
        } catch (e) {
            console.warn('WalletConnect: proposal not handled', e)
        }
        if (!handled) {
            await kit.rejectSession({ id: ev.id, reason: getSdkError('USER_REJECTED') }).catch(() => {})
        }
    })
}

const onRequest = (kit: Kit) => async (ev: WalletKitTypes.SessionRequest) => {
    if (handledRequests.has(ev.id)) return
    handledRequests.add(ev.id)
    const { id, topic, params, verifyContext } = ev
    await track(async () => {
        const expiry = Number(params?.request?.expiryTimestamp)
        const ms = Number.isFinite(expiry) && expiry > 0
            ? Math.max(expiry * 1000 - Date.now(), 5e3)
            : DEFAULT_REQUEST_TIMEOUT_MS
        let response
        try {
            const res = await Promise.race([
                toSw({
                    event: 'session_request',
                    id,
                    topic,
                    chainId: params?.chainId,
                    method: params?.request?.method,
                    params: params?.request?.params,
                    verifyContext,
                }),
                timeout(ms),
            ])
            if (res && 'error' in res && res.error) {
                response = { id, jsonrpc: '2.0', error: toRpcError(res.error) }
            } else if (res && 'result' in res) {
                response = { id, jsonrpc: '2.0', result: res.result ?? null }
            } else {
                response = { id, jsonrpc: '2.0', error: { code: WC_ERRORS.EXECUTION_ERROR, message: 'The wallet did not answer' } }
            }
        } catch (e) {
            const timedOut = String((e as Error)?.message) === 'timeout'
            response = {
                id,
                jsonrpc: '2.0',
                error: { code: WC_ERRORS.EXECUTION_ERROR, message: timedOut ? 'Request timed out' : 'The wallet is not available' },
            }
        }
        await kit.respondSessionRequest({ topic, response }).catch((e) => console.warn('WalletConnect: respond failed', e))
    })
}

const kitPromise: Promise<Kit> = (async () => {
    const core = new Core({ projectId: WC_PROJECT_ID, telemetryEnabled: false, logger: 'error' })
    const kit = await WalletKit.init({ core, metadata: WC_METADATA })
    kit.on('session_proposal', onProposal(kit))
    kit.on('session_request', onRequest(kit))
    kit.on('session_delete', (ev) => {
        toSw({ event: 'session_delete', topic: ev.topic }).catch(() => {})
    })
    await toSw({ event: 'ready', topics: Object.keys(kit.getActiveSessions()) }).catch(() => {})
    // Requests that arrived while the document was down
    for (const req of kit.getPendingSessionRequests()) {
        onRequest(kit)(req as unknown as WalletKitTypes.SessionRequest)
    }
    return kit
})()

kitPromise.catch((e) => console.error('WalletConnect: init failed', e))

// Commands from the service worker only. Offscreen documents only get a part of
// chrome.runtime (no getManifest), so the worker is recognised as the extension
// context that is a script, not a document (no tab, no documentId).
const isServiceWorkerSender = (sender: chrome.runtime.MessageSender) => {
    const url = sender?.url ?? ''
    return sender?.id === chrome.runtime.id && !sender?.tab && !sender?.documentId &&
        url.startsWith(chrome.runtime.getURL('')) && url.endsWith('.js')
}

const runCommand = async (msg: any): Promise<unknown> => {
    const kit = await kitPromise
    switch (msg?.action) {
        case 'pair':
            await kit.pair({ uri: String(msg.uri ?? '') })
            return null
        case 'approveSession': {
            const session = await kit.approveSession({ id: Number(msg.id), namespaces: msg.namespaces })
            return { topic: session.topic, peer: { metadata: session.peer?.metadata } }
        }
        case 'rejectSession':
            await kit.rejectSession({ id: Number(msg.id), reason: toRpcError(msg.error ?? { sdk: 'USER_REJECTED' }) })
            return null
        case 'emitSessionEvent':
            await kit.emitSessionEvent({ topic: String(msg.topic), event: msg.event, chainId: String(msg.chainId) })
            return null
        case 'disconnectSession': {
            const topic = String(msg.topic)
            if (kit.getActiveSessions()[topic]) {
                await kit.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })
            }
            return null
        }
        case 'getActiveSessions':
            return Object.keys(kit.getActiveSessions())
        default:
            throw new Error('Unknown action')
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== WC_TO_OFFSCREEN) return false
    if (!isServiceWorkerSender(sender)) return false
    runCommand(msg)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }))
    return true
})
