import { modalController } from '@ionic/vue'
import type { Account } from '@/extension/types'
import {
    getStoredAccounts,
    getStoredSelectedAccount,
    replaceAccounts,
    saveSelectedAccount,
    setUnlockedPks,
    getSettings,
    setSettings,
    hasEncryptionPassword,
    needsEncryptionSetup,
} from '@/utils/platform'
import { decrypt, encrypt, getCryptoParams } from '@/utils/webCrypto'

/**
 * Turns on (mandatory) storage encryption with `password` and unlocks the wallet.
 *
 * Every account that still has a plaintext pk in chrome.storage.local is
 * encrypted, the plaintext is removed from chrome.storage.local and the
 * decrypted keys are kept only in the session store. If a password was already
 * set, `password` must match it (decryption of the existing encPk throws otherwise).
 */
export const setupStorageEncryption = async (password: string): Promise<void> => {
    const [existingPassword, accounts, selectedAccount] = await Promise.all([
        hasEncryptionPassword(),
        getStoredAccounts(),
        getStoredSelectedAccount(),
    ])
    const cryptoParams = await getCryptoParams(password)

    const unlocked: Account[] = await Promise.all(accounts.map(async (a) => {
        let pk = a.pk ?? ''
        if (pk && !(existingPassword && a.encPk)) {
            if (pk.length === 64) {
                pk = `0x${pk}`
            }
            return { ...a, pk, encPk: await encrypt(pk, cryptoParams) }
        }
        if (a.encPk) {
            return { ...a, pk: await decrypt(a.encPk, cryptoParams) }
        }
        return a
    }))

    await setUnlockedPks(unlocked)
    await replaceAccounts(unlocked)

    if (selectedAccount?.address) {
        const match = unlocked.find((a) => a.address === selectedAccount.address)
        if (match) {
            await saveSelectedAccount({ ...selectedAccount, pk: match.pk, encPk: match.encPk })
        } else if (selectedAccount.pk && !selectedAccount.encPk) {
            await saveSelectedAccount({ ...selectedAccount, encPk: await encrypt(selectedAccount.pk, cryptoParams) })
        }
    }

    const settings = await getSettings()
    settings.enableStorageEnctyption = true
    settings.lastLock = Date.now()
    await setSettings(settings)
}

/**
 * Asks the user to create (or, if one exists, re-enter) the encryption password
 * and runs setupStorageEncryption. Resolves to the password, or false if closed.
 * `required` hides the close button (forced migration of plaintext installs).
 */
export const openSetPasswordModal = async (required = false): Promise<string | false> => {
    // Imported lazily: the modal itself imports this module.
    const [{ default: SetPasswordModal }, existingPassword] = await Promise.all([
        import('@/views/modals/SetPasswordModal.vue'),
        hasEncryptionPassword(),
    ])
    const modal = await modalController.create({
        component: SetPasswordModal,
        animated: true,
        focusTrap: false,
        backdropDismiss: false,
        componentProps: { required, existingPassword },
    })
    await modal.present()
    const { role, data } = await modal.onWillDismiss()
    return role === 'confirm' ? data : false
}

/** Forces installs that still hold plaintext keys to set a password first. */
export const enforceStorageEncryption = async (): Promise<void> => {
    while (await needsEncryptionSetup()) {
        await openSetPasswordModal(true)
    }
}
