import type { Network, Account, Prices, Settings, Networks, HistoryItem, ContractActions, ContractAction, Contact, ConnectedSites } from '@/extension/types'
import type { Ref } from 'vue'
import { isWcOrigin, wcTopicOf, type WcSessionRecord } from '@/extension/wcConstants'

const pottentialMissingSettings = ['copyLowerCaseAddress']

const defaultSettings = {
    // Storage encryption is mandatory; kept as a setting for older installs.
    enableStorageEnctyption: true,
    encryptAfterEveryTx: false,
    lockOutEnabled: false,
    lockOutPeriod: 2,
    lockOutBlockedUntil: 0,
    showRawTransactionData: true,
    enableAssetTransactionSimulation: false,
    assetTransactionSimulationAlchemyKey: '',
    theme: 'system',
    lastLock: Date.now(),
    lastRPCNotification: Date.now(),
    copyLowerCaseAddress: false,
    lastExecutedMigration: '',
}

const defaultAbis = {} as {
    [key: string]: string
}

export const CLW_CONTEXT_MENU_ID = 'clw-paste-address'

export const storageSave = async (key: string, value: any): Promise<void> =>{
    await chrome.storage.local.set({ [key]: value })
}

export const storageGet = async (key: string): Promise<{ [key: string]: any }> => {
    return await chrome.storage.local.get(key)
}

export const storageWipe = async (): Promise<void> => {
    await Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()])
}

// Decrypted private keys never touch chrome.storage.local. After unlock they are
// kept only in chrome.storage.session (memory-only, wiped on browser restart and
// not readable by content scripts with the default TRUSTED_CONTEXTS access level),
// keyed by lowercase address. Accounts in chrome.storage.local carry only encPk.
const SESSION_PKS_KEY = 'unlockedPks'

type UnlockedPks = { [address: string]: string }

const getUnlockedPks = async (): Promise<UnlockedPks> => {
    return (await chrome.storage.session.get(SESSION_PKS_KEY))?.[SESSION_PKS_KEY] ?? {}
}

/** Replaces the set of unlocked (decrypted) keys held in the session store. */
export const setUnlockedPks = async (accounts: { address: string, pk: string }[]): Promise<void> => {
    const pks = {} as UnlockedPks
    accounts.forEach(a => {
        if (a?.address && a?.pk) pks[a.address.toLowerCase()] = a.pk
    })
    await chrome.storage.session.set({ [SESSION_PKS_KEY]: pks })
}

/** Adds decrypted keys to the session store (e.g. just-added accounts). */
export const addUnlockedPks = async (accounts: { address: string, pk: string }[]): Promise<void> => {
    const pks = await getUnlockedPks()
    accounts.forEach(a => {
        if (a?.address && a?.pk) pks[a.address.toLowerCase()] = a.pk
    })
    await chrome.storage.session.set({ [SESSION_PKS_KEY]: pks })
}

/** Removes a deleted account's decrypted key from the session store. */
export const removeUnlockedPk = async (address: string): Promise<void> => {
    if (!address) return
    const pks = await getUnlockedPks()
    delete pks[address.toLowerCase()]
    await chrome.storage.session.set({ [SESSION_PKS_KEY]: pks })
}

/** Session-store key listing sites whose Canton reads were blocked by a locked wallet. */
export const CIP103_UNLOCK_WAITING_KEY = 'cip103UnlockWaiting'

/**
 * True when the wallet has encrypted accounts but none of their keys is in the
 * session store (never unlocked since browser start, or auto-locked).
 */
export const isWalletLocked = async (): Promise<boolean> => {
    const encrypted = (await getStoredAccounts()).filter(a => a?.encPk)
    if (!encrypted.length) return false
    const pks = await getUnlockedPks()
    return !encrypted.some(a => pks[a.address?.toLowerCase()])
}

/** Decrypted key of one account from the session store ('' while locked). */
export const getUnlockedPk = async (address: string): Promise<string> => {
    if (!address) return ''
    const account = (await getStoredAccounts()).find(a => a?.address?.toLowerCase() === address.toLowerCase())
    if (!account) return ''
    return withSessionPk(account, await getUnlockedPks()).pk ?? ''
}

