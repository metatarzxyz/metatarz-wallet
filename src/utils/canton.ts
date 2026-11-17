import { getSelectedAccount, getSelectedNetwork, numToHexStr } from '@/utils/platform';
import { TransactionResponse, ethers } from "ethers"
import { getCurrentProvider, signHashDER, signMsg, signMsgWithPk } from './wallet';


/*/api/v2/transfer/prepare
ADD HEADERS:("X-Signature") //eip191
("X-Message")

//{to, amount, token "DEMO" or "PROMPT"}
type PrepareResponse struct {
    TransferID      string `json:"transfer_id"`
    TransactionHash string `json:"transaction_hash"` // hex-encoded hash to sign
    PartyID         string `json:"party_id"`
    ExpiresAt       string `json:"expires_at"` // RFC3339
}
*/

///api/v2/transfer/execute


/*
TransferID string `json:"transfer_id"`
    Signature  string `json:"signature"` // hex-encoded DER signature
    SignedBy   string `json:"signed_by"` // Canton multihash fingerprint
type ExecuteResponse struct {
    Status string `json:"status"` // "completed"
}

    */

export const isCantonChain = (chainId?: number) => chainId === 31337 || chainId === 30337

// Amount on the transfer wire is always an 18-decimal wei integer for every
// instrument (middleware weiToCantonDecimal divides by 1e18).
export const CANTON_TRANSFER_DECIMALS = 18

type CantonTransferToken = { symbol: string, priceId?: string, fixedPrice?: number }

// Instruments the wallet knows, keyed by the `token` value sent to /api/v2/transfer/prepare.
// The middleware has no default: a missing token is rejected.
const CANTON_TRANSFER_TOKENS: Record<string, CantonTransferToken> = {
    Amulet: { symbol: 'CC', priceId: 'canton-network' },
    USDCx: { symbol: 'USDCx', fixedPrice: 1 },
    HANDL: { symbol: 'HANDL' },
    CBTC: { symbol: 'CBTC', priceId: 'bitcoin' },
    cETH: { symbol: 'cETH', priceId: 'ethereum' },
    BETH: { symbol: 'BETH', priceId: 'ethereum' },
}

// cETH is disabled on Canton Testnet (see ManageTokensTab)
const CANTON_TESTNET_EXCLUDED = ['cETH']

export const getCantonTransferToken = (chainId: number, token: unknown): CantonTransferToken | undefined => {
    if (!isCantonChain(chainId) || typeof token !== 'string') return undefined
    if (!Object.prototype.hasOwnProperty.call(CANTON_TRANSFER_TOKENS, token)) return undefined
    if (chainId === 30337 && CANTON_TESTNET_EXCLUDED.includes(token)) return undefined
    return CANTON_TRANSFER_TOKENS[token]
}

// Signed middleware auth messages have the form "<action>:<unix seconds>" (the
// middleware also accepts milliseconds, but seconds are the protocol).
// Registration messages are single use, so a timestamp is never reused here.
let lastTimedMessageSec = 0
const timedMessage = (action: string) => {
    lastTimedMessageSec = Math.max(Math.floor(Date.now() / 1000), lastTimedMessageSec + 1)
    return `${action}:${lastTimedMessageSec}`
}

type MiddlewareError = { error?: string, code?: number }

// User-facing message for a middleware error response ({ error, code }).
const cantonErrorMessage = (res?: MiddlewareError): string => {
    const { error, code } = res ?? {}
    switch (code) {
        case 400:
            if (error?.startsWith('too many pending')) {
                return 'Too many pending Canton transactions. Wait a few minutes for them to expire, then try again.'
            }
            break
        case 401:
            if (error === 'registration signature already used') {
                return 'This registration request was already submitted. Please try again.'
            }
            if (error === 'user not found') {
                return 'This account is not registered with Canton. Activate CC in Manage Tokens first.'
            }
            // "message expired or invalid format", "registration message expired or invalid timestamp"
            if (/expired|timestamp/i.test(error ?? '')) {
                return 'The wallet signature was rejected as expired or invalid. Check that your device clock is correct and try again.'
            }
            break
        case 403:
            return 'Not authorized: ' + (error ?? 'request rejected')
        case 404:
        case 410:
            return 'The prepared request expired or was already used. Please try again.'
        case 409:
            if (error === 'canton party already registered') {
                return 'This Canton party is already registered to another account.'
            }
            break
    }
    return error ? 'Canton request failed: ' + error : 'Transaction failed. Try again later'
}

//send canton non-custodial transaction flow.
export const sendCantonTransaction = async (params: any, type = "transfer", party?: string, pk?: string): Promise<TransactionResponse | undefined> => {

    //console.log('partyid', party)

    const account = await getSelectedAccount()
    const { provider, network } = await getCurrentProvider()
    const wallet = new ethers.Wallet(pk ? pk : account.pk, provider)
    const url = network.rpc

    const chainId = network.chainId

    //only for Canton
    if (chainId !== 31337 && chainId !== 30337) {
        return
    }

    const message = timedMessage("transfer")

    const signature = await signMsgWithPk(message, pk ? pk : account?.pk)


    const prepareResponse = await callPrepare(url, {
        message, sig: signature, ...(type === 'transfer' ? {
            to: params?.to, amount: params?.value,
            token: params?.token,
            //token: "Amulet", // TODO: replace
            memo: params?.memo
        } : {}), type
    })

    if (prepareResponse?.code) {
        // 409 on preapproval / merge delegation: it already exists, nothing to do.
        if (prepareResponse.code === 409 && type !== 'transfer') {
            return
        }
        throw new Error(cantonErrorMessage(prepareResponse))
    }
    if (prepareResponse && prepareResponse?.transaction_hash) {


        const txHash = prepareResponse?.transaction_hash

        const txHashSig = await signHashDER(txHash, pk ? pk : account?.pk)


        const executeResponse = await callExecute(url, {
            message,
            sig: signature,
            signed_by: party ? party.split('::')[1] : account?.cantonParty?.split('::')[1],
            signature: txHashSig,
            transfer_id: prepareResponse?.transfer_id,
            transaction_hash: txHash,
            public_key: wallet.signingKey.compressedPublicKey,
            type,
        })

        if (!executeResponse || executeResponse.code) {
            throw new Error(cantonErrorMessage(executeResponse))
        }


        return { hash: executeResponse?.update_id ?? txHash } as TransactionResponse

    }

    throw new Error('Transaction failed. Try again later')




}


