interface RequestArguments {
    id?: string
    method: string;
    params?: unknown[] | object;
}

interface EIP6963ProviderInfo {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  }

let PQueuePromise: Promise<unknown> = new Promise(() => {})
let queueDefault : null | any = null
let queueChainId : null |any = null
const MAX_PROMISES = 20

const impLib = import('p-queue')
PQueuePromise = impLib
impLib.then((lib) => {
    queueDefault = new lib.default({concurrency: MAX_PROMISES});
    queueChainId = new lib.default({concurrency: MAX_PROMISES});
});
 
const listeners = {
    accountsChanged: new Set<(p?: any) => void>(),
    connect: new Set<(p?: any) => void>(),
    disconnect: new Set<(p?: any) => void>(),
    chainChanged: new Set<(p?: any) => void>(),
    once: {
        accountsChanged: new Set<(p?: any) => void>(),
        connect: new Set<(p?: any) => void>(),
        disconnect: new Set<(p?: any) => void>(),
        chainChanged: new Set<(p?: any) => void>(),
    }
}

const promResolvers = new Map()

const ProviderInfo: EIP6963ProviderInfo = {
    uuid: '1fa914a1-f8c9-4c74-8d84-4aa93dc90eec',
    name: 'Metatarz Wallet',
    icon: 'data:image/png;base64,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',
    rdns: 'xyz.metatarz.wallet',
}

const ProviderInfoMetamask = {
    "uuid": "5531e370-ec90-497b-a734-0268948ac6a4",
    "name": "MetaMask",
    "icon": 'data:image/png;base64,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',
    "rdns": "io.metamask"
}

function loadEIP1193Provider(provider: any) {

    function announceProvider() {
      const info: EIP6963ProviderInfo = ProviderInfo
      if(!provider.accounts?.length) {
        return
      }
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info, provider }),
        })
      );

      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info: ProviderInfoMetamask, provider }),
        })
      );
    }
  
    window.addEventListener(
      "eip6963:requestProvider",
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      () => {
        announceProvider();
      }
    );
  
    announceProvider();
    // console.info('EIP-1193 Provider loaded')
  }



const clearListeners = () => {
    for(const key of Object.keys(listeners)) {
        if(key === 'once'){
            for(const onceKey of Object.keys(listeners[key])) {
                (<any>listeners)[key][onceKey].clear()
            }
        }else {
            (<any>listeners)[key].clear()
        }
    }
}

const getListenersCount = (): number => {
    let count = 0
    for(const key of Object.keys(listeners)) {
        if(key === 'once'){
            for(const onceKey of Object.keys(listeners[key])) {
                count += (<any>listeners)[key][onceKey]?.length
            }
        }else {
            count += (<any>listeners)[key].length
        }
    }
    return count
}

const sendMessage = (args: RequestArguments, ping = false, from = 'request'): Promise<unknown> => {
    const resId = [...`${Math.random().toString(16) + Date.now().toString(16)}`].slice(2).join('')
    const method = args.method

    const newMessage =  async () => {
        return await new Promise((resolve, reject) => {
        if (method === 'wallet_getPermissions') {
            args.params = [{ isConnected: eth.isConnected() }]
        }

        const data = { 
            type: "CLWALLET_CONTENT", 
            target: 'metamask-contentscript',
            data: {
                method,
                name: 'metamask-provider', data: args, jsonrpc: '2.0', id: Number(resId.replace(/[A-Za-z]/g, '').slice(0, 10)) 
            },
            resId,
            from,
        }
        if (ping) {
            data.type = 'CLWALLET_PING'
        }

        // if(method !== 'eth_chainId') {
        //     console.info('data in', data)          
        // }

        window.postMessage(data, "*");
        promResolvers.set(resId, { resolve, reject })
    })
   }

   let retPromise: Promise<unknown>

   if(method !== 'eth_chainId') {
    retPromise = queueDefault!.add(newMessage)
   } else {
    retPromise = queueChainId!.add(newMessage)
   }
   return retPromise
}

