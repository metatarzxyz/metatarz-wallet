<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title v-if="!isEdit">Add Account</ion-title>
        <ion-title v-else>Edit Account</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-loading
        :is-open="loading"
        cssClass="my-custom-class"
        message="Please wait..."
        :key="`k${loading}`"
        @didDismiss="loading = false"
      >
      </ion-loading>
      <ion-item>
        <ion-input
          label="Name"
          labelPlacement="stacked"
          v-model="name"
          fill="outline"
        ></ion-input>
      </ion-item>
      <ion-item>
        <ion-button @click="getRandomName">Generate Random Name</ion-button>
      </ion-item>
      <ion-item v-if="!isEdit">
        <ion-icon
          style="margin-right: 0.5rem; cursor: pointer"
          @click="paste('pastePk')"
          :icon="clipboardOutline"
          button
        />
        <ion-input
          label="PK"
          labelPlacement="stacked"
          id="pastePk"
          v-model="pk"
          fill="outline"
        ></ion-input>
      </ion-item>
      <template v-if="!isEdit">
        <ion-item>
          <ion-button @click="generateRandomPk"
            >Generate Random Private Key</ion-button
          >
        </ion-item>
        <ion-item>
          <ion-button @click="mnemonicModal = true" expand="full"
            >Extract Private Key From A Mnemonic</ion-button
          >
        </ion-item>
      </template>
      <ion-item>
        <div style="margin-left: auto; display: flex">
          <ion-button @click="onCancel">Cancel</ion-button>
          <ion-button
            @click="
              () => {
                isEdit ? onEditAccount() : onAddAccount();
              }
            "
            expand="full"
            color="primary"
            >{{ isEdit ? "Edit Account" : "Add Account" }}</ion-button
          >
        </div>
      </ion-item>
      <ion-alert
        :is-open="alertOpen"
        header="Error"
        :message="alertMsg"
        :buttons="['OK']"
        @didDismiss="alertOpen = false"
      ></ion-alert>

      <ion-modal :is-open="mnemonicModal" @didDismiss="mnemonic = ''">
        <ion-header>
          <ion-toolbar>
            <ion-buttons slot="start">
              <ion-button @click="mnemonicModal = false">Close</ion-button>
            </ion-buttons>
            <ion-title>Extract PK from mnemonic</ion-title>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          <ion-item>
            <ion-label>Enter mnemonic</ion-label>
          </ion-item>
          <ion-item>
            <ion-textarea
              style="overflow-y: scroll; width: 100%"
              aria-label="Enter mnemonic"
              :rows="10"
              :cols="10"
              v-model="mnemonic"
            ></ion-textarea>
          </ion-item>
          <ion-item>
            <ion-label>Enter Index (default: 0)</ion-label>
          </ion-item>
          <ion-item>
            <ion-input
              aria-label="mnemonic index"
              v-model="mnemonicIndex"
            ></ion-input>
          </ion-item>
          <ion-item>
            <ion-button @click="mnemonicModal = false" color="light"
              >Close</ion-button
            >
            <ion-button @click="extractMnemonic">Extract</ion-button>
          </ion-item>
        </ion-content>
      </ion-modal>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import {
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  IonItem,
  IonLabel,
  IonInput,
  IonButton,
  IonAlert,
  IonIcon,
  onIonViewWillEnter,
  modalController,
  IonModal,
  IonButtons,
  IonTextarea,
  IonLoading,
} from "@ionic/vue";
import { ethers } from "ethers";
import {
  saveSelectedAccount,
  getAccounts,
  saveAccount,
  smallRandomString,
  paste,
  getSettings,
  replaceAccounts,
} from "@/utils/platform";
import router from "@/router";
import { useRoute } from "vue-router";
import type { Account, Settings } from "@/extension/types";
import UnlockModal from "@/views/UnlockModal.vue";
import { encrypt, getCryptoParams } from "@/utils/webCrypto";
import { registerWallet } from "@/utils/canton";

import { clipboardOutline } from "ionicons/icons";
import { getFromMnemonic, getRandomPk } from "@/utils/wallet";
import { setUnlockModalState } from "@/utils/unlockStore";

const loading = ref(false);

const name = ref("");
const pk = ref("");
const alertOpen = ref(false);
const alertMsg = ref("");
const route = useRoute();
const isEdit = route.path.includes("/edit");
const paramAddress = route.params.address ?? "";
const mnemonicModal = ref(false);
const mnemonic = ref("");
const mnemonicIndex = ref(0);

let accountsProm: Promise<Account[] | undefined>;
let settingsProm: Promise<Settings | undefined>;

const resetFields = () => {
  name.value = "";
  pk.value = "";
};

const openModal = async () => {
  const modal = await modalController.create({
    component: UnlockModal,
    animated: true,
    focusTrap: false,
    backdropDismiss: false,
    componentProps: {
      unlockType: "addAccount",
    },
  });
  await modal.present();
  setUnlockModalState(true);
  const { role, data } = await modal.onWillDismiss();
  if (role === "confirm") return data;
  setUnlockModalState(false);
  return false;
};

onIonViewWillEnter(async () => {
  if (isEdit && paramAddress) {
    accountsProm = getAccounts();
    settingsProm = getSettings();
    const accounts = (await accountsProm) as Account[];
    const acc = accounts.find((account) => account.address === paramAddress);
    if (acc) {
      name.value = acc.name;
    }
  }
});