// Fills account.pk from the session store. Accounts that still have no encPk
// (installs not yet migrated to mandatory encryption) keep their legacy pk.
const withSessionPk = (account: Account, pks: UnlockedPks): Account => {
    if (!account || !account.address) return account
    if (!account.encPk) return { ...account, pk: account.pk ?? '' }
    return { ...account, pk: pks[account.address.toLowerCase()] ?? '' }
}

// Removes the plaintext key before an account is written to chrome.storage.local.
// A legacy account without encPk keeps its pk so it is not lost before migration.
const toStoredAccount = (account: Account): Account => {
    if (!account || !account.encPk) return account
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pk, ...stored } = account
    return stored as Account
}

/**
 * Always returns networks keyed by chainId. An older NetworksTab bug could save
 * them as an array; that shape is repaired here so `networks[chainId]` works.
 */
const normalizeNetworks = (raw: unknown): Networks => {
    if (!raw || typeof raw !== 'object') return {} as Networks
    const out = {} as Networks
    for (const n of Object.values(raw as Record<string, Network>)) {
        if (n && n.chainId != null) out[Number(n.chainId)] = n
    }
    return out
}

export const getNetworks = async (): Promise<Networks> => {
    return normalizeNetworks((await storageGet('networks'))?.networks)
}

export const replaceNetworks = async (networks: Networks): Promise<void> => {
    await storageSave('networks', normalizeNetworks(networks))
}

export const saveNetwork = async (network: Network): Promise<void> => {
    const saveNetworks = await getNetworks()
    saveNetworks[network.chainId] = network
    await storageSave('networks', saveNetworks)
}


export const getSelectedNetwork  = async (): Promise<Network > => {
    return (await storageGet('selectedNetwork'))?.selectedNetwork ?? null as unknown as Network 
}


export const saveSelectedNetwork  = async (selectedNetwork: Network ): Promise<void> => {
    await storageSave('selectedNetwork', selectedNetwork )
}


export const getContacts = async (): Promise<Contact[]> => {
    return (await storageGet('contacts')).contacts ?? [] as Contact[]
}

export const saveContact = async (contact: Contact): Promise<void> => {
    const savedContacts = await getContacts()
    await storageSave('contacts', [contact, ...savedContacts])
}

export const replaceContacts = async (contacts: Contact[]): Promise<void> => {
    await storageSave('contacts', contacts)
}

// Accounts as stored in chrome.storage.local (no decrypted keys).
export const getStoredAccounts = async (): Promise<Account[]> => {
    return (await storageGet('accounts')).accounts ?? [] as Account[]
}

export const getAccounts = async (): Promise<Account[]> => {
    const [accounts, pks] = await Promise.all([getStoredAccounts(), getUnlockedPks()])
    return accounts.map(a => withSessionPk(a, pks))
}

export const saveAccount = async (account: Account): Promise<void> => {
    const savedAccounts = await getStoredAccounts()
    await replaceAccounts([account, ...savedAccounts])
}

export const replaceAccounts = async (accounts: Account[]): Promise<void> => {
    await storageSave('accounts', accounts.map(toStoredAccount))
}


// Selected account as stored in chrome.storage.local (no decrypted key).
export const getStoredSelectedAccount = async (): Promise<Account> => {
    return (await storageGet('selectedAccount'))?.selectedAccount ?? null as unknown as Account
}

export const getSelectedAccount = async (): Promise<Account> => {
    const [selectedAccount, pks] = await Promise.all([getStoredSelectedAccount(), getUnlockedPks()])
    return withSessionPk(selectedAccount, pks)
}


export const saveSelectedAccount = async (selectedAccount: Account): Promise<void> => {
    await storageSave('selectedAccount', toStoredAccount(selectedAccount))
}

/**
 * True when an install still has accounts that are not encrypted at rest
 * (created before encryption became mandatory, or with encryption disabled),
 * so the user must set a password before the wallet can be used.
 */
export const needsEncryptionSetup = async (): Promise<boolean> => {
    const [accounts, settings] = await Promise.all([getStoredAccounts(), getSettings()])
    return accounts.length > 0 && (!settings.enableStorageEnctyption || accounts.some(a => !a.encPk && a.pk))
}

/** True when an encryption password was already set (accounts carry encPk). */
export const hasEncryptionPassword = async (): Promise<boolean> => {
    const [accounts, settings] = await Promise.all([getStoredAccounts(), getSettings()])
    return !!settings.enableStorageEnctyption && accounts.some(a => !!a.encPk)
}

