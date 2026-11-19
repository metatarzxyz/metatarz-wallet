// Canton token activation, shared by Manage Tokens and the metatarz_swap popup.
//
// A wallet can only receive a Canton instrument once it has created a transfer
// preapproval for it ("activated"). The flag is stored per network at
// network.tokens[<account address>].canton.<key>.activated.
//
// First-time CC activation also registers the Canton party; that registration
// stays in ManageTokensTab. activateToken('cc') only does what follows it there
// (flag, Amulet preapproval, merge delegation).
//
// No Vue / popup dependencies: usable from views and the service worker.

import type { Network } from '@/extension/types'
import { getSelectedNetwork, saveNetwork, saveSelectedNetwork } from '@/utils/platform'
import { sendMergeDelegation, sendPreapproval } from '@/utils/canton'

export type CantonTokenKey = 'cc' | 'cbtc' | 'ceth' | 'usdcx' | 'handl' | 'beth'

/** Display symbol (as in Manage Tokens) by token key. */
export const CANTON_TOKEN_SYMBOLS: Record<CantonTokenKey, string> = {
    cc: 'CC',
    cbtc: 'CBTC',
    ceth: 'cETH',
    usdcx: 'USDCx',
    handl: 'HANDL',
    beth: 'BETH',
}

/** Preapproval transfer type sent to the middleware, by token key. */
export const CANTON_TOKEN_PREAPPROVAL: Record<CantonTokenKey, string> = {
    cc: 'preapproval',
    cbtc: 'preapproval2',
    ceth: 'preapproval3',
    usdcx: 'preapproval4',
    handl: 'preapproval5',
    beth: 'preapproval6',
}

/** Swap pool symbol (middleware instrument name) -> wallet token key. */
export const SWAP_POOL_TOKEN_KEYS: Record<string, CantonTokenKey> = {
    Amulet: 'cc',
    USDCx: 'usdcx',
    CBTC: 'cbtc',
    BETH: 'beth',
    cETH: 'ceth',
    HANDL: 'handl',
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Token key of a Manage Tokens display symbol ("CC", "CBTC", ...), if known. */
export const tokenKeyOfSymbol = (symbol: string): CantonTokenKey | undefined =>
    (Object.keys(CANTON_TOKEN_SYMBOLS) as CantonTokenKey[]).find((k) => CANTON_TOKEN_SYMBOLS[k] === symbol)

/** Token key of a swap pool symbol ("Amulet", "USDCx", ...), if known. */
export const tokenKeyOfPoolSymbol = (poolSymbol: string): CantonTokenKey | undefined =>
    typeof poolSymbol === 'string' && has(SWAP_POOL_TOKEN_KEYS, poolSymbol) ? SWAP_POOL_TOKEN_KEYS[poolSymbol] : undefined

/**
 * Whether the wallet lets the user activate the token on this network (the
 * Manage Tokens "enabled" state): HANDL is disabled, cETH is disabled on testnet.
 */
export const isTokenActivatable = (chainId: number, key: CantonTokenKey): boolean => {
    if (key === 'handl') return false
    if (key === 'ceth' && chainId === 30337) return false
    return true
}

const tokensEntryOf = (network: Network | undefined, address: string) => {
    const tokens = network?.tokens
    if (!tokens || !address) return undefined
    if (has(tokens, address)) return tokens[address]
    const key = Object.keys(tokens).find((k) => k.toLowerCase() === address.toLowerCase())
    return key ? tokens[key] : undefined
}

/** True when `key` is activated for `address` on `network`. */
export const isTokenActivated = (network: Network | undefined, address: string, key: CantonTokenKey): boolean =>
    tokensEntryOf(network, address)?.canton?.[key]?.activated === true

/**
 * The network object activation reads and writes for a Canton chain: the
 * selected network when it is that chain (as Manage Tokens does), otherwise the
 * stored one from `networks`.
 */
export const getStoredCantonNetwork = async (chainId: number, networks: Record<number, Network>): Promise<Network | undefined> => {
    const selected = await getSelectedNetwork()
    if (selected && selected.chainId === chainId) return selected
    return networks[chainId]
}

// Writes the activated flag (same shape as Manage Tokens always wrote it). The
// selected network copy is updated too when it is this network.
const saveActivated = async (network: Network, address: string, key: CantonTokenKey): Promise<Network> => {
    const currentCanton = network.tokens?.[address]?.canton ?? {}
    const updatedNetwork: Network = {
        ...network,
        tokens: {
            ...network.tokens,
            [address]: {
                canton: {
                    ...currentCanton,
                    [key]: {
                        activated: true,
                    },
                },
            },
        },
    }
    await saveNetwork(updatedNetwork)
    if ((await getSelectedNetwork())?.chainId === updatedNetwork.chainId) {
        await saveSelectedNetwork(updatedNetwork)
    }
    return updatedNetwork
}

export type ActivationAccount = {
    address: string
    pk: string // unlocked key
    cantonParty?: string
}

export type ActivateTokenOptions = {
    network: Network
    account: ActivationAccount
    key: CantonTokenKey
    /** Called with the updated network every time the flag is saved. */
    onNetworkSaved?: (network: Network) => void
}

/**
 * Creates the transfer preapproval for `key` and stores the activated flag, as
 * Manage Tokens does. A preapproval that already exists (middleware 409) counts
 * as success. For CC (after registration), the flag is stored first, then the
 * Amulet preapproval is sent and a merge delegation is granted (best effort).
 *
 * Throws on failure; returns the updated network.
 */
export const activateToken = async ({ network, account, key, onNetworkSaved }: ActivateTokenOptions): Promise<Network> => {
    if (!has(CANTON_TOKEN_PREAPPROVAL, key)) {
        throw new Error('Unknown Canton token')
    }
    if ((account?.pk ?? '').length !== 66) {
        throw new Error('The wallet is locked')
    }
    const party = () => {
        if (!account.cantonParty) {
            throw new Error('No Canton party for this account. Activate CC first.')
        }
        return account.cantonParty
    }

    if (key === 'cc') {
        const updated = await saveActivated(network, account.address, 'cc')
        onNetworkSaved?.(updated)

        // send Amulet preapproval
        await sendPreapproval(CANTON_TOKEN_PREAPPROVAL.cc, party(), account.pk, updated)

        // grant merge delegation (best effort, must not block token activation)
        try {
            await sendMergeDelegation(party(), account.pk, updated)
        } catch (e) {
            console.error('merge delegation failed', e)
        }
        return updated
    }

    await sendPreapproval(CANTON_TOKEN_PREAPPROVAL[key], party(), account.pk, network)
    const updated = await saveActivated(network, account.address, key)
    onNetworkSaved?.(updated)
    return updated
}