const deleteAccount = async (address: string, accounts: Account[]) => {
  const findIndex = accounts.findIndex((a) => a.address === address);
  const pArr: Array<Promise<void>> = [];
  if (findIndex !== -1) {
    accounts.splice(findIndex, 1);
    pArr.push(replaceAccounts([...accounts]));
  }
  await Promise.all(pArr);
};

const onEditAccount = async () => {
  if (name.value.length < 1) {
    alertMsg.value = "Name cannot be empty.";
    alertOpen.value = true;
    return;
  }
  const accounts = (await accountsProm) as Account[];
  const account = accounts.find((acc) => acc.address === paramAddress);
  if (!account) {
    alertMsg.value = "Account not found.";
    alertOpen.value = true;
    return;
  }
  const savedAcc = {
    address: account.address,
    name: name.value,
    pk: account.pk,
    encPk: account.encPk,
    cantonParty: account?.cantonParty,
    cantonFingerprint: account?.cantonFingerprint,
  };
  await deleteAccount(account.address, accounts);

  await saveAccount(savedAcc);
  router.push("/tabs/accounts");
};

const onAddAccount = async () => {
  try {
    // 1. Validate input
    if (!validateInput()) return;
    
    // 2. Prepare wallet and data
    const wallet = new ethers.Wallet(pk.value);
    const accounts = await getAccountsData();
    const settings = await getSettingsData();
    
    // 3. Check for duplicate account
    if (accounts?.find((account) => account.address === wallet.address)) {
      alertMsg.value = "Account already exists.";
      alertOpen.value = true;
      return;
    }
    
    // 4. Handle encryption if enabled
    let cryptoParams = null;
    if (settings?.enableStorageEnctyption) {
      const pass = await openModal();
      if (!pass) {
        alertMsg.value = "Cannot add account without encryption password.";
        alertOpen.value = true;
        return;
      }
      cryptoParams = await getCryptoParams(pass);
    }
    
    // 5. Register wallet with Canton
    loading.value = true;
    const cantonData = await registerWallet(pk.value);
    
    if (cantonData?.error) {
      alertMsg.value = 'Failed to register Canton wallet: ' + cantonData.error;
      alertOpen.value = true;
      return;
    }
    
    // 6. Prepare account data
    const accountData = await buildAccountData(wallet, cryptoParams, cantonData);
    
    // 7. Save account(s)
    const savePromises = [];
    
    // Always save the main account
    savePromises.push(saveAccount(accountData));
    
    // If no accounts exist yet, also set as selected
    if (!accounts || accounts.length === 0) {
      await saveSelectedAccount(accountData);
    }
    
    await Promise.all(savePromises);
    
    // 8. Navigate and cleanup
    await navigateAfterSave();
    resetFields();
    
  } catch (e) {
    console.error(e);
    alertMsg.value = "An error occurred while adding the account.";
    alertOpen.value = true;
  } finally {
    loading.value = false;
  }
};

// Helper functions
const validateInput = (): boolean => {
  if (name.value.length < 1) {
    alertMsg.value = "Name cannot be empty.";
    alertOpen.value = true;
    return false;
  }
  
  let privateKey = pk.value;
  if (privateKey.length === 64) {
    privateKey = `0x${privateKey.trim()}`;
    pk.value = privateKey;
  }
  
  if (privateKey.length !== 66) {
    alertMsg.value = "Provided private key is invalid.";
    alertOpen.value = true;
    return false;
  }
  
  return true;
};

const getAccountsData = async (): Promise<Account[] | undefined> => {
  if (!accountsProm) {
    accountsProm = getAccounts();
  }
  return await accountsProm;
};

const getSettingsData = async (): Promise<Settings | undefined> => {
  if (!settingsProm) {
    settingsProm = getSettings();
  }
  return await settingsProm;
};

const buildAccountData = async (
  wallet: ethers.Wallet,
  cryptoParams: any | null,
  cantonData: any | null
): Promise<Account> => {
  const baseAccount: Partial<Account> = {
    address: wallet.address,
    name: name.value,
    pk: pk.value,
  };
  
  // Handle encryption
  if (cryptoParams) {
    baseAccount.encPk = await encrypt(pk.value, cryptoParams);
  } else {
    baseAccount.encPk = "";
  }
  
  // Handle Canton data
  if (cantonData) {
    baseAccount.cantonParty = cantonData.party;
    baseAccount.cantonFingerprint = cantonData.fingerprint;
  }
  
  return baseAccount as Account;
};

const navigateAfterSave = async () => {
  if (isEdit) {
    await router.push("/tabs/accounts");
  } else {
    await router.push("/tabs/home");
  }
};

const generateRandomPk = () => {
  pk.value = getRandomPk();
};

const getRandomName = () => {
  name.value = smallRandomString();
};

const onCancel = () => {
  if (isEdit) {
    router.push("/tabs/accounts");
  } else {
    router.push("/tabs/home");
  }
};

const extractMnemonic = () => {
  mnemonic.value = mnemonic.value.trim().replace(/\s+/g, " ");
  mnemonicIndex.value = Number(mnemonicIndex.value);
  const wordCount = mnemonic.value.trim().split(" ").length;

  if (wordCount !== 12 && wordCount !== 24) {
    alertMsg.value = "Invalid mnemonic.";
    alertOpen.value = true;
    return;
  }
  if (mnemonicIndex.value < 0) {
    alertMsg.value = "Invalid index.";
    alertOpen.value = true;
    return;
  }
  pk.value = getFromMnemonic(mnemonic.value, mnemonicIndex.value);
  mnemonicModal.value = false;
};
</script>

<style scoped>
.input-fill-outline.sc-ion-input-md-h {
  min-height: 38px;
}
</style>
