import {
    CLW_CONTEXT_MENU_ID,
    getSelectedAccount,
    getSelectedNetwork,
    smallRandomString,
    getSettings,
    clearPk,
    openTab,
    getUrl,
    addToHistory,
    getNetworks,
    strToHex,
    numToHexStr,
    enableRightClickPasteAddr,
    setSettings,
    replaceNetworks,
    saveSelectedNetwork,
    isSiteConnected,
    addConnectedSite,
    removeConnectedSite,
    isCantonSiteConnected
} from '@/utils/platform';
import {
    userApprove,
    userReject,
    rIdWin,
    rIdData,
} from '@/extension/userRequest'
import {
    signMsg,
    getBalance,
    getBlockNumber,
    estimateGas,
    sendTransaction,
    getGasPrice,
    getBlockByNumber,
    evmCall,
    getTxByHash,
    getTxReceipt,
    signTypedData,
    getCode,
    getTxCount,
    getSelectedAddress,
    getRpcPerformance
} from '@/utils/wallet'
import type { Network, Networks, RequestArguments } from '@/extension/types'
import { rpcError } from '@/extension/rpcConstants'
import { triggerListener } from '@/extension/listeners'
import { updatePrices } from '@/utils/gecko'
import { allTemplateNets, noFoundNetworks } from '@/utils/networks'
import { cyrb64Hash, stringify } from '@/utils/misc'
import { runMigrations } from '@/utils/network-migrations'
import { getCantonTransferToken, isCantonChain, sendCantonTransaction } from '@/utils/canton';
import { handleCip103Request, onCip103Event, toCip103Error, watchCip103State, type Cip103Event } from '@/extension/cip103';

// const METAMAKS_EXTENSION_ID = 'nkbihfbeogaeaoehlefnkodbefgpgknn'

let notificationUrl: string

const chainIdThrottle: { [key: string]: number } = {}
const cache = new Map<string, { [key: string]: any }>()

// Origin of the frame that sent the message, as reported by the browser.
// Never taken from message data, which the page can influence.
// Opaque origins (sandboxed iframes, data: URLs) report origin "null": treat
// them as unknown ('' = unauthorized) instead of deriving one from the URL,
// which would let a sandboxed frame borrow its URL's connected origin.
// The URL is only used when the browser does not report an origin (Firefox).
const getSenderOrigin = (sender: chrome.runtime.MessageSender): string => {
    if (sender?.origin !== undefined) {
        return sender.origin && sender.origin !== 'null' ? sender.origin : ''
    }
    try {
        const origin = new URL(sender?.url ?? '').origin
        return origin !== 'null' ? origin : ''
    } catch {
        return ''
    }
}

// Requests made by the wallet's own pages (popup, side panel), not by a website
const isExtensionSender = (sender: chrome.runtime.MessageSender): boolean =>
    sender?.id === chrome.runtime.id && (sender?.url ?? '').startsWith(chrome.runtime.getURL(''))

// Origin shown to the user in approval popups ('' for the wallet's own pages)
const requestOrigin = (sender: chrome.runtime.MessageSender): string =>
    isExtensionSender(sender) ? '' : getSenderOrigin(sender)

const isAuthorized = async (sender: chrome.runtime.MessageSender): Promise<boolean> =>
    isExtensionSender(sender) || await isSiteConnected(getSenderOrigin(sender))

// Methods that need a connected site (EIP-1193 4100 Unauthorized otherwise)
const authorizedOnlyMethods = new Set([
    'eth_sendTransaction',
    'signTypedData',
    'eth_signTypedData',
    'signTypedData_v1',
    'eth_signTypedData_v1',
    'signTypedData_v3',
    'eth_signTypedData_v3',
    'signTypedData_v4',
    'eth_signTypedData_v4',
    'personal_sign',
    'eth_sign',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
])

// CIP-0103 events waiting to be picked up by the content scripts. Only an event
// id is broadcast to the tabs; each frame then asks for the event and gets it
// only if its own (browser-reported) origin may see it.
const CIP103_EVENT_TTL_MS = 6e4
const cip103Events = new Map<string, Cip103Event & { at: number }>()

onCip103Event((event) => {
    const now = Date.now()
    for (const [id, e] of cip103Events) {
        if (now - e.at > CIP103_EVENT_TTL_MS) cip103Events.delete(id)
    }
    const id = crypto.randomUUID()
    cip103Events.set(id, { ...event, at: now })
    triggerListener('canton', { id })
})

watchCip103State()

const cip103EventFor = async (id: unknown, sender: chrome.runtime.MessageSender) => {
    const event = typeof id === 'string' ? cip103Events.get(id) : undefined
    const origin = getSenderOrigin(sender)
    if (!event || !origin || isExtensionSender(sender)) return undefined
    if (event.origin !== undefined && event.origin !== origin) return undefined
    if (event.requireConnected && !(await isCantonSiteConnected(origin))) return undefined
    return { method: event.event, params: event.payload }
}