// Drops any plaintext pk left in chrome.storage.local next to an encPk
// (written by older versions while the wallet was unlocked). Skipped while an
// older install still has encryption disabled: there the plaintext key is the
// usable copy until the forced password setup re-encrypts it.
export const stripPlaintextPks = async (): Promise<void> => {
    const [accounts, selectedAccount, settings] = await Promise.all([
        getStoredAccounts(),
        getStoredSelectedAccount(),
        getSettings()
    ])
    if (!settings.enableStorageEnctyption) return
    if (accounts.some(a => a.encPk && 'pk' in a)) {
        await replaceAccounts(accounts)
    }
    if (selectedAccount?.encPk && 'pk' in selectedAccount) {
        await saveSelectedAccount(selectedAccount)
    }
}

export const setPrices = async (prices: Prices): Promise<void> => {
    await storageSave('prices', prices )
}

export const getPrices = async (): Promise<Prices> => {
    return (await storageGet('prices'))?.prices ?? {} as unknown as Prices
}

export const getHistory = async (): Promise<HistoryItem[]> => {
    return (await storageGet('history'))?.history ?? [] as unknown as Prices
}

export const addToHistory = async (historyItem: HistoryItem): Promise<void> => {
    const history = await getHistory()
    if (history.length >= 100) {
        history.pop()
        history.unshift(historyItem)
    } else {
        history.unshift(historyItem)
    }
    await storageSave('history', history)
}

export const wipeHistory = async (): Promise<void> => {
    await storageSave('history', [])
}

// Origins (scheme://host[:port]) the user approved to see the selected address
// and request signatures (EIP-1102 / EIP-2255 style per-site connection).
export const getConnectedSites = async (): Promise<ConnectedSites> => {
    return (await storageGet('connectedSites'))?.connectedSites ?? {}
}

export const isSiteConnected = async (origin: string): Promise<boolean> => {
    if (!origin) return false
    return origin in (await getConnectedSites())
}

export const addConnectedSite = async (origin: string): Promise<void> => {
    if (!origin) return
    const sites = await getConnectedSites()
    sites[origin] = { date: Date.now() }
    await storageSave('connectedSites', sites)
}

export const removeConnectedSite = async (origin: string): Promise<void> => {
    const sites = await getConnectedSites()
    delete sites[origin]
    await storageSave('connectedSites', sites)
}

// Origins the user approved for the Canton dApp API (CIP-0103). Kept apart from
// connectedSites: EVM and Canton approvals are granted and revoked independently.
export const getCantonConnectedSites = async (): Promise<ConnectedSites> => {
    return (await storageGet('cantonConnectedSites'))?.cantonConnectedSites ?? {}
}

// A WalletConnect session's origin key ("walletconnect:<topic>") is approved
// while the session is in walletconnectSessions; it is never stored as a site.
export const isCantonSiteConnected = async (origin: string): Promise<boolean> => {
    if (!origin) return false
    if (isWcOrigin(origin)) {
        const topic = wcTopicOf(origin)
        return !!topic && Object.prototype.hasOwnProperty.call(await getWalletConnectSessions(), topic)
    }
    return Object.prototype.hasOwnProperty.call(await getCantonConnectedSites(), origin)
}

export const addCantonConnectedSite = async (origin: string): Promise<void> => {
    if (!origin || isWcOrigin(origin)) return
    const sites = await getCantonConnectedSites()
    sites[origin] = { date: Date.now() }
    await storageSave('cantonConnectedSites', sites)
}

export const removeCantonConnectedSite = async (origin: string): Promise<void> => {
    if (isWcOrigin(origin)) {
        await removeWalletConnectSession(wcTopicOf(origin))
        return
    }
    const sites = await getCantonConnectedSites()
    if (!Object.prototype.hasOwnProperty.call(sites, origin)) return
    delete sites[origin]
    await storageSave('cantonConnectedSites', sites)
}

// WalletConnect sessions approved for the Canton dApp API, keyed by session
// topic. WalletKit keeps its own copy in the offscreen document; this record is
// the wallet's permission: a session missing here is disconnected.
export const getWalletConnectSessions = async (): Promise<Record<string, WcSessionRecord>> => {
    return (await storageGet('walletconnectSessions'))?.walletconnectSessions ?? {}
}

