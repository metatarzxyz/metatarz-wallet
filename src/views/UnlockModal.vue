<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ isLockScreen ? "Wallet Locked" : "Unlock to Proceed" }}</ion-title>
        <ion-buttons slot="end" v-if="!isLockScreen">
          <ion-button @click="close" color="primary">Close</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list>
        <ion-list v-if="unlockType === 'message'">
          <ion-item>To continue signing the message, unlock wallet.</ion-item>
          <ion-item>Closing will reject sigining the message.</ion-item>
        </ion-list>
        <ion-list v-else-if="unlockType === 'open'">
          <ion-item>Your wallet is locked. Enter your password to unlock it.</ion-item>
        </ion-list>
        <ion-list v-else-if="unlockType === 'canton'">
          <ion-item class="ion-text-wrap">
            {{ requester || "A connected site" }} wants to read your Canton data (balances
            and contracts). Unlock the wallet to allow it.
          </ion-item>
        </ion-list>
        <ion-list v-else-if="unlockType === 'viewPk'">
          <ion-item>To view the PK, unlock wallet.</ion-item>
          <ion-item>Closing will not show the PK.</ion-item>
        </ion-list>
        <ion-list v-else-if="unlockType === 'delAcc'">
          <ion-item>Storage Encrypted, unlock to delete account.</ion-item>
          <ion-item>Closing will not delete the account.</ion-item>
        </ion-list>
        <ion-list v-else-if="unlockType === 'addAccount'">
          <ion-item>Storage Encrypted, unlock to add account.</ion-item>
          <ion-item>Closing will not add the account.</ion-item>
        </ion-list>
        <ion-list v-else>
          <ion-item>To continue sending the transaction, unlock wallet.</ion-item>
          <ion-item>Closing will reject sending the transaction.</ion-item>
        </ion-list>
        <ion-item>
          <ion-label>Unlock Password</ion-label>
        </ion-item>
        <ion-list>
          <ion-item>
            <ion-input
              ref="passinputref"
              label-placement="floating"
              aria-label="password"
              type="password"
              v-model="mpPass"
              autocomplete="off"
              autocorrect="off"
              :clear-input="false"
              :clear-on-edit="false"
              :spellcheck="false"
              id="pass-input"
            >
              <div slot="label"><ion-text color="danger">(Password)</ion-text></div>
            </ion-input>

            <!-- <ion-input
            label="Password"
            label-placement="floating"
            fill="outline"
            placeholder=""
            type="password"
            @ion-input="mpPass = String($event.target.value)"
          ></ion-input> -->
          </ion-item>
        </ion-list>
      </ion-list>
      <ion-item>
        <ion-button @click="unlock">Confirm</ion-button>
      </ion-item>
      <ion-alert
        :is-open="alertOpen"
        header="Error"
        :message="alertMsg"
        :buttons="['OK']"
        @didDismiss="alertOpen = false"
      ></ion-alert>
      <ion-loading
        :is-open="loading"
        cssClass="my-custom-class"
        message="Please wait..."
        :key="`k${loading}`"
        @didDismiss="loading = false"
      />
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { computed, ref, Ref } from "vue";
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
  IonList,
  IonButtons,
  modalController,
  IonLoading,
} from "@ionic/vue";
import { getStoredAccounts, setUnlockedPks, markWalletActivity } from "@/utils/platform";
import { decrypt, getCryptoParams } from "@/utils/webCrypto";
import { unlockModalStateSubscribe } from "@/utils/unlockStore";

const props = defineProps<{
  unlockType: string;
  requester?: string;
}>();

// The wallet's lock screen ('open' on opening a locked wallet, 'canton' when a
// connected site is waiting) cannot be closed: only unlocking dismisses it.
// In request flows (transaction, message, ...) Close still rejects the request.
const isLockScreen = computed(() => props.unlockType === "open" || props.unlockType === "canton");

const mpPass = ref("");
const loading = ref(false);
const alertOpen = ref(false);
const alertMsg = ref("");
const passinputref: Ref<any> = ref(null);

const close = () => {
  return modalController?.dismiss(null, "cancel");
};

const unlock = async () => {
  try {
    loading.value = true;
    const accounts = (await getStoredAccounts()).filter((a) => a.encPk);
    if (!accounts.length) {
      throw new Error("No encrypted accounts");
    }
    const cryptoParams = await getCryptoParams(mpPass.value);
    const unlocked = await Promise.all(
      accounts.map(async (a) => ({
        address: a.address,
        pk: await decrypt(a.encPk, cryptoParams),
      }))
    );
    // Decrypted keys are kept in the memory-only session store, never on disk
    await setUnlockedPks(unlocked);
    await markWalletActivity();
    loading.value = false;
    return modalController?.dismiss(mpPass.value, "confirm");
  } catch {
    loading.value = false;
    alertMsg.value = "Decryption failed, password is not correct, try again.";
    alertOpen.value = true;
    return;
  }
};

unlockModalStateSubscribe((state) => {
  if (state) {
    passinputref.value?.$el?.setFocus?.();
  }
});
</script>
