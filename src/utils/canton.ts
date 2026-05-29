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
//send canton non-custodial transaction flow.
export const sendCantonTransaction = async(params:any, type = "transfer", party?:string, pk?:string):Promise<TransactionResponse | undefined>=>{

    //console.log('partyid', party)
    
    const account = await getSelectedAccount()
    const { provider, network} = await getCurrentProvider()
    const wallet = new ethers.Wallet(pk ? pk : account.pk, provider)
    const url = network.rpc

    const chainId = network.chainId

    //only for Canton
    if(chainId !== 31337){
        return
    }

    const message = "transfer:"+Date.now()

    const signature = await signMsgWithPk(message, pk ? pk : account?.pk)


    const prepareResponse = await callPrepare(url, {message, sig:signature, ...(type === 'transfer' ? {to: params?.to, amount: params?.value, token: "Amulet",}:{}), type})


    const txHash = prepareResponse?.transaction_hash

    const txHashSig= await signHashDER(txHash, pk ? pk : account?.pk)

    
    const executeResponse = await callExecute(url, {
        message,
        sig:signature,
        signed_by:  party ? party.split('::')[1] : account?.cantonParty?.split('::')[1],
        signature: txHashSig,
        transfer_id: prepareResponse?.transfer_id,
        transaction_hash: txHash,
        public_key: wallet.signingKey.compressedPublicKey,
        type,
    })

    if(!executeResponse){
        throw new Error('Transaction failed. Try again later')
    }


    return {hash: txHash} as TransactionResponse
    



}


// call register + preapprove (prepare + execute) endpoints
export const registerWallet = async (pk:string)=>{
    const wallet = new ethers.Wallet(pk)

    const publicKey = wallet.signingKey.compressedPublicKey
    

    const {provider, network} = await getCurrentProvider()

    const url = network.rpc

    const chainId = network.chainId

    //only for Canton
    if(chainId === 31337){

    //need signature + message

    const msg = "registration:"+Date.now()

    const signature = await signMsgWithPk(msg, pk)

    const data:{user_exists: boolean, party: string, fingerprint:string, topology_hash: string, public_key_fingerprint: string, registration_token:string} 
    = await callRegisterTopology(url, {
        signature,
        message:msg,
        key_mode:'external',
        canton_public_key: publicKey
      })
    //fetch /register/prepare-topology

    if(data?.user_exists){
        return {
            
                party: data?.party,
                fingerprint: data?.fingerprint
            
        }
    }

    const topologySignature = await signHashDER(data?.topology_hash, pk)

    const registerResponse = await callRegister(url, {
        signature,
        message:msg,
        key_mode:'external',
        //used for verifyDER server side
        topology_signature: topologySignature,
        transaction_hash: data?.topology_hash,
        canton_public_key: publicKey,
        public_key_fingerprint: data?.public_key_fingerprint,
        registration_token: data?.registration_token
    })


    //send preapproval transaction
    await sendCantonTransaction({}, "preapproval", registerResponse?.party, pk)
    
    return registerResponse

    }



    
    
}

async function callRegister(url:string, params:any) {
    const response = await fetch(url+'/register', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });
    
    if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return
    }
    
    return await response.json();
}

async function callPrepare(url:string, params:any) {
    const response = await fetch(url+'/api/v2/transfer/prepare', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature": params.sig,
            "X-Message": params.message
        },
        body: JSON.stringify({...(params.type==='transfer' ? {amount: params?.amount, to: params.to, token: params.token}:{}), type: params.type}),
    });
    
    if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return
    }
    
    return await response.json();
}

async function callExecute(url:string, params:any) {
    const response = await fetch(url+'/api/v2/transfer/execute', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Signature": params.sig,
            "X-Message": params.message
        },
        body: JSON.stringify(
            {signature: params.signature, 
            signed_by: params.signed_by, 
            transfer_id: params.transfer_id,
            transaction_hash: params.transaction_hash,
            public_key: params.public_key,
            type: params.type
        }),
    });
    
    if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return
    }
    
    return await response.json();
}


async function callRegisterTopology(url:string, params:any) {
    const response = await fetch(url+'/register/prepare-topology', {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });
    
    if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return
    }
    
    return await response.json();
}