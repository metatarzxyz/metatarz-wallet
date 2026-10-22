import { ethers } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";


const RPC_URL = "";
const PRIVATE_KEY = ""
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const EVM_ADDRESS = wallet.address;
const COMPRESSED_PUBKEY = wallet.signingKey.compressedPublicKey;

// Base64-decode it and sign all 34 bytes as they are (the 0x12 0x20 prefix included), Ed25519, then send me the 64-byte signature base64-encoded.
export function signHashDER(
    hashBase64: string,
    privateKeyBytes: Uint8Array,
  ): string {
    // Decode the base64 to get the raw bytes to sign
    const messageBytes = Uint8Array.from(Buffer.from(hashBase64, "base64"));
  
    // Ed25519 signs the message directly (no pre-hashing needed)
    const signature = ed25519.sign(messageBytes, privateKeyBytes);
  
    // Return base64-encoded 64-byte signature
    return Buffer.from(signature).toString("base64");
  }

  export async function signHash(hashHex: string, privateKeyHex: string, raw = false): Promise<string> {
    // Convert inputs to bytes

    let hash = Uint8Array.from(Buffer.from(hashHex, "base64"));

    const privateKey = ethers.getBytes(privateKeyHex);

    // Sign with noble-curves
    // prehash: false means the input is already a hash (don't hash again)
    // lowS: true matches go-ethereum's behavior
    const signature = secp256k1.sign(raw ? hash : sha256(hash), privateKey, {
        prehash: false,
        lowS: true,
        format: 'der'
    });

    // Return DER encoded signature (what Canton expects)
    return signature.toBase64()
}
  
  
  // Usage
  const message = "";
  // privateKeyBytes must be your 32-byte Ed25519 private key
  const sig = await signHash(message,  PRIVATE_KEY);
  console.log(sig);