(function() {
      
    class MetaMaskAPI {
        isMetaMask = true
        isClWallet = true
        accounts = []
        _state = {accounts: [], isConnected: false, isUnlocked: true, initialized: true, isPermanentlyDisconnected: false}
        _sentWarnings = {
            enable: false,
            experimentalMethods: false,
            send: false,
            events: {
              close: false,
              data: false,
              networkChanged: false,
              notification: false,
            },
          }
        // Deprecated - hardcoded for now, websites should not access this directly since is deprecated for a long time
        chainId = "0x89"
        // Deprecated - hardcoded for now, websites should not access this directly since is deprecated for a long time
        networkVersion = "137"
        selectedAddress = null
        autoRefreshOnNetworkChange = false
        // Internal Simulate Metamask 
        _events = {}
        _eventsCount = 2
        _jsonRpcConnection = {}
        _log = {}
        _maxListeners = 10
        _metamask = new Proxy({
            isUnlocked: () => { 
                return Promise.resolve(true)
            },
            requestBatch: () => {
                // empty
            },
        }, {})
        _rpcEngine = {
            _events: {}, _eventsCount: 0, _maxListeners: undefined, _middleware: Array(4)
        }
        initialConnect()  {
            sendMessage({
                method: 'wallet_ready'
            }, true)
        }
        isConnected() {
            return this._state.isConnected
        }
        // for maximum compatibility since is cloning the same API
        enable() {
            return sendMessage({ method: 'eth_requestAccounts', params: Array(0)})
        }
    
        request(args: RequestArguments): Promise<unknown> {
            return sendMessage(args) as Promise<unknown>
        }
        // Deprecated
        sendAsync (arg1: any, arg2: any): void | Promise<unknown>  {
            // return this.send(arg1, arg2) as any
            if( typeof arg1 === 'string' ) {
                return sendMessage({
                    method: arg1,
                    params: arg2 as object
                }, false , 'sendAsync') as Promise<unknown>
            }else if (typeof arg2 === 'function'){
                    ((sendMessage(arg1 as RequestArguments, false, 'sendAsync') as Promise<unknown>).then(result => {
                        (arg2 as (e?: any, r?: any) => any )(undefined, {
                                id: (arg1 as RequestArguments)?.id,
                                jsonrpc: '2.0',
                                method: (arg1 as RequestArguments).method,
                                result
                              }
                        ) 
                    }) as Promise<unknown>).catch( e => {
                        (arg2 as (er?: any, r?: any) => any )(new Error(e), {
                            id: (arg1 as RequestArguments)?.id,
                            jsonrpc: '2.0',
                            method: (arg1 as RequestArguments).method,
                            error: new Error(e)
                          }
                    )
                    })
                } else {
                    return sendMessage(arg1 as RequestArguments, false, 'sendAsync') as Promise<unknown>
                }
        }
        send (arg1: unknown, arg2: unknown): unknown {
            const resultFmt = async (result: Promise<any>) => {
                return {
                    "id": 0,
                    "jsonrpc": "2.0",
                    result: await result
                }
            }
            if (arg2 === undefined) {
                if( typeof arg1 === 'string' ) {
                    return resultFmt(sendMessage({
                        method: arg1,
                        params: undefined
                    }, false, 'send')) 
                }
                return resultFmt(sendMessage(arg1 as RequestArguments, false, 'send'))
          } else if (typeof arg1 === 'object') {
                    if( typeof arg1 === 'string' ) {
                        return resultFmt(sendMessage({
                            method: arg1,
                            params: undefined
                        }, false, 'send')) 
                }
                return resultFmt(sendMessage(arg1 as RequestArguments, false, 'send'))
            }else if( typeof arg1 === 'string' ) {
                return resultFmt( sendMessage({
                    method: arg1,
                    params: arg2 as object
                }, false, 'send'))
            }
            return resultFmt(sendMessage(arg1 as RequestArguments, false, 'send'))
        }
        on (eventName: string, callback: () => void) {
            this.addListener(eventName, callback)
            return this
        }
    
        addListener (eventName: string, callback: () => void) {
            switch (eventName) {
                case 'accountsChanged':
                    listeners.accountsChanged.add(callback)
                    break
                case 'connect':
                    listeners.connect.add(callback)
                    sendMessage({
                        method: 'wallet_ready'
                    }, true)
                    break;
                case 'disconnect':
                case 'close':
                    listeners.disconnect.add(callback)
                    break;
                // Deprecated  - chainIdChanged -networkChanged
                case 'chainChanged':
                case 'chainIdChanged':
                case 'networkChanged':
                    listeners.chainChanged.add(callback)
                    break;
            }
            return this
        }
    
        once (eventName: string, callback: () => void) {
            switch (eventName) {
                case 'accountsChanged':
                    listeners.once.accountsChanged.add(callback)
                    break
                case 'connect':
                    listeners.once.connect.add(callback)
                    sendMessage({
                        method: 'wallet_ready'
                    }, true)
                    break;
                case 'disconnect':
                case 'close':
                    listeners.once.disconnect.add(callback)
                    break;
                // Deprecated  - chainIdChanged -networkChanged
                case 'chainChanged':
                case 'chainIdChanged':
                case 'networkChanged':
                    listeners.once.chainChanged.add(callback)
                    break;
            }
            return this
        }
        off (eventName: string, callback: () => void) {
            (this).removeListener(eventName, callback)
            return this
        }
        removeListener (eventName: string, callback: () => void) {
            switch (eventName) {
                case 'accountsChanged':
                    listeners.accountsChanged.delete(callback)
                    break
                case 'connect':
                    listeners.connect.delete(callback)
                    break;
                case 'disconnect':
                case 'close':
                    listeners.disconnect.delete(callback)
                    break;
                // Deprecated  - chainIdChanged -networkChanged
                case 'chainChanged':
                case 'chainIdChanged':
                case 'networkChanged':
                    listeners.chainChanged.delete(callback)
                    break;
                default:
                    return
            }
            return this
        }
        
        removeAllListeners()  {
            listeners.accountsChanged.clear()
            listeners.chainChanged.clear()
            listeners.disconnect.clear()
            listeners.connect.clear()
            return this
        }
    
        getMaxListeners()  {
            return 10
        }
        _getExperimentalApi ()  {
            return this._metamask
        }
        eventNames () {
            return []
        }
        listenerCount () {
            return getListenersCount()
        }
        listeners() { return [] }
        rawListeners() { return [] }
        // Internal Simulate Metamask 
        _warnOfDeprecation() { return true }
    
        _rpcRequest() { return true }
        _handleAccountsChanged() { return true }
    
        _handleChainChanged() { return true }
        _handleConnect() { return true }
        _handleDisconnect() { return true }
        _handleStreamDisconnect() { return true }
        _handleUnlockStateChanged() { return true }
        _sendSync () {
            console.warn('ERROR: Metatarz Wallet: Sync calling is deprecated and not supported')
        }
    }

      (window as any).MetaMaskAPI = MetaMaskAPI;

  })();