const permissionsResponse = async (origin: string) => [{
    id: smallRandomString(21),
    parentCapability: 'eth_accounts',
    invoker: origin,
    caveats: [{
        type: 'restrictReturnedAccounts',
        value: await getSelectedAddress()
    }],
    date: Date.now(),
}]

// One approval popup per origin; concurrent requests share its outcome
const pendingConnections = new Map<string, Promise<void>>()

const requestConnection = (message: RequestArguments, sender: chrome.runtime.MessageSender): Promise<void> => {
    const origin = getSenderOrigin(sender)
    if (!origin) {
        return Promise.reject(new Error('Unknown origin'))
    }
    const pending = pendingConnections.get(origin)
    if (pending) {
        return pending
    }
    const request = (async () => {
        const param = strToHex(JSON.stringify({ origin, subframe: (sender?.frameId ?? 0) !== 0 }))
        await new Promise((resolve, reject) => {
            chrome.windows.create({
                height: 550,
                width: 400,
                url: chrome.runtime.getURL(`index.html?route=connect&param=${param}&rid=${String(message?.resId ?? '')}&website=${strToHex(origin)}`),
                type: 'popup'
            }).then((win) => {
                userReject[String(win?.id)] = reject
                userApprove[String(win?.id)] = resolve
                rIdWin[String(win?.id)] = String(message.resId)
            }).catch(reject)
        })
        await addConnectedSite(origin)
        // Let the site's other frames/tabs pick up the address
        triggerListener('accountsChanged', null)
    })().finally(() => {
        pendingConnections.delete(origin)
    })
    pendingConnections.set(origin, request)
    return request
}

const walletConnect = async (dataToSend: any = undefined) => {
    const pNetwork = getSelectedNetwork()
    const pAccount = getSelectedAccount()
    const [network, account] = await Promise.all([pNetwork, pAccount])
    const address = account?.address ? [account?.address] : []
    const chainId = `0x${(network?.chainId ?? 0).toString(16)}`
    const data = {
        type: "CLWALLET_PAGE_LISTENER", 
        data: {
            listener: 'connect',
            data: dataToSend ? dataToSend : {
                chainId
            },
            address
        }
    }
    return { data, chainId, address }
}


const reInjectContentScripts = async () => {
    const cts = chrome.runtime.getManifest().content_scripts ?? []
    for (const cs of cts) {
        const tabs = await chrome.tabs.query({ url: cs.matches })
        for (const tab of tabs) {
            if (!tab?.id || !cs.js || !tab.url) {
                continue;
            }
            if (tab.url.match(/(chrome|chrome-extension):\/\//gi)) {
                continue;
            }

            const isWorldMain = (cs as any)?.world === 'MAIN'

            chrome.scripting.executeScript({
                files: cs.js,
                target: { tabId: tab.id, allFrames: cs.all_frames },
                injectImmediately: cs.run_at === 'document_start',
                world: isWorldMain ? 'MAIN' : 'ISOLATED'
            }).catch((err) => {
                console.warn('Error injecting content script', err)
            })
        }
    }
}


const addDefaultNetworksOnInstall = async () => {
    const userNetworks = await getNetworks()
    if (Object.keys(userNetworks).length === 0) {
        let networks = {} as Networks
        const selectedNetwork = allTemplateNets[noFoundNetworks.defaultNetworks[0]]
        for (const network of noFoundNetworks.defaultNetworks) {
            if (allTemplateNets[network]) {
                networks[network] = allTemplateNets[network]

            }
        }
        replaceNetworks(networks)
   
        saveSelectedNetwork(selectedNetwork)
    }
     
}

// Decrypted keys live in chrome.storage.session: keep it out of content scripts
// (TRUSTED_CONTEXTS is the default, set explicitly so it is never widened).
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
    enableRightClickPasteAddr();
    reInjectContentScripts();
    addDefaultNetworksOnInstall();
    // Drop any Farcaster API token cached by the removed Farcaster feature
    chrome.storage.local.remove('fcAuthToken').catch(() => {});
    // Lock on install/update; also removes plaintext keys that older versions
    // left in chrome.storage.local next to the encrypted ones
    clearPk().catch((e) => console.warn('Lock on install failed', e));
    console.info('Service worker installed version', chrome.runtime.getManifest().version);
    if (chrome.runtime.lastError) {
        console.warn("Whoops.. " + chrome.runtime.lastError.message);
    }
})

chrome.runtime.onStartup.addListener(() => {
    console.info('Service worker startup');
    enableRightClickPasteAddr();
    // Always start a browser session locked, and drop any stale auto-lock suspension
    clearPk().catch((e) => console.warn('Lock on startup failed', e));
    getSettings().then((settings) => {
        settings.lockOutBlockedUntil = 0
        return setSettings(settings)
    }).catch(() => {});
    if (chrome.runtime.lastError) {
        console.warn("Whoops.. " + chrome.runtime.lastError.message);
    }
})

