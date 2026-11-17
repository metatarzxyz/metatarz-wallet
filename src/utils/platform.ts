import type { Network, Account, Prices, Settings, Networks, HistoryItem, ContractActions, ContractAction, Contact } from '@/extension/types'
import type { Ref } from 'vue'

const pottentialMissingSettings = ['copyLowerCaseAddress']

const defaultSettings = {
    enableStorageEnctyption: false,
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
    await chrome.storage.local.clear()
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

export const getAccounts = async (): Promise<Account[]> => {
    return (await storageGet('accounts')).accounts ?? [] as Account[]
}

export const saveAccount = async (account: Account): Promise<void> => {
    const savedAccounts = await getAccounts()
    await storageSave('accounts', [account, ...savedAccounts])
}

export const replaceAccounts = async (accounts: Account[]): Promise<void> => {
    await storageSave('accounts', accounts)
}


export const getSelectedAccount = async (): Promise<Account> => {
    return (await storageGet('selectedAccount'))?.selectedAccount ?? null as unknown as Account
}


export const saveSelectedAccount = async (selectedAccount: Account): Promise<void> => {
    await storageSave('selectedAccount', selectedAccount )
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

export const clearPk = async (): Promise<void> => {
    let accounts = await getAccounts()
    const accProm = accounts.map(async a => {
        if(a.encPk) {
            a.pk = ''
        }
      return a
    })
    accounts = await Promise.all(accProm)
    await Promise.all([replaceAccounts(accounts), saveSelectedAccount(accounts[0])])
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