const eth = new Proxy( new (window as any).MetaMaskAPI(), {
    deleteProperty: () => { return true },
    // set(obj, prop, value) {
    //     // Reflect.set(obj, prop, value);
    //     return true;
    //   }
})

const listener =  function(event: any) {
    if (event.source != window) return;
    if(!['CLWALLET_PAGE', 'CLWALLET_PAGE_LISTENER'].includes(event?.data?.type)) return;
    const eventData = event?.data
    const eventDataData = event?.data?.data
    const eventDataDataData = event?.data?.data?.data
    const resId = eventData?.resId
    const result = eventDataDataData?.result
    if(eventData?.type === "CLWALLET_PAGE_LISTENER") {
        if((eventDataData?.listener ?? 'x') in listeners ) {
            try {
                const listenerName = eventDataData.listener as ('accountsChanged' | 'connect' | 'disconnect' | 'chainChanged')
                if( listenerName === 'connect' && eventDataData) {
                    (<any>eth).networkVersion = String(parseInt(eventDataDataData?.chainId ?? "0x89", 16));
                    (<any>eth).chainId = eventDataDataData?.chainId ?? '0x89';
                    (<any>eth).selectedAddress = eventDataData?.address?.[0] ?? null;
                    (<any>eth).accounts = eventDataData.address?.[0] ? [eventDataData.address?.[0]] : [];
                    (<any>eth)._state.accounts = (<any>eth).accounts;
                    (<any>eth)._state.isConnected = true;
                } else if( listenerName === 'chainChanged' ) {
                    (<any>eth).networkVersion = String(parseInt(eventDataDataData ?? "0x89", 16));
                    (<any>eth).chainId = eventDataData ?? '0x89';
                } else if ( listenerName === 'accountsChanged' ) {
                    (<any>eth).accounts = eventDataData?.[0] ? [eventDataData?.[0]] : [];
                    (<any>eth)._state.accounts = (<any>eth).accounts;
                    (<any>eth).selectedAddress = eventDataData?.[0] ?? '';
                } else if ( listenerName === 'disconnect' ) {
                    clearListeners();
                    (<any>eth)._state.isConnected = false;
                    (<any>eth).selectedAddress = null;
                    (<any>eth).accounts = [];
                    (<any>eth)._state.accounts = (<any>eth).accounts;
                    (<any>eth).networkVersion = null;
                    (<any>eth).chainId = null;
                    (<any>eth).initialConnect = () => {}
                }

                listeners[listenerName].forEach(pageListener => {
                    pageListener(eventDataData)
                });
                
                listeners.once[listenerName].forEach(pageListener => {
                    pageListener(eventDataData)
                    listeners.once[listenerName].delete(pageListener)
                });
            } catch (e) {
                // console.info(e)
                // ignore
            }
        }
    }
    if(promResolvers?.has(resId)) {
    const promise = promResolvers.get(resId);
    try {
        if(result?.error) {
            promise.reject(result);
        } else {
            promise.resolve(result);
        }
    } catch (e) {
        console.error('Failed to connect resolve msg', e)
        promResolvers?.get(resId)?.reject({code: -32000, message: 'Failed to connect resolve msg', error: true });
    }
     promResolvers.delete(resId)
    }
  }