chrome.runtime.onSuspend.addListener(() => {
    console.info('Service worker suspend');
    if (chrome.runtime.lastError) {
        console.warn("Whoops.. " + chrome.runtime.lastError.message);
    }
})

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Runs in the page: only inserts the address passed in by the service worker.
// The address is read here, not via window.ethereum, so pasting it into a
// field never connects the site (eth_accounts stays [] for unconnected sites).
function pasteAddress (address: string) {
    if (address) {
        document.execCommand("insertText", false, address);
    }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const extensionId = chrome.runtime.id
    const isOwnExtension = info?.pageUrl?.startsWith(`chrome-extension://${extensionId}`)

    if (info.menuItemId === CLW_CONTEXT_MENU_ID && tab?.id && !isOwnExtension) {
        try {
            const address = (await getSelectedAddress())?.[0]
            if (!address) return
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
                world: 'MAIN',
                func: pasteAddress,
                args: [address]
            });
        } catch {
            // igonre
        }
    } else if (isOwnExtension) {
        chrome.runtime.sendMessage({ method: 'paste', type: 'CLWALLET_PAGE_MSG' }, (r) => {
            if (chrome.runtime.lastError) {
                console.warn("LOC3: Error sending message:", chrome.runtime.lastError);
            }
            return r
        })
    }
})

chrome.alarms.create('updatePrices', {
    periodInMinutes: 1
})

chrome.alarms.create('checkCurrentRpc', {
    periodInMinutes: 5
})

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'updatePrices') {
        updatePrices().then(() => {
            console.info('Prices updated')
        }).catch((err) => {
            console.warn('Prices update failed', err)
        })
    }
    getSettings().then(async (settings) => {
        const now = Date.now()
        const blocked = (settings.lockOutBlockedUntil ?? 0) > now
        if (settings.lockOutEnabled && !blocked && (now - (settings.lastLock ?? 0)) > settings.lockOutPeriod * 6e4) {
            await clearPk()
            settings.lastLock = now
            settings.lockOutBlockedUntil = 0
            await setSettings(settings)
        }


        runMigrations(settings).catch((e) => {
            console.warn('Migration failed', e)
        })

        if((settings.lastRPCNotification + 600 * 1000) < Date.now() && alarm.name === 'checkCurrentRpc') {
            (async () => { const currentRPCPerformance = await getRpcPerformance(true)
                if(currentRPCPerformance.performance > 5000) {
                    settings.lastRPCNotification = Date.now()
                    await setSettings(settings)
                    const currentNetwork = await getSelectedNetwork()
                    const warrningMessage = `Your current RPC URL for ${currentNetwork.name} ID ${currentNetwork.chainId} seems unresponsive. Please check your internet connection or try to use another RPC if your internet connection is fine.`

                    chrome.notifications.create('rpc_notification', {
                        type: 'basic',
                        iconUrl: 'images/logo.png',
                        title: 'RPC Warning',
                        message: warrningMessage,
                        priority: 0
                    })
                }
            })()
        }

    })
})

chrome.windows.onRemoved.addListener(async (winId) => {
    const wasPendingApproval = !!userReject?.[winId]
    if (winId in (userReject ?? {})) {
        userReject[winId]?.()
    }
    userReject[winId] = undefined
    userApprove[winId] = undefined
    rIdWin[winId] = undefined
    rIdData[winId] = undefined
    // An approval popup was closed (possibly via the window X, which skips the
    // popup's own unblock): lift the auto-lock suspension once none are left.
    if (wasPendingApproval && !Object.values(userReject).some(Boolean)) {
        const s = await getSettings()
        if (s.lockOutBlockedUntil) {
            s.lockOutBlockedUntil = 0
            await setSettings(s)
        }
    }
    const wins = await chrome.windows.getAll()
    if (wins.length === 0) {
        const s = await getSettings()
        if (s.enableStorageEnctyption) {
            await clearPk()
        }
    }
})

const viewTxListener = async (id: string) => {
    try {
        const url = new URL(notificationUrl)
        openTab(url.href)
        chrome.notifications.clear(id)
    } catch {
        // ignore
    }
}

if (!chrome.notifications.onButtonClicked.hasListener(viewTxListener)) {
    chrome.notifications.onButtonClicked.addListener(viewTxListener)
}

const chainIdThrottleFn = async (website: string) => {
    let urlKey
    try {
        const url = new URL(website)
        urlKey = url.hostname
    } catch {
        urlKey = 'invalid'
    }
    if (chainIdThrottle[urlKey] === undefined) {
        chainIdThrottle[urlKey] = 0
    }
    chainIdThrottle[urlKey] += 1

    if (chainIdThrottle[urlKey] > 6) {
        await new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(null)
            }, 250)
        })
    }
    return urlKey
}

