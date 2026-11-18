<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Unlock requested</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <h2>{{ requester }}</h2>
            <p>wants to read your Canton data (balances and contracts).</p>
          </ion-label>
        </ion-item>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <p>
              The wallet is locked. Unlocking lets connected sites read data for your own
              Canton party. Any transaction or signature still needs your separate
              approval.
            </p>
          </ion-label>
        </ion-item>
      </ion-list>

      <ion-item lines="none">
        <ion-button @click="onUnlock" expand="block">Unlock</ion-button>
        <ion-button @click="onClose" color="medium" fill="outline">Not now</ion-button>
      </ion-item>

      <ion-loading
        :is-open="loading"
        message="Please wait..."
        :key="`k${loading}`"
        @didDismiss="loading = false"
      ></ion-loading>
    </ion-content>
  </ion-page>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import {
  IonButton,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonLoading,
  IonPage,
  IonTitle,
  IonToolbar,
  modalController,
} from "@ionic/vue";
import { useRoute } from "vue-router";
import { hexTostr } from "@/utils/platform";
import UnlockModal from "@/views/UnlockModal.vue";
import { setUnlockModalState } from "@/utils/unlockStore";

const route = useRoute();
// Display-only label (site host, or "<dApp> (via WalletConnect)") chosen by the service worker
const requester = hexTostr((route.params?.param as string) ?? "") || "A connected site";
const loading = ref(false);

const onClose = () => {
  window.close();
};

const onUnlock = async () => {
  const modal = await modalController.create({
    component: UnlockModal,
    animated: true,
    focusTrap: false,
    backdropDismiss: false,
    componentProps: { unlockType: "canton" },
  });
  await modal.present();
  setUnlockModalState(true);
  const { role } = await modal.onWillDismiss();
  await setUnlockModalState(false);
  if (role === "confirm") {
    // Keys are now in the session store; the site's next request succeeds.
    window.close();
  }
};
</script>