window.addEventListener("message", listener)

Object.defineProperties(eth, {
    selectedAddress: { enumerable: false },
    chainId: { enumerable: false },
    networkVersion: { enumerable: false },
});

const web3Shim = {
    currentProvider: eth,
    __isMetaMaskShim__: true
}

const injectWallet = () => {
const ethKey = 'ethereum'
if ((window as any)[ethKey]?.isClWallet) {
    return;
}

Object.defineProperty((window as any), ethKey, {
    value: eth,
    writable: true
});
Object.defineProperty((window as any), 'web3', {
    value: web3Shim,
    writable: true
});

  eth.initialConnect() 
}

(PQueuePromise).then(() => {
injectWallet();
loadEIP1193Provider(eth);
document.addEventListener('DOMContentLoaded', () => {
loadEIP1193Provider(eth);
})
})



// HELPERS TO CLONE METAMASK API


// const MMReflect = async () => {

//     await new Promise((resolve) => setTimeout(resolve, 2000))

//     const originalRequest = (window as any).ethereum.request
//     const originalSend = (window as any).ethereum.send
//     const originalSendAsync = (window as any).ethereum.sendAsync

//     const methods = [originalRequest, originalSend, originalSendAsync]
//     const originalMethods = ['request', 'send', 'sendAsync']

//     for(const [index, method] of methods.entries()) {
//         const methodName = originalMethods[index];
//         (window as any).ethereum[methodName] = new Proxy(method, {
//             apply(target, thisArg, argsList) {
//                 const isEthChainId = argsList[0]?.method === 'eth_chainId'

//                 const result = Reflect.apply(target, thisArg, argsList) as Promise<unknown>
//                 const resultCLW = Reflect.apply(sendMessage, thisArg, argsList) as Promise<unknown>
                
//                 if(!isEthChainId) {
//                  result?.then((res: any) => {
//                     resultCLW?.then((resCLW: any) => {
//                         console.log(`window.ethereum.${methodName} ${JSON.stringify(argsList, null, 2)} result:`, res, resCLW);
//                     })
//                 })
//                 }

//                 return result;
//             }
//         });
//     }

//         console.log('Reflecting Metamask API')
// }


// MMReflect()

