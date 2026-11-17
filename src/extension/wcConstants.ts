// WalletConnect (Reown WalletKit) transport for the Canton dApp API.
// Shared by the service worker, the offscreen document and the wallet UI, so it
// must not import any WalletConnect library code.

// Public Reown Cloud client id (not a secret)
export const WC_PROJECT_ID = '2682d383248789fea4949925e216c54a'

export const WC_METADATA = {
    name: 'Metatarz Wallet',
    description: 'Metatarz Wallet is the first EVM native Canton wallet built for privacy and security.',
    url: 'https://wallet.metatarz.xyz',
    icons: ['https://wallet.metatarz.xyz/favicon.ico'],
}

// Path of the offscreen document that hosts WalletKit (built by vite/crxjs)
export const WC_OFFSCREEN_PATH = 'src/extension/offscreen.html'

// CIP-0103 origin key of a WalletConnect session. Browser senders only ever have
// http(s) origins, and the service worker refuses this prefix from them.
export const WC_ORIGIN_PREFIX = 'walletconnect:'
export const wcOriginOf = (topic: string) => `${WC_ORIGIN_PREFIX}${topic}`
export const isWcOrigin = (origin: string) => typeof origin === 'string' && origin.startsWith(WC_ORIGIN_PREFIX)
export const wcTopicOf = (origin: string) => (isWcOrigin(origin) ? origin.slice(WC_ORIGIN_PREFIX.length) : '')

export const WC_CANTON_NAMESPACE = 'canton'

export const WC_CANTON_METHODS = [
    'canton_prepareSignExecute',
    'canton_listAccounts',
    'canton_getPrimaryAccount',
    'canton_getActiveNetwork',
    'canton_status',
    'canton_ledgerApi',
    'canton_signMessage',
]

export const WC_CANTON_EVENTS = ['accountsChanged', 'statusChanged', 'chainChanged']

// Error codes of the WalletConnect Canton integration
export const WC_ERRORS = {
    USER_REJECTED: 5000,
    EXECUTION_ERROR: 5001,
    NAMESPACE_NOT_FOUND: 5100,
    DISCONNECTED: 6000,
}

// Messages between the service worker and the offscreen document
export const WC_TO_OFFSCREEN = 'CLWALLET_WC_TO_OFFSCREEN'
export const WC_TO_SW = 'CLWALLET_WC_TO_SW'

export type WcVerify = {
    validation: 'VALID' | 'UNKNOWN' | 'INVALID'
    origin: string
    isScam: boolean
}

export type WcPeer = {
    name: string
    description: string
    url: string
    icon: string
}

// Session record kept by the wallet (chrome.storage.local "walletconnectSessions")
export type WcSessionRecord = {
    topic: string
    peer: WcPeer
    verify: WcVerify
    chains: string[]
    accounts: string[]
    methods: string[]
    networkId: string
    date: number
}

// A JSON-RPC error for respondSessionRequest / rejectSession. sdk names a
// getSdkError() key that the offscreen document resolves.
export type WcError = { code: number, message: string } | { sdk: 'UNSUPPORTED_METHODS' | 'USER_REJECTED' | 'USER_DISCONNECTED' | 'UNSUPPORTED_CHAINS' | 'UNSUPPORTED_NAMESPACE_KEY', message?: string }

export const WC_URI_RE = /^wc:[0-9a-fA-F]{8,}@2\?/

/** Basic shape check of a pairing URI; the SDK validates the rest. */
export const isWcUri = (uri: string) => typeof uri === 'string' && uri.startsWith('wc:') && uri.includes('@2') && WC_URI_RE.test(uri.trim())

/** chrome.offscreen is Chromium only (Firefox has no offscreen documents). */
export const isWalletConnectSupported = () => {
    try {
        return typeof chrome !== 'undefined' && !!chrome.offscreen?.createDocument &&
            !chrome.runtime.getURL('').startsWith('moz-extension://')
    } catch {
        return false
    }
}