export const setWalletConnectSession = async (record: WcSessionRecord): Promise<void> => {
    if (!record?.topic) return
    const sessions = await getWalletConnectSessions()
    sessions[record.topic] = record
    await storageSave('walletconnectSessions', sessions)
}

export const removeWalletConnectSession = async (topic: string): Promise<void> => {
    const sessions = await getWalletConnectSessions()
    if (!topic || !Object.prototype.hasOwnProperty.call(sessions, topic)) return
    delete sessions[topic]
    await storageSave('walletconnectSessions', sessions)
}

// Compressed secp256k1 public keys (hex, no 0x) of accounts, keyed by lowercase
// address. Public keys are not secret; they are cached here when the wallet is
// unlocked so Canton accounts can still be listed to connected sites while it is
// locked. Readers must check that a key matches its address before using it.
export const getCachedPublicKeys = async (): Promise<{ [address: string]: string }> => {
    return (await storageGet('cantonPublicKeys'))?.cantonPublicKeys ?? {}
}

export const setCachedPublicKeys = async (keys: { [address: string]: string }): Promise<void> => {
    await storageSave('cantonPublicKeys', keys)
}

export const getSettings = async (): Promise<Settings> => {
    const settings = (await storageGet('settings'))?.settings ?? defaultSettings as unknown as Settings
    pottentialMissingSettings.forEach( (s: string) => {
        if(settings[s] === undefined) {
            settings[s as keyof Settings] = defaultSettings[s as keyof Settings]
        }
    })
    return settings
}

export const setSettings = async (settings: Settings): Promise<void> => {
    await storageSave('settings', settings )
}

export const getAllAbis = async (): Promise<{ [key: string]: string }> => {
    return ((await storageGet('abis'))?.abis) ?? defaultAbis
}

export const getAbis = async (name: string): Promise<string> => {
    return (await getAllAbis())?.[name] ?? ''
}

export const setAbi = async ({
    name ,
    content
}: {
    name: string
    content: string
}): Promise<void> => {
    const abis = await getAllAbis() || defaultAbis
    await storageSave('abis', { ...abis, [name]: content })
}

export const setAbis = async (abis: { [key: string]: string }): Promise<void> => {
    await storageSave('abis', abis)
}

export const removeAllAbis = async (): Promise<void> => {
    await storageSave('abis', defaultAbis)
}

export const readCAGetAll = async (): Promise<ContractActions> => {
    return ((await storageGet('read-actions'))?.['read-actions'] ?? {}) as ContractActions
}

export const readCAGet = async (action: string): Promise<ContractAction | undefined> => {
    return ((await readCAGetAll())?.[action]) as ContractAction
}

export const readCASet = async (action: ContractAction): Promise<void> => {
    const actions = await readCAGetAll()
    await storageSave('read-actions', { ...actions, [action.name]: action })
}

export const readCARemove = async (action: string): Promise<void> => {
    const actions = await readCAGetAll()
    delete actions[action]
    await storageSave('read-actions', actions)
}

export const readCAWipe = async (): Promise<void> => {
    await storageSave('read-actions', {})
}

export const writeCAGetAll = async (): Promise<ContractActions> => {
    return ((await storageGet('write-actions'))?.['write-actions'] ?? {}) as ContractActions
}

export const writeCAGet = async (action: string): Promise<ContractAction | undefined> => {
    return ((await writeCAGetAll())?.[action]) as ContractAction
}

export const writeCASet = async (action: ContractAction): Promise<void> => {
    const actions = await writeCAGetAll()
    await storageSave('write-actions', { ...actions, [action.name]: action })
}

export const writeCARemove = async (action: string): Promise<void> => {
    const actions = await writeCAGetAll()
    delete actions[action]
    await storageSave('write-actions', actions)
}

export const writeCAWipe = async (): Promise<void> => {
    await storageSave('write-actions', {})
}


// Auto-lock is suspended while an approval popup is open. The suspension is a
// lease that expires on its own, so a popup that is closed without unblocking
// (window X, crash, killed service worker) can never disable auto-lock for good.
// Approval popups auto-reject after 140s, so the lease outlives a normal popup.
export const LOCKOUT_BLOCK_LEASE_MS = 5 * 6e4