// window.addEventListener("message" , (event) => {
//     console.log('event', JSON.stringify(event?.data?.data, null, 2), JSON.stringify(event?.data, null, 2))
// })

// setTimeout(() => {
//     console.log('Metamask clone test');
//     console.log((<any>window).ethereum.send({
//         "jsonrpc": "2.0",
//         "method": "eth_accounts",
//         "params": [],
//         "id": 0
//     }))
//     console.log((<any>window).ethereum.request({
//         "jsonrpc": "2.0",
//         "method": "eth_accounts",
//         "params": [],
//         "id": 0
//     }))
// }, 5000)

// setTimeout(async () => {
//     console.log('Metamask clone test');
//     // (<any>window).ethereum.request({method: 'eth_requestAccounts', params: Array(0)}).then((res: any) => { console.log(res, 'MT: eth_requestAccounts')});
//     // (<any>window).ethereum2.request({method: 'eth_requestAccounts', params: Array(0)}).then((res: any) => { console.log(res, 'CW: eth_requestAccounts')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));

//     // (<any>window).ethereum.request({method: 'eth_accounts', params: Array(0)}).then((res: any) => { console.log(res, 'MT: eth_accounts')});
//     // (<any>window).ethereum2.request({method: 'eth_accounts', params: Array(0)}).then((res: any) => { console.log(res, 'CW: eth_accounts')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));

//     (<any>window).ethereum.request({method: 'eth_chainId', params: Array(0)}).then((res: any) => { console.log(res, 'MT: eth_chainId')});
//     (<any>window).ethereum2.request({method: 'eth_chainId', params: Array(0)}).then((res: any) => { console.log(res, 'CW: eth_chainId')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));


//     // (<any>window).ethereum.request({method: 'eth_blockNumber', params:  Array(0)}).then((res: any) => { console.log(res, 'MT: eth_chainId')});
//     // (<any>window).ethereum2.request({method: 'eth_blockNumber', params:  Array(0)}).then((res: any) => { console.log(res, 'CW: eth_chainId')});
    
//     // await new Promise((resolve) => setTimeout(resolve, 1000));

    
//     // (<any>window).ethereum.request({method: 'wallet_requestPermissions', params: [{eth_accounts: {}}]}).then((res: any) => { console.log(res, 'MT: wallet_requestPermissions')});
//     // (<any>window).ethereum2.request({method: 'wallet_requestPermissions', params: [{eth_accounts: {}}]}).then((res: any) => { console.log(res, 'CW: wallet_requestPermissions')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));
    
//     // (<any>window).ethereum.request({method: 'net_version', params: []}).then((res: any) => { console.log(res, 'MT: net_version')});
//     // (<any>window).ethereum2.request({method: 'net_version', params: []}).then((res: any) => { console.log(res, 'CW: net_version')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));
    
//     // (<any>window).ethereum.request({method: 'wallet_switchEthereumChain', params: [{chainId: "0x89"}]}).then((res: any) => { console.log(res, 'MT: wallet_switchEthereumChain')});
//     // (<any>window).ethereum2.request({method: 'wallet_switchEthereumChain', params: [{chainId: "0x89"}]}).then((res: any) => { console.log(res, 'CW: wallet_switchEthereumChain')});

//     // await new Promise((resolve) => setTimeout(resolve, 1000));

//     // (<any>window).ethereum.on('connect', ((a: any, b: any) => console.log('connect MT', a, b)));
//     // (<any>window).ethereum.on('accountsChanged', ((a: any, b: any) => console.log('accountsChanged MT', a, b)));
//     // (<any>window).ethereum.on('chainChanged', ((a: any) => console.log('chainChanged MT', a, typeof a)));
  
//     // await new Promise((resolve) => setTimeout(resolve, 1000));

//     // (<any>window).ethereum2.on('connect', ((a: any, b: any) => console.log('connect CW', a, b)));
//     // (<any>window).ethereum2.on('accountsChanged', ((a: any, b: any) => console.log('accountsChanged CW', a, b)));
//     // (<any>window).ethereum2.on('chainChanged', ((a: any) => console.log('chainChanged CW', a, typeof a)));

// }, 3500)