// call register + preapprove (prepare + execute) endpoints

export const sendPreapproval = async (type: string, party: string, pk: string,) => {
    await sendCantonTransaction({}, type, party, pk)

}

// grant the wallet operator a merge delegation (prepare + execute), so it can merge
// fragmented holdings for the user. One per user, covers all assets; 409 = already exists.
export const sendMergeDelegation = async (party: string, pk: string) => {
    await sendCantonTransaction({}, "merge-delegation", party, pk)
}
export const registerWallet = async (pk: string) => {
    const wallet = new ethers.Wallet(pk)

    const publicKey = wallet.signingKey.compressedPublicKey


    const { provider, network } = await getCurrentProvider()

    const url = network.rpc

    const chainId = network.chainId

    //only for Canton
    if (chainId === 31337 || chainId === 30337) {

        //need signature + message

        const msg = timedMessage("registration")

        const signature = await signMsgWithPk(msg, pk)

        const data: { user_exists: boolean, party: string, fingerprint: string, topology_hash: string, public_key_fingerprint: string, registration_token: string, error: string, code: number }
            = await callRegisterTopology(url, {
                signature,
                message: msg,
                key_mode: 'external',
                canton_public_key: publicKey
            })
        //fetch /register/prepare-topology

        if (!data || data.code) {
            return {
                error: cantonErrorMessage(data)
            }
        }



        if (!data?.user_exists) {
            if (!data?.topology_hash || !data?.registration_token) {
                return {
                    error: 'Unexpected response from the Canton middleware'
                }
            }

            const topologySignature = await signHashDER(data?.topology_hash, pk)

            const registerData = await callRegister(url, {
                signature,
                message: msg,
                key_mode: 'external',
                //used for verifyDER server side
                topology_signature: topologySignature,
                transaction_hash: data?.topology_hash,
                canton_public_key: publicKey,
                public_key_fingerprint: data?.public_key_fingerprint,
                registration_token: data?.registration_token
            })

            // 409 means the user/party was already registered (e.g. by an earlier
            // attempt). The response has no party: look it up with a fresh step 1.
            if (registerData?.code === 409 && registerData.error !== 'canton party already registered') {
                const existingMsg = timedMessage("registration")
                const existing = await callRegisterTopology(url, {
                    signature: await signMsgWithPk(existingMsg, pk),
                    message: existingMsg,
                    key_mode: 'external',
                    canton_public_key: publicKey
                })
                if (!existing?.code && existing?.user_exists && existing?.party) {
                    return {
                        party: existing.party,
                        fingerprint: existing.fingerprint
                    }
                }
            }

            if (!registerData?.party || registerData.code) {
                return {
                    error: cantonErrorMessage(registerData)
                }
            }

            return {

                party: registerData?.party,
                fingerprint: registerData?.fingerprint

            }

        }


        return {

            party: data?.party,
            fingerprint: data?.fingerprint

        }

    }





}

// Parses a middleware response; errors come back as { error, code }.
async function readMiddlewareResponse(response: Response) {
    const body = await response.json().catch(() => undefined)

    if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return { error: body?.error ?? response.statusText, code: response.status }
    }

    return body
}

async function callRegister(url: string, params: any) {
    const response = await fetch(url + '/register', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    return await readMiddlewareResponse(response);
}

async function callPrepare(url: string, params: any) {
    const response = await fetch(url + '/api/v2/transfer/prepare', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature": params.sig,
            "X-Message": params.message
        },
        body: JSON.stringify({ ...(params.type === 'transfer' ? { amount: params?.amount, to: params.to, token: params.token, ...(params.memo ? { memo: params.memo } : {}) } : {}), type: params.type }),
    });

    return await readMiddlewareResponse(response);
}

async function callExecute(url: string, params: any) {
    const response = await fetch(url + '/api/v2/transfer/execute', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature": params.sig,
            "X-Message": params.message
        },
        body: JSON.stringify(
            {
                signature: params.signature,
                signed_by: params.signed_by,
                transfer_id: params.transfer_id,
                transaction_hash: params.transaction_hash,
                public_key: params.public_key,
                type: params.type
            }),
    });

    return await readMiddlewareResponse(response);
}


async function callRegisterTopology(url: string, params: any) {
    const response = await fetch(url + '/register/prepare-topology', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    return await readMiddlewareResponse(response);
}




export function isCantonAddress(partyID: string): boolean {
    // Split by '::' delimiter
    const parts = partyID.split('::');
    if (parts.length !== 2) {
        return false
    }

    let fingerprint = parts[1];

    // Remove 0x prefix if present
    if (fingerprint.startsWith('0x')) {
        fingerprint = fingerprint.slice(2);
    }

    // Remove multihash prefix "1220" if present (SHA-256 multihash)
    if (fingerprint.startsWith('1220') && fingerprint.length > 68) {
        fingerprint = fingerprint.slice(4);
    }

    // Validate fingerprint is hex
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(fingerprint)) {

        return false
    }

    return true
}