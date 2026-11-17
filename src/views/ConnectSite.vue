<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Connect Site</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-list>
        <ion-item>
          <ion-text>
            <b style="word-break: break-all">{{ origin || "Unknown site" }}</b>
            wants to connect to your wallet
          </ion-text>
        </ion-item>
        <ion-item v-if="subframe">
          <ion-text color="warning" style="font-size: 0.9rem">
            This request comes from an embedded frame, not from the page shown in the
            address bar. Only connect if you trust this site.
          </ion-text>
        </ion-item>
        <ion-item v-if="origin.startsWith('http:')">
          <ion-text color="warning" style="font-size: 0.9rem">
            This site does not use a secure (https) connection.
          </ion-text>
        </ion-item>
        <ion-item>
          <ion-text style="font-size: 0.9rem">
            The site will see your selected account address
            <b v-if="selectedAccount?.address">
              {{
                selectedAccount.address.slice(0, 6) + "..." + selectedAccount.address.slice(-4)
              }}</b
            >, your network, and can ask you to approve transactions and signatures. You can
            disconnect it at any time in Settings.
          </ion-text>
        </ion-item>
        <ion-item>Auto-reject Timer:&nbsp;<b>{{ timerReject }}</b></ion-item>
        <ion-item class="no-inner-border">
          <ion-button @click="onCancel">Cancel</ion-button>
          <ion-button @click="onConnect" :disabled="!origin">Connect</ion-button>
        </ion-item>
      </ion-list>
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
  IonButton,
  IonText,
  IonList,
  onIonViewWillEnter,
} from "@ionic/vue";
import { useRoute } from "vue-router";
import { approve, walletPing } from "@/extension/userRequest";
import { getStoredSelectedAccount, hexTostr } from "@/utils/platform";
import type { Account } from "@/extension/types";

const route = useRoute();
const rid = (route?.params?.rid as string) ?? "";

// The service worker passes { origin, subframe } taken from the browser-provided sender
let origin = "";
let subframe = false;
try {
  const data = JSON.parse(hexTostr((route?.params?.param as string) ?? ""));
  origin = String(data?.origin ?? "");
  subframe = !!data?.subframe;
} catch {
  origin = "";
}

const selectedAccount = ref(null as Account | null);
const timerReject = ref(140);
let interval: any;

const onCancel = () => {
  if (interval) {
    clearInterval(interval);
  }
  window.close();
};

const onConnect = () => {
  if (interval) {
    clearInterval(interval);
  }
  approve(rid);
};

onIonViewWillEnter(async () => {
  getStoredSelectedAccount().then((account) => {
    selectedAccount.value = account;
  });
  interval = setInterval(async () => {
    if (timerReject.value <= 0) {
      onCancel();
      return;
    }
    timerReject.value -= 1;
    walletPing();
  }, 1000) as any;
});
</script>