export const blockLockout = async (): Promise<Settings> => {
    const settings = await getSettings()
    settings.lockOutBlockedUntil = Date.now() + LOCKOUT_BLOCK_LEASE_MS
    await setSettings(settings)
    return settings
}

// Pass activity = true when the user actually used the unlocked wallet
// (e.g. approved a signature) to restart the auto-lock period.
export const unBlockLockout = async (activity = false): Promise<Settings> => {
    const settings = await getSettings()
    settings.lockOutBlockedUntil = 0
    if (activity) {
        settings.lastLock = Date.now()
    }
    await setSettings(settings)
    return settings
}

// Records an unlock / user activity; auto-lock fires lockOutPeriod after this.
export const markWalletActivity = async (): Promise<void> => {
    const settings = await getSettings()
    settings.lastLock = Date.now()
    await setSettings(settings)
}

export const getBalanceCache = async (): Promise<string> => {
    return (await storageGet('balance'))?.balance ?? '0x0'
}

export const setBalanceCache = async (balance: string): Promise<void> => {
    await storageSave('balance', balance )
}

export const smallRandomString = (size = 7) => {
    if(size <= 7) {
    return (Math.random() + 1).toString(36).substring(0,7);
    } else {
        let str = ''
        for(let i = 0; i < (size / 7) << 0; i++){
            str+=(Math.random() + i).toString(36).substring(0,7);
        }
        return str.substring(0, size)
    }
}

// Locks the wallet: forgets all decrypted keys.
export const clearPk = async (): Promise<void> => {
    await chrome.storage.session.remove(SESSION_PKS_KEY)
    await stripPlaintextPks()
}

// Lossless UTF-8 <-> hex helpers used to pass data to popups via the URL.
// hexTostr returns the input unchanged if it is not well-formed hex or not valid UTF-8,
// so nothing is ever silently re-interpreted for display.
export const hexTostr = (hexStr: string) => {
    if (hexStr.substring(0, 2) !== '0x') {
       return hexStr
    }
    const hex = hexStr.substring(2);
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
        return hexStr
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return hexStr
    }
};

export const strToHex = (str: string) =>
    `0x${Array.from(new TextEncoder().encode(str), b => b.toString(16).padStart(2, '0')).join('')}`

export const numToHexStr = (num: number | bigint) => `0x${num.toString(16)}`

export const copyText = async (address: string, toastRef: Ref<boolean>) => {
    await navigator.clipboard.writeText(address)
    toastRef.value = true
}

export const getUrl = (url: string) => chrome.runtime.getURL(url)

export const paste = (id: string) => {
    const el = document.querySelector(`#${id} input.native-input`) as HTMLInputElement
    if(el){
      el.focus();
      (document as any)?.execCommand('paste')
    }
}

export const pasteTextArea = (id: string) => {
    const el = document.querySelector(`#${id} textarea`) as HTMLTextAreaElement
    if(el){
      el.focus();
      (document as any)?.execCommand('paste')
    }
}

export const enableRightClickPasteAddr = async () => {
    try {
        await chrome.contextMenus.removeAll();
        await chrome.contextMenus.create({
            id: CLW_CONTEXT_MENU_ID,
            title: "Paste Current Address",
            contexts: ["editable"],
        });
    } catch (error) {
        // ignore
    }
}

export const pasteToFocused = () => {
    const el = document.activeElement as HTMLInputElement
    if(el){
      el?.focus();
      (document as any)?.execCommand('paste')
    }
}

/** Opens `url` in a new browser tab (works from popup and side panel). */
export const openTab = (url: string) => {
    if (!url) return
    try {
        chrome.tabs.create({ url }).catch((err: unknown) => {
            console.warn('chrome.tabs.create failed, using window.open', err)
            window.open(url, '_blank', 'noopener,noreferrer')
        })
    } catch (err) {
        // No chrome.tabs (e.g. non-extension context): fall back to window.open.
        window.open(url, '_blank', 'noopener,noreferrer')
    }
}

export const getVersion = () => chrome?.runtime?.getManifest()?.version ?? ''

export const isFirefox = () => {
 return chrome?.runtime.getURL('').startsWith('moz-extension://')
}