
const allowedMethods = {
  'eth_accounts': true,
  'eth_requestAccounts': true,
  'eth_chainId': true,
  'personal_sign': true,
  'wallet_requestPermissions': true,
  'wallet_registerOnboarding': true,
  'wallet_revokePermissions': true,
  'eth_gasPrice': true,
  'eth_getBlockByNumber': true,
  'eth_blockNumber': true,
  'eth_estimateGas': true,
  'eth_syncing': true,
  'eth_sign': true,
  'net_version': true,
  'eth_sendTransaction': true,
  'wallet_switchEthereumChain': true,
  'eth_call': true,
  'eth_getBalance': true,
  'eth_getTransactionByHash': true,
  'eth_getTransactionReceipt': true,
  'signTypedData': true,
  'eth_signTypedData': true,
  'signTypedData_v1': true,
  'eth_signTypedData_v1': true,
  'signTypedData_v3': true,
  'eth_signTypedData_V3': true,
  'signTypedData_v4': true,
  'eth_signTypedData_v4': true,
  'web3_clientVersion': true,
  'wallet_getPermissions': true,
  'net_listening': true,
  'eth_coinbase': true,
  'wallet_addEthereumChain': true,
  'eth_getCode': true,
  'eth_getTransactionCount': true,
  // CIP-0103 (Canton dApp API) requests, relayed from SPLICE_WALLET_REQUEST frames
  'canton_cip103': true,
}

// CIP-0103 routing key: frames addressed to another wallet are ignored
const CANTON_TARGET = 'metatarz-wallet'

// CIP-0103 requests posted by the page (dApp SDK or window.canton) to this window.
// Only frames with a request id are handled: id-less frames are notifications,
// including the events this script posts itself.
window.addEventListener("message", (event) => {
  if (event.source != window) return
  const msg = event?.data
  if (msg?.type !== 'SPLICE_WALLET_REQUEST') return
  if (msg.target && msg.target !== CANTON_TARGET) return
  const request = msg.request
  if (!request || typeof request !== 'object' || request.id == null) return
  const id = request.id
  if (typeof id !== 'string' && typeof id !== 'number') return
  const reply = (payload: { result: unknown } | { error: { code: number, message: string, data?: unknown } }) => {
    window.postMessage({ type: 'SPLICE_WALLET_RESPONSE', response: { jsonrpc: '2.0', id, ...payload } }, '*')
  }
  if (typeof request.method !== 'string' || !request.method) {
    reply({ error: { code: -32600, message: 'Invalid request' } })
    return
  }
  if (!('canton_cip103' in allowedMethods)) return
  try {
    // The service worker derives the origin from the browser-provided sender
    chrome.runtime.sendMessage({
      type: "CLWALLET_CONTENT_MSG",
      method: 'canton_cip103',
      params: [request.method, request.params],
    }, (res) => {
      if (chrome.runtime.lastError || !res) {
        reply({ error: { code: -32603, message: 'Metatarz Wallet is unavailable' } })
        return
      }
      if (res.error) {
        reply({ error: res.error })
      } else {
        reply({ result: res.result ?? null })
      }
    })
  } catch (e) {
    if ((e as Error)?.message === 'Extension context invalidated') {
      console.info('Error: Extension context invalidated. Ignoring.');
    }
    reply({ error: { code: -32603, message: 'Metatarz Wallet is unavailable' } })
  }
});

window.addEventListener("message", (event) => {
  if (event.source != window)
    return;
  if (event?.data?.type === "CLWALLET_CONTENT") {
    const eventData = {
      ...event.data.data.data
    }
    eventData.resId = event.data.resId
    eventData.type = "CLWALLET_CONTENT_MSG"
    // The service worker derives the requesting origin from the browser-provided sender
    delete eventData.website
    if ((eventData?.method ?? 'x') in allowedMethods) {
      try {
        chrome?.runtime?.sendMessage(eventData, (res) => {
          if (chrome.runtime.lastError) {
            console.warn("LOC1: Error sending message:", JSON.stringify(chrome.runtime.lastError));
          }
          const id = Number(eventData.resId.replace(/[A-Za-z]/g, '').slice(0, 10))
          const data = {
            target: 'metatarz-inpage',
            type: "CLWALLET_PAGE",
            resId: eventData.resId,
            data: {
              name: 'metatarz-provider', data: {
                jsonrpc: '2.0',
                id,
                result: res,
              },
              id,
              method: eventData?.method ?? '',
              params: eventData?.params ?? [],
              listener: undefined
            },
          }

          if(res?.type === "CLWALLET_PAGE_LISTENER") {
            data.type = "CLWALLET_PAGE_LISTENER"
            data.data.listener = res?.data?.listener
            data.data.data.result = res?.data?.data
          }

          if (eventData?.method !== 'eth_chainId') {
            // console.info('data out', data)
          }

          window.postMessage(data, "*");
        })
      } catch (e) {
        if ((e as Error)?.message === 'Extension context invalidated') {
          console.info('Error: Extension context invalidated. Ignoring.');
        }
      }
    }
    else {
      const data = {
        type: "CLWALLET_PAGE",
        data: {
          data: {
            result: { error: true, message: 'MetatarzWallet: Unknown method requested ' + (event?.data?.data?.data?.method ?? '') }
          }
        }
        , resId: event.data.resId
      };
      window.postMessage(data, "*");
    }
  } else if (event?.data?.type === "CLWALLET_PING") {
    const data = {
      ...event.data.data.data
    }
    data.resId = event.data.resId
    data.type = "CLWALLET_CONTENT_MSG"
    data.method = "wallet_connect"
    data.params = []
    try {
      chrome.runtime.sendMessage(data, async (res) => {
        if (chrome.runtime.lastError) {
          console.warn("LOC2: Error sending message:", chrome.runtime.lastError);
        }
        window.postMessage(res, "*");
      })
    } catch (e) {
      if ((e as Error)?.message === 'Extension context invalidated') {
        console.info('Error: Extension context invalidated. Ignoring.');
      }
    }
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
chrome.runtime?.onMessage?.addListener((message: any, sender, sendResponse) => {
  if (chrome.runtime.lastError) {
    console.warn("Error receiving message:", chrome.runtime.lastError);
  }
  if (message.type === "CLWALLET_EXT_LISTENER") {
    // Events go to every tab and frame; the service worker decides, based on this
    // frame's origin, whether it is connected and what it may see.
    const listener = message?.data?.listener
    // CIP-0103 events carry only an id; the payload is fetched for this frame
    const params = listener === 'canton' ? [listener, message?.data?.data?.id] : [listener]
    try {
      chrome.runtime.sendMessage({ type: "CLWALLET_CONTENT_MSG", method: "wallet_listenerData", params }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("LOC9: Error sending message:", chrome.runtime.lastError);
          return
        }
        if (!res?.deliver) {
          return
        }
        if (listener === 'canton') {
          // CIP-0103 notification: SPLICE_WALLET_REQUEST without an id
          window.postMessage({
            type: 'SPLICE_WALLET_REQUEST',
            request: { jsonrpc: '2.0', method: res.data?.method, params: res.data?.params },
            target: CANTON_TARGET,
          }, '*');
          return
        }
        const data = { type: "CLWALLET_PAGE_LISTENER", data: { listener, data: res.data } };
        window.postMessage(data, "*");
      })
    } catch (e) {
      if ((e as Error)?.message === 'Extension context invalidated') {
        console.info('Error: Extension context invalidated. Ignoring.');
      }
    }
  }
  return true

});