const mainListener = (message: RequestArguments, sender: chrome.runtime.MessageSender, sendResponse: (a: any) => any) => {
    if (chrome.runtime.lastError) {
        console.info("Error receiving message:", chrome.runtime.lastError);
    }
    if (message?.type !== "CLWALLET_CONTENT_MSG") {
        return true
    }

    (async () => {
        if (!(message?.method)) {
            sendResponse({
                code: 500,
                message: 'Invalid request method'
            })
        } else {
            if (authorizedOnlyMethods.has(message.method) && !(await isAuthorized(sender))) {
                sendResponse({
                    error: true,
                    code: rpcError.UNAUTHORIZED,
                    message: 'Unauthorized: connect this site to the wallet first (eth_requestAccounts)'
                })
                return
            }
            // ETH API
            switch (message.method) {
                case 'eth_call': {
                    try {
                        const hash = cyrb64Hash('eth_call' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = await evmCall(message?.params ?? [])
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_call', e)
                    }
                    break
                }
                case 'eth_getBlockByNumber': {
                    try {

                        const hash = cyrb64Hash('eth_call' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }

                        const params = message?.params?.[0] as any
                        const block = await getBlockByNumber(params) as any
 
                        const newBlock = {} as any
 
                        newBlock.baseFeePerGas = typeof block.baseFeePerGas === 'string' ? block.baseFeePerGas : numToHexStr(block.baseFeePerGas)
                        newBlock.blobGasUsed = typeof block.blobGasUsed === 'string' ? block.blobGasUsed : numToHexStr(block.blobGasUsed)
                        newBlock.difficulty = typeof block.difficulty === 'string' ? block.difficulty : numToHexStr(block.difficulty)
                        newBlock._difficulty = newBlock.difficulty
                        newBlock.excessBlobGas = typeof block.excessBlobGas === 'string' ? block.excessBlobGas : numToHexStr(block.excessBlobGas)
                        newBlock.extraData = typeof block.extraData === 'string' ? block.extraData : numToHexStr(block.extraData)
                        newBlock.hash = typeof block.hash === 'string' ? block.hash : numToHexStr(block.hash)
                        newBlock.miner = typeof block.miner === 'string' ? block.miner : numToHexStr(block.miner)
                        newBlock.nonce = typeof block.nonce === 'string' ? block.nonce : numToHexStr(block.nonce)
                        newBlock.number = typeof block.number === 'string' ? block.number : numToHexStr(block.number)
                        newBlock.parentBeaconBlockRoot = typeof block.parentBeaconBlockRoot === 'string' ? block.parentBeaconBlockRoot : numToHexStr(block.parentBeaconBlockRoot)
                        newBlock.parentHash = typeof block.parentHash === 'string' ? block.parentHash : numToHexStr(block.parentHash)
                        newBlock.prevRandao = typeof block.prevRandao === 'string' ? block.prevRandao : numToHexStr(block.prevRandao)
                        newBlock.gasLimit = typeof block.gasLimit === 'string' ? block.gasLimit : numToHexStr(block.gasLimit)
                        newBlock.gasUsed = numToHexStr(block.gasUsed)
                        newBlock.receiptsRoot = typeof block.receiptsRoot === 'string' ? block.receiptsRoot : numToHexStr(block.receiptsRoot)
                        newBlock.stateRoot = typeof block.stateRoot === 'string' ? block.stateRoot : numToHexStr(block.stateRoot)
                        newBlock.timestamp =  block.timestamp
                        sendResponse(newBlock)

                        cache.set(hash, { time: Date.now(), data: newBlock })

                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getBlockByNumber', e)
                    }
                    break;
                }
                case 'eth_getTransactionCount': {
                    try {
                        if (message?.params?.[1]) {
                            const hash = cyrb64Hash('eth_getTransactionCount' + stringify(message?.params))
                            const cacheItem = cache.get(hash)
                            if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                                sendResponse(cacheItem?.data);
                                break
                            }
                            const resp = numToHexStr(Number(await getTxCount(message?.params?.[0] as string, message?.params?.[1] as string)))
                            sendResponse(resp)
                            cache.set(hash, { time: Date.now(), data: resp })
                        } else {
                            const hash = cyrb64Hash('eth_getTransactionCount' + stringify(message?.params))
                            const cacheItem = cache.get(hash)
                            if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                                sendResponse(cacheItem?.data);
                                break
                            }
                            const resp = numToHexStr(Number(await getTxCount(message?.params?.[0] as string)))
                            sendResponse(resp)
                            cache.set(hash, { time: Date.now(), data: resp })
                        }
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getTransactionCount', e)
                    }
                    break
                }
                case 'eth_getTransactionByHash': {
                    try {
                        const hash = cyrb64Hash('eth_getTransactionByHash' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = await getTxByHash(message?.params?.[0] as string)
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getTransactionByHash', e)
                    }
                    break
                }
                case 'eth_getTransactionReceipt': {
                    try {
                        const hash = cyrb64Hash('eth_getTransactionByHash' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = await getTxReceipt(message?.params?.[0] as string)
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getTransactionReceipt', e)
                    }
                    break
                }
                case 'eth_gasPrice': {
                    try {
                        const hash = cyrb64Hash('eth_gasPrice' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = numToHexStr(BigInt(Math.trunc((await getGasPrice()).price * 1e9)))
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_gasPrice', e)
                    }
                    break;
                }
                case 'eth_getBalance': {
                    try {
                        const hash = cyrb64Hash('eth_getBalance' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e2) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const balance = await getBalance()
                        const balanceHex = numToHexStr(balance ?? 0n)
                        sendResponse(balanceHex)
                        cache.set(hash, { time: Date.now(), data: balanceHex })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getBalance', e)
                    }
                    break
                }
                case 'eth_getCode': {
                    try {
                        const hash = cyrb64Hash('eth_getCode' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = await getCode(message?.params?.[0] as string)
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_getCode', e)
                    }
                    break
                }
                case 'eth_blockNumber': {
                    try {
                        const hash = cyrb64Hash('eth_blockNumber' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 3e3) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = numToHexStr(await getBlockNumber())
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_blockNumber', e)
                    }
                    break
                }
                case 'eth_estimateGas': {
                    try {
                        const params = message?.params?.[0] as any
                        if (!params) {
                            sendResponse({
                                error: true,
                                code: rpcError.INVALID_PARAM,
                                message: 'Invalid param for gas estimate'
                            })
                            break
                        }
                        const hash = cyrb64Hash('eth_estimateGas' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e2) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const gas = await estimateGas({
                            to: params?.to ?? '',
                            from: params?.from ?? '',
                            data: params?.data ?? '',
                            value: params?.value ?? '0x0'
                        })

                        const gasHex = numToHexStr(gas ?? 0n)
                        sendResponse(gasHex)
                        cache.set(hash, { time: Date.now(), data: gasHex })
                    } catch (err) {
                        if (String(err).includes('UNPREDICTABLE_GAS_LIMIT')) {
                            chrome.notifications.create({
                                message: 'Gas estimate failed likely due to to many decimals substract 0.00001 form the value you have inpputed and try again.',
                                title: 'Error',
                                iconUrl: getUrl('assets/extension-icon/wallet_128.png'),
                                type: 'basic'
                            } as any)
                            sendResponse({
                                error: true,
                                code: rpcError.USER_REJECTED,
                                message: 'Gas estimate failed'
                            })
                        } else {
                            sendResponse({
                                error: true,
                                code: rpcError.USER_REJECTED,
                                message: 'No network or user selected'
                            })
                            console.warn('Error: eth_estimateGas', err)
                        }
                    }
                    break
                }
                case 'eth_requestAccounts': {
                    try {
                        if (!(await isAuthorized(sender))) {
                            await requestConnection(message, sender)
                        }
                        sendResponse(await getSelectedAddress())
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'User rejected the connection request'
                        })
                        console.info('eth_requestAccounts rejected', e)
                    }
                    break
                }
                case 'eth_accounts': {
                    try {
                        if (!(await isAuthorized(sender))) {
                            sendResponse([])
                            break
                        }
                        const hash = cyrb64Hash('eth_accounts' + stringify(message?.params))
                        const cacheItem = cache.get(hash)
                        if (cacheItem &&  cacheItem?.time > Date.now() - 5e2) {
                            sendResponse(cacheItem?.data);
                            break
                        }
                        const resp = await getSelectedAddress()
                        sendResponse(resp)
                        cache.set(hash, { time: Date.now(), data: resp })
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'No network or user selected'
                        })
                        console.warn('Error: eth_accounts', e)
                    }
                    break
                }
                case 'eth_chainId':
                case 'net_version':
                    {
                        try {
                            const hash = cyrb64Hash('eth_chainId' + stringify(message?.params))
                            const cacheItem = cache.get(hash)
                            if (cacheItem &&  cacheItem?.time > Date.now() - 1e3) {
                                sendResponse(cacheItem?.data);
                                break
                            }
                            const isNetVersion = message.method === 'net_version'
                            const urlKey = await chainIdThrottleFn(getSenderOrigin(sender))
                            const network = await getSelectedNetwork()
                            const chainId = network?.chainId ?? 1
                            const resp = isNetVersion ? chainId.toString() : `0x${chainId.toString(16)}`
                            sendResponse(resp)
                            chainIdThrottle[urlKey] -= 1
                            cache.set(hash, { time: Date.now(), data: resp })
                        } catch (e) {
                            sendResponse({
                                error: true,
                                code: rpcError.USER_REJECTED,
                                message: 'No network or user selected'
                            })
                            console.warn('Error: eth_chainId', e)
                        }
                        break
                    }
                case 'eth_sendTransaction': {
                    try {
                        console.info('eth_sendTransaction', message)

                        const params = message?.params?.[0] as any
                        if (!params) {
                            sendResponse({
                                error: true,
                                code: rpcError.INVALID_PARAM,
                                message: 'Invalid param for send transaction'
                            })
                            break
                        }
                        const [account, network] = await Promise.all([getSelectedAccount(), getSelectedNetwork()])
                        if (!account || !('address' in account)) {
                            await chrome.windows.create({
                                height: 550,
                                width: 400,
                                url: chrome.runtime.getURL(`index.html?route=wallet-error&param=${strToHex('No account is selected you need to have an account selected before trying to make a transaction')}&rid=${String(message?.resId ?? '')}`),
                                type: 'popup'
                            })
                            return
                        }
                        if (!network || !('chainId' in network)) {
                            await chrome.windows.create({
                                height: 550,
                                width: 400,
                                url: chrome.runtime.getURL(`index.html?route=wallet-error&param=${strToHex('No network is selected you need to have a network selected before trying to make a transaction')}&rid=${String(message?.resId ?? '')}`),
                                type: 'popup'
                            })
                            return
                        }
                        if (isCantonChain(network.chainId)) {
                            // Canton transfers cannot execute calldata and need a known instrument
                            const hasData = [params?.data, params?.input].some((d) => d !== undefined && d !== null && d !== '' && d !== '0x')
                            if (hasData || !getCantonTransferToken(network.chainId, params?.token)) {
                                sendResponse({
                                    error: true,
                                    code: rpcError.INVALID_PARAM,
                                    message: hasData ? 'Canton transfers do not support transaction data' : 'Unsupported or missing Canton token'
                                })
                                break
                            }
                        }
                        params.from = account.address
                        const serializeParams = strToHex(JSON.stringify(params)) ?? ''
                        let gWin: any

                        
                        const webDomain = requestOrigin(sender)

                        await new Promise((resolve, reject) => {
                            chrome.windows.create({
                                height: 550,
                                width: 400,
                                url: chrome.runtime.getURL(`index.html?route=sign-tx&param=${serializeParams}&rid=${String(message?.resId ?? '')}&website=${strToHex(webDomain)}`),
                                type: 'popup'
                            }).then((win) => {
                                gWin = win
                                userReject[String(win?.id)] = reject
                                userApprove[String(win?.id)] = resolve
                                rIdWin[String(win?.id)] = String(message.resId)
                                rIdData[String(win?.id)] = {}
                            })

                        })
                        const requestChainId = network.chainId
                        try {
                            const network = await getSelectedNetwork()

                            const isCanton = isCantonChain(network.chainId)
                            let tx
                            if(isCanton){
                                // Canton validation above was done for the network the request was made on
                                if (network.chainId !== requestChainId) {
                                    throw new Error('Network changed while confirming the transaction')
                                }
                                //submit prepare, execute canton flow
                                tx = await sendCantonTransaction({...params})

                            }else{
                            tx = await sendTransaction({ ...params, ...(rIdData?.[String(gWin?.id ?? 0)] ?? {}) })
                            
                            }
                        
                            if(tx){
                            sendResponse(tx.hash)
                            const buttons = {} as any
                            addToHistory({
                                date: Date.now(),
                                txHash: tx.hash,
                                chainId: network.chainId,
                                ...(network.explorer ? { txUrl: `${network.explorer.replace(/\/+$/, '')}/${isCanton ? 'updates' : 'tx'}/${tx.hash}` } : {}),
                                webiste: requestOrigin(sender) || undefined
                            })
                            const notificationId = crypto.randomUUID()
                            if (network?.explorer) {
                                notificationUrl = `${network.explorer}/${isCanton ? 'updates' : 'tx'}/${tx.hash}`.replace('//', '/')
                                buttons.buttons = [{
                                    title: 'View Transaction',
                                }]
                                setTimeout(() => {
                                    try {
                                        chrome.notifications.clear(notificationId)
                                    } catch {
                                        // ignore
                                    }
                                }, 6e4)
                            }
                            chrome.notifications.create(notificationId, {
                                message: 'Transaction Sent',
                                title: 'Success',
                                iconUrl: getUrl('assets/extension-icon/wallet_128.png'),
                                type: 'basic',
                                ...(buttons)
                            } as any)
                        }
                        } catch (err) {
                            console.info('Error: eth_sendTransaction', err)
                            sendResponse({
                                error: true,
                                code: rpcError.USER_REJECTED,
                                message: 'TX Failed'
                            })
                            chrome.windows.create({
                                height: 550,
                                width: 400,
                                url: chrome.runtime.getURL(`index.html?route=wallet-error&param=${strToHex(String(err))}&rid=${String(message?.resId ?? '')}`),
                                type: 'popup'
                            })
                            chrome.notifications.create({
                                message: 'Transaction Failed',
                                title: 'Error',
                                iconUrl: getUrl('assets/extension-icon/wallet_128.png'),
                                type: 'basic'
                            } as any)
                        }
                    } catch (err) {
                        console.warn('Error: eth_sendTransaction', err)
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'User Rejected Signature'
                        })
                    }
                    try {
                        const settings = await getSettings()
                        if (settings.encryptAfterEveryTx) {
                            await clearPk()
                        }
                    } catch {
                        // ignore
                    }
                    break
                }
                case 'signTypedData':
                case 'eth_signTypedData':
                case 'signTypedData_v1':
                case 'eth_signTypedData_v1':
                case 'signTypedData_v3':
                case 'eth_signTypedData_v3':
                case 'signTypedData_v4':
                case 'eth_signTypedData_v4':
                case 'personal_sign':
                case 'eth_sign': {
                    try {
                        const account = await getSelectedAccount()

                        if (!account || !('address' in account)) {
                            await chrome.windows.create({
                                height: 470,
                                width: 400,
                                url: chrome.runtime.getURL(`index.html?route=wallet-error&param=${strToHex('No account is selected you need to have an account selected before trying sign a message')}&rid=${String(message?.resId ?? '')}`),
                                type: 'popup'
                            })
                            return
                        }

                        const isTypedSigned = [
                            'signTypedData',
                            'eth_signTypedData',
                            'signTypedData_v1',
                            'eth_signTypedData_v1',
                            'signTypedData_v3',
                            'eth_signTypedData_v3',
                            'signTypedData_v4',
                            'eth_signTypedData_v4'].includes(message?.method);
                        const signMsgData = isTypedSigned ? String(message?.params?.[1] ?? '') : String(message?.params?.[0] ?? '');

                        const webDomain = requestOrigin(sender)

                        await new Promise((resolve, reject) => {
                            chrome.windows.create({
                                height: 510,
                                width: 480,
                                url: chrome.runtime.getURL(`index.html?route=sign-msg&param=${strToHex(JSON.stringify({ typed: isTypedSigned, data: signMsgData }))}&rid=${String(message?.resId ?? '')}&website=${strToHex(webDomain)}`),
                                type: 'popup'
                            }).then((win) => {
                                userReject[String(win?.id)] = reject
                                userApprove[String(win?.id)] = resolve
                                rIdWin[String(win?.id)] = String(message.resId)
                            })

                        })
                        sendResponse(
                            isTypedSigned ?
                                await signTypedData(signMsgData) :
                                await signMsg(signMsgData)
                        )
                    } catch (e) {
                        console.warn('Error: signTypedData', e)
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'User Rejected Signature'
                        })
                    }
                    try {
                        const settings = await getSettings()
                        if (settings.encryptAfterEveryTx) {
                            await clearPk()
                        }
                    } catch {
                        // ignore
                    }
                    break
                }
                // NON Standard / metamask API
                case 'eth_coinbase': {
                    if (!(await isAuthorized(sender))) {
                        sendResponse(null)
                        break
                    }
                    const account = await getSelectedAccount()
                    const address = account?.address ?? null
                    sendResponse(address)
                    break
                }
                case 'net_listening': {
                    sendResponse(true)
                    break
                }
                case 'web3_clientVersion': {
                    sendResponse(`MetatarzWallet/v${chrome.runtime.getManifest().version}`)
                    break
                }
                case 'wallet_getPermissions': {
                    if (await isAuthorized(sender)) {
                        sendResponse(await permissionsResponse(getSenderOrigin(sender)))
                    } else {
                        sendResponse([])
                    }
                    break
                }
                case 'wallet_requestPermissions': {
                    try {
                        if (!(await isAuthorized(sender))) {
                            await requestConnection(message, sender)
                        }
                        sendResponse(await permissionsResponse(getSenderOrigin(sender)))
                    } catch (e) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'User rejected the permission request'
                        })
                        console.info('wallet_requestPermissions rejected', e)
                    }
                    break
                }
                case 'wallet_revokePermissions': {
                    const origin = getSenderOrigin(sender)
                    if (!isExtensionSender(sender) && await isSiteConnected(origin)) {
                        await removeConnectedSite(origin)
                        triggerListener('accountsChanged', [])
                    }
                    const data = {
                        type: "CLWALLET_PAGE_LISTENER", data: {
                            listener: 'disconnect',
                            data: null
                        }
                    };
                    sendResponse(data)
                    break
                }
                case 'wallet_registerOnboarding': {
                    sendResponse(true)
                    break
                }
                case 'eth_syncing': {
                    sendResponse(false)
                    break
                }
                case 'wallet_switchEthereumChain': {
                    try {
                        const currentChainId = `0x${((await getSelectedNetwork())?.chainId ?? 0).toString(16)}`
                        if (currentChainId === String(message?.params?.[0]?.chainId ?? '')) {
                            sendResponse(null)
                        } else {

                            const webDomain = requestOrigin(sender)

                            await new Promise((resolve, reject) => {
                                chrome.windows.create({
                                    height: 550,
                                    width: 400,
                                    url: chrome.runtime.getURL(`index.html?route=switch-network&param=${String(message?.params?.[0]?.chainId ?? '')}&rid=${String(message?.resId ?? '')}&website=${strToHex(webDomain)}`),
                                    type: 'popup'
                                }).then((win) => {
                                    userReject[String(win?.id)] = reject
                                    userApprove[String(win?.id)] = resolve
                                    rIdWin[String(win?.id)] = String(message.resId)
                                })
                            })
                            sendResponse(null)
                        }
                    } catch {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'User Rejected chain switch'
                        })
                    }
                    break
                }
                case 'wallet_addEthereumChain': {
                    const userNetworks = await getNetworks()
                    const networks = { ...allTemplateNets, ...userNetworks }
                    const chainId = Number(message?.params?.[0]?.chainId ?? '0')
                    if (!chainId) {
                        sendResponse({
                            error: true,
                            code: rpcError.USER_REJECTED,
                            message: 'Invalid Network'
                        })
                    }
                    if (chainId in networks) {
                        mainListener({
                            ...message, method: 'wallet_switchEthereumChain', params: [{
                                chainId: `0x${(chainId).toString(16)}`
                            }]
                        }, sender, sendResponse)
                    } else {
                        if (!message?.params?.[0]?.chainId ||
                            !message?.params?.[0]?.chainName ||
                            !message?.params?.[0]?.rpcUrls ||
                            !message?.params?.[0]?.blockExplorerUrls ||
                            !message?.params?.[0]?.nativeCurrency?.symbol
                        ) {
                            sendResponse({
                                error: true,
                                code: rpcError.USER_REJECTED,
                                message: 'Invalid Network params chainId, chainName, rpcUrls, blockExplorerUrls, and nativeCurrency are required'
                            })
                        } else {
                            try {
                                await new Promise((resolve, reject) => {
                                    chrome.windows.create({
                                        height: 550,
                                        width: 400,
                                        url: chrome.runtime.getURL(`index.html?route=request-network&param=${strToHex(JSON.stringify({ ...(message?.params?.[0] ?? {}), website: requestOrigin(sender) }) ?? '')}&rid=${String(message?.resId ?? '')}`),
                                        type: 'popup'
                                    }).then((win) => {
                                        userReject[String(win?.id)] = reject
                                        userApprove[String(win?.id)] = resolve
                                        rIdWin[String(win?.id)] = String(message.resId)
                                    })
                                })
                                sendResponse(null)
                            } catch (err) {
                                console.error('err')
                                sendResponse({
                                    error: true,
                                    code: rpcError.USER_REJECTED,
                                    message: 'User Rejected adding network'
                                })
                            }
                        }
                    }
                    break
                }
                // internal messeges
                case 'wallet_connect': {
                    // Automatic page-load handshake: only connected sites get the address
                    const { data } = await walletConnect()
                    if (!(await isAuthorized(sender))) {
                        data.data.address = []
                    }
                    sendResponse(data)
                    break
                }
                case 'wallet_listenerData': {
                    // Asked by the content script of every frame when the wallet emits an
                    // event; the payload depends on the frame's own (browser-reported) origin.
                    // chainChanged goes to every frame (the chain id is public via eth_chainId);
                    // accountsChanged only reveals the address to connected origins.
                    const listener = message?.params?.[0]
                    if (listener === 'accountsChanged') {
                        const authorized = await isAuthorized(sender)
                        sendResponse({ deliver: true, data: authorized ? await getSelectedAddress() : [] })
                    } else if (listener === 'chainChanged') {
                        const network = await getSelectedNetwork()
                        sendResponse({ deliver: true, data: numToHexStr(network?.chainId ?? 0) })
                    } else if (listener === 'canton') {
                        const event = await cip103EventFor(message?.params?.[1], sender)
                        sendResponse(event ? { deliver: true, data: event } : { deliver: false })
                    } else {
                        sendResponse({ deliver: false })
                    }
                    break
                }
                case 'canton_cip103': {
                    // CIP-0103 request relayed by the content script: [method, params].
                    // The origin always comes from the browser-reported sender.
                    const [method, params] = Array.isArray(message?.params) ? message.params : []
                    try {
                        const result = await handleCip103Request(
                            { method: String(method ?? ''), params },
                            { origin: requestOrigin(sender), subframe: (sender?.frameId ?? 0) !== 0 }
                        )
                        sendResponse({ result: result === undefined ? null : result })
                    } catch (e) {
                        sendResponse({ error: toCip103Error(e) })
                    }
                    break
                }
                case 'wallet_approve': {
                    if (String(sender.tab?.windowId) in rIdWin) {
                        userApprove[String(sender.tab?.windowId)]?.(true)
                    }
                    try {
                        chrome.windows.remove(sender.tab?.windowId ?? 0)
                    } catch (e) {
                        console.info(e)
                        // ignore
                    }
                    break
                }
                case 'wallet_send_data': {
                    if (String(sender.tab?.windowId) in rIdData) {
                        const intData = rIdData[String(sender?.tab?.windowId ?? '')] ?? {}
                        rIdData[String(sender?.tab?.windowId ?? '')] = { ...intData, ...(message?.data ?? {}) }
                        sendResponse(true)
                    }
                    break
                }
                case 'wallet_get_data': {
                    // Only the wallet's own approval popup can read its request data.
                    // Always answer, so a popup that asks before the data is stored can retry.
                    if (isExtensionSender(sender) && String(sender.tab?.windowId) in rIdData) {
                        sendResponse(rIdData[String(sender?.tab?.windowId ?? '')] ?? {})
                    } else {
                        sendResponse(null)
                    }
                    break
                }
                case 'wallet_ping': {
                    sendResponse(true)
                    break
                }
                default: {
                    sendResponse({
                        error: true,
                        code: rpcError.INVALID_PARAM,
                        message: 'MetatarzWallet: Invalid request method ' + (message?.method ?? '')
                    })
                    break
                }
            }
        }

    }
    )();
    return true;
}

chrome.runtime.onMessage.addListener(mainListener);